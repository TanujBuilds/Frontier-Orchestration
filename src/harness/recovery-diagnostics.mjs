import {closeSync,constants,fstatSync,openSync,readSync} from 'node:fs';
import path from 'node:path';

const blockerEvents = {
 'task.provider_wait':['implementation','Known provider unavailability; original request remains spent'],
 'task.question':['waiting-answer','An owner answer is required'],
 'task.uncertain':['blocked','Execution outcome requires reconciliation'],
 'task.blocked':['blocked','Saved execution needs attention'],
 'task.expired':['expired','Original task deadline reached'],
 'planning.provider_wait':['planning','Known planner provider unavailability; original request remains spent'],
 'planning.uncertain':['blocked','Planning outcome requires reconciliation'],
 'planning.blocked':['blocked','Saved planning needs attention'],
 'legacy_review.failed':['blocked','Independent review failed'],
 'task.legacy_reviewed':['blocked','Independent reviewer blocked the stage'],
};
const evidenceEvents = {
 'task.integrated':'stage_integrated',
 'task.result':'result_saved',
 'coding.checks.passed':'checks_saved',
 'coding.checks.failed':'checks_saved',
 'coding.edit.applied':'edits_saved',
 'request.saved':'response_saved',
};
const placeholders=entries=>Object.keys(entries).map(()=>'?').join(',');
const next=(instruction,tool=null)=>({instruction,tool});

export function firstRecoveryBlocker(store,goal,tasks,planning,state,previous,after,through,now){
 if(previous)return previous;
 // Row order breaks timestamp ties and also retains answered questions and resolved failures.
 const event=after<through?store.db.prepare(`
  SELECT seq,at,task_id,type,json_extract(data,'$.reason') AS reason,json_extract(data,'$.id') AS question_id
  FROM events WHERE seq>? AND seq<=? AND goal_id=? AND type IN (${placeholders(blockerEvents)})
  AND (type!='task.legacy_reviewed' OR json_extract(data,'$.decision')='blocked')
  ORDER BY seq LIMIT 1`).get(after,through,goal.id,...Object.keys(blockerEvents)):null;
 const candidates=[];
 if(event){
  const [phase,fallback]=blockerEvents[event.type];
  const reviewFeedback=event.type==='task.legacy_reviewed'
   ?tasks.find(task=>task.id===event.task_id)?.feedback?.findLast(entry=>entry.kind==='legacy_review'&&entry.decision==='blocked'&&entry.at<=event.at)?.text
   :null;
  candidates.push({at:event.at,taskId:event.task_id,phase,reason:event.reason??reviewFeedback??fallback,
   ...(event.type==='task.question'?{questionId:event.question_id}:{}),eventSeq:event.seq});
 }
 for(const task of tasks)if(task.firstBlocker)candidates.push({taskId:task.id,phase:'blocked',...task.firstBlocker});
 // Older planner records retain the first outage time without an event.
 if(planning?.reconnectStartedAt!=null)candidates.push({at:planning.reconnectStartedAt,taskId:null,phase:'planning',
  reason:blockerEvents['planning.provider_wait'][1]});
 if(state.reason&&['blocked','waiting-answer','expired','provider_unavailable'].some(value=>value===state.phase||value===state.code)){
  candidates.push({at:state.deadline??state.providerWait?.startedAt??now,taskId:state.taskId,phase:state.phase,reason:state.reason});
 }
 return candidates.sort((a,b)=>(a.at??Infinity)-(b.at??Infinity))[0]??null;
}

function unresolvedRequest(store,taskId){
 return store.db.prepare(`
  SELECT id,kind FROM requests WHERE task_id=? AND kind IN ('model','codexReview')
  AND (status='reserved' OR (status='failed' AND COALESCE(json_extract(data,'$.requestOutcome'),'unknown')='unknown'))
  ORDER BY rowid DESC LIMIT 1`).get(taskId);
}

