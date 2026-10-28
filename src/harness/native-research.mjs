import path from 'node:path';
import {ResearchClient} from './research.mjs';
import {Integration} from './integration.mjs';

export class NativeResearch {
 constructor({c,config={},rpc,collect}){this.c=c;this.config=config;this.effects=new Integration({c,config});const client=new ResearchClient(config.research??{});this.rpc=rpc??(r=>client.call(r));this.collect=collect??((p,o)=>client.call(p,o));}
 async start(input,key){return this.effects.effect(key,{op:'research.native.start',...input},async()=>{
  let t=this.c.getTask(input.taskId),g=this.c.store.get('goal',t.goalId);this.c.liveGoal(g);
  if(t.spec.actor!=='codex'||t.spec.kind!=='research'||!g.manifest.mode.actors.includes('codex'))throw Error('Mode prohibits native research');
  if(g.manifest.environment!==(this.config.environment??'live'))throw Error('Approved environment differs from research provider');
  if(t.status==='codex_active'&&t.checkpoint.remoteJobId)return t;
  if(!['codex_ready','codex_active'].includes(t.status)||!t.spec.dependsOn.every(id=>this.c.getTask(id).status==='accepted'))throw Error('Native research is not ready');
  this.c.store.tx(()=>{const current=this.c.store.get('task',t.id);current.status='codex_active';current.executionActor='codex';current.startedAt??=this.c.now();current.deadline??=Math.min(g.deadline,current.startedAt+current.spec.limits.seconds*1000);this.c.store.put('task',current);this.c.learning.pin(t.id);});t=this.c.getTask(t.id);
  const manifest={schema:2,executor:'operator',submission_id:t.id,question:t.spec.objective,mode:g.manifest.environment,
   scope:{seed_urls:t.spec.scope.seedUrls,include_domains:t.spec.scope.includeDomains,exclude_domains:t.spec.scope.excludeDomains},
   limits:{seconds:t.spec.limits.seconds,searches:t.spec.limits.searches,downloads:t.spec.limits.downloads,model_calls:t.spec.limits.modelCalls},
   not_after:Math.floor(t.deadline/1000),collaboration:{supervisor:'codex',max_questions:t.spec.limits.questions}};
  const prepared=await this.rpc({command:'prepare_manifest',manifest}),remote=await this.rpc({command:'submit',manifest:prepared.manifest,approved_hash:prepared.hash});
  this.c.store.tx(()=>{const current=this.c.store.get('task',t.id);current.checkpoint={...current.checkpoint,remoteJobId:remote.id,remoteHash:prepared.hash};this.c.store.put('task',current);this.c.emit('research.native_started',g.id,t.id,{remoteJobId:remote.id,remoteHash:prepared.hash});});return this.c.getTask(t.id);
 });}
 async action(input,key){return this.effects.effect(key,{op:'research.native.action',...input},async()=>{
  const t=this.c.getTask(input.taskId),g=this.c.store.get('goal',t.goalId);this.c.liveGoal(g);
  if(t.spec.actor!=='codex'||t.spec.kind!=='research'||t.status!=='codex_active'||!g.manifest.mode.actors.includes('codex'))throw Error('Native research ownership/mode mismatch');
  if(t.pauseRequested||t.stopRequested)throw Error('Native research is paused or stopped');
  if(!['search','read','finish'].includes(input.action?.action))throw Error('Unsupported deterministic research action');
  const result=await this.rpc({command:'operator_action',job:t.checkpoint.remoteJobId,action:input.action,idempotency_key:key});
  const status=await this.rpc({command:'status',job:t.checkpoint.remoteJobId});
  if(status.manifest_hash!==t.checkpoint.remoteHash||status.counters.model!==0)throw Error('Native research evidence or actor mismatch');
  this.c.store.tx(()=>{const current=this.c.store.get('task',t.id);current.remoteSpent=status.counters;this.c.store.put('task',current);this.c.emit('research.native_action',g.id,t.id,{action:input.action.action,counters:status.counters});});
  if(['completed','partial'].includes(status.status)){
   const packet=await this.rpc({command:'export',job:t.checkpoint.remoteJobId}),collected=await this.collect(packet,path.join(this.c.store.root,'research-results'));
   if(!collected.checksums_verified)throw Error('Research checksums were not verified');
   this.c.store.tx(()=>{const current=this.c.store.get('task',t.id);current.status=status.status==='completed'?'accepted':'partial';current.result={directory:collected.directory,checksumsVerified:true,remoteJobId:status.id,modelSelfCheck:'not_run_operator_mode'};this.c.store.put('task',current);this.c.emit('task.native_finished',g.id,t.id,current.result);});return this.c.getTask(t.id);
  }
  return result;
 });}
}
