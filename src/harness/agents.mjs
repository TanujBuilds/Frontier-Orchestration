import { randomUUID } from 'node:crypto';
import { digest } from './contracts.mjs';
import { normalizeAgentRegistration,normalizeProgressReport,normalizeHelpRequest } from './collaboration-contracts.mjs';

// This allowlist describes host capability, not proof that a model executed.
function nativeModelConfig(config){
 const models=config.nativeModels??[],roles=config.nativeRoleModels??{};
 const valid=value=>typeof value==='string'&&value===value.trim()&&value.length>0&&value.length<=200;
 if(!Array.isArray(models)||models.length>100||models.some(x=>!valid(x))||new Set(models).size!==models.length)throw Error('Invalid native model configuration: nativeModels must be a unique string array');
 if(!roles||typeof roles!=='object'||Array.isArray(roles)||Object.getPrototypeOf(roles)!==Object.prototype||Object.entries(roles).some(([role,model])=>!['implementer','explorer','reviewer','supervisor'].includes(role)||!valid(model)||!models.includes(model)))throw Error('Invalid native role model configuration');
 return {models,roles};
}

export class Agents {
 constructor({c,config={}}){this.c=c;this.config=config;}
 register(input,key){return this.c.store.command(key,{op:'agent.register',...input},()=>{
  const caller=normalizeAgentRegistration(input);
  const previous=caller.hostAgentId?this.c.store.all('agent').find(a=>a.hostAgentId===caller.hostAgentId):null;
  // Correlation replays preserve a persisted historical identity. Inferring a
  // host after upgrade must not change the old no-host registration's digest.
  const historicalReplay=previous&&!Object.hasOwn(previous,'hostId')&&input.hostId===undefined;
  const selectedHost=this.c.selectedHost??this.config.hostId;
  if(selectedHost&&input.hostId!==undefined&&input.hostId!==selectedHost)throw Error('Reported host identity differs from selected host');
  const registration=normalizeAgentRegistration(!historicalReplay&&selectedHost&&input.hostId===undefined?{...input,hostId:selectedHost}:input),t=this.c.getTask(registration.taskId),g=this.c.store.get('goal',t.goalId);this.c.liveTask(t,{allowStopped:true});
  if(!g.manifest.mode.actors.includes(registration.actor))throw Error('Mode prohibits registered actor');
  // An identical historical correlation is a metadata replay, not a request to
  // apply newly configured model defaults or to rewrite its persisted identity.
  if(historicalReplay){
   // Reconstruct only the default originally applied to an omitted request.
   // Changed role, task, explicit model or resolved identity still conflicts.
   const historical=previous.modelSource==='role_default'&&!caller.model.requested
    ?{...caller,model:{...caller.model,requested:previous.model.requested}}:caller;
   if(previous.registrationHash===digest(historical))return previous;
  }
  let modelSource=registration.model.requested?'explicit':'inherited';
  if(registration.actor==='codex'&&(!registration.hostId||registration.hostId==='codex')){
   const {models,roles}=nativeModelConfig(this.config);
   const fallback=roles[registration.role];
   if(!registration.model.requested&&fallback){registration.model.requested=fallback;modelSource='role_default';}
   for(const model of [registration.model.requested,registration.model.resolved].filter(Boolean))if(!models.includes(model))throw Error(`Native model unavailable or unsupported: ${model}`);
  }
  if(registration.actor==='codex'&&(!registration.hostId||registration.hostId==='codex')&&registration.model.requested&&registration.model.resolved&&registration.model.requested!==registration.model.resolved)throw Error('Native requested/resolved model mismatch; host aliases are unsupported');
  if(previous){if(previous.registrationHash!==digest(registration))throw Error('Host agent correlation already belongs to another registration');return previous;}
  if(registration.hostId&&!registration.model.requested&&!registration.model.resolved)modelSource='unknown';
  const identity=registration.hostId?{modelProvenance:registration.model.resolved?'reported':'unknown'}:{};
  const agent={...registration,...identity,id:randomUUID(),goalId:t.goalId,registrationHash:digest(registration),modelSource,registeredAt:this.c.now(),lastReport:null,accounting:{tokens:null,source:'unavailable'}};
  this.c.store.put('agent',agent);this.c.emit('agent.registered',t.goalId,t.id,{agentId:agent.id,actor:agent.actor,role:agent.role,model:agent.model,modelSource,...(agent.hostId?{hostId:agent.hostId,modelProvenance:agent.modelProvenance}:{})});return agent;
 });}
 report(input,key){return this.c.store.command(key,{op:'agent.report',...input},()=>{
  const report=normalizeProgressReport(input),agent=this.c.store.get('agent',report.agentId);
  agent.lastReport={...report,at:this.c.now(),provenance:'reported'};this.c.store.put('agent',agent);
  this.c.emit('agent.reported',agent.goalId,agent.taskId,agent.lastReport);return agent;
 });}
 list({goalId}={}){return this.c.store.all('agent').filter(a=>!goalId||a.goalId===goalId);}
 linkHelp(input,key){return this.c.store.command(key,{op:'help.link',...input},()=>{
  const link=normalizeHelpRequest(input),parent=this.c.getTask(link.taskId),helper=this.c.getTask(link.helperTaskId),g=this.c.store.get('goal',parent.goalId);
  this.c.liveTask(parent);this.c.liveTask(helper);
  if(g.manifest.mode.review!=='operator')throw Error('Mode prohibits supervisor help link');
  if(parent.goalId!==helper.goalId)throw Error('Helper must belong to the same goal');
  if(parent.owner||parent.status!=='awaiting_supervisor'||parent.questions.at(-1)?.id!==link.questionId||parent.answers.some(a=>a.questionId===link.questionId))throw Error('A live quiescent supervisor question is required');
  const links=this.c.store.all('help_link'),seen=new Set();
  const depends=id=>{if(id===parent.id)return true;if(seen.has(id))return false;seen.add(id);const t=this.c.getTask(id);return [...t.spec.dependsOn,...links.filter(l=>l.taskId===id&&l.status==='waiting').map(l=>l.helperTaskId)].some(depends);};
  if(depends(helper.id))throw Error('Helper dependency cycle: helper depends on blocked parent');
  const old=links.find(l=>l.taskId===parent.id&&l.questionId===link.questionId);
  if(old){if(digest({...link})!==old.linkHash)throw Error('Question already has a linked helper');return old;}
  const saved={...link,id:randomUUID(),goalId:g.id,status:'waiting',linkHash:digest(link),at:this.c.now()};
  this.c.store.put('help_link',saved);this.c.emit('help.linked',g.id,parent.id,{id:saved.id,questionId:link.questionId,helperTaskId:helper.id,reason:link.reason});return saved;
 });}
}
