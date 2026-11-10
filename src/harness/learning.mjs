import { randomUUID } from 'node:crypto';
import { keys,integer,text,digest,Registry,normalizeGoal,normalizeTask } from './contracts.mjs';
import { PROJECT_CHECK_GUIDANCE, renderProjectCheckGuidance, validateProjectCheckGuidance } from './project-guidance/contract.mjs';
import { resolveGuidanceEvidence } from './project-guidance/evidence.mjs';
import { buildProjectGuidanceCases, evaluateProjectCheckGuidance } from './project-guidance/evaluator.mjs';
import { fitsMemoryBudget, guidanceMemoryPacket } from './project-guidance/applicability.mjs';

const cases=Object.freeze([
 {id:'regression-response-size',role:'regression',files:[16000,16000]},
 {id:'heldout-small-files',role:'heldout',files:[1000,1500,2000]},
 {id:'heldout-mixed-files',role:'heldout',files:[12000,10000,5000]},
]);
const backoffCases=Object.freeze([
 {id:'regression-zero-overflow',role:'regression',attempt:1024,base:0,cap:5000,expected:0},
 {id:'heldout-larger-zero',role:'heldout',attempt:4096,base:0,cap:17,expected:0},
 {id:'heldout-zero-cap',role:'heldout',attempt:2048,base:0,cap:0,expected:0},
]);
const zeroFailure=task=>task.feedback.some(f=>f.decision==='revise'&&/zero[\s\S]*(?:Infinity|overflow|NaN)/i.test(f.text));
function simulate(recipe,sample){
 if(recipe.family==='backoff_zero'){const actual=recipe.guardZeroBeforeExponent&&(sample.base===0||sample.cap===0)?0:Math.min(sample.base*2**sample.attempt,sample.cap),passed=Object.is(actual,sample.expected);return {requests:1,failures:passed?0:1,passed};}
 let requests=0,failures=0;for(let i=0;i<sample.files.length;i+=recipe.maxFiles){requests++;if(sample.files.slice(i,i+recipe.maxFiles).reduce((a,b)=>a+b,0)>recipe.maxBytes)failures++;}return {requests,failures,passed:failures===0};
}
function boundaries(){
 const r=new Registry(),project={repo:'/fixture',baseCommit:'a'.repeat(40),readPaths:['src/'],writePaths:['src/'],checks:[{id:'verify',argv:['node','checks/verify.mjs']}]};
 const g=normalizeGoal({submissionId:'boundary',objective:'Verify boundaries',acceptance:['Scope enforced'],project},r);
 const t={submissionId:'test',kind:'coding',objective:'Code',acceptance:['Pass']};
 const failures=[()=>normalizeTask({...t,permissions:{readPaths:['outside/'],writePaths:['outside/'],checks:['verify']}},g,r),()=>normalizeTask({...t,limits:{modelCalls:51}},g,r),()=>normalizeTask({...t,actor:'codex'},normalizeGoal({submissionId:'only',objective:'Verify mode',acceptance:['Pass'],project,mode:'deepseek_only'},r),r)];
 return failures.every(fn=>{try{fn();return false;}catch{return true;}});
}

