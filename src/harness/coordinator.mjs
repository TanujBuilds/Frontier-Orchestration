import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { Store } from './store.mjs';
import { Registry, normalizeGoal, normalizeTask, digest, text, identifier } from './contracts.mjs';
import { Learning } from './learning.mjs';

const TERMINAL=new Set(['accepted','failed','partial','cancelled']);
const SLOT=new Set(['running','uncertain','taking_over']);
const rank={background:0,normal:1,blocking:2};
export class Coordinator {
 constructor({root,now=Date.now,registry=new Registry()}={}){
  this.store=new Store(root);this.now=now;this.registry=registry;
  for(const record of this.store.all('mode')){const m=record.definition??record;if(!this.registry.modes.has(`${m.id}@${m.version}`))this.registry.registerMode(m);}
  for(const record of this.store.all('workflow')){const w=record.definition??record;if(!this.registry.workflows.has(`${w.id}@${w.version}`))this.registry.registerWorkflow(w);}
  this.learning=new Learning({c:this});
 }
 close(){this.store.close();}
 acquireWorker(token){identifier(token,'worker token');return this.store.tx(()=>{
  const existing=this.store.maybe('lease','coordinator');
  if(existing&&existing.token!==token){
   if(existing.host!==os.hostname())throw Error('Worker host ownership is uncertain');
   try{process.kill(existing.pid,0);throw Error('Another worker owns this coordinator');}catch(e){if(e.code!=='ESRCH')throw e;}
   for(const t of this.store.all('task').filter(t=>t.owner&&SLOT.has(t.status))){t.status='uncertain';t.reason='Previous coordinator died; reconcile backend before reuse';this.store.put('task',t);this.emit('task.uncertain',t.goalId,t.id,{reason:t.reason});}
   for(const p of this.store.all('planning').filter(p=>p.status==='running')){p.status='uncertain';p.reason='Previous planner owner died; reconcile its saved request';this.store.put('planning',p);}
  }
  const lease={id:'coordinator',token,pid:process.pid,host:os.hostname(),at:this.now()};this.store.put('lease',lease);return lease;
 });}
 releaseWorker(token){return this.store.tx(()=>{const l=this.store.maybe('lease','coordinator');if(l&&l.token!==token)throw Error('Worker ownership conflict');this.store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('lease','coordinator');return {released:true};});}
 recoverSaved(taskId,owner){return this.store.tx(()=>{
  const lease=this.store.get('lease','coordinator');if(lease.token!==owner||lease.pid!==process.pid)throw Error('Current worker lease required for recovery');
  const t=this.store.get('task',taskId);if(t.status!=='uncertain')throw Error('Task does not need ownership recovery');
  const requests=this.store.db.prepare('SELECT status FROM requests WHERE task_id=?').all(taskId);
  if(!requests.length||requests.some(r=>r.status!=='completed'))throw Error('Pending or ambiguous request prevents safe recovery');
  if(!['consult','learning'].includes(t.spec.kind)&&!(t.spec.kind==='coding'&&['model','apply'].includes(t.checkpoint.phase)))throw Error('Backend/check quiescence requires separate verification');
  const g=this.store.get('goal',t.goalId);t.owner=null;t.status=this.now()>=Math.min(g.deadline,t.deadline)?'partial':t.stopRequested?'stopped':t.pauseRequested?'paused':'queued';t.reason='Recovered from fully saved operations; no bounded check was active';this.store.put('task',t);this.emit('task.recovered',t.goalId,t.id,{status:t.status,spending:this.store.spent(t.id)});return this.getTask(t.id);
 });}
 recoverPlanning(goalId,owner){return this.store.tx(()=>{
  const lease=this.store.get('lease','coordinator');if(lease.token!==owner||lease.pid!==process.pid)throw Error('Current worker lease required for recovery');
  const p=this.store.get('planning',goalId),g=this.store.get('goal',goalId);if(p.status!=='uncertain')throw Error('Planner does not need ownership recovery');
  const requests=this.store.db.prepare('SELECT status FROM requests WHERE task_id=?').all(goalId),saved=this.store.request(goalId,`plan-${p.attempt}`);
  if(!requests.length||requests.some(r=>r.status!=='completed')||saved?.status!=='completed')throw Error('Pending or ambiguous planning request prevents safe recovery');
  if(this.now()>=g.deadline){p.status='partial';p.owner=null;}else{p.status='running';p.owner=owner;}
  this.store.put('planning',p);this.emit('planning.recovered',goalId,null,{attempt:p.attempt,status:p.status,spent:this.store.spent(goalId)});return p;
 });}
 emit(type,goalId,taskId,data={}){return this.store.tx(()=>{const seq=this.store.event(type,{goalId,taskId,data,at:this.now()});if(taskId&&this.learning?.captures(type))this.learning.capture(taskId,seq);
  if(type==='task.answered')for(const n of this.store.all('notification').filter(n=>n.taskId===taskId&&n.kind==='decision'&&!n.resolved)){n.resolved=true;n.resolvedAt=this.now();this.store.put('notification',n);}
  const kind=type==='task.question'?'decision':['task.blocked','task.uncertain','legacy_review.failed'].includes(type)?'blocker':type==='goal.finalized'?'completion':['task.result','task.integrated','task.native_finished','learning.promoted'].includes(type)?'result':null;
  if(kind){const task=taskId?this.store.get('task',taskId):null,title=type==='task.question'?'An answer is needed':type==='goal.finalized'?'Goal '+data.status:type==='learning.promoted'?'Tested procedure available':kind==='blocker'?'Work needs attention':'Saved work is ready';this.store.put('notification',{id:`notice-${seq}`,sequence:seq,goalId,taskId,kind,title,objective:task?.spec.objective??this.store.maybe('goal',goalId)?.manifest.objective??'',at:this.now(),acknowledged:false,resolved:false});}
  return seq;
 });}
 notifications({goalId}={}){return this.store.all('notification').filter(n=>!n.acknowledged&&!n.resolved&&(!goalId||n.goalId===goalId)).sort((a,b)=>b.sequence-a.sequence).slice(0,50);}
 ackNotification(input,key){return this.store.command(key,{op:'notification.ack',...input},()=>{const n=this.store.get('notification',input.notificationId);n.acknowledged=true;n.acknowledgedAt=this.now();this.store.put('notification',n);return n;});}
 prepareGoal(raw,key){const manifest=normalizeGoal(raw,this.registry);return this.store.command(key,{op:'goal.prepare',manifest},()=>{
  const g=this.store.submission('goal','',manifest.submissionId,digest(manifest),id=>({id,manifest,hash:digest(manifest),version:1,status:'draft',createdAt:this.now(),activatedAt:null,deadline:null}));
  this.emit('goal.prepared',g.id,null,{hash:g.hash});return g;
 });}
 activateGoal(input,key){return this.store.command(key,{op:'goal.activate',...input},()=>{
  const g=this.store.get('goal',input.goalId);if(input.hash!==g.hash)throw Error('Exact goal approval hash required');
  if(g.status==='draft'){g.status='active';g.activatedAt??=this.now();g.deadline??=g.activatedAt+g.manifest.limits.hours*3600000;this.store.put('goal',g);this.emit('goal.activated',g.id,null,{hash:g.hash,version:g.version});}
  return g;
 });}
 getGoal(id){const g=this.store.get('goal',id),planning=this.store.maybe('planning',id);return {...g,planning:planning?{...planning,spent:this.store.spent(id).model??0}:null,tasks:this.store.all('task').filter(t=>t.goalId===id).map(t=>this.getTask(t.id)),reviewerRuns:this.store.all('reviewer').filter(r=>r.goalId===id)};}
 getTask(id){const t=this.store.get('task',id),local=this.store.spent(id),spent={model:0,search:0,download:0,codexReview:0};for(const k of Object.keys(spent))spent[k]=Math.max(local[k]??0,t.remoteSpent?.[k]??0);return {...t,spent};}
 snapshot(){return {goals:this.store.all('goal').map(g=>this.getGoal(g.id)),notifications:this.notifications(),events:this.store.events(Math.max(0,Number(this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get().n)-1000),1000),operations:this.store.all('operation').slice(-30).map(({result,...r})=>r),registry:this.registry.snapshot()};}
 liveGoal(g){if(g.status!=='active')throw Error('Goal is not active');if(this.now()>=g.deadline)throw Error('Goal deadline exceeded');}
 liveTask(t,{allowStopped=false}={}){const current=this.store.get('task',t.id),g=this.store.get('goal',current.goalId);this.liveGoal(g);if(current.goalVersion!==g.version)throw Error('Task needs explicit rebind to the approved goal version');if(current.deadline&&this.now()>=current.deadline)throw Error('Original task deadline exceeded');if(current.pauseRequested||(current.stopRequested&&!(allowStopped&&current.status==='stopped'&&!current.owner)))throw Error('Task is paused or stopped');return current;}
 startNativeText(input,key){return this.store.command(key,{op:'native.text.start',...input},()=>{
  const t=this.getTask(input.taskId),g=this.store.get('goal',t.goalId);this.liveTask(t);
  if(!g.manifest.mode.actors.includes('codex')||!['consult','learning'].includes(t.spec.kind))throw Error('Mode/capability prohibits native text execution');
  if(t.spec.actor!=='codex')text(input.reason,'takeover reason');
  if(t.owner||!['codex_ready','blocked','stopped','awaiting_review'].includes(t.status))throw Error('Verify quiescence before native execution');
  if(!t.spec.dependsOn.every(id=>this.getTask(id).status==='accepted'))throw Error('Dependencies are incomplete');
  t.status='codex_active';t.executionActor='codex';t.startedAt??=this.now();t.deadline??=Math.min(g.deadline,t.startedAt+t.spec.limits.seconds*1000);this.store.put('task',t);this.learning.pin(t.id);this.emit('task.native_started',g.id,t.id,{kind:t.spec.kind,reason:input.reason??null});return this.getTask(t.id);
 });}
 finishNativeText(input,key){return this.store.command(key,{op:'native.text.finish',...input},()=>{
  const t=this.getTask(input.taskId);this.liveTask(t);if(t.status!=='codex_active'||t.executionActor!=='codex'||!['consult','learning'].includes(t.spec.kind))throw Error('Native text ownership required');
  const lessons=t.spec.kind==='learning'?this.store.all('lesson').filter(l=>l.maintenanceId===t.id):[];
  if(t.spec.kind==='learning'&&(!lessons.length||lessons.some(l=>l.status==='candidate')||!this.store.all('evaluation').some(e=>lessons.some(l=>l.id===e.lessonId))))throw Error('Native learning needs a protected evaluation and finalized procedure decision');
  text(input.content,'native result',20000);t.result={content:input.content,actor:'codex',accounting:'native host; token totals unavailable',...(lessons.length?{lessons:lessons.map(l=>({id:l.id,status:l.status,recipeHash:l.recipeHash}))}:{})};t.status='accepted';this.store.put('task',t);this.emit('task.native_finished',t.goalId,t.id,{status:t.status,actor:'codex'});return this.getTask(t.id);
 });}
 submitTask(input,key){const {goalId,...raw}=input;return this.store.command(key,{op:'task.submit',...input},()=>{
  const g=this.store.get('goal',goalId);this.liveGoal(g);const spec=normalizeTask(raw,g.manifest,this.registry),hash=digest(spec);
  const duplicate=this.store.db.prepare('SELECT * FROM submissions WHERE kind=? AND scope=? AND key=?').get('task',goalId,spec.submissionId);
  if(duplicate){if(duplicate.hash!==hash)throw Error('Submission conflict');return this.getTask(duplicate.id);}
  const existing=this.store.all('task').filter(t=>t.goalId===goalId);
  if(existing.length>=g.manifest.limits.maxTasks)throw Error('Goal task cap reached');
  if(spec.kind==='learning'&&existing.some(t=>t.spec.kind==='learning'))throw Error('Learning assignment limit reached');
  for(const id of spec.dependsOn){const dep=this.store.get('task',id);if(dep.goalId!==goalId)throw Error('Dependency outside goal');}
  const t=this.store.submission('task',goalId,spec.submissionId,hash,id=>({id,goalId,goalVersion:g.version,spec,hash,status:spec.actor==='codex'?'codex_ready':'queued',sequence:this.store.all('task').length+1,createdAt:this.now(),startedAt:null,deadline:null,owner:null,checkpoint:{},attempts:0,reviews:0,questions:[],answers:[],feedback:[],yieldRequested:false,pauseRequested:false,stopRequested:false,reviewed:false,result:null}));
  this.emit('task.submitted',goalId,t.id,{actor:spec.actor,kind:spec.kind,hash});this.requestUrgentYield();return this.getTask(t.id);
 });}
 submitWorkflow(input,key){return this.store.command(key,{op:'workflow.submit',...input},()=>{
  identifier(input.submissionId,'submissionId');const g=this.store.get('goal',input.goalId);this.liveGoal(g);
  const definition=this.registry.workflows.get(`${input.workflowId}@${input.version}`);if(!definition)throw Error('Unknown workflow version');if(definition.mode!==g.manifest.mode.id)throw Error('Workflow mode differs from approved policy');
  const definitionHash=digest(definition),hash=digest({goalId:g.id,definitionHash,submissionId:input.submissionId});
  const existing=this.store.db.prepare('SELECT * FROM submissions WHERE kind=? AND scope=? AND key=?').get('workflow_run',g.id,input.submissionId);if(existing){if(existing.hash!==hash)throw Error('Workflow submission conflict');return this.store.get('workflow_run',existing.id);}
  const byKey=new Map(definition.tasks.map(t=>[t.key,t])),ids=new Map();
  const submit=stage=>{if(ids.has(stage.key))return ids.get(stage.key);const dependsOn=(stage.dependsOn??[]).map(k=>submit(byKey.get(k))),{key:stageKey,...spec}=stage;
   const task=this.submitTask({goalId:g.id,...spec,dependsOn,submissionId:`${input.submissionId}-${stageKey}`},`wf-${digest({goal:g.id,run:input.submissionId,stageKey})}`);ids.set(stage.key,task.id);return task.id;};
  for(const stage of definition.tasks)submit(stage);
  const run=this.store.submission('workflow_run',g.id,input.submissionId,hash,id=>({id,goalId:g.id,workflowId:input.workflowId,version:input.version,definitionHash,goalVersion:g.version,tasks:[...ids.values()],at:this.now()}));this.emit('workflow.submitted',g.id,null,{id:run.id,definitionHash,tasks:run.tasks});return run;
 });}
 effectivePriorities(){const tasks=this.store.all('task'),p=new Map(tasks.map(t=>[t.id,rank[t.priority??t.spec.priority]]));let changed=true;
  while(changed){changed=false;for(const t of tasks)if(!TERMINAL.has(t.status))for(const id of t.spec.dependsOn)if(p.get(id)<p.get(t.id)){p.set(id,p.get(t.id));changed=true;}}
  return p;
 }
 eligible(t){const g=this.store.get('goal',t.goalId);return g.status==='active'&&g.deadline>this.now()&&(!t.deadline||t.deadline>this.now())&&!(g.integrationSealed&&t.spec.kind==='coding')&&!t.pauseRequested&&!t.stopRequested&&t.goalVersion===g.version&&t.spec.dependsOn.every(id=>this.store.get('task',id).status==='accepted');}
 expireQuiescent(){return this.store.tx(()=>{
  for(const t of this.store.all('task')){
   const g=this.store.get('goal',t.goalId);
   if(TERMINAL.has(t.status)||t.owner||t.status==='legacy_reviewing'||t.executionActor==='codex'||g.integrationOwner===t.id)continue;
   if(this.now()<Math.min(g.deadline,t.deadline??g.deadline))continue;
   t.status='partial';t.reason='Original deadline reached; saved evidence retained';this.store.put('task',t);this.emit('task.expired',g.id,t.id,{reason:t.reason});
  }
 });}
 requestUrgentYield(){const tasks=this.store.all('task'),p=this.effectivePriorities();for(const active of tasks.filter(t=>t.status==='running'&&t.spec.actor==='deepseek'))if(tasks.some(t=>['queued','suspended'].includes(t.status)&&this.eligible(t)&&p.get(t.id)>p.get(active.id))){active.yieldRequested=true;this.store.put('task',active);this.emit('task.yield_requested',active.goalId,active.id);}}
 claimNext(owner){identifier(owner,'owner');return this.store.tx(()=>{
  if(this.store.all('planning').some(p=>['running','uncertain'].includes(p.status)))return null;
  const tasks=this.store.all('task');if(tasks.some(t=>SLOT.has(t.status)&&t.spec.actor==='deepseek'))return null;
  const priorities=this.effectivePriorities();const candidates=tasks.filter(t=>['queued','suspended'].includes(t.status)&&t.spec.actor==='deepseek'&&this.eligible(t)).sort((a,b)=>priorities.get(b.id)-priorities.get(a.id)||a.sequence-b.sequence);
  if(!candidates.length)return null;const t=candidates[0],g=this.store.get('goal',t.goalId);
  t.startedAt??=this.now();t.deadline??=Math.min(g.deadline,t.startedAt+t.spec.limits.seconds*1000);t.owner=owner;t.status='running';t.yieldRequested=false;
  this.store.put('task',t);this.learning.pin(t.id);this.emit('task.claimed',t.goalId,t.id,{owner});return this.getTask(t.id);
 });}
 owned(id,owner){const t=this.store.get('task',id);if(t.owner!==owner||!['running','uncertain','taking_over'].includes(t.status))throw Error('Worker ownership conflict');return t;}
 reserve(taskId,{key,kind},owner){identifier(key,'request key');return this.store.tx(()=>{
  const saved=this.store.request(taskId,key);if(saved){if(saved.kind!==kind)throw Error('Request key conflict');if(saved.status==='completed')return {...saved,cached:true};throw Error('Request is ambiguous and remains spent');}
  const t=this.owned(taskId,owner),g=this.store.get('goal',t.goalId);this.liveGoal(g);if(t.status!=='running'||this.now()>=t.deadline||t.stopRequested||t.pauseRequested)throw Error('Task deadline/control prevents request');
  if(t.spec.actor!=='deepseek'||!g.manifest.mode.actors.includes('deepseek'))throw Error('Mode prohibits model actor');
  const budget={model:'modelCalls',search:'searches',download:'downloads'}[kind];if(!budget||!t.spec.limits[budget])throw Error('Unsupported request kind');
  if((this.store.spent(taskId)[kind]??0)>=t.spec.limits[budget])throw Error('Request budget limit reached');
  const id=randomUUID(),data={owner,reservedAt:this.now()};this.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(id,taskId,key,kind,'reserved',JSON.stringify(data));
  this.emit('request.reserved',t.goalId,taskId,{id,key,kind});return {id,task_id:taskId,key,kind,status:'reserved',...data,cached:false};
 });}
 saveRequest(id,result){return this.store.tx(()=>{const row=this.store.db.prepare('SELECT * FROM requests WHERE id=?').get(id);if(!row)throw Error('Unknown request');const data=JSON.parse(row.data);
  if(row.status==='completed'){if(digest(data.result)!==digest(result))throw Error('Saved response conflict');return data.result;}
  data.result=result;data.savedAt=this.now();this.store.db.prepare('UPDATE requests SET status=?,data=? WHERE id=?').run('completed',JSON.stringify(data),id);const t=this.store.get('task',row.task_id);this.emit('request.saved',t.goalId,t.id,{id});return result;
 });}
 beginAttempt(taskId,owner){return this.store.tx(()=>{const t=this.owned(taskId,owner);if(t.attempts>=t.spec.limits.attempts)throw Error('Attempt limit reached');t.attempts++;this.store.put('task',t);this.emit('attempt.started',t.goalId,t.id,{attempt:t.attempts});return t.attempts;});}
 boundary(taskId,checkpoint,owner,{quiescent=true}={}){return this.store.tx(()=>{const t=this.owned(taskId,owner),g=this.store.get('goal',t.goalId);t.checkpoint=checkpoint;
  if(!quiescent){this.store.put('task',t);this.emit('task.checkpoint',t.goalId,t.id,{status:t.status,quiescent:false});return this.getTask(t.id);}
  if(this.now()>=Math.min(g.deadline,t.deadline)){t.status='partial';t.reason='Deadline reached';}
  else if(t.stopRequested||g.status==='stopped')t.status='stopped';
  else if(t.pauseRequested||g.status==='paused')t.status='paused';
  else if(t.yieldRequested)t.status='suspended';
  if(t.status!=='running')t.owner=null;this.store.put('task',t);this.emit('task.checkpoint',t.goalId,t.id,{status:t.status});return this.getTask(t.id);
 });}
 ask(taskId,question,checkpoint,owner){text(question,'question',8000);return this.store.tx(()=>{const t=this.owned(taskId,owner),g=this.store.get('goal',t.goalId);
  if(t.questions.length>=t.spec.limits.questions)throw Error('Clarification limit reached');
  const q={id:randomUUID(),text:question,at:this.now()};t.questions.push(q);t.status=g.manifest.mode.actors.includes('codex')?'awaiting_supervisor':'awaiting_user';t.checkpoint=checkpoint;t.owner=null;
  this.store.put('task',t);this.emit('task.question',t.goalId,t.id,q);return this.getTask(t.id);
 });}
 answer(input,key){return this.store.command(key,{op:'task.answer',...input},()=>{const t=this.store.get('task',input.taskId),g=this.store.get('goal',t.goalId);this.liveGoal(g);
  if(!['awaiting_supervisor','awaiting_user'].includes(t.status))throw Error('Task is not waiting for an answer');
  if(t.status==='awaiting_user'&&input.responder!=='user')throw Error('This mode requires a user answer');
  text(input.answer,'answer',8000);const answer={questionId:t.questions.at(-1).id,text:input.answer,responder:input.responder,at:this.now()};t.answers.push(answer);t.status=t.spec.actor==='codex'?'codex_ready':'queued';this.store.put('task',t);this.emit('task.answered',t.goalId,t.id,answer);this.requestUrgentYield();return this.getTask(t.id);
 });}
 completeTask(taskId,result,owner,{reviewRequired=false}={}){return this.store.tx(()=>{const t=this.owned(taskId,owner),g=this.store.get('goal',t.goalId);t.result=result;t.owner=null;t.yieldRequested=false;
  t.status=this.now()>=Math.min(g.deadline,t.deadline)?'partial':t.spec.kind==='coding'?(g.manifest.mode.review==='checks'?'ready_to_integrate':g.manifest.mode.review==='legacy'?'awaiting_legacy_review':'awaiting_review'):reviewRequired&&g.manifest.mode.review==='operator'?'awaiting_review':'accepted';
  if(t.status!=='partial'&&(t.stopRequested||g.status==='stopped')){t.controlReturnStatus=t.status;t.status='stopped';}
  else if(t.status!=='partial'&&(t.pauseRequested||g.status==='paused')){t.controlReturnStatus=t.status;t.status='paused';}
  this.store.put('task',t);this.emit('task.result',t.goalId,t.id,{status:t.status,result});return this.getTask(t.id);
 });}
 review(input,key){return this.store.command(key,{op:'task.review',...input},()=>{const t=this.store.get('task',input.taskId),g=this.store.get('goal',t.goalId);this.liveTask(t);if(g.manifest.mode.review!=='operator')throw Error('Mode prohibits Codex operator review');if(t.status!=='awaiting_review')throw Error('Task is not awaiting review');if(t.reviews>=t.spec.limits.reviews)throw Error('Review limit reached');if(!['accept','revise'].includes(input.decision))throw Error('Invalid review decision');text(input.feedback,'feedback',12000);t.reviews++;t.feedback.push({decision:input.decision,text:input.feedback,at:this.now()});t.reviewed=true;
  const exhausted=t.reviews>=t.spec.limits.reviews||t.attempts>=t.spec.limits.attempts||(this.store.spent(t.id).model??0)>=t.spec.limits.modelCalls;
  t.status=input.decision==='accept'?(t.spec.kind==='coding'?'ready_to_integrate':'accepted'):exhausted?'blocked':'queued';if(input.decision==='revise'){t.checkpoint={...t.checkpoint,phase:'attempt'};if(exhausted)t.reason='Revision cannot proceed: original review, attempt or request budget exhausted';}
  this.store.put('task',t);this.emit('task.reviewed',t.goalId,t.id,{decision:input.decision});this.requestUrgentYield();return this.getTask(t.id);});}
 setPriority(input,key){return this.store.command(key,{op:'task.priority',...input},()=>{const t=this.store.get('task',input.taskId);if(!(input.priority in rank))throw Error('Invalid priority');if(t.spec.kind==='learning'&&input.priority!=='background')throw Error('Learning priority must remain background');text(input.reason,'priority reason',2000);t.priority=input.priority;this.store.put('task',t);this.emit('task.priority',t.goalId,t.id,{priority:input.priority,reason:input.reason});this.requestUrgentYield();return this.getTask(t.id);});}
 control(input,key){return this.store.command(key,{op:'control',...input},()=>{
  if(!['pause','stop','resume'].includes(input.action))throw Error('Invalid control');
  const g=input.goalId?this.store.get('goal',input.goalId):this.store.get('goal',this.store.get('task',input.taskId).goalId);
  if(input.action==='resume'&&this.now()>=g.deadline)throw Error('Original deadline exceeded');
  const targets=this.store.all('task').filter(t=>input.goalId?t.goalId===g.id:t.id===input.taskId);
  if(input.goalId){if(['completed','partial'].includes(g.status))throw Error('Goal is terminal');g.status=input.action==='resume'?'active':input.action==='stop'?'stopped':'paused';this.store.put('goal',g);}
  for(const t of targets){
   if(TERMINAL.has(t.status))continue;if(t.status==='uncertain')throw Error('Uncertain ownership must be reconciled');
   if(input.action==='resume'){
    if(t.deadline&&this.now()>=t.deadline)continue;t.stopRequested=t.pauseRequested=false;
    if(['paused','stopped'].includes(t.status)){t.status=t.controlReturnStatus??(t.executionActor==='codex'?'codex_active':t.spec.actor==='codex'?'codex_ready':'queued');delete t.controlReturnStatus;}
   }else if(t.status==='running'){t.pauseRequested=input.action==='pause';t.stopRequested=input.action==='stop';}
   else if(!t.owner&&!['paused','stopped','legacy_reviewing'].includes(t.status)){t.controlReturnStatus=t.status;t.status=input.action==='stop'?'stopped':'paused';t.pauseRequested=input.action==='pause';t.stopRequested=input.action==='stop';}
   this.store.put('task',t);
  }
  this.emit('work.control',g.id,input.taskId??null,{action:input.action});return input.goalId?this.getGoal(g.id):this.getTask(input.taskId);
 });}
 markUncertain(taskId,reason,owner){return this.store.tx(()=>{const t=this.owned(taskId,owner);t.status='uncertain';t.reason=reason;this.store.put('task',t);this.emit('task.uncertain',t.goalId,t.id,{reason});return this.getTask(t.id);});}
 reserveReviewer(input,key){return this.store.command(key,{op:'reviewer.reserve',...input},()=>{const t=this.store.get('task',input.taskId),g=this.store.get('goal',t.goalId);this.liveGoal(g);if(g.manifest.mode.review!=='operator')throw Error('Mode prohibits reviewer');const runs=this.store.all('reviewer').filter(r=>r.goalId===g.id);if(runs.some(r=>r.status==='reserved'))throw Error('A reviewer is already active');if(runs.length>=g.manifest.limits.reviewAgentRuns)throw Error('Reviewer budget limit reached');const run={id:randomUUID(),goalId:g.id,taskId:t.id,status:'reserved',at:this.now()};this.store.put('reviewer',run);this.emit('reviewer.reserved',g.id,t.id,{id:run.id});return run;});}
 finishReviewer(input,key){return this.store.command(key,{op:'reviewer.finish',...input},()=>{const r=this.store.get('reviewer',input.reservationId);if(r.status!=='reserved')throw Error('Reviewer is already finalized');r.status=input.error?'failed':'completed';r.result=input.result??null;r.error=input.error??null;this.store.put('reviewer',r);this.emit('reviewer.finished',r.goalId,r.taskId,{id:r.id,status:r.status});return r;});}
}
