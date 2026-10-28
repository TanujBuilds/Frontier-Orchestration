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
test('research truncation is not applicable evidence for a coding batch recipe',t=>{
 const f=setup(t),source=f.c.submitTask({goalId:f.g.id,submissionId:'research',kind:'research',objective:'Research evidence',acceptance:['Citations']},'research');
 const seq=f.c.emit('attempt.protocol_failed',f.g.id,source.id,{reason:'Response truncated'}),outcome=f.learning.capture(source.id,seq);
 assert.throws(()=>f.learning.propose(f.maintenance.id,proposal(outcome),'wrong-capability'),/coding|applicable/);
});
test('native learning permits one proposal and one repair, including invalid proposals',t=>{
 const f=setup(t);
 // Use a separate approved goal so its one learning assignment is native.
 const g=f.makeGoal('native'),m=f.c.submitTask({goalId:g.id,submissionId:'native-learning',actor:'codex',kind:'learning',objective:'Distill batch lesson',acceptance:['Protected evaluation']},'native-learn');f.c.startNativeText({taskId:m.id},'native-start');
 assert.throws(()=>f.learning.propose(m.id,{...proposal(f.outcome),family:'shell-execution'},'native-bad'),/evaluator/);assert.equal(f.c.getTask(m.id).attempts,1);
 const lesson=f.learning.propose(m.id,proposal(f.outcome),'native-repair');assert.equal(f.c.getTask(m.id).attempts,2);assert.equal(f.learning.propose(m.id,proposal(f.outcome),'native-repair').id,lesson.id);
 assert.throws(()=>f.learning.propose(m.id,proposal(f.outcome),'native-third'),/proposal|attempt|repair/);
 f.learning.evaluate(lesson.id,'native-evaluate');f.learning.promote(lesson.id,'native-promote');const done=f.c.finishNativeText({taskId:m.id,content:'Protected regression and held-out replay passed'},'native-finish');assert.equal(done.status,'accepted');assert.equal(done.spent.model,0);assert.equal(done.attempts,2);
});
test('owner correction creates a separately evaluated candidate without editing the active lesson',t=>{
 const f=setup(t),a=f.learning.propose(f.maintenance.id,proposal(f.outcome),'a');f.learning.evaluate(a.id,'ea');f.learning.promote(a.id,'pa');
 const g=f.makeGoal('correction'),m=f.c.submitTask({goalId:g.id,submissionId:'learn',actor:'codex',kind:'learning',objective:'Correct the batch procedure',acceptance:['Protected evaluation']},'correction-task');f.c.startNativeText({taskId:m.id},'correction-start');
 const corrected=f.learning.correct(a.id,m.id,{maxFiles:1,maxBytes:20000},'Use a stricter size bound','correct');assert.equal(corrected.correctedFrom,a.id);assert.equal(corrected.status,'candidate');assert.equal(f.c.store.get('lesson',a.id).status,'active');assert.equal(f.c.store.get('lesson',a.id).recipe.maxBytes,24576);assert.equal(f.c.getTask(m.id).attempts,1);
 assert.equal(f.learning.correct(a.id,m.id,{maxFiles:1,maxBytes:20000},'Use a stricter size bound','correct').id,corrected.id);assert.throws(()=>f.learning.promote(corrected.id,'early'),/evaluation/);
});
test('a verified backoff correction promotes a bounded procedure after regression and held-out replay',t=>{
 const f=setup(t);f.c.store.tx(()=>{const task=f.c.store.get('task',f.source.id);task.feedback=[{decision:'revise',text:'Zero base times Infinity returns NaN for attempt1024; guard zero before exponent overflow'},{decision:'accept',text:'Corrected source independently checked'}];task.status='accepted';f.c.store.put('task',task);});
 const revised=f.c.emit('task.reviewed',f.g.id,f.source.id,{decision:'revise'}),accepted=f.c.emit('task.integrated',f.g.id,f.source.id,{commit:'a'.repeat(40),checks:[{id:'verify',passed:true}]}),evidence=[f.learning.capture(f.source.id,revised).id,f.learning.capture(f.source.id,accepted).id];
 const raw={family:'backoff_zero',scope:'project',parameters:{guardZeroBeforeExponent:true},evidence,rationale:'Preserve finite zero results when the exponential overflows'};
 const lesson=f.learning.propose(f.maintenance.id,raw,'backoff'),result=f.learning.evaluate(lesson.id,'eval-backoff');assert.equal(result.passed,true);assert.equal(result.cases.filter(c=>c.role==='heldout').length,2);assert.equal(result.candidate.failures,0);assert.ok(result.baseline.failures>0);f.learning.promote(lesson.id,'promote-backoff');
 const memory=f.learning.retrieve({goalId:f.g.id,query:'capped exponential backoff',capability:'coding'});assert.equal(memory[0].recipe.family,'backoff_zero');assert.match(memory[0].content,/zero|Infinity/);
 assert.throws(()=>f.learning.propose(f.maintenance.id,{...raw,evidence:[evidence[0]]},'no-correction'),/accepted|integration|correction/);
});
test('archive preserves evidence and rollback does not reactivate a quarantined predecessor',t=>{
 const f=setup(t),a=f.learning.propose(f.maintenance.id,proposal(f.outcome),'a');f.learning.evaluate(a.id,'ea');f.learning.promote(a.id,'pa');
 f.learning.quarantine(a.id,'Real regression','qa');
 const b=f.learning.propose(f.maintenance.id,proposal(f.outcome),'b');f.learning.evaluate(b.id,'eb');f.learning.promote(b.id,'pb');
 // A rollback may restore only previously superseded, eligible versions.
 f.c.store.tx(()=>{const record=f.c.store.get('lesson',b.id);record.previousIds=[a.id];f.c.store.put('lesson',record);});f.learning.rollback(b.id,'rollback-b');assert.equal(f.c.store.get('lesson',a.id).status,'quarantined');
 f.learning.archive(b.id,'Archived by owner','archive');assert.equal(f.c.store.get('lesson',b.id).status,'archived');assert.ok(f.c.store.get('lesson',b.id).evaluationId);
});
