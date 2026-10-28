import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Goals} from '../src/harness/goals.mjs';

function fixture(t){const root=mkdtempSync(path.join(os.tmpdir(),'harness-goals-')),c=new Coordinator({root});t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});const raw={submissionId:'g',objective:'Explain a queue',acceptance:['Useful answer']},g=c.prepareGoal(raw,'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');return {c,g,raw,goals:new Goals(c)};}
test('approved goal revision keeps original spending, identity and deadline',t=>{
 const f=fixture(t),a=f.c.submitTask({goalId:f.g.id,submissionId:'a',kind:'consult',objective:'Explain WAL',acceptance:['Answer']},'a');f.c.claimNext('o');const deadline=f.c.getTask(a.id).deadline,goalDeadline=f.c.getGoal(f.g.id).deadline;
 const r=f.c.reserve(a.id,{key:'model-1',kind:'model'},'o');f.c.saveRequest(r.id,{content:'Saved'});f.c.control({taskId:a.id,action:'stop'},'stop');f.c.boundary(a.id,{phase:'saved'},'o');
 const revision=f.goals.prepareRevision({goalId:f.g.id,expectedHash:f.g.hash,manifest:{...f.raw,objective:'Explain queue tradeoffs'}},'revise');assert.throws(()=>f.goals.activateRevision({revisionId:revision.id,hash:'wrong'},'wrong'),/hash/);
 f.goals.activateRevision({revisionId:revision.id,hash:revision.hash},'approve-version');const rebound=f.goals.rebind({taskId:a.id},'rebind');assert.equal(rebound.id,a.id);assert.equal(rebound.deadline,deadline);assert.equal(rebound.spent.model,1);assert.equal(rebound.goalVersion,2);assert.equal(f.c.getGoal(f.g.id).deadline,goalDeadline);
 assert.equal(f.c.store.get('goal_history',`${f.g.id}-1`).goalId,f.g.id);
});
test('goal changes cannot activate over a live owner or create dependency cycles on rebind',t=>{
 const f=fixture(t),a=f.c.submitTask({goalId:f.g.id,submissionId:'a',kind:'consult',objective:'A',acceptance:['A']},'a');const b=f.c.submitTask({goalId:f.g.id,submissionId:'b',kind:'consult',objective:'B',acceptance:['B'],dependsOn:[a.id]},'b');
 const revision=f.goals.prepareRevision({goalId:f.g.id,expectedHash:f.g.hash,manifest:{...f.raw,objective:'Explain two queue designs'}},'revise');f.c.claimNext('o');assert.throws(()=>f.goals.activateRevision({revisionId:revision.id,hash:revision.hash},'approve'),/owner|quiescen/);
 f.c.control({taskId:a.id,action:'stop'},'stop');f.c.boundary(a.id,{},'o');f.goals.activateRevision({revisionId:revision.id,hash:revision.hash},'approve');
 assert.throws(()=>f.goals.rebind({taskId:a.id,spec:{...a.spec,dependsOn:[b.id]}},'cycle'),/cycle/);
});
test('finalization requires accepted work and produces an immutable idempotent receipt',t=>{
 const f=fixture(t),a=f.c.submitTask({goalId:f.g.id,submissionId:'a',kind:'consult',objective:'A',acceptance:['A']},'a');assert.throws(()=>f.goals.finalize({goalId:f.g.id,summary:'Done'},'finish'),/unfinished|accepted/);
 f.c.claimNext('o');const reservation=f.c.reserve(a.id,{key:'r',kind:'model'},'o');f.c.saveRequest(reservation.id,{content:'Answer'});f.c.completeTask(a.id,{content:'Answer'},'o');
 const done=f.goals.finalize({goalId:f.g.id,summary:'Evidence reviewed'},'finish');assert.equal(done.status,'completed');assert.equal(done.receipt.spending.model,1);assert.ok(done.receiptHash);assert.deepEqual(f.goals.finalize({goalId:f.g.id,summary:'Evidence reviewed'},'finish'),done);
 assert.throws(()=>f.c.control({goalId:f.g.id,action:'resume'},'restart'),/terminal/);
});