export class Learning {
 constructor({c}){this.c=c;this.store=c.store;this.store.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(lesson_id UNINDEXED, content)');}
 captures(type){return ['attempt.protocol_failed','checks.failed','task.blocked','task.result','task.integrated','task.native_finished','task.reviewed','task.answered'].includes(type);}
 projectKey(goalId){const g=this.store.get('goal',goalId);return digest(g.manifest.project?.repo??g.id);}
 capture(taskId,eventSequence){
  const task=this.c.getTask(taskId),event=this.store.events(eventSequence-1,1)[0];
  if(!event||event.seq!==eventSequence||event.task_id!==taskId||!['attempt.protocol_failed','checks.failed','task.blocked','task.result','task.integrated','task.native_finished','task.reviewed','task.answered'].includes(event.type))throw Error('Trusted outcome evidence required');
  const id=`${taskId}-${eventSequence}`,old=this.store.maybe('outcome',id);if(old)return old;
  const requests=this.store.db.prepare("SELECT data FROM requests WHERE task_id=? AND status='completed' ORDER BY rowid").all(taskId).map(r=>JSON.parse(r.data));
  const outcome={id,taskId,goalId:task.goalId,projectKey:this.projectKey(task.goalId),eventSequence,sourceHash:digest(event),kind:event.type,status:task.status,data:event.data,spent:task.spent,attempts:task.attempts,capability:task.spec.kind,capabilityVersion:1,nodeVersion:process.versions.node,modelId:requests.findLast(r=>r.result?.model)?.result.model??null,reportedUsage:requests.map(r=>r.result?.usage).filter(Boolean),environment:this.store.get('goal',task.goalId).manifest.environment,at:this.c.now()};
  this.store.put('outcome',outcome);
  if(event.type==='attempt.protocol_failed'&&/truncat|batch.*limit/i.test(event.data.reason??''))for(const pinned of task.memory??[]){const lesson=this.store.maybe('lesson',pinned.id);if(lesson?.status==='active'&&lesson.family==='edit_batch')this.quarantine(lesson.id,`Observed recurrence in outcome ${id}`,`learning-regression-${id}`);}
  if(event.type==='task.reviewed'&&event.data.decision==='revise'&&zeroFailure(task))for(const pinned of task.memory??[]){const lesson=this.store.maybe('lesson',pinned.id);if(lesson?.status==='active'&&lesson.family==='backoff_zero')this.quarantine(lesson.id,`Reviewed backoff regression in outcome ${id}`,`learning-regression-${id}`);}
  return outcome;
 }
 liveMaintenance(taskId){
  const t=this.store.get('task',taskId),g=this.store.get('goal',t.goalId);this.c.liveGoal(g);
  if(t.spec.kind!=='learning'||!['queued','codex_ready','running','codex_active'].includes(t.status)||t.pauseRequested||t.stopRequested)throw Error('Learning assignment is not active');
  t.startedAt??=this.c.now();t.deadline??=Math.min(g.deadline,t.startedAt+t.spec.limits.seconds*1000);
  if(this.c.now()>=t.deadline)throw Error('Learning deadline exceeded');this.store.put('task',t);return t;
 }
 propose(maintenanceId,raw,key){
  const task=this.c.getTask(maintenanceId);
  if(task.executionActor==='codex'||task.spec.actor==='codex')this.store.command('native-proposal-'+digest({maintenanceId,key}),{op:'learning.native_proposal',maintenanceId,raw},()=>{
   const t=this.liveMaintenance(maintenanceId);if(t.status!=='codex_active'||t.executionActor!=='codex')throw Error('Native learning ownership required');if(t.attempts>=Math.min(2,t.spec.limits.attempts))throw Error('Native proposal and repair attempts exhausted');t.attempts++;this.store.put('task',t);this.c.emit('learning.native_proposal_reserved',t.goalId,t.id,{attempt:t.attempts,accounting:'Native host; token totals unavailable'});return {attempt:t.attempts};
  });
  return this.store.command(key,{op:'learning.propose',maintenanceId,raw},()=>{
  const maintenance=this.c.getTask(maintenanceId);if(maintenance.spec.kind!=='learning')throw Error('A budgeted learning assignment is required');
  this.liveMaintenance(maintenanceId);
  keys(raw,['family','scope','parameters','evidence','rationale'],'lesson');
  if(!['edit_batch','backoff_zero',PROJECT_CHECK_GUIDANCE].includes(raw.family))throw Error('This procedure needs a registered protected evaluator');
  if(!['project','general'].includes(raw.scope))throw Error('Invalid lesson scope');
  if(raw.family==='edit_batch'){keys(raw.parameters,['maxFiles','maxBytes'],'parameters');integer(raw.parameters.maxFiles,'maxFiles',1,2);integer(raw.parameters.maxBytes,'maxBytes',100,24576);}
  else if(raw.family==='backoff_zero'){keys(raw.parameters,['guardZeroBeforeExponent'],'parameters');if(typeof raw.parameters.guardZeroBeforeExponent!=='boolean')throw Error('A boolean zero guard is required');}
  text(raw.rationale,'rationale',2000);if(!Array.isArray(raw.evidence)||!raw.evidence.length||raw.evidence.length>10)throw Error('Outcome evidence required');
  const guidance=raw.family===PROJECT_CHECK_GUIDANCE;
  if(guidance&&raw.scope!=='project')throw Error('Project check guidance is project-only');
  const goal=guidance?this.guidanceGoal(maintenance):null;
  const sourceEvidence=guidance?resolveGuidanceEvidence({c:this.c,maintenanceTaskId:maintenanceId,outcomeIds:raw.evidence}):null;
  const evidence=sourceEvidence??raw.evidence.map(id=>{const o=this.store.maybe('outcome',id);if(!o||o.projectKey!==this.projectKey(maintenance.goalId))throw Error('Unknown or cross-project outcome evidence');const e=this.store.events(o.eventSequence-1,1)[0];if(!e||digest(e)!==o.sourceHash)throw Error('Outcome source integrity failed');return o;});
  if(raw.family==='edit_batch'&&!evidence.some(o=>this.store.get('task',o.taskId).spec.kind==='coding'&&o.kind==='attempt.protocol_failed'&&/truncat|batch.*limit/i.test(o.data.reason??'')))throw Error('An applicable coding batch or truncation failure observation is required');
  if(raw.family==='backoff_zero'&&!evidence.some(o=>{const task=this.c.getTask(o.taskId);return task.spec.kind==='coding'&&task.status==='accepted'&&zeroFailure(task)&&o.kind==='task.reviewed'&&o.data.decision==='revise'&&evidence.some(e=>e.taskId===o.taskId&&e.kind==='task.integrated'&&e.data.checks?.length&&e.data.checks.every(check=>check.passed));}))throw Error('Backoff learning requires the reviewed zero failure and checked accepted integration of its correction');
  const projectKey=raw.scope==='general'?null:this.projectKey(maintenance.goalId),versions=this.store.all('lesson').filter(l=>l.family===raw.family&&l.projectKey===projectKey);
  const parameters=guidance?validateProjectCheckGuidance({parameters:raw.parameters,goal,sourceEvidence}):raw.parameters;
  const recipe={family:raw.family,...parameters},content=guidance?renderProjectCheckGuidance(parameters):raw.family==='edit_batch'?`For coding edits, request at most ${recipe.maxFiles} file(s) and ${recipe.maxBytes} UTF-8 content bytes per submission. Smaller batches reduce response truncation. Continue with the same task and preserve checks, scope and budgets.`:`For JavaScript capped exponential backoff, ${recipe.guardZeroBeforeExponent?'handle a zero base or zero cap before computing the exponent':'use the previous multiplication procedure'}. Zero multiplied by an overflowing exponent is NaN, even for a finite integer attempt. Preserve finite-input validation, the cap, permissions and required checks. This lesson covers the observed arithmetic edge case; it does not establish general model improvement.`;
  const lesson={id:randomUUID(),maintenanceId,goalId:maintenance.goalId,family:raw.family,scope:raw.scope,projectKey,version:Math.max(0,...versions.map(v=>v.version))+1,status:'candidate',recipe,recipeHash:digest(recipe),content,evidence:raw.evidence,applicability:{capability:'coding',version:1,environment:evidence[0].environment,...(raw.family==='backoff_zero'?{nodeMajor:Number(process.versions.node.split('.')[0]),condition:'JavaScript Number arithmetic in capped exponential backoff'}:{})},createdAt:this.c.now()};
  this.store.put('lesson',lesson);
  if(!guidance)this.store.db.prepare('INSERT INTO memory_fts(lesson_id,content) VALUES(?,?)').run(lesson.id,'coding '+content);
  this.c.emit('learning.candidate',maintenance.goalId,maintenanceId,{id:lesson.id,recipeHash:lesson.recipeHash});return lesson;
 });}
 guidanceGoal(maintenance){
  const task=this.c.liveTask(maintenance);
  if(task.spec.kind!=='learning'||task.status!=='codex_active'||task.executionActor!=='codex')throw Error('Active native learning ownership required for project check guidance');
  return this.store.get('goal',task.goalId);
 }
 guidanceEvaluation(lesson,active){
  const goal=this.guidanceGoal(this.c.getTask(lesson.maintenanceId));
  const sourceEvidence=resolveGuidanceEvidence({c:this.c,maintenanceTaskId:lesson.maintenanceId,outcomeIds:lesson.evidence});
  const {family,...parameters}=lesson.recipe;
  const validated=validateProjectCheckGuidance({parameters,goal,sourceEvidence});
  if(family!==PROJECT_CHECK_GUIDANCE||lesson.family!==family||lesson.scope!=='project'||lesson.goalId!==goal.id||
     lesson.projectKey!==this.projectKey(goal.id)||lesson.recipeHash!==digest({family,...validated})||
     lesson.recipeHash!==digest(lesson.recipe)||lesson.content!==renderProjectCheckGuidance(validated))throw Error('Project guidance candidate binding changed');
  const protectedCases=buildProjectGuidanceCases({goal,sourceEvidence});
  const result=evaluateProjectCheckGuidance({candidate:lesson,baseline:active??null,protectedCases,sourceEvidence});
  return {...result,guidanceBinding:digest({lesson,approvalHash:goal.hash,sourceEvidence,baseline:active??null})};
 }
 evaluate(lessonId,key){return this.store.command(key,{op:'learning.evaluate',lessonId},()=>{
  const lesson=this.store.get('lesson',lessonId);this.liveMaintenance(lesson.maintenanceId);if(lesson.status!=='candidate')throw Error('Only candidate procedures can be evaluated');
  const active=this.store.all('lesson').find(l=>l.status==='active'&&l.family===lesson.family&&l.projectKey===lesson.projectKey);
  if(lesson.family===PROJECT_CHECK_GUIDANCE){
   const result={...this.guidanceEvaluation(lesson,active),id:randomUUID(),lessonId,recipeHash:lesson.recipeHash,at:this.c.now()};
   this.store.put('evaluation',result);
   this.c.emit('learning.evaluated',lesson.goalId,lesson.maintenanceId,{id:lessonId,evaluationId:result.id,passed:result.passed});
   return result;
  }
  const baseline=active?.recipe??(lesson.family==='backoff_zero'?{family:'backoff_zero',guardZeroBeforeExponent:false}:{maxFiles:2,maxBytes:24576});
  const results=(lesson.family==='backoff_zero'?backoffCases:cases).map(sample=>({id:sample.id,role:sample.role,baseline:simulate(baseline,sample),candidate:simulate(lesson.recipe,sample)}));
  const totals=key=>({failures:results.reduce((n,r)=>n+r[key].failures,0),requests:results.reduce((n,r)=>n+r[key].requests,0)});
  const integrity=lesson.evidence.every(id=>{const o=this.store.get('outcome',id),e=this.store.events(o.eventSequence-1,1)[0];return e&&digest(e)===o.sourceHash;});
  const result={id:randomUUID(),lessonId,recipeHash:lesson.recipeHash,evaluatorVersion:lesson.family==='backoff_zero'?'backoff-zero-replay-v1':'edit-batch-replay-v1',evidenceKind:'protected_replay',cases:results,baseline:totals('baseline'),candidate:totals('candidate'),boundariesPassed:integrity&&boundaries(),at:this.c.now()};
  result.passed=result.boundariesPassed&&result.candidate.failures===0&&result.baseline.failures>result.candidate.failures;
  this.store.put('evaluation',result);this.c.emit('learning.evaluated',lesson.goalId,lesson.maintenanceId,{id:lessonId,evaluationId:result.id,passed:result.passed});return result;
 });}
 promote(lessonId,key){return this.store.command(key,{op:'learning.promote',lessonId},()=>{
  const lesson=this.store.get('lesson',lessonId),evaluation=this.store.all('evaluation').findLast(e=>e.lessonId===lessonId);this.liveMaintenance(lesson.maintenanceId);
  if(!evaluation?.passed||evaluation.recipeHash!==lesson.recipeHash||lesson.status!=='candidate')throw Error('Passing protected evaluation required for promotion');
  const previous=this.store.all('lesson').filter(l=>l.status==='active'&&l.family===lesson.family&&l.projectKey===lesson.projectKey);
  if(lesson.family===PROJECT_CHECK_GUIDANCE||evaluation.guidanceBinding){
   const current=this.guidanceEvaluation(lesson,previous[0]);
   if(!current.passed||current.evaluatorVersion!==evaluation.evaluatorVersion||
      current.guidanceBinding!==evaluation.guidanceBinding)throw Error('Project guidance needs a fresh passing protected evaluation');
  }
  for(const old of previous){old.status='superseded';this.store.put('lesson',old);}
  lesson.status='active';lesson.evaluationId=evaluation.id;lesson.previousIds=previous.map(l=>l.id);lesson.promotedAt=this.c.now();this.store.put('lesson',lesson);
  this.c.emit('learning.promoted',lesson.goalId,lesson.maintenanceId,{id:lesson.id,before:previous.map(l=>l.recipeHash),after:lesson.recipeHash,evaluationId:evaluation.id});return lesson;
 });}
 retrieve({goalId,query='',capability='coding',environment,permissions}){
  const g=this.store.get('goal',goalId),projectKey=this.projectKey(goalId);
  const terms=(query.match(/[A-Za-z0-9_]{2,}/g)??[]).slice(0,12);
  const guidanceRows=capability==='coding'&&g.manifest.project?this.store.db.prepare(`SELECT data FROM records WHERE kind='lesson'
    AND json_extract(data,'$.family')=? AND json_extract(data,'$.status')='active'
    AND json_extract(data,'$.scope')='project' AND json_extract(data,'$.projectKey')=?
    ORDER BY rowid DESC LIMIT 40`).all(PROJECT_CHECK_GUIDANCE,projectKey):[];
  const sql=`SELECT r.data FROM memory_fts JOIN records r ON r.kind='lesson' AND r.id=memory_fts.lesson_id
    WHERE memory_fts MATCH ? AND json_extract(r.data,'$.status')='active'
    AND (json_extract(r.data,'$.scope')='general' OR json_extract(r.data,'$.projectKey')=?)
    ORDER BY bm25(memory_fts) LIMIT 40`;
  const rows=terms.length?this.store.db.prepare(sql).all(terms.map(t=>'"'+t+'"').join(' OR '),projectKey):[];
  const result=[];
  for(const row of [...guidanceRows,...rows]){
   const l=JSON.parse(row.data);
   if(l.applicability.capability!==capability||l.applicability.version!==g.manifest.capabilities.find(c=>c.id===capability)?.version||l.applicability.environment!==(environment??g.manifest.environment)||l.applicability.nodeMajor&&l.applicability.nodeMajor!==Number(process.versions.node.split('.')[0]))continue;
   const packet=l.family===PROJECT_CHECK_GUIDANCE?
    guidanceMemoryPacket({lesson:l,goal:g,taskContext:{query,capability,environment,permissions}}):
    {id:l.id,version:l.version,recipeHash:l.recipeHash,recipe:l.recipe,content:l.content,evidence:l.evidence,applicability:l.applicability};
   if(!packet)continue;
   if(!fitsMemoryBudget([...result,packet])){
    if(l.family===PROJECT_CHECK_GUIDANCE)continue;
    break;
   }
   result.push(packet);if(result.length===4)break;
  }
  return result;
 }
 pin(taskId){return this.store.tx(()=>{const t=this.store.get('task',taskId);if(t.memory!==undefined)return t.memory;t.memory=this.retrieve({goalId:t.goalId,query:t.spec.objective+' '+t.spec.context+' '+t.spec.kind,capability:t.spec.kind,permissions:t.spec.permissions});this.store.put('task',t);this.c.emit('memory.pinned',t.goalId,t.id,{items:t.memory.map(m=>({id:m.id,version:m.version,recipeHash:m.recipeHash}))});return t.memory;});}
 correct(lessonId,maintenanceId,parameters,rationale,key){
  const old=this.store.get('lesson',lessonId),task=this.c.getTask(maintenanceId);if(old.projectKey&&old.projectKey!==this.projectKey(task.goalId))throw Error('Correction cannot cross project scope');
  const lesson=this.propose(maintenanceId,{family:old.family,scope:old.scope,parameters,evidence:old.evidence,rationale},'correction-proposal-'+digest({key,lessonId,maintenanceId}));
  return this.store.command(key,{op:'learning.correct',lessonId,maintenanceId,parameters,rationale},()=>{const current=this.store.get('lesson',lesson.id);current.correctedFrom=old.id;this.store.put('lesson',current);this.c.emit('learning.corrected',task.goalId,maintenanceId,{before:old.recipeHash,candidate:current.recipeHash,id:current.id,previousId:old.id});return current;});
 }
 quarantine(lessonId,reason,key){return this.store.command(key,{op:'learning.quarantine',lessonId,reason},()=>{const l=this.store.get('lesson',lessonId);text(reason,'reason');l.status='quarantined';l.reason=reason;this.store.put('lesson',l);this.c.emit('learning.quarantined',l.goalId,l.maintenanceId,{id:l.id,reason});return l;});}
 rollback(lessonId,key){return this.store.command(key,{op:'learning.rollback',lessonId},()=>{
  const lesson=this.store.get('lesson',lessonId);
  if(lesson.family===PROJECT_CHECK_GUIDANCE&&lesson.status!=='active')throw Error('Only active project check guidance can roll back');
  lesson.status='superseded';this.store.put('lesson',lesson);
  const restored=[];
  for(const id of lesson.previousIds??[]){
   const old=this.store.get('lesson',id);if(old.status!=='superseded')continue;
   old.status='active';this.store.put('lesson',old);restored.push(id);
  }
  this.c.emit('learning.rolled_back',lesson.goalId,lesson.maintenanceId,{id:lesson.id,restored});return lesson;
 });}
 archive(lessonId,reason,key){return this.store.command(key,{op:'learning.archive',lessonId,reason},()=>{const l=this.store.get('lesson',lessonId);text(reason,'archive reason',2000);l.status='archived';l.archiveReason=reason;l.archivedAt=this.c.now();this.store.put('lesson',l);this.c.emit('learning.archived',l.goalId,l.maintenanceId,{id:l.id,reason});return l;});}
}