export function recoveryDetails(store,goal,tasks,planning,state){
 const uncertain=tasks.find(task=>task.status==='uncertain');
 const interruptedReview=tasks.find(task=>task.checkpoint?.legacyReviewKey&&
  (['blocked','partial'].includes(task.status)||state.phase==='expired'&&task.status==='legacy_reviewing'));
 const unknown=uncertain?unresolvedRequest(store,uncertain.id):planning?.status==='uncertain'&&!planning.recoveryPending?unresolvedRequest(store,goal.id)
  :interruptedReview?unresolvedRequest(store,interruptedReview.id):null;
 const code=unknown&&['execution_uncertain','blocked'].includes(state.code)?'request_outcome_unknown':state.code;
 const task=tasks.find(task=>task.id===state.taskId);
 const outcome=unknown?'unknown':state.providerWait?'not_dispatched':null;
 const details={code,taskId:state.taskId,reason:state.reason??null,outcome,deadline:state.deadline??task?.deadline??goal.deadline,
  ...(unknown?{requestId:unknown.id,requestKind:unknown.kind}:state.providerWait?.requestId?{requestId:state.providerWait.requestId,requestKind:'model'}:{}),
  ...(state.providerWait?{reconnectUntil:state.providerWait.until}:{})};
 switch(code){
  case 'provider_unavailable':
   details.nextStep=next('Restore provider availability and allow automatic reconnect within the saved reconnect window and remaining limits.');
   break;
  case 'provider_reconnect_expired':
  case 'provider_budget_exhausted':
   details.nextStep=next('Inspect the retained work and separately authorize a new goal with its own scope and limits if work should continue.','goal_prepare');
   break;
  case 'goal_deadline_expired':
  case 'task_deadline_expired':
   details.nextStep=next((unknown?'Reconcile the original spent request with its backend. ':'')+
    'If work should continue, separately authorize a new goal with a fresh window using the retained evidence.','goal_prepare');
   break;
  case 'execution_uncertain':
  case 'request_outcome_unknown':
   details.nextStep=next('Inspect the saved task or planner record and reconcile the original operation with its backend. Automatic continuation requires verified quiescence and a recoverable saved boundary.',task?'task_get':'goal_get');
   break;
  case 'owner_answer_required':
   details.questionId=task?.questions?.at(-1)?.id??null;
   details.nextStep=next('Review the saved question and submit the owner’s answer for this task within its original deadline.','question_answer');
   break;
  case 'integration_pending':
   details.nextStep=next('Inspect the pending import and protected checks. For a verified failed import, inspect eligibility for supervised repair with task_integration_repair within the original limits.','task_get');
   break;
  case 'paused':
  case 'stopped':
   details.nextStep=next('Resume explicitly within the original deadline and remaining limits.','work_control');
   break;
  case 'preparation':
   details.nextStep=next('Complete matching preflight and obtain exact owner authorization before activation.','overnight_preflight');
   break;
  case 'completed':
   details.nextStep=next('Accepted result; no continuation required.');
   break;
  case 'blocked':
   details.nextStep=next('Inspect the saved blocker and retained evidence to determine whether the existing authorization permits a repair.',task?'task_get':'goal_get');
   break;
  default:
   details.nextStep=next('Service continues independently inside the original authorization. Observation may end without stopping execution.');
 }
 return details;
}

