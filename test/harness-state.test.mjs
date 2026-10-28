import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import { Coordinator } from '../src/harness/coordinator.mjs';

function fixture(t,extra={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'harness-state-'));let clock=1700000000000;
 const c=new Coordinator({root,now:()=>clock});t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 const g=c.prepareGoal({submissionId:'goal',objective:'Compare durable queues',acceptance:['Cited evidence'],project:null,...extra},'prepare');
 c.activateGoal({goalId:g.id,hash:g.hash},'activate');return {c,root,g,advance:n=>clock+=n};
}
const task=(id,extra={})=>({submissionId:id,kind:'research',objective:'Research '+id,acceptance:['Saved report'],...extra});
test('an unknown database version is rejected without rewriting its schema marker',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'harness-version-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'harness.sqlite3'),db=new DatabaseSync(file);db.exec('PRAGMA user_version=99');db.close();
 assert.throws(()=>new Coordinator({root}),/version|schema/i);const check=new DatabaseSync(file);assert.equal(check.prepare('PRAGMA user_version').get().user_version,99);check.close();
});
test('a consult revision cannot replay a spent answer as a new candidate',t=>{
 const {c,g}=fixture(t),a=c.submitTask({goalId:g.id,...task('consult',{kind:'consult'})},'consult');c.claimNext('o');c.beginAttempt(a.id,'o');
 const r=c.reserve(a.id,{key:'consult-1',kind:'model'},'o');c.saveRequest(r.id,{content:'Incomplete'});c.completeTask(a.id,{content:'Incomplete'},'o',{reviewRequired:true});
 const revised=c.review({taskId:a.id,decision:'revise',feedback:'Missing material evidence'},'revise');assert.equal(revised.status,'blocked');assert.match(revised.reason,/budget|attempt|request/i);assert.equal(revised.spent.model,1);
});
test('workflow submission pins a validated template and atomically maps dependencies',t=>{
 const {c,g}=fixture(t);c.registry.registerWorkflow({id:'pair',version:1,mode:'collaborative',tasks:[{key:'b',kind:'consult',objective:'Compare saved evidence',acceptance:['Comparison'],dependsOn:['a']},{key:'a',kind:'research',objective:'Gather public evidence',acceptance:['Saved sources']}]});
 const input={goalId:g.id,workflowId:'pair',version:1,submissionId:'run-one'},run=c.submitWorkflow(input,'workflow');assert.equal(run.tasks.length,2);const tasks=run.tasks.map(id=>c.getTask(id));assert.equal(tasks[1].spec.dependsOn[0],tasks[0].id);
 assert.deepEqual(c.submitWorkflow(input,'retry'),run);assert.equal(c.getGoal(g.id).tasks.length,2);assert.ok(run.definitionHash);
});
test('manual pause and stop preserve a question or review inbox instead of reexecuting it',t=>{
 const {c,g}=fixture(t),a=c.submitTask({goalId:g.id,...task('a')},'a');c.claimNext('o');c.ask(a.id,'Reliability or latency?',{},'o');
 c.control({taskId:a.id,action:'pause'},'pause');assert.equal(c.getTask(a.id).status,'paused');assert.throws(()=>c.answer({taskId:a.id,answer:'Reliability',responder:'codex'},'answer-paused'),/waiting|paused/);
 c.control({taskId:a.id,action:'resume'},'resume');assert.equal(c.getTask(a.id).status,'awaiting_supervisor');c.answer({taskId:a.id,answer:'Reliability',responder:'codex'},'answer');c.claimNext('o');c.completeTask(a.id,{content:'Saved'},'o',{reviewRequired:true});
 c.control({taskId:a.id,action:'stop'},'stop');assert.equal(c.getTask(a.id).status,'stopped');assert.throws(()=>c.review({taskId:a.id,decision:'accept',feedback:'Saved answer checked'},'review-stopped'),/stopped|review/);
 c.control({taskId:a.id,action:'resume'},'resume-review');assert.equal(c.getTask(a.id).status,'awaiting_review');assert.equal(c.claimNext('other'),null);
});
test('submission and commands are idempotent but changed content conflicts',t=>{
 const {c,g}=fixture(t);const a=c.submitTask({goalId:g.id,...task('a')},'add-a');
 assert.equal(c.submitTask({goalId:g.id,...task('a')},'add-a').id,a.id);
 assert.equal(c.submitTask({goalId:g.id,...task('a')},'same-submission').id,a.id);
 assert.throws(()=>c.submitTask({goalId:g.id,...task('a',{objective:'different'})},'add-a'),/idempotency|conflict/);
 assert.equal(c.getGoal(g.id).tasks.length,1);
});
test('dependency urgency inherits, FIFO ties, single global DeepSeek slot',t=>{
 const {c,g}=fixture(t);const a=c.submitTask({goalId:g.id,...task('a',{priority:'background'})},'a');
 const b=c.submitTask({goalId:g.id,...task('b')},'b');
 c.submitTask({goalId:g.id,...task('urgent',{priority:'blocking',dependsOn:[a.id]})},'u');
 assert.equal(c.claimNext('owner').id,a.id);assert.equal(c.claimNext('other'),null);
 c.completeTask(a.id,{report:'saved'},'owner');assert.equal(c.claimNext('owner').spec.submissionId,'urgent');
 assert.equal(c.getTask(b.id).status,'queued');
});
test('question frees slot, answer resumes same task and deadlines/counters',t=>{
 const {c,g}=fixture(t);const a=c.submitTask({goalId:g.id,...task('a')},'a');const b=c.submitTask({goalId:g.id,...task('b')},'b');
 const running=c.claimNext('owner');const r=c.reserve(a.id,{key:'model-1',kind:'model'},'owner');c.saveRequest(r.id,{question:'Which durability?'});
 c.ask(a.id,'Which durability guarantee?',{phase:'read'},'owner');assert.equal(c.claimNext('owner').id,b.id);
 c.answer({taskId:a.id,answer:'Survive process death',responder:'codex'},'answer');
 assert.equal(c.getTask(a.id).status,'queued');assert.equal(c.getTask(a.id).deadline,running.deadline);assert.equal(c.getTask(a.id).spent.model,1);
 assert.deepEqual(c.getTask(a.id).checkpoint,{phase:'read'});
});
test('DeepSeek-only questions require the user and never Codex fallback',t=>{
 const {c,g}=fixture(t,{mode:'deepseek_only'});const a=c.submitTask({goalId:g.id,...task('a')},'a');c.claimNext('o');c.ask(a.id,'Choose format',{},'o');
 assert.equal(c.getTask(a.id).status,'awaiting_user');
 assert.throws(()=>c.answer({taskId:a.id,answer:'Markdown',responder:'codex'},'bad'),/user|mode/);
 c.answer({taskId:a.id,answer:'Markdown',responder:'user'},'good');assert.equal(c.getTask(a.id).status,'queued');
});
test('reservation survives reopening; uncertain requests remain spent',t=>{
 const {c,root,g}=fixture(t);const a=c.submitTask({goalId:g.id,...task('a')},'a');c.claimNext('o');c.reserve(a.id,{key:'r1',kind:'model'},'o');
 const other=new Coordinator({root});t.after(()=>other.close());
 assert.equal(other.getTask(a.id).spent.model,1);
 assert.throws(()=>other.reserve(a.id,{key:'r1',kind:'model'},'o'),/ambiguous|uncertain/);
 assert.equal(other.getTask(a.id).spent.model,1);
});
test('saved results replay without new reservation and limits cannot reset',t=>{
 const {c,g}=fixture(t);const a=c.submitTask({goalId:g.id,...task('a',{limits:{modelCalls:1}})},'a');c.claimNext('o');
 const r=c.reserve(a.id,{key:'r1',kind:'model'},'o');c.saveRequest(r.id,{answer:'saved'});
 assert.equal(c.reserve(a.id,{key:'r1',kind:'model'},'o').cached,true);
 assert.throws(()=>c.reserve(a.id,{key:'r2',kind:'model'},'o'),/budget|limit/);
 assert.equal(c.getTask(a.id).spent.model,1);
});
test('urgent task requests safe yield; slot releases only on acknowledgement',t=>{
 const {c,g}=fixture(t);const a=c.submitTask({goalId:g.id,...task('background',{priority:'background'})},'a');c.claimNext('o');
 const urgent=c.submitTask({goalId:g.id,...task('urgent',{priority:'blocking'})},'u');
 assert.equal(c.getTask(a.id).yieldRequested,true);assert.equal(c.claimNext('other'),null);
 c.boundary(a.id,{phase:'saved',index:2},'o');assert.equal(c.getTask(a.id).status,'suspended');
 assert.equal(c.claimNext('o').id,urgent.id);c.completeTask(urgent.id,{report:'urgent'},'o');
 const resumed=c.claimNext('o');assert.equal(resumed.id,a.id);assert.equal(resumed.checkpoint.index,2);
});
test('stop prevents further dispatch; resume preserves deadline and expired goals stay expired',t=>{
 const {c,g,advance}=fixture(t);const a=c.submitTask({goalId:g.id,...task('a')},'a');const running=c.claimNext('o');
 c.control({goalId:g.id,action:'stop'},'stop');assert.equal(c.claimNext('other'),null);
 c.boundary(a.id,{phase:'saved'},'o');assert.equal(c.getTask(a.id).status,'stopped');
 c.control({goalId:g.id,action:'resume'},'resume');assert.equal(c.claimNext('o').deadline,running.deadline);
 c.control({goalId:g.id,action:'stop'},'stop-2');c.boundary(a.id,{},'o');advance(9*3600000);
 assert.throws(()=>c.control({goalId:g.id,action:'resume'},'late'),/deadline/);
});
test('unknown remote task ownership remains exclusive after supervisor reconnect',t=>{
 const {c,g}=fixture(t);const a=c.submitTask({goalId:g.id,...task('a')},'a');c.submitTask({goalId:g.id,...task('b')},'b');c.claimNext('old');
 c.markUncertain(a.id,'SSH lost','old');assert.equal(c.claimNext('new'),null);assert.equal(c.getTask(a.id).status,'uncertain');
 assert.throws(()=>c.control({taskId:a.id,action:'resume'},'resume'),/uncertain/i);
});
test('learning tasks share the task cap and are limited to one per goal',t=>{
 const {c,g}=fixture(t,{limits:{maxTasks:2}});c.submitTask({goalId:g.id,...task('a')},'a');
 c.submitTask({goalId:g.id,...task('learn',{kind:'learning'})},'l');
 assert.throws(()=>c.submitTask({goalId:g.id,...task('learn-again',{kind:'learning'})},'l2'),/limit|cap|learning/);
 assert.throws(()=>c.submitTask({goalId:g.id,...task('b')},'b'),/limit|cap/);
});
test('review-agent reservations count failed/unknown runs and enforce exclusivity',t=>{
 const {c,g}=fixture(t);const a=c.submitTask({goalId:g.id,...task('a')},'a');
 const r=c.reserveReviewer({taskId:a.id},'review-1');assert.throws(()=>c.reserveReviewer({taskId:a.id},'review-2'),/active|reviewer/);
 c.finishReviewer({reservationId:r.id,result:{decision:'revise',feedback:'Missing evidence'}},'finish-1');
 const next=c.reserveReviewer({taskId:a.id},'review-2');c.finishReviewer({reservationId:next.id,error:'interrupted'},'finish-2');
 assert.throws(()=>c.reserveReviewer({taskId:a.id},'review-3'),/budget|limit/);
});
test('reprioritization is scheduling metadata and does not rewrite approved task',t=>{
 const {c,g}=fixture(t);const a=c.submitTask({goalId:g.id,...task('a')},'a');
 c.setPriority({taskId:a.id,priority:'blocking',reason:'Main work needs this result'},'priority');
 const after=c.getTask(a.id);assert.equal(after.spec.priority,'normal');assert.equal(after.hash,a.hash);assert.equal(after.priority,'blocking');
});
test('worker lease rejects a live competitor and stale task owners cannot reserve',t=>{
 const {c,root,g}=fixture(t);c.acquireWorker('worker-one');
 const other=new Coordinator({root});t.after(()=>other.close());assert.throws(()=>other.acquireWorker('worker-two'),/worker|owner/);
 const a=c.submitTask({goalId:g.id,...task('a')},'a');c.claimNext('one');
 assert.throws(()=>other.reserve(a.id,{key:'evil',kind:'model'},'two'),/ownership/);
 c.releaseWorker('worker-one');assert.ok(other.acquireWorker('worker-two'));
});
test('native Codex text execution is recorded without a DeepSeek reservation',t=>{
 const {c,g}=fixture(t,{mode:'codex_only'}),a=c.submitTask({goalId:g.id,...task('explain',{kind:'consult'})},'a');
 c.startNativeText({taskId:a.id},'start');const done=c.finishNativeText({taskId:a.id,content:'Native explanation recorded by the supervisor.'},'finish');
 assert.equal(done.status,'accepted');assert.equal(done.spent.model,0);assert.equal(done.executionActor,'codex');
});
