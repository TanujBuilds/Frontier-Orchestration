import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Learning} from '../src/harness/learning.mjs';

function setup(t){
 const root=mkdtempSync(path.join(os.tmpdir(),'harness-learning-')),c=new Coordinator({root});t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 const makeGoal=(id,repo='/tmp/fixture-project')=>{const g=c.prepareGoal({submissionId:id,objective:'Improve bounded coding',acceptance:['Protected checks pass'],environment:'fixture',project:{repo,baseCommit:'a'.repeat(40),readPaths:['src/'],writePaths:['src/'],checks:[{id:'verify',argv:['node','checks/verify.mjs']}]}},'prepare-'+id);c.activateGoal({goalId:g.id,hash:g.hash},'activate-'+id);return g;};
 const g=makeGoal('a'),source=c.submitTask({goalId:g.id,submissionId:'source',kind:'coding',objective:'Implement two files',acceptance:['Pass']},'source');
 const seq=c.emit('attempt.protocol_failed',g.id,source.id,{reason:'Response truncated; smaller edits required'});
 const learning=new Learning({c}),outcome=learning.capture(source.id,seq);
 const maintenance=c.submitTask({goalId:g.id,submissionId:'learn',kind:'learning',objective:'Distill response-size lesson',acceptance:['Protected evaluation passes']},'learn');
 return {c,g,source,maintenance,learning,outcome,makeGoal};
}
const proposal=(outcome,extra={})=>({family:'edit_batch',scope:'project',parameters:{maxFiles:1,maxBytes:24576},evidence:[outcome.id],rationale:'Smaller edit batches avoid truncation',...extra});
test('candidate must cite real trusted outcomes; model-supplied certifications are rejected',t=>{
 const f=setup(t);assert.throws(()=>f.learning.propose(f.maintenance.id,proposal({id:'invented'}),'bad'),/evidence|outcome/);
 assert.throws(()=>f.learning.propose(f.maintenance.id,{...proposal(f.outcome),passed:true},'fake'),/unknown|certif/);
 const candidate=f.learning.propose(f.maintenance.id,proposal(f.outcome),'candidate');assert.equal(candidate.status,'candidate');
 assert.throws(()=>f.learning.promote(candidate.id,'early'),/evaluat/);
});
test('protected regression and two held-out cases enable evidence-backed promotion',t=>{
 const f=setup(t),candidate=f.learning.propose(f.maintenance.id,proposal(f.outcome),'candidate');
 const evaluation=f.learning.evaluate(candidate.id,'evaluate');assert.equal(evaluation.passed,true);assert.equal(evaluation.cases.length,3);assert.ok(evaluation.baseline.failures>evaluation.candidate.failures);
 const active=f.learning.promote(candidate.id,'promote');assert.equal(active.status,'active');assert.ok(active.recipeHash);
 assert.equal(f.learning.promote(candidate.id,'promote').id,active.id);
});
test('bad procedure cannot weaken check requirements or pass its own evaluation',t=>{
 const f=setup(t);assert.throws(()=>f.learning.propose(f.maintenance.id,proposal(f.outcome,{parameters:{maxFiles:1,maxBytes:24576,skipChecks:true}}),'bypass'),/unknown/);
 const candidate=f.learning.propose(f.maintenance.id,proposal(f.outcome,{parameters:{maxFiles:1,maxBytes:100}}),'small');
 assert.equal(f.learning.evaluate(candidate.id,'evaluate').passed,false);assert.throws(()=>f.learning.promote(candidate.id,'promote'),/evaluat/);
});
test('retrieval isolates projects, bounds size and rejects stale applicability',t=>{
 const f=setup(t),candidate=f.learning.propose(f.maintenance.id,proposal(f.outcome),'candidate');f.learning.evaluate(candidate.id,'evaluate');f.learning.promote(candidate.id,'promote');
 const context=f.learning.retrieve({goalId:f.g.id,query:'coding edits truncation',capability:'coding'});assert.equal(context.length,1);assert.ok(Buffer.byteLength(JSON.stringify(context))<=8192);
 const other=f.makeGoal('other','/tmp/other-project');assert.equal(f.learning.retrieve({goalId:other.id,query:'coding edits',capability:'coding'}).length,0);
 assert.equal(f.learning.retrieve({goalId:f.g.id,query:'coding edits',capability:'coding',environment:'changed'}).length,0);
});
test('general lessons render only safe generic recipe text and rollback removes future use',t=>{
 const f=setup(t),candidate=f.learning.propose(f.maintenance.id,proposal(f.outcome,{scope:'general',rationale:'secret project /private/work and hidden company'}),'candidate');
 assert.doesNotMatch(candidate.content,/secret|private\/work|hidden company/);f.learning.evaluate(candidate.id,'evaluate');f.learning.promote(candidate.id,'promote');
 const other=f.makeGoal('other','/tmp/other-project');assert.equal(f.learning.retrieve({goalId:other.id,query:'coding edits',capability:'coding'}).length,1);
 f.learning.rollback(candidate.id,'rollback');assert.equal(f.learning.retrieve({goalId:f.g.id,query:'coding edits',capability:'coding'}).length,0);
});
test('pinned memory stays fixed when a procedure is quarantined',t=>{
 const f=setup(t),candidate=f.learning.propose(f.maintenance.id,proposal(f.outcome),'candidate');f.learning.evaluate(candidate.id,'evaluate');f.learning.promote(candidate.id,'promote');
 const pinned=f.learning.pin(f.source.id);assert.equal(pinned.length,1);f.learning.quarantine(candidate.id,'Observed regression','quarantine');
 assert.equal(f.learning.pin(f.source.id)[0].recipeHash,pinned[0].recipeHash);
 const next=f.c.submitTask({goalId:f.g.id,submissionId:'next',kind:'coding',objective:'Implement code',acceptance:['Pass']},'next');assert.equal(f.learning.pin(next.id).length,0);
});
test('expired maintenance cannot evaluate or promote and counters remain spent',t=>{
 const f=setup(t),candidate=f.learning.propose(f.maintenance.id,proposal(f.outcome),'candidate');
 const running=f.c.claimNext('o');f.c.ask(running.id,'Pause source',{},'o');
 f.c.claimNext('o');const reservation=f.c.reserve(f.maintenance.id,{key:'learn-1',kind:'model'},'o');f.c.saveRequest(reservation.id,{content:'proposal'});
 const original=f.c.getTask(f.maintenance.id).deadline;f.c.now=()=>original+1;
 assert.throws(()=>f.learning.evaluate(candidate.id,'late-evaluate'),/deadline|expired/);
 assert.equal(f.c.getTask(f.maintenance.id).spent.model,1);assert.equal(f.c.getTask(f.maintenance.id).deadline,original);
});
test('a demonstrated recurrence quarantines the pinned procedure for future assignments',t=>{
 const f=setup(t),candidate=f.learning.propose(f.maintenance.id,proposal(f.outcome),'candidate');f.learning.evaluate(candidate.id,'evaluate');f.learning.promote(candidate.id,'promote');
 f.learning.pin(f.source.id);f.c.emit('attempt.protocol_failed',f.g.id,f.source.id,{reason:'Response truncated; submit smaller edits'});
 assert.equal(f.c.store.get('lesson',candidate.id).status,'quarantined');
 assert.equal(f.learning.retrieve({goalId:f.g.id,query:'coding edits',capability:'coding'}).length,0);
 assert.equal(f.learning.pin(f.source.id)[0].id,candidate.id);
});
test('only observed batch failures can propose a batch lesson and learning cannot be urgent',t=>{
 const f=setup(t);const seq=f.c.emit('checks.failed',f.g.id,f.source.id,{reason:'Incorrect numeric result'});const other=f.learning.capture(f.source.id,seq);
 assert.throws(()=>f.learning.propose(f.maintenance.id,proposal(other),'unrelated'),/batch|truncation|applicable/);
 const g=f.makeGoal('b');assert.throws(()=>f.c.submitTask({goalId:g.id,submissionId:'urgent-learn',kind:'learning',priority:'blocking',objective:'Learn',acceptance:['Measured']},'urgent-learn'),/background|priority/);
});
