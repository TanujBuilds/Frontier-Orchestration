// Explicit trusted local state, inspected without Store/Coordinator side effects.
import {DatabaseSync} from 'node:sqlite';
import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {digest,normalizeResearchPolicy} from './contracts.mjs';
import {verifyLocalAcceptance,verifyReviewedReceipt,verifyAcceptedArtifacts} from './research-review.mjs';
const MAX_ROW=1024*1024;
export class ReleaseAuthorityError extends Error {constructor(code){super(code);this.code=code;}}
const need=(ok,code)=>{if(!ok)throw new ReleaseAuthorityError(code);};
const same=(a,b)=>a!==undefined&&b!==undefined&&digest(a)===digest(b);
const pending=reason=>({status:'pending',reason,runtimeAttested:false});
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v);
const time=v=>Number.isSafeInteger(v)&&v>0;
/** Validate the operator selector even when the database has not been created. */
export async function researchAuthorityPath(stateRoot){
 need(typeof stateRoot==='string'&&stateRoot.length<4096&&path.isAbsolute(stateRoot)&&!/[\x00-\x1f\x7f\\]/.test(stateRoot)&&!stateRoot.split('/').includes('..'),'unsafe_authority_path');
 let root=path.resolve(stateRoot);if(process.platform==='darwin')root=root.replace(/^\/var(?=\/|$)/,'/private/var').replace(/^\/tmp(?=\/|$)/,'/private/tmp');
 let current=path.parse(root).root,missing=false;
 for(const part of root.split(path.sep).filter(Boolean)){
  current=path.join(current,part);if(missing)continue;let st;try{st=await lstat(current);}catch(e){if(e.code==='ENOENT'){missing=true;continue;}throw new ReleaseAuthorityError('authority_path_unavailable');}
  need(!st.isSymbolicLink()&&st.isDirectory(),'unsafe_authority_path');
 }
 if(!missing)need(await realpath(root)===root,'unsafe_authority_path');
 const database=path.join(root,'harness.sqlite3');let exists=!missing;
 if(!missing){try{const st=await lstat(database);need(st.isFile()&&!st.isSymbolicLink(),'unsafe_authority_database');}catch(e){if(e.code==='ENOENT')exists=false;else throw e;}
  for(const suffix of ['-wal','-shm','-journal']){try{const st=await lstat(database+suffix);need(st.isFile()&&!st.isSymbolicLink(),'unsafe_authority_sidecar');}catch(e){if(e.code!=='ENOENT')throw e;}}
 }
 return {root,database,exists};
}
/** A fresh coherent snapshot, never an export or executable-runtime attestation.
 * Returns bounded public metadata. No database-provided path is opened.
 */
