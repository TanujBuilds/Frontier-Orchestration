import {randomUUID} from 'node:crypto';
import {ProjectFrontier} from '../project/providers.mjs';
import {keys,text} from './contracts.mjs';

export class LegacyReview {
 constructor(worker){this.worker=worker;this.c=worker.c;this.inflight=null;}
 async tick(){
  if(this.inflight)return null;
  const task=this.c.store.all('task').find(t=>['awaiting_legacy_review','legacy_reviewing'].includes(t.status));if(!task)return null;
  const run=this.run(task);this.inflight=run;try{return await run;}finally{this.inflight=null;}
 }
 async run(task){
  const {c}=this,g=c.store.get('goal',task.goalId);c.liveGoal(g);
  if(g.manifest.mode.review!=='legacy')throw Error('Mode prohibits background Codex review');
  const source=await this.worker.integration.candidate(task),unlock=await source.journal.lock();
  try{
   await source.workspace.recover();const runner=this.worker.integration.checks(source.workspace);await runner.verify();
   const checks=await runner.run(source.manifest.permissions.checks,`legacy-${task.id}-${task.reviews}`);if(!checks.every(r=>r.passed))throw Error('Legacy review requires passing protected checks');
   const reservation=c.store.tx(()=>{
    const current=c.store.get('task',task.id);c.liveGoal(c.store.get('goal',task.goalId));if(c.now()>=current.deadline)throw Error('Task deadline reached');
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
    const evidence={...await source.workspace.evidence(),checks};
    try{result=await this.worker.reviewer.reviewCode({brief:g.manifest.objective,approvedPlan:g.manifest.acceptance,stage:task.spec,assignment:task.spec,evidence},AbortSignal.timeout(Math.max(1,Math.min(300000,task.deadline-c.now()))));c.saveRequest(reservation.id,result);}
    catch(error){c.store.tx(()=>{const t=c.store.get('task',task.id);t.status='blocked';t.reason=error.message;t.checkpoint.legacyReviewKey=null;c.store.put('task',t);c.store.db.prepare("UPDATE requests SET status='failed' WHERE id=?").run(reservation.id);c.emit('legacy_review.failed',g.id,t.id,{id:reservation.id,reason:t.reason});});return c.getTask(task.id);}
   }
   keys(result,['decision','feedback','unverified'],'legacy review');text(result.feedback,'review feedback',12000);if(!['accept','revise','blocked'].includes(result.decision)||!Array.isArray(result.unverified))throw Error('Malformed legacy review');
   return c.store.tx(()=>{
    const t=c.store.get('task',task.id);t.legacyDecision=result;t.feedback.push({kind:'legacy_review',text:result.feedback,decision:result.decision,at:c.now()});t.checkpoint.legacyReviewKey=null;
    t.status=c.now()>=t.deadline?'partial':result.decision==='accept'?'ready_to_integrate':result.decision==='revise'&&t.reviews<t.spec.limits.reviews?'queued':'blocked';
    if(t.status==='queued')t.checkpoint.phase='attempt';c.store.put('task',t);c.emit('task.legacy_reviewed',g.id,t.id,{decision:result.decision,unverified:result.unverified});return c.getTask(t.id);
   });
  }finally{await unlock();}
 }
}
