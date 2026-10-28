import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { Store } from './store.mjs';
import { Registry, normalizeGoal, normalizeTask, digest, text, identifier } from './contracts.mjs';

const TERMINAL=new Set(['accepted','failed','partial','cancelled']);
const SLOT=new Set(['running','uncertain','taking_over']);
const rank={background:0,normal:1,blocking:2};
export class Coordinator {
 constructor({root,now=Date.now,registry=new Registry()}={}){
  this.store=new Store(root);this.now=now;this.registry=registry;
  for(const m of this.store.all('mode'))if(!this.registry.modes.has(`${m.id}@${m.version}`))this.registry.registerMode(m);
 }
 close(){this.store.close();}
 acquireWorker(token){identifier(token,'worker token');return this.store.tx(()=>{
  const existing=this.store.maybe('lease','coordinator');
  if(existing&&existing.token!==token){
   if(existing.host!==os.hostname())throw Error('Worker host ownership is uncertain');
   try{process.kill(existing.pid,0);throw Error('Another worker owns this coordinator');}catch(e){if(e.code!=='ESRCH')throw e;}
   for(const t of this.store.all('task').filter(t=>t.owner&&SLOT.has(t.status))){t.status='uncertain';t.reason='Previous coordinator died; reconcile backend before reuse';this.store.put('task',t);this.emit('task.uncertain',t.goalId,t.id,{reason:t.reason});}
  }
  const lease={id:'coordinator',token,pid:process.pid,host:os.hostname(),at:this.now()};this.store.put('lease',lease);return lease;
 });}
 releaseWorker(token){return this.store.tx(()=>{const l=this.store.maybe('lease','coordinator');if(l&&l.token!==token)throw Error('Worker ownership conflict');this.store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('lease','coordinator');return {released:true};});}
 emit(type,goalId,taskId,data={}){return this.store.event(type,{goalId,taskId,data,at:this.now()});}
 prepareGoal(raw,key){const manifest=normalizeGoal(raw,this.registry);return this.store.command(key,{op:'goal.prepare',manifest},()=>{
  const g=this.store.submission('goal','',manifest.submissionId,digest(manifest),id=>({id,manifest,hash:digest(manifest),version:1,status:'draft',createdAt:this.now(),activatedAt:null,deadline:null}));
  this.emit('goal.prepared',g.id,null,{hash:g.hash});return g;
 });}
 activateGoal(input,key){return this.store.command(key,{op:'goal.activate',...input},()=>{
  const g=this.store.get('goal',input.goalId);if(input.hash!==g.hash)throw Error('Exact goal approval hash required');
  if(g.status==='draft'){g.status='active';g.activatedAt??=this.now();g.deadline??=g.activatedAt+g.manifest.limits.hours*3600000;this.store.put('goal',g);this.emit('goal.activated',g.id,null,{hash:g.hash,version:g.version});}
  return g;
 });}
 getGoal(id){const g=this.store.get('goal',id);return {...g,tasks:this.store.all('task').filter(t=>t.goalId===id).map(t=>this.getTask(t.id)),reviewerRuns:this.store.all('reviewer').filter(r=>r.goalId===id)};}
 getTask(id){const t=this.store.get('task',id);return {...t,spent:{model:0,search:0,download:0,...this.store.spent(id)}};}
 snapshot(){return {goals:this.store.all('goal').map(g=>this.getGoal(g.id)),events:this.store.events(0,1000),registry:this.registry.snapshot()};}
 liveGoal(g){if(g.status!=='active')throw Error('Goal is not active');if(this.now()>=g.deadline)throw Error('Goal deadline exceeded');}
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
 effectivePriorities(){const tasks=this.store.all('task'),p=new Map(tasks.map(t=>[t.id,rank[t.priority??t.spec.priority]]));let changed=true;
  while(changed){changed=false;for(const t of tasks)if(!TERMINAL.has(t.status))for(const id of t.spec.dependsOn)if(p.get(id)<p.get(t.id)){p.set(id,p.get(t.id));changed=true;}}
  return p;
 }
 eligible(t){const g=this.store.get('goal',t.goalId);return g.status==='active'&&g.deadline>this.now()&&(!t.deadline||t.deadline>this.now())&&t.goalVersion===g.version&&t.spec.dependsOn.every(id=>this.store.get('task',id).status==='accepted');}
 requestUrgentYield(){const tasks=this.store.all('task'),p=this.effectivePriorities();for(const active of tasks.filter(t=>t.status==='running'&&t.spec.actor==='deepseek'))if(tasks.some(t=>['queued','suspended'].includes(t.status)&&this.eligible(t)&&p.get(t.id)>p.get(active.id))){active.yieldRequested=true;this.store.put('task',active);this.emit('task.yield_requested',active.goalId,active.id);}}
 claimNext(owner){identifier(owner,'owner');return this.store.tx(()=>{
  const tasks=this.store.all('task');if(tasks.some(t=>SLOT.has(t.status)&&t.spec.actor==='deepseek'))return null;
  const priorities=this.effectivePriorities();const candidates=tasks.filter(t=>['queued','suspended'].includes(t.status)&&t.spec.actor==='deepseek'&&this.eligible(t)).sort((a,b)=>priorities.get(b.id)-priorities.get(a.id)||a.sequence-b.sequence);
  if(!candidates.length)return null;const t=candidates[0],g=this.store.get('goal',t.goalId);
  t.startedAt??=this.now();t.deadline??=Math.min(g.deadline,t.startedAt+t.spec.limits.seconds*1000);t.owner=owner;t.status='running';t.yieldRequested=false;
  this.store.put('task',t);this.emit('task.claimed',t.goalId,t.id,{owner});return this.getTask(t.id);
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
 boundary(taskId,checkpoint,owner){return this.store.tx(()=>{const t=this.owned(taskId,owner),g=this.store.get('goal',t.goalId);t.checkpoint=checkpoint;
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
  t.status=this.now()>=Math.min(g.deadline,t.deadline)?'partial':reviewRequired&&g.manifest.mode.review==='operator'?'awaiting_review':'accepted';
  this.store.put('task',t);this.emit('task.result',t.goalId,t.id,{status:t.status,result});return this.getTask(t.id);
 });}
 review(input,key){return this.store.command(key,{op:'task.review',...input},()=>{const t=this.store.get('task',input.taskId),g=this.store.get('goal',t.goalId);this.liveGoal(g);if(g.manifest.mode.review!=='operator')throw Error('Mode prohibits Codex operator review');if(t.status!=='awaiting_review')throw Error('Task is not awaiting review');if(t.reviews>=t.spec.limits.reviews)throw Error('Review limit reached');if(!['accept','revise'].includes(input.decision))throw Error('Invalid review decision');text(input.feedback,'feedback',12000);t.reviews++;t.feedback.push({decision:input.decision,text:input.feedback,at:this.now()});t.reviewed=true;t.status=input.decision==='accept'?'accepted':t.reviews>=t.spec.limits.reviews?'blocked':'queued';this.store.put('task',t);this.emit('task.reviewed',t.goalId,t.id,{decision:input.decision});this.requestUrgentYield();return this.getTask(t.id);});}
 setPriority(input,key){return this.store.command(key,{op:'task.priority',...input},()=>{const t=this.store.get('task',input.taskId);if(!(input.priority in rank))throw Error('Invalid priority');text(input.reason,'priority reason',2000);t.priority=input.priority;this.store.put('task',t);this.emit('task.priority',t.goalId,t.id,{priority:input.priority,reason:input.reason});this.requestUrgentYield();return this.getTask(t.id);});}
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
    if(['paused','stopped'].includes(t.status))t.status=t.spec.actor==='codex'?'codex_ready':'queued';
   }else if(t.status==='running'){t.pauseRequested=input.action==='pause';t.stopRequested=input.action==='stop';}
   else if(['queued','suspended','codex_ready'].includes(t.status)){t.status=input.action==='stop'?'stopped':'paused';}
   this.store.put('task',t);
  }
  this.emit('work.control',g.id,input.taskId??null,{action:input.action});return input.goalId?this.getGoal(g.id):this.getTask(input.taskId);
 });}
 markUncertain(taskId,reason,owner){return this.store.tx(()=>{const t=this.owned(taskId,owner);t.status='uncertain';t.reason=reason;this.store.put('task',t);this.emit('task.uncertain',t.goalId,t.id,{reason});return this.getTask(t.id);});}
 reserveReviewer(input,key){return this.store.command(key,{op:'reviewer.reserve',...input},()=>{const t=this.store.get('task',input.taskId),g=this.store.get('goal',t.goalId);this.liveGoal(g);if(g.manifest.mode.review!=='operator')throw Error('Mode prohibits reviewer');const runs=this.store.all('reviewer').filter(r=>r.goalId===g.id);if(runs.some(r=>r.status==='reserved'))throw Error('A reviewer is already active');if(runs.length>=g.manifest.limits.reviewAgentRuns)throw Error('Reviewer budget limit reached');const run={id:randomUUID(),goalId:g.id,taskId:t.id,status:'reserved',at:this.now()};this.store.put('reviewer',run);this.emit('reviewer.reserved',g.id,t.id,{id:run.id});return run;});}
 finishReviewer(input,key){return this.store.command(key,{op:'reviewer.finish',...input},()=>{const r=this.store.get('reviewer',input.reservationId);if(r.status!=='reserved')throw Error('Reviewer is already finalized');r.status=input.error?'failed':'completed';r.result=input.result??null;r.error=input.error??null;this.store.put('reviewer',r);this.emit('reviewer.finished',r.goalId,r.taskId,{id:r.id,status:r.status});return r;});}
}