export async function readResearchAuthority({stateRoot,taskId,receipt,policy,reportBytes,sourceBytes}){
 need(id(taskId),'invalid_authority_task_id');try{normalizeResearchPolicy(policy);}catch{throw new ReleaseAuthorityError('invalid_authority_policy');}need(policy.version===3,'incompatible_authority_policy');
 const selected=await researchAuthorityPath(stateRoot);if(!selected.exists)return pending('authority_state_unavailable');
 let db,transaction=false;
 try{
  db=new DatabaseSync(selected.database,{readOnly:true});db.exec('PRAGMA busy_timeout=1000; BEGIN');transaction=true;
  need(db.prepare('PRAGMA user_version').get().user_version===1,'unsupported_authority_schema');
  need(db.prepare("SELECT type FROM sqlite_schema WHERE name='records'").get()?.type==='table','unsupported_authority_table');
  const columns=db.prepare('PRAGMA table_info(records)').all();need(columns.length===3&&columns.every((c,i)=>c.name===['kind','id','data'][i]&&c.type==='TEXT'&&c.notnull===1&&c.pk===[1,2,0][i]),'unsupported_authority_table');
  const statement=db.prepare('SELECT length(CAST(data AS BLOB)) AS bytes, CASE WHEN length(CAST(data AS BLOB))<=? THEN data ELSE NULL END AS data FROM records WHERE kind=? AND id=?');
  const load=(kind,key)=>{
   need(id(key),'invalid_authority_record_id');const row=statement.get(MAX_ROW,kind,key);if(!row)return null;
   need(Number.isSafeInteger(row.bytes)&&row.bytes<=MAX_ROW&&typeof row.data==='string','authority_row_too_large');
   let value;try{value=JSON.parse(row.data);}catch{throw new ReleaseAuthorityError('malformed_authority_row');}
   need(value&&typeof value==='object'&&!Array.isArray(value)&&value.id===key,'malformed_authority_record');return value;
  };
  // Ancillary exact-key metadata only: never decode an extra full goal row.
  // The size CASE runs before SQLite JSON extraction as well as JS decoding.
  const project=db.prepare(`SELECT length(CAST(data AS BLOB)) AS bytes,
   CASE WHEN length(CAST(data AS BLOB))<=? THEN CASE WHEN json_valid(data)
    THEN json_array(json_extract(data,'$.id'),json_extract(data,'$.goalId'),json_extract(data,'$.version'),json_extract(data,'$.activatedAt'),json_extract(data,'$.deadline')) END END AS metadata
   FROM records WHERE kind=? AND id=?`);
  const metadata=(kind,key)=>{
   need(id(key),'invalid_authority_record_id');const row=project.get(MAX_ROW,kind,key);if(!row)return null;
   need(Number.isSafeInteger(row.bytes)&&row.bytes<=MAX_ROW,'authority_row_too_large');
   need(typeof row.metadata==='string','malformed_authority_row');const [recordId,goalId,version,activatedAt,deadline]=JSON.parse(row.metadata);
   need(recordId===key&&Number.isSafeInteger(version)&&version>=1,'malformed_authority_record');return {goalId,version,activatedAt,deadline};
  };
  const task=load('task',taskId);if(!task)return pending('authority_task_missing');
  need(task.spec?.kind==='research'&&task.spec.actor==='deepseek'&&same(task.spec.researchPolicy,policy)&&task.hash===digest(task.spec),'authority_task_binding_mismatch');
  const current=metadata('goal',task.goalId);if(!current)return pending('authority_goal_missing');
  need(Number.isSafeInteger(task.goalVersion)&&task.goalVersion>=1&&task.goalVersion<=current.version,'authority_goal_version_mismatch');
  const historical=task.goalVersion<current.version;
  const goal=load(historical?'goal_history':'goal',historical?`${task.goalId}-${task.goalVersion}`:task.goalId);
  if(!goal)return pending('authority_goal_history_missing');
  need(!historical||goal.goalId===task.goalId,'authority_goal_history_mismatch');
  let approvedDeadline=goal.activatedAt+goal.manifest?.limits?.hours*3600000;
  if(goal.version>1){
   const previous=metadata('goal_history',`${task.goalId}-${goal.version-1}`);if(!previous)return pending('authority_goal_predecessor_missing');
   need(previous.goalId===task.goalId&&previous.version===goal.version-1&&previous.activatedAt===goal.activatedAt&&time(previous.deadline)&&previous.deadline>previous.activatedAt,'authority_goal_predecessor_mismatch');
   approvedDeadline=Math.min(previous.deadline,approvedDeadline);
  }
  need(goal.manifest?.schema===1&&goal.manifest.mode?.id==='collaborative'&&goal.manifest.mode.review==='operator'&&goal.manifest.mode.actors?.includes('deepseek')&&goal.manifest.mode.actors?.includes('codex')&&goal.manifest.mode.capabilities?.includes('research')&&goal.manifest.capabilities?.some(c=>c.id==='research'&&c.version===4&&c.actors?.includes('deepseek'))&&same(goal.manifest.researchPolicy,policy)&&goal.hash===digest(goal.manifest)&&Number.isSafeInteger(goal.version)&&goal.version>=1&&task.goalVersion===goal.version,'authority_goal_binding_mismatch');
  need(['active','paused','stopped','completed','partial'].includes(goal.status)&&time(goal.activatedAt)&&time(goal.deadline)&&goal.deadline>goal.activatedAt&&goal.deadline===approvedDeadline&&time(task.createdAt)&&task.createdAt>=goal.activatedAt&&time(task.startedAt)&&task.startedAt>=task.createdAt&&time(task.deadline)&&task.deadline===Math.min(goal.deadline,task.startedAt+task.spec.limits?.seconds*1000),'authority_approval_deadline_mismatch');
  const environment=goal.manifest.environment;
  need(['live','fixture'].includes(environment)&&task.checkpoint?.manifest?.mode===environment&&receipt?.mode===environment,'authority_environment_mismatch');
  need(task.status==='accepted'&&task.owner===null&&!task.pauseRequested&&!task.stopRequested&&!task.yieldRequested&&!task.checkpoint.remotePaused&&(!task.executionActor||task.executionActor==='deepseek'),'authority_task_not_terminal_accepted');
  const result=task.result;
  need(result&&result.receiptStatus==='completed'&&result.checksumsVerified===true&&result.independentReview==='accepted'&&result.remoteJobId===task.checkpoint.remoteJobId,'authority_result_mismatch');
  const a=task.researchReviewAcceptance;
  if(!a)return pending('authority_acceptance_missing');
  need(a.version===1&&a.state==='accepted'&&id(a.ticketId),'invalid_authority_acceptance');
  need(Array.isArray(task.researchReviewTickets),'invalid_authority_tickets');
  const ticket=task.researchReviewTickets.find(t=>t.id===a.ticketId);if(!ticket)return pending('authority_ticket_missing');
  if(!ticket.submissionIntent||ticket.submissionIntent.state!=='acknowledged')return pending('authority_submission_pending');
  const reviewer=load('reviewer',a.nativeReservationId);if(!reviewer)return pending('authority_reviewer_missing');
  need(time(reviewer.at)&&reviewer.at>=task.startedAt&&reviewer.at<=a.intentAt,'authority_reviewer_timing_mismatch');
  verifyLocalAcceptance(task,key=>key===reviewer.id?reviewer:null);
  const descriptor=verifyReviewedReceipt(receipt,task,key=>key===reviewer.id?reviewer:null);
  verifyAcceptedArtifacts(descriptor,reportBytes,sourceBytes);
  need(same(result.reviewBinding,descriptor),'authority_result_binding_mismatch');
  return {status:'verified',reason:'accepted_local_research_snapshot',version:1,taskId:task.id,goalId:task.goalId,goalVersion:goal.version,goalHash:goal.hash,taskHash:task.hash,environment,ticketId:a.ticketId,nativeReservationId:reviewer.id,candidateHash:descriptor.candidateHash,reportSha256:descriptor.reportSha256,sourcesSha256:descriptor.sourcesSha256,runtimeAttested:false};
 }catch(e){if(e instanceof ReleaseAuthorityError)throw e;throw new ReleaseAuthorityError('invalid_authority_snapshot');}
 finally{if(db){try{if(transaction)db.exec('ROLLBACK');}finally{db.close();}}}
}