// The authoritative receipt can precede the optional activity event. Inspect only
// the exact saved apply/check boundary and cap the read even for large journals.
const journalTailBytes=256*1024;
function journalCheckpoint(root,task){
 const {id,checkpoint:cp}=task;
 if(task.spec.kind!=='coding'||!['apply','checks'].includes(cp?.phase)||!Number.isInteger(cp.attempt)||!/^[a-f0-9-]{36}$/.test(id))return null;
 const journalRoot=path.join(root,'coding');
 const applying=cp.phase==='apply';
 const type=applying?'edits.applied':'operation.completed';
 const key=applying?`${id}/attempt-${cp.attempt}/batch-${cp.batch}`:`harness-attempt-${cp.attempt}/checks`;
 let file;
 try{
  file=openSync(path.join(journalRoot,'jobs',id+'.jsonl'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const stat=fstatSync(file);
  if(!stat.isFile())return null;
  const offset=Math.max(0,stat.size-journalTailBytes),bytes=Buffer.alloc(stat.size-offset);
  const read=readSync(file,bytes,0,bytes.length,offset);
  const tail=bytes.toString('utf8',0,read).split('\n');
  if(offset)tail.shift();
  tail.pop(); // The journal treats an unterminated last line as incomplete.
  for(const line of tail.reverse()){
   let event;
   try{event=JSON.parse(line);}catch{continue;}
   if(event?.jobId!==id||event.type!==type||event.data?.key!==key||!Number.isInteger(event.sequence))continue;
   if(!applying&&(!Array.isArray(event.data.value)||event.data.value.some(check=>typeof check?.id!=='string'||typeof check.passed!=='boolean')))continue;
   const result={
    kind:applying?'edits_saved':'checks_saved',source:'journal',journalSequence:event.sequence,
    journalRoot,candidateWorktree:path.join(journalRoot,'artifacts',id,'worktree'),
   };
   if(!applying)result.checks=event.data.value.map(({id,passed})=>({id,passed}));
   return result;
  }
 }catch{/* An unreadable tail cannot establish a verified checkpoint. */}
 finally{if(file!==undefined)closeSync(file);}
 return null;
}

export function retainedProgress(store,goal,tasks){
 const latest=store.db.prepare(`
  SELECT seq,at,type,
   CASE WHEN type='coding.edit.applied' THEN json_extract(data,'$.requestId')
    WHEN type='request.saved' THEN json_extract(data,'$.id') END AS request_id,
   CASE WHEN type IN ('coding.checks.passed','coding.checks.failed') THEN json_extract(data,'$.checks') END AS checks,
   CASE WHEN type='coding.edit.applied' THEN json_extract(data,'$.paths') END AS paths
  FROM events WHERE task_id=? AND type!='model.output' AND type IN (${placeholders(evidenceEvents)})
  AND (type!='coding.checks.failed' OR json_type(data,'$.checks')='array')
  ORDER BY seq DESC LIMIT 1`);
 const byTask=new Map();
 for(const task of tasks){
  const event=latest.get(task.id,...Object.keys(evidenceEvents)),cp=task.checkpoint;
  const commit=task.integration?.commit;
  const identity={taskId:task.id,eventSeq:event?.seq??null};
  const receipt=commit||task.result?.checks?.length?null:journalCheckpoint(store.root,task);
  if(commit)byTask.set(task.id,{...identity,kind:'stage_integrated',commit});
  else if(receipt)byTask.set(task.id,{...identity,...receipt,attempt:cp.attempt,batch:cp.batch??null});
  else if(event)byTask.set(task.id,{...identity,kind:evidenceEvents[event.type],at:event.at,requestId:event.request_id??null,
   ...(event.checks?{checks:JSON.parse(event.checks)}:{}),
   ...(event.paths?{paths:JSON.parse(event.paths)}:{})});
  else if(task.result)byTask.set(task.id,{...identity,kind:'result_saved'});
  else if(cp?.phase)byTask.set(task.id,{...identity,kind:'checkpoint_saved',phase:cp.phase,attempt:cp.attempt??null,exchange:cp.exchange??null,batch:cp.batch??null});
 }
 const plan=store.db.prepare(`
  SELECT id,json_extract(data,'$.savedAt') AS at FROM requests
  WHERE task_id=? AND kind='model' AND status='completed' ORDER BY rowid DESC LIMIT 1`).get(goal.id);
 const lastVerifiedCheckpoint=[...byTask.values()].reduce((latest,checkpoint)=>
  !latest||(checkpoint.eventSeq??0)>=(latest.eventSeq??0)?checkpoint:latest,
  plan?{taskId:null,kind:'response_saved',requestId:plan.id,at:plan.at}:null);
 return {byTask,summary:{lastVerifiedCheckpoint,
  integratedStages:tasks.filter(task=>task.status==='accepted'&&task.integration?.commit).map(task=>({taskId:task.id,commit:task.integration.commit}))}};
}
