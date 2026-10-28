import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';

function fixture(t,mode='deepseek_only'){
 const root=mkdtempSync(path.join(os.tmpdir(),'harness-planner-')),c=new Coordinator({root});t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 const g=c.prepareGoal({submissionId:'goal',objective:'Explain durable queues',acceptance:['Two focused answers'],mode,environment:'fixture'},'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');return {c,g,config:{environment:'fixture'}};
}
const plan={tasks:[{key:'a',kind:'consult',objective:'Explain SQLite durability',acceptance:['Explain WAL']},{key:'b',kind:'consult',objective:'Compare filesystem queues',acceptance:['Explain tradeoffs'],dependsOn:['a']}]};
test('DeepSeek-only plans validated dependent assignments then executes without Codex',async t=>{
 const f=fixture(t);let planning=0,answers=0;
 const worker=new Worker({...f,provider:{complete:async m=>{const p=JSON.parse(m.at(-1).content);if(p.goal){planning++;return {content:JSON.stringify(plan)};}answers++;return {content:'Bounded answer'};}}});await worker.drain();
 const goal=f.c.getGoal(f.g.id);assert.equal(planning,1);assert.equal(answers,2);assert.equal(goal.tasks.length,2);assert.ok(goal.tasks.every(t=>t.status==='accepted'&&t.spec.actor==='deepseek'));
 assert.equal(goal.planning.spent,1);assert.equal(goal.reviewerRuns.length,0);
 await worker.drain();assert.equal(planning,1);assert.equal(answers,2);
});
test('malformed or permission-expanding plans consume all three planning attempts and submit nothing',async t=>{
 const f=fixture(t);let calls=0;const worker=new Worker({...f,provider:{complete:async()=>{calls++;return {content:JSON.stringify({tasks:[{...plan.tasks[0],actor:'codex'}]})};}}});await worker.drain();
 const g=f.c.getGoal(f.g.id);assert.equal(calls,3);assert.equal(g.tasks.length,0);assert.equal(g.planning.status,'blocked');assert.equal(g.planning.spent,3);
 const reopened=new Coordinator({root:f.c.store.root});t.after(()=>reopened.close());await new Worker({c:reopened,config:f.config,provider:{complete:async()=>{throw Error('Must not retry a spent plan');}}}).drain();
 assert.equal(reopened.getGoal(g.id).planning.spent,3);
});
test('cyclic proposed dependencies are rejected before any assignment is created',async t=>{
 const f=fixture(t),cyclic={tasks:[{...plan.tasks[0],dependsOn:['b']},plan.tasks[1]]};
 await new Worker({...f,provider:{complete:async()=>({content:JSON.stringify(cyclic)})}}).drain();assert.equal(f.c.getGoal(f.g.id).tasks.length,0);assert.equal(f.c.getGoal(f.g.id).planning.status,'blocked');
});
test('Codex-only never dispatches a model planner and ambiguous planning retains the global slot',async t=>{
 const f=fixture(t,'codex_only');let calls=0;await new Worker({...f,provider:{complete:async()=>{calls++;}}}).drain();assert.equal(calls,0);
 const g=f.c.prepareGoal({submissionId:'other',objective:'Explain',acceptance:['Answer'],mode:'deepseek_only',environment:'fixture'},'other');f.c.activateGoal({goalId:g.id,hash:g.hash},'activate-other');
 await new Worker({...f,provider:{complete:async()=>{throw Error('socket closed after sending');}}}).drain();
 assert.equal(f.c.getGoal(g.id).planning.status,'uncertain');
 const task=f.c.submitTask({goalId:g.id,submissionId:'manual',kind:'consult',objective:'A later task',acceptance:['Answer']},'manual');assert.equal(f.c.claimNext('new-worker'),null);assert.equal(f.c.getTask(task.id).status,'queued');
});
