import { git } from '../project/process.mjs';
import { digest,text } from './contracts.mjs';

// Supervised recovery only: never infer permission to discard unknown target edits.
export async function repairIntegration(i,input,key){
 const c=i.c;let t=c.getTask(input.taskId);text(input.reason,'repair reason');
 const prior=t.integrationFailures?.find(f=>f.repairKey===key);if(prior)return t;
 const g=c.store.get('goal',t.goalId);
 if(g.integrationPending?.taskId!==t.id||t.owner||t.native?.writerActive||t.goalVersion!==g.version)throw Error('Quiescent current task with pending integration required for repair');
 const candidate=await i.candidate(t),releaseCandidate=await candidate.journal.lock();
 try{
  const target=await i.lockedGoal(g.id,{refuseLegacy:true,integrationTaskId:t.id}),release=target.release;
  try{
   t=c.getTask(t.id);const goal=c.store.get('goal',g.id),pending=goal.integrationPending;
   if(pending?.taskId!==t.id||t.owner||t.native?.writerActive||t.goalVersion!==goal.version)throw Error('Integration repair ownership changed');
   const {journal,workspace}=target,importKey=pending.importKey;
   const intent=journal.events.findLast(e=>e.type==='integration.import.intent'&&e.data.key===importKey)?.data;
   const checked=journal.events.findLast(e=>e.type==='integration.checks'&&e.data.key===importKey)?.data;
   if(!intent||intent.candidateCommit!==pending.candidateCommit||!checked||checked.checks.every(check=>check.passed))throw Error('Saved failed integration check and exact import intent required');
   if(await git(workspace.root,'rev-parse','HEAD')!==intent.baseCommit)throw Error('Integration HEAD changed; repair refuses committed or external changes');
   if(await git(workspace.root,'diff','--cached','--name-only'))throw Error('Integration index changed outside pending import');
   const rollbackKey=`rollback-${importKey}`;
   let repair=journal.events.findLast(e=>e.type==='integration.repair.intent'&&e.data.key===rollbackKey)?.data;
   if(!repair){
    const snapshot=await workspace.snapshot();if(digest(snapshot)!==digest(checked.snapshot))throw Error('Failed target snapshot changed before repair');
    const edits=[];for(const change of intent.changes){const current=await workspace.content(change.path);if(current.hash!==change.afterHash)throw Error('Pending import preimage changed');edits.push({path:change.path,action:change.before.content===null?'delete':'write',content:change.before.content,baseHash:current.hash});}
    repair={key:rollbackKey,importKey,taskId:t.id,candidateCommit:pending.candidateCommit,reason:input.reason,failedSnapshot:snapshot,checks:checked.checks,edits,snapshotBefore:intent.snapshotBefore,baseCommit:intent.baseCommit};
    await journal.append('integration.repair.intent',repair);
   }
   await workspace.apply(rollbackKey,{writePaths:t.spec.permissions.writePaths},repair.edits);
   await workspace.assertSnapshot(intent.snapshotBefore);
   if(await git(workspace.root,'diff','HEAD','--name-only'))throw Error('Target differs from accepted committed base after inverse import');
   let receipt=journal.events.findLast(e=>e.type==='integration.repaired'&&e.data.key===rollbackKey)?.data;
   if(!receipt){receipt={key:rollbackKey,taskId:t.id,baseCommit:intent.baseCommit,failedSnapshotHash:digest(repair.failedSnapshot),restoredSnapshotHash:digest(intent.snapshotBefore),checks:repair.checks,reason:input.reason,snapshot:intent.snapshotBefore};await journal.append('integration.repaired',receipt);}
   return c.store.tx(()=>{
    const current=c.getTask(t.id),goal=c.store.get('goal',g.id);if(goal.integrationPending?.importKey!==importKey||current.owner||current.native?.writerActive)throw Error('Repair ownership changed before final save');
    current.integrationFailures??=[];current.integrationFailures.push({repairKey:key,importKey,candidateCommit:pending.candidateCommit,result:current.result,receipt,at:c.now()});
    current.feedback.push({kind:'integration_check',text:'Combined project checks failed. Correct this same assignment using the saved check evidence.',checks:repair.checks,at:c.now()});
    const exhausted=current.reviews>=current.spec.limits.reviews||current.attempts>=current.spec.limits.attempts||(c.store.spent(t.id).model??0)>=current.spec.limits.modelCalls;
    const controlled=goal.status!=='active'||current.pauseRequested||current.stopRequested||c.now()>=Math.min(goal.deadline,current.deadline??goal.deadline);
    current.status=exhausted||controlled?'blocked':current.native?.layout==='candidate_v1'?'codex_ready':'queued';current.reason=current.status==='blocked'?'Integration restored; original budget, deadline or control prevents correction':null;
    current.result=null;current.reviewed=false;current.legacyDecision=null;current.checkpoint={...current.checkpoint,phase:'attempt'};if(current.native)current.native.status='revision_requested';goal.integrationPending=null;
    c.store.put('task',current);c.store.put('goal',goal);c.emit('task.integration_repaired',g.id,t.id,{importKey,status:current.status,receipt});return c.getTask(t.id);
   });
  }finally{await release();}
 }finally{await releaseCandidate();}
}
