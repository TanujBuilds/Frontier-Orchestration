import {randomUUID} from 'node:crypto';
import {ProjectFrontier} from '../project/providers.mjs';
import {keys,text,digest} from './contracts.mjs';
import {isOvernightV2} from './overnight.mjs';
import {git} from '../project/process.mjs';
import {matches} from '../project/contracts.mjs';

export class LegacyReview {
 constructor(worker){this.worker=worker;this.c=worker.c;this.inflight=null;}
 async tick(){
  if(this.inflight)return null;
  this.c.expireQuiescent();
  const task=this.c.store.all('task').find(t=>['awaiting_legacy_review','legacy_reviewing'].includes(t.status)&&this.c.eligible(t));if(!task)return null;
  const run=this.run(task);this.inflight=run;try{return await run;}finally{this.inflight=null;}
 }
 async referenceFiles(source,task){
  const paths=(await source.workspace.inventory()).map(f=>f.path).filter(file=>task.spec.role==='final'||!matches(file,task.spec.permissions.writePaths));
  if(paths.length>128)throw Error('Review reference context exceeds 128 files; inspect approved stage scope');
  return source.workspace.readFiles(paths);
 }
 async repairEvidence(input,key){return this.worker.integration.effect(key,{op:'review.evidence_repair',...input},async()=>{
  const {c}=this;let task=c.getTask(input.taskId);const g=c.store.get('goal',task.goalId);c.liveTask(task);text(input.reason,'evidence repair reason',2000);
  const old=c.store.maybe('review_evidence_repair',key);if(old){if(old.inputHash!==digest(input))throw Error('Evidence repair key conflict');return c.getTask(task.id);}
  if(!isOvernightV2(g.manifest)||g.integrationPending||task.owner||task.status!=='blocked'||task.legacyDecision?.decision!=='revise')throw Error('Evidence repair requires a quiescent blocked v2 candidate with a saved revise verdict');
  if(task.hash!==input.expectedTaskHash||digest(task.result)!==input.expectedResultHash)throw Error('Approved task or candidate result changed');
  if(task.checkpoint.legacyReviewKey||c.store.db.prepare("SELECT 1 FROM requests WHERE kind='codexReview' AND status='reserved'").get())throw Error('Uncertain review authority must be reconciled');
  if(task.reviews>=task.spec.limits.reviews||(c.store.spent(task.id).codexReview??0)>=task.spec.limits.reviews)throw Error('No remaining original review budget');
  if(!task.result?.checks?.length||!task.result.checks.every(r=>r.passed))throw Error('Saved passing candidate checks are required');
  const source=await this.worker.integration.candidate(task),unlock=await source.journal.lock();
  try{
   await source.workspace.recover();const snapshot=(await source.workspace.evidence()).snapshot;if(digest(snapshot)!==digest(task.result.snapshot))throw Error('Candidate changed after its passing check receipt; evidence-only retry cannot repair code');
   const references=await this.referenceFiles(source,task),runner=this.worker.integration.checks(source.workspace);await runner.verify();const checks=await runner.run(source.manifest.permissions.checks,'review-evidence-repair');if(!checks.every(r=>r.passed))throw Error('Candidate checks failed before evidence re-review');
   if(digest((await source.workspace.evidence()).snapshot)!==digest(snapshot))throw Error('Candidate changed during evidence re-review preparation');
   return c.store.tx(()=>{const current=c.liveTask(task);if(current.status!=='blocked'||current.owner||current.hash!==input.expectedTaskHash||digest(current.result)!==input.expectedResultHash||current.reviews!==task.reviews)throw Error('Candidate or review authority changed during evidence repair');
    c.store.put('review_evidence_repair',{id:key,taskId:task.id,goalId:g.id,inputHash:digest(input),snapshotHash:digest(snapshot),referenceFiles:references.map(({path,hash})=>({path,hash})),checks,at:c.now()});
    current.feedback.push({kind:'review_evidence_repair',text:input.reason,at:c.now(),snapshotHash:digest(snapshot)});current.status='awaiting_legacy_review';current.reason=null;c.store.put('task',current);c.emit('task.review_evidence_repaired',g.id,task.id,{key,snapshotHash:digest(snapshot),remainingReviews:current.spec.limits.reviews-current.reviews});return c.getTask(task.id);
   });
  }finally{await unlock();}
 });}
 async run(task){
  const {c}=this,g=c.store.get('goal',task.goalId);c.liveGoal(g);
  if(g.manifest.mode.review!=='legacy')throw Error('Mode prohibits background Codex review');
  const source=await this.worker.integration.candidate(task),unlock=await source.journal.lock();
  try{
   await source.workspace.recover();const runner=this.worker.integration.checks(source.workspace),sandbox=await runner.verify();
   const checks=await runner.run(source.manifest.permissions.checks,`legacy-${task.id}-${task.reviews}`);if(!checks.every(r=>r.passed))throw Error('Legacy review requires passing protected checks');
   const referenceFiles=isOvernightV2(g.manifest)?await this.referenceFiles(source,task):null;
   const reservation=c.store.tx(()=>{
    const current=c.liveTask(task);if(c.now()>=current.deadline)throw Error('Task deadline reached');
    if(current.checkpoint.legacyReviewKey)return c.store.request(task.id,current.checkpoint.legacyReviewKey);
    if(c.store.db.prepare("SELECT 1 FROM requests WHERE kind='codexReview' AND status='reserved'").get())throw Error('Another background review has uncertain ownership');
    if((c.store.spent(task.id).codexReview??0)>=current.spec.limits.reviews)throw Error('Legacy review budget exhausted');
    const id=randomUUID(),key=`legacy-review-${current.reviews+1}`;current.reviews++;current.status='legacy_reviewing';current.checkpoint.legacyReviewKey=key;c.store.put('task',current);
    c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(id,task.id,key,'codexReview','reserved',JSON.stringify({reservedAt:c.now()}));c.emit('legacy_review.reserved',g.id,task.id,{id,round:current.reviews});return {id,key,status:'reserved',fresh:true};
   });
   let result=reservation.result;
   if(reservation.status!=='completed'){
    if(!reservation.fresh)throw Error('Interrupted Codex review remains spent; operator reconciliation required');
    this.worker.reviewer??=new ProjectFrontier({command:this.worker.config.codexPath??'codex',timeoutMs:Math.min(300000,task.deadline-c.now())});
    const repo=g.manifest.project.repo,head=await git(repo,'rev-parse','HEAD'),status=await git(repo,'status','--porcelain'),sourceFixture={head,status,approvedBase:g.manifest.project.baseCommit,unchanged:head===g.manifest.project.baseCommit&&!status};
    if(!sourceFixture.unchanged)throw Error('Source fixture changed from its approved revision/status');
    const modelContext=source.journal.events.filter(e=>e.type==='harness.context'&&c.store.request(task.id,e.data.key)?.status==='completed').map(e=>e.data);
    const evidence={...await source.workspace.evidence(),checks,sandbox,sourceFixture,modelContext,...(referenceFiles?{referenceFiles}:{})};
    try{result=await this.worker.reviewer.reviewCode({brief:g.manifest.objective,approvedPlan:g.manifest.acceptance,stage:task.spec,assignment:task.spec,evidence},AbortSignal.timeout(Math.max(1,Math.min(300000,task.deadline-c.now()))));c.saveRequest(reservation.id,result);}
    catch(error){c.store.tx(()=>{const t=c.store.get('task',task.id);t.status='blocked';t.reason=error.message;t.checkpoint.legacyReviewKey=null;c.store.put('task',t);c.store.db.prepare("UPDATE requests SET status='failed' WHERE id=?").run(reservation.id);c.emit('legacy_review.failed',g.id,t.id,{id:reservation.id,reason:t.reason});});return c.getTask(task.id);}
   }
   keys(result,['decision','feedback','unverified'],'legacy review');text(result.feedback,'review feedback',12000);if(!['accept','revise','blocked'].includes(result.decision)||!Array.isArray(result.unverified))throw Error('Malformed legacy review');
   return c.store.tx(()=>{
    const t=c.store.get('task',task.id);t.legacyDecision=result;t.feedback.push({kind:'legacy_review',text:result.feedback,decision:result.decision,at:c.now()});t.checkpoint.legacyReviewKey=null;
    t.status=c.now()>=t.deadline?'partial':result.decision==='accept'?'ready_to_integrate':result.decision==='revise'&&t.reviews<t.spec.limits.reviews?'queued':'blocked';
    if(isOvernightV2(g.manifest)&&t.status==='blocked')t.reason=(result.decision==='blocked'?'Reviewer blocked stage: ':'Review revision budget exhausted: ')+result.feedback;
    if(t.status==='queued')t.checkpoint.phase='attempt';c.store.put('task',t);c.emit('task.legacy_reviewed',g.id,t.id,{decision:result.decision,unverified:result.unverified});return c.getTask(t.id);
   });
  }catch(error){if(!isOvernightV2(g.manifest))throw error;return c.store.tx(()=>{const t=c.store.get('task',task.id);t.status='blocked';t.reason=String(error.message).slice(0,2000);c.store.put('task',t);c.emit('task.blocked',g.id,t.id,{reason:t.reason});return c.getTask(t.id);});}finally{await unlock();}
 }
}
