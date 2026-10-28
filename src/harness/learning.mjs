import { randomUUID } from 'node:crypto';
import { keys,integer,text,digest,Registry,normalizeGoal,normalizeTask } from './contracts.mjs';

const cases=Object.freeze([
 {id:'regression-response-size',role:'regression',files:[16000,16000]},
 {id:'heldout-small-files',role:'heldout',files:[1000,1500,2000]},
 {id:'heldout-mixed-files',role:'heldout',files:[12000,10000,5000]},
]);
function simulate(recipe,sample){let requests=0,failures=0;for(let i=0;i<sample.files.length;i+=recipe.maxFiles){requests++;if(sample.files.slice(i,i+recipe.maxFiles).reduce((a,b)=>a+b,0)>recipe.maxBytes)failures++;}return {requests,failures,passed:failures===0};}
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
  const outcome={id,taskId,goalId:task.goalId,projectKey:this.projectKey(task.goalId),eventSequence,sourceHash:digest(event),kind:event.type,status:task.status,data:event.data,spent:task.spent,attempts:task.attempts,environment:this.store.get('goal',task.goalId).manifest.environment,at:this.c.now()};
  this.store.put('outcome',outcome);
  if(event.type==='attempt.protocol_failed'&&/truncat|batch.*limit/i.test(event.data.reason??''))for(const pinned of task.memory??[]){const lesson=this.store.maybe('lesson',pinned.id);if(lesson?.status==='active'&&lesson.family==='edit_batch')this.quarantine(lesson.id,`Observed recurrence in outcome ${id}`,`learning-regression-${id}`);}
  return outcome;
 }
 liveMaintenance(taskId){
  const t=this.store.get('task',taskId),g=this.store.get('goal',t.goalId);this.c.liveGoal(g);
  if(t.spec.kind!=='learning'||!['queued','codex_ready','running','codex_active'].includes(t.status)||t.pauseRequested||t.stopRequested)throw Error('Learning assignment is not active');
  t.startedAt??=this.c.now();t.deadline??=Math.min(g.deadline,t.startedAt+t.spec.limits.seconds*1000);
  if(this.c.now()>=t.deadline)throw Error('Learning deadline exceeded');this.store.put('task',t);return t;
 }
 propose(maintenanceId,raw,key){return this.store.command(key,{op:'learning.propose',maintenanceId,raw},()=>{
  const maintenance=this.c.getTask(maintenanceId);if(maintenance.spec.kind!=='learning')throw Error('A budgeted learning assignment is required');
  this.liveMaintenance(maintenanceId);
  keys(raw,['family','scope','parameters','evidence','rationale'],'lesson');
  if(raw.family!=='edit_batch')throw Error('This procedure needs a registered protected evaluator');
  if(!['project','general'].includes(raw.scope))throw Error('Invalid lesson scope');
  keys(raw.parameters,['maxFiles','maxBytes'],'parameters');integer(raw.parameters.maxFiles,'maxFiles',1,2);integer(raw.parameters.maxBytes,'maxBytes',100,24576);
  text(raw.rationale,'rationale',2000);if(!Array.isArray(raw.evidence)||!raw.evidence.length||raw.evidence.length>10)throw Error('Outcome evidence required');
  const evidence=raw.evidence.map(id=>{const o=this.store.maybe('outcome',id);if(!o||o.projectKey!==this.projectKey(maintenance.goalId))throw Error('Unknown or cross-project outcome evidence');const e=this.store.events(o.eventSequence-1,1)[0];if(!e||digest(e)!==o.sourceHash)throw Error('Outcome source integrity failed');return o;});
  if(!evidence.some(o=>o.kind==='attempt.protocol_failed'&&/truncat|batch.*limit/i.test(o.data.reason??'')))throw Error('An applicable batch or truncation failure observation is required');
  const projectKey=raw.scope==='general'?null:this.projectKey(maintenance.goalId),versions=this.store.all('lesson').filter(l=>l.family===raw.family&&l.projectKey===projectKey);
  const recipe={family:raw.family,...raw.parameters},content=`For coding edits, request at most ${recipe.maxFiles} file(s) and ${recipe.maxBytes} UTF-8 content bytes per submission. Smaller batches reduce response truncation. Continue with the same task and preserve checks, scope and budgets.`;
  const lesson={id:randomUUID(),maintenanceId,goalId:maintenance.goalId,family:raw.family,scope:raw.scope,projectKey,version:Math.max(0,...versions.map(v=>v.version))+1,status:'candidate',recipe,recipeHash:digest(recipe),content,evidence:raw.evidence,applicability:{capability:'coding',version:1,environment:evidence[0].environment},createdAt:this.c.now()};
  this.store.put('lesson',lesson);this.store.db.prepare('INSERT INTO memory_fts(lesson_id,content) VALUES(?,?)').run(lesson.id,'coding edits truncation '+content);this.c.emit('learning.candidate',maintenance.goalId,maintenanceId,{id:lesson.id,recipeHash:lesson.recipeHash});return lesson;
 });}
 evaluate(lessonId,key){return this.store.command(key,{op:'learning.evaluate',lessonId},()=>{
  const lesson=this.store.get('lesson',lessonId);this.liveMaintenance(lesson.maintenanceId);if(lesson.status!=='candidate')throw Error('Only candidate procedures can be evaluated');
  const active=this.store.all('lesson').find(l=>l.status==='active'&&l.family===lesson.family&&l.projectKey===lesson.projectKey),baseline=active?.recipe??{maxFiles:2,maxBytes:24576};
  const results=cases.map(sample=>({id:sample.id,role:sample.role,baseline:simulate(baseline,sample),candidate:simulate(lesson.recipe,sample)}));
  const totals=key=>({failures:results.reduce((n,r)=>n+r[key].failures,0),requests:results.reduce((n,r)=>n+r[key].requests,0)});
  const result={id:randomUUID(),lessonId,recipeHash:lesson.recipeHash,evaluatorVersion:'edit-batch-replay-v1',evidenceKind:'protected_replay',cases:results,baseline:totals('baseline'),candidate:totals('candidate'),boundariesPassed:boundaries(),at:this.c.now()};
  result.passed=result.boundariesPassed&&result.candidate.failures===0&&result.baseline.failures>result.candidate.failures;
  this.store.put('evaluation',result);this.c.emit('learning.evaluated',lesson.goalId,lesson.maintenanceId,{id:lessonId,evaluationId:result.id,passed:result.passed});return result;
 });}
 promote(lessonId,key){return this.store.command(key,{op:'learning.promote',lessonId},()=>{
  const lesson=this.store.get('lesson',lessonId),evaluation=this.store.all('evaluation').findLast(e=>e.lessonId===lessonId);this.liveMaintenance(lesson.maintenanceId);
  if(!evaluation?.passed||evaluation.recipeHash!==lesson.recipeHash||lesson.status!=='candidate')throw Error('Passing protected evaluation required for promotion');
  const previous=this.store.all('lesson').filter(l=>l.status==='active'&&l.family===lesson.family&&l.projectKey===lesson.projectKey);
  for(const old of previous){old.status='superseded';this.store.put('lesson',old);}
  lesson.status='active';lesson.evaluationId=evaluation.id;lesson.previousIds=previous.map(l=>l.id);lesson.promotedAt=this.c.now();this.store.put('lesson',lesson);
  this.c.emit('learning.promoted',lesson.goalId,lesson.maintenanceId,{id:lesson.id,before:previous.map(l=>l.recipeHash),after:lesson.recipeHash,evaluationId:evaluation.id});return lesson;
 });}
 retrieve({goalId,query='',capability='coding',environment}){
  const g=this.store.get('goal',goalId),terms=(query.match(/[A-Za-z0-9_]{2,}/g)??[]).slice(0,12);if(!terms.length)return [];
  const sql=`SELECT r.data FROM memory_fts JOIN records r ON r.kind='lesson' AND r.id=memory_fts.lesson_id WHERE memory_fts MATCH ? AND json_extract(r.data,'$.status')='active' AND (json_extract(r.data,'$.scope')='general' OR json_extract(r.data,'$.projectKey')=?) ORDER BY bm25(memory_fts) LIMIT 40`;
  const rows=this.store.db.prepare(sql).all(terms.map(t=>'"'+t+'"').join(' OR '),this.projectKey(goalId));const result=[];
  for(const row of rows){const l=JSON.parse(row.data);if(l.applicability.capability!==capability||l.applicability.environment!==(environment??g.manifest.environment))continue;const packet={id:l.id,version:l.version,recipeHash:l.recipeHash,recipe:l.recipe,content:l.content,evidence:l.evidence,applicability:l.applicability};if(Buffer.byteLength(JSON.stringify([...result,packet]))>8192)break;result.push(packet);if(result.length===4)break;}
  return result;
 }
 pin(taskId){return this.store.tx(()=>{const t=this.store.get('task',taskId);if(t.memory!==undefined)return t.memory;t.memory=this.retrieve({goalId:t.goalId,query:t.spec.objective+' '+t.spec.context+' '+t.spec.kind,capability:t.spec.kind});this.store.put('task',t);this.c.emit('memory.pinned',t.goalId,t.id,{items:t.memory.map(m=>({id:m.id,version:m.version,recipeHash:m.recipeHash}))});return t.memory;});}
 quarantine(lessonId,reason,key){return this.store.command(key,{op:'learning.quarantine',lessonId,reason},()=>{const l=this.store.get('lesson',lessonId);text(reason,'reason');l.status='quarantined';l.reason=reason;this.store.put('lesson',l);this.c.emit('learning.quarantined',l.goalId,l.maintenanceId,{id:l.id,reason});return l;});}
 rollback(lessonId,key){return this.store.command(key,{op:'learning.rollback',lessonId},()=>{const l=this.store.get('lesson',lessonId);l.status='superseded';this.store.put('lesson',l);for(const id of l.previousIds??[]){const old=this.store.get('lesson',id);old.status='active';this.store.put('lesson',old);}this.c.emit('learning.rolled_back',l.goalId,l.maintenanceId,{id:l.id,restored:l.previousIds??[]});return l;});}
}
