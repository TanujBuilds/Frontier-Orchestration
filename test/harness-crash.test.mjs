import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
const coordinatorUrl=new URL('../src/harness/coordinator.mjs',import.meta.url).href;
const code=`import {Coordinator} from ${JSON.stringify(coordinatorUrl)};const c=new Coordinator({root:process.argv[1]});c.acquireWorker('old');const g=c.prepareGoal({submissionId:'g',objective:'Crash proof',acceptance:['Same identity and spending'],environment:'fixture'},'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');const t=c.submitTask({goalId:g.id,submissionId:'t',kind:'consult',objective:'Explain WAL',acceptance:['Saved answer']},'t');c.claimNext('old');const r=c.reserve(t.id,{key:'consult-1',kind:'model'},'old');if(process.argv[2]==='saved')c.saveRequest(r.id,{content:'Saved before death',model:'fixture'});console.log(JSON.stringify(c.getTask(t.id)));setInterval(()=>{},1000);`;
for(const point of ['reserved','saved'])test(`SIGKILL after ${point} preserves budgets and ${point==='saved'?'reuses the completed response':'holds ambiguous ownership'}`,async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-kill-')),child=spawn(process.execPath,['--input-type=module','-e',code,root,point],{stdio:['ignore','pipe','pipe']});let c;t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');c?.close();await rm(root,{recursive:true,force:true});});
 const before=await new Promise((resolve,reject)=>{let out='',err='';child.stderr.on('data',b=>err+=b);child.stdout.on('data',b=>{out+=b;if(out.includes('\n'))resolve(JSON.parse(out.split('\n')[0]));});child.on('exit',()=>reject(Error('Child exited before checkpoint: '+err)));});
 c=new Coordinator({root});assert.throws(()=>c.acquireWorker('competing'),/worker|owns/);const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await ended;
 c.acquireWorker('new');let after=c.getTask(before.id);assert.equal(after.status,'uncertain');assert.equal(after.deadline,before.deadline);assert.equal(after.spent.model,1);
 if(point==='reserved'){assert.throws(()=>c.recoverSaved(before.id,'new'),/ambiguous|pending/);assert.equal(c.claimNext('new'),null);}
 else{c.recoverSaved(before.id,'new');await new Worker({c,owner:'new',config:{environment:'fixture'},provider:{complete:async()=>{throw Error('Duplicate completion');}}}).drain();after=c.getTask(before.id);assert.equal(after.status,'awaiting_review');assert.equal(after.result.content,'Saved before death');assert.equal(after.spent.model,1);assert.equal(after.deadline,before.deadline);}
});
test('a saved planning response survives SIGKILL without a second planning request',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-plan-kill-'));
 const script=`import {Coordinator} from ${JSON.stringify(coordinatorUrl)};const c=new Coordinator({root:process.argv[1]});c.acquireWorker('old');const g=c.prepareGoal({submissionId:'g',objective:'Explain a queue',acceptance:['Answer'],mode:'deepseek_only',environment:'fixture'},'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');c.store.tx(()=>{c.store.put('planning',{id:g.id,goalId:g.id,status:'running',attempt:1,feedback:[],owner:'old'});c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run('saved-plan',g.id,'plan-1','model','completed',JSON.stringify({owner:'old',result:{content:JSON.stringify({tasks:[{key:'explain',kind:'consult',objective:'Explain durable queues',acceptance:['Bounded answer']}]})}}));});console.log(g.id);setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,root],{stdio:['ignore','pipe','pipe']});let c;t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');c?.close();await rm(root,{recursive:true,force:true});});
 const goalId=await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',b=>{out+=b;if(out.includes('\n'))resolve(out.split('\n')[0]);});child.on('exit',()=>reject(Error('Child exited')));});
 const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await ended;c=new Coordinator({root});c.acquireWorker('new');c.recoverPlanning(goalId,'new');
 await new Worker({c,owner:'new',config:{environment:'fixture'},provider:{complete:async()=>{throw Error('Duplicate planning request');}}}).planner.tick();
 const goal=c.getGoal(goalId);assert.equal(goal.planning.status,'completed');assert.equal(goal.planning.attempt,1);assert.equal(goal.planning.spent,1);assert.equal(goal.tasks.length,1);assert.equal(goal.tasks[0].goalVersion,1);
});
