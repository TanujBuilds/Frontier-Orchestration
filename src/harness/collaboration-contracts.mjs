import path from 'node:path';
import {keys,identifier,integer,text,canonical} from './contracts.mjs';

// Metadata contracts only. State transitions and permissions belong to the
// coordinator; a reported actor, model or status grants no authority.
export const COLLABORATION_VERSION=1;
export const OBSERVER_LIMITS=Object.freeze({pageDefault:50,pageMax:200,evidenceBytes:32768});
const copy=value=>JSON.parse(canonical(value));
function version(raw,fields,label){keys(raw,['version',...fields],label);if(raw.version!==COLLABORATION_VERSION)throw Error(`Unsupported ${label} version`);}
function choice(value,values,label){if(!values.includes(value))throw Error(`Invalid ${label}`);return value;}
function nullable(value,fn){return value===undefined||value===null?null:fn(value);}
function ids(raw,label){if(!Array.isArray(raw)||raw.length>100)throw Error(`Invalid ${label}`);const out=raw.map(x=>identifier(x,label));if(new Set(out).size!==out.length)throw Error(`Duplicate ${label}`);return out;}
function sha(value,label){if(typeof value!=='string'||!/^[a-f0-9]{40}$/.test(value))throw Error(`Invalid ${label}`);return value;}
export function normalizeModelSelection(raw={}){
 keys(raw,['requested','resolved'],'model selection');
 return {requested:nullable(raw.requested,x=>text(x,'requested model',200)),resolved:nullable(raw.resolved,x=>text(x,'resolved model',200))};
}
export function normalizeAgentRegistration(raw){
 version(raw,['taskId','hostAgentId','role','actor','model'],'agent registration');
 return {version:1,taskId:identifier(raw.taskId,'taskId'),hostAgentId:nullable(raw.hostAgentId,x=>text(x,'hostAgentId',120)),role:choice(raw.role,['implementer','explorer','reviewer','supervisor'],'role'),actor:choice(raw.actor,['codex','deepseek'],'actor'),model:normalizeModelSelection(raw.model??{})};
}
export function normalizeProgressReport(raw){
 version(raw,['agentId','status','summary','evidenceIds'],'progress report');
 return {version:1,agentId:identifier(raw.agentId,'agentId'),status:choice(raw.status,['running','waiting','completed','blocked','stopped'],'reported status'),summary:text(raw.summary,'progress summary',2000),evidenceIds:ids(raw.evidenceIds??[],'evidence ID')};
}
export function normalizeNativeCandidate(raw){
 version(raw,['taskId','baseCommit','worktree','commit','status','checks'],'native candidate');
 text(raw.worktree,'worktree',4096);if(!path.isAbsolute(raw.worktree))throw Error('Candidate worktree must be absolute');
 if(!Array.isArray(raw.checks)||raw.checks.length>100||Buffer.byteLength(canonical(raw.checks))>512*1024)throw Error('Invalid candidate check metadata');
 return {version:1,taskId:identifier(raw.taskId,'taskId'),baseCommit:sha(raw.baseCommit,'base commit'),worktree:raw.worktree,commit:nullable(raw.commit,x=>sha(x,'candidate commit')),status:choice(raw.status,['active','awaiting_review','ready_to_integrate','integrated','partial'],'candidate status'),checks:copy(raw.checks)};
}
export function normalizeHelpRequest(raw){
 version(raw,['taskId','questionId','helperTaskId','reason'],'help link');
 const link={version:1,taskId:identifier(raw.taskId,'taskId'),questionId:identifier(raw.questionId,'questionId'),helperTaskId:identifier(raw.helperTaskId,'helperTaskId'),reason:text(raw.reason,'help reason',2000)};
 if(link.taskId===link.helperTaskId)throw Error('A task cannot help itself');return link;
}
export function normalizeObserverQuery(raw={}){
 keys(raw,['goalId','actor','after','limit'],'observer query');
 return {goalId:nullable(raw.goalId,x=>identifier(x,'goalId')),actor:nullable(raw.actor,x=>choice(x,['codex','deepseek'],'actor')),after:integer(raw.after??0,'after',0,Number.MAX_SAFE_INTEGER),limit:integer(raw.limit??OBSERVER_LIMITS.pageDefault,'limit',1,OBSERVER_LIMITS.pageMax)};
}
export function normalizeActivityEvent(raw){
 version(raw,['seq','at','goalId','taskId','agentId','requestId','type','actor','provenance','summary','artifactIds'],'activity event');
 return {version:1,seq:integer(raw.seq,'sequence',1,Number.MAX_SAFE_INTEGER),at:integer(raw.at,'timestamp',0,Number.MAX_SAFE_INTEGER),goalId:nullable(raw.goalId,x=>identifier(x,'goalId')),taskId:nullable(raw.taskId,x=>identifier(x,'taskId')),agentId:nullable(raw.agentId,x=>identifier(x,'agentId')),requestId:nullable(raw.requestId,x=>identifier(x,'requestId')),type:text(raw.type,'event type',120),actor:nullable(raw.actor,x=>choice(x,['codex','deepseek'],'actor')),provenance:choice(raw.provenance,['captured','reported','coordinator'],'provenance'),summary:text(raw.summary,'event summary',2000),artifactIds:ids(raw.artifactIds??[],'artifact ID')};
}
