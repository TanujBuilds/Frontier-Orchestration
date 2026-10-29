import { randomUUID } from 'node:crypto';
import { digest } from './contracts.mjs';
import { normalizeAgentRegistration,normalizeProgressReport,normalizeHelpRequest } from './collaboration-contracts.mjs';

export class Agents {
 constructor({c,config={}}){this.c=c;this.config=config;}
 register(input,key){return this.c.store.command(key,{op:'agent.register',...input},()=>{
  const registration=normalizeAgentRegistration(input),t=this.c.getTask(registration.taskId),g=this.c.store.get('goal',t.goalId);this.c.liveTask(t,{allowStopped:true});
  if(!g.manifest.mode.actors.includes(registration.actor))throw Error('Mode prohibits registered actor');
  let modelSource=registration.model.requested?'explicit':'inherited';
  if(registration.actor==='codex'){
   const fallback=this.config.nativeRoleModels?.[registration.role];
   if(!registration.model.requested&&fallback){registration.model.requested=fallback;modelSource='role_default';}
   for(const model of [registration.model.requested,registration.model.resolved].filter(Boolean))if(!this.config.nativeModels?.includes(model))throw Error(`Native model unavailable or unsupported: ${model}`);
  }
  const previous=registration.hostAgentId?this.c.store.all('agent').find(a=>a.hostAgentId===registration.hostAgentId):null;
  if(previous){if(previous.registrationHash!==digest(registration))throw Error('Host agent correlation already belongs to another registration');return previous;}
  const agent={...registration,id:randomUUID(),goalId:t.goalId,registrationHash:digest(registration),modelSource,registeredAt:this.c.now(),lastReport:null,accounting:{tokens:null,source:'unavailable'}};
  this.c.store.put('agent',agent);this.c.emit('agent.registered',t.goalId,t.id,{agentId:agent.id,actor:agent.actor,role:agent.role,model:agent.model,modelSource});return agent;
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
