import {randomUUID} from 'node:crypto';
import {normalizeGoal,normalizeTask,digest,text} from './contracts.mjs';

function quiescent(c,goalId){return !c.store.all('task').some(t=>t.goalId===goalId&&(t.owner||['codex_active','legacy_reviewing'].includes(t.status)))&&!['running','uncertain'].includes(c.store.maybe('planning',goalId)?.status);}
export class Goals {
 constructor(c){this.c=c;}
 prepareRevision(input,key){return this.c.store.command(key,{op:'goal.revise.prepare',...input},()=>{
  const g=this.c.store.get('goal',input.goalId);if(['completed','partial'].includes(g.status))throw Error('Goal is terminal');if(g.hash!==input.expectedHash)throw Error('Goal approval changed');
  const manifest=normalizeGoal(input.manifest,this.c.registry);if(manifest.submissionId!==g.manifest.submissionId)throw Error('Goal submission identity cannot change');
  if(manifest.environment!==g.manifest.environment)throw Error('Execution environment cannot change after approval');
  if(g.integration||this.c.store.all('task').some(t=>t.goalId===g.id&&t.startedAt)){
   if(manifest.project?.repo!==g.manifest.project?.repo||manifest.project?.baseCommit!==g.manifest.project?.baseCommit)throw Error('Started work requires explicit stale-base handling in a new goal');
  }
  const revision={id:randomUUID(),goalId:g.id,previousHash:g.hash,version:g.version+1,manifest,hash:digest(manifest),status:'draft',createdAt:this.c.now()};this.c.store.put('goal_revision',revision);this.c.emit('goal.revision_prepared',g.id,null,{id:revision.id,version:revision.version,hash:revision.hash});return revision;
 });}
 activateRevision(input,key){return this.c.store.command(key,{op:'goal.revise.activate',...input},()=>{
  const revision=this.c.store.get('goal_revision',input.revisionId),g=this.c.store.get('goal',revision.goalId);
  if(input.hash!==revision.hash)throw Error('Exact revision approval hash required');if(g.hash!==revision.previousHash||revision.status!=='draft')throw Error('Revision is stale');
  if(!quiescent(this.c,g.id))throw Error('Verify quiescent owners before changing an approved version');
  if(this.c.now()>=g.deadline)throw Error('Original deadline exceeded');
  this.c.store.put('goal_history',{...g,id:`${g.id}-${g.version}`,goalId:g.id});
  g.manifest=revision.manifest;g.hash=revision.hash;g.version=revision.version;g.deadline=Math.min(g.deadline,g.activatedAt+g.manifest.limits.hours*3600000);this.c.store.put('goal',g);
  revision.status='approved';this.c.store.put('goal_revision',revision);this.c.emit('goal.revision_activated',g.id,null,{id:revision.id,hash:g.hash,version:g.version,deadline:g.deadline});return this.c.getGoal(g.id);
 });}
 rebind(input,key){return this.c.store.command(key,{op:'task.rebind',...input},()=>{
  const t=this.c.getTask(input.taskId),g=this.c.store.get('goal',t.goalId);this.c.liveGoal(g);
  if(t.owner||['codex_active','legacy_reviewing','accepted','partial'].includes(t.status))throw Error('Task must be quiescent and unfinished');
  const spec=normalizeTask(input.spec??t.spec,g.manifest,this.c.registry);if(spec.submissionId!==t.spec.submissionId||spec.kind!==t.spec.kind)throw Error('Task identity/kind cannot change');
  if(t.startedAt&&spec.actor!==t.spec.actor)throw Error('Started actor changes require explicit takeover');
  for(const [name,limit] of Object.entries(spec.limits))if(limit>t.spec.limits[name])throw Error('Rebind cannot refresh assignment limits');
  const tasks=this.c.store.all('task').filter(x=>x.goalId===g.id),graph=new Map(tasks.map(x=>[x.id,x.id===t.id?spec.dependsOn:x.spec.dependsOn]));
  const visited=new Set(),visiting=new Set(),visit=id=>{if(visiting.has(id))throw Error('Dependency cycle');if(visited.has(id))return;if(!graph.has(id))throw Error('Dependency outside goal');visiting.add(id);graph.get(id).forEach(visit);visiting.delete(id);visited.add(id);};visit(t.id);
  t.history??=[];t.history.push({goalVersion:t.goalVersion,spec:t.spec,hash:t.hash,at:this.c.now()});t.spec=spec;t.hash=digest(spec);t.goalVersion=g.version;t.deadline=t.deadline?Math.min(t.deadline,g.deadline):null;t.status=spec.actor==='codex'?'codex_ready':'queued';t.stopRequested=t.pauseRequested=false;
  this.c.store.put('task',t);this.c.emit('task.rebound',g.id,t.id,{goalVersion:t.goalVersion,hash:t.hash});return this.c.getTask(t.id);
 });}
 finalize(input,key){return this.c.store.command(key,{op:'goal.finalize',...input},()=>{
  const g=this.c.store.get('goal',input.goalId);text(input.summary,'summary',12000);if(g.status==='draft'||['completed','partial'].includes(g.status))throw Error('Goal is not ready for finalization');
  const tasks=this.c.store.all('task').filter(t=>t.goalId===g.id);if(!tasks.length||!quiescent(this.c,g.id))throw Error('Goal has unfinished owners or no accepted work');
  const unfinished=tasks.filter(t=>t.status!=='accepted');if(unfinished.length&&!input.partial)throw Error('Goal has unfinished tasks; accepted work is required');
  if(unfinished.some(t=>['queued','suspended','running','codex_ready'].includes(t.status)))throw Error('Stop unfinished work before partial finalization');
  const spending={model:this.c.store.spent(g.id).model??0,search:0,download:0,codexReview:0};for(const t of tasks)for(const [kind,n] of Object.entries(this.c.getTask(t.id).spent))spending[kind]=(spending[kind]??0)+n;
  const receipt={schema:1,goalId:g.id,approvalHash:g.hash,goalVersion:g.version,mode:g.manifest.mode,capabilities:g.manifest.capabilities,environment:g.manifest.environment,deadline:g.deadline,finishedAt:this.c.now(),summary:input.summary,spending,nativeCodexUsage:'host accounting; token totals unavailable',tasks:tasks.map(t=>({id:t.id,hash:t.hash,status:t.status,goalVersion:t.goalVersion,attempts:t.attempts,reviews:t.reviews,deadline:t.deadline,resultHash:digest(t.result),integration:t.integration??null,memory:(t.memory??[]).map(x=>({id:x.id,version:x.version,recipeHash:x.recipeHash}))}))};
  g.status=unfinished.length?'partial':'completed';g.receipt=receipt;g.receiptHash=digest(receipt);this.c.store.put('goal',g);this.c.emit('goal.finalized',g.id,null,{status:g.status,receiptHash:g.receiptHash});return {goalId:g.id,status:g.status,receipt,receiptHash:g.receiptHash};
 });}
}
