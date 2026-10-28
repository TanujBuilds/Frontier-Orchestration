import { createHash } from 'node:crypto';
import path from 'node:path';
import { matches, relativePath, validatePermissions } from '../project/contracts.mjs';

export function canonical(value) {
 if (value===null||typeof value!=='object') {
  if(typeof value==='number'&&!Number.isFinite(value)) throw Error('Non-finite JSON value');
  if(value===undefined) throw Error('Undefined JSON value');
  return JSON.stringify(value);
 }
 return Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function keys(value,allowed,label='object') {
 if(!value||typeof value!=='object'||Array.isArray(value)) throw Error(`${label} must be an object`);
 for(const k of Object.keys(value)) if(!allowed.includes(k)) throw Error(`${label}: unknown field ${k}`);
}
export function text(value,label,max=20000) {if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`Invalid ${label}`);return value;}
export function identifier(value,label='id') {text(value,label,120);if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value))throw Error(`Invalid ${label}`);return value;}
export function integer(value,label,min,max) {if(!Number.isInteger(value)||value<min||value>max)throw Error(`Invalid ${label}: expected ${min}..${max}`);return value;}
function strings(v,label,{empty=false,max=100}={}) {if(!Array.isArray(v)||(!empty&&!v.length)||v.length>max)throw Error(`Invalid ${label}`);v.forEach(x=>text(x,label));if(new Set(v).size!==v.length)throw Error(`Duplicate ${label}`);return [...v];}
const clone=x=>structuredClone(x);
const baseModes=[
 {id:'collaborative',version:1,planner:'codex',actors:['codex','deepseek'],review:'operator',capabilities:['coding','research','consult','learning']},
 {id:'deepseek_only',version:1,planner:'deepseek',actors:['deepseek'],review:'checks',capabilities:['coding','research','consult','learning']},
 {id:'codex_only',version:1,planner:'codex',actors:['codex'],review:'operator',capabilities:['coding','research','consult','learning']},
 {id:'overnight_review',version:1,planner:'deepseek',actors:['deepseek'],review:'legacy',capabilities:['coding']},
];
export class Registry {
 constructor(){
  this.capabilities=new Map();this.modes=new Map();this.workflows=new Map();
  for(const id of ['coding','research','consult','learning'])this.capabilities.set(`${id}@1`,{id,version:1,actors:['deepseek','codex'],handler:id});
  for(const m of baseModes)this.registerMode(m);
 }
 registerMode(raw){
  keys(raw,['id','version','planner','actors','review','capabilities'],'mode');
  const m=clone(raw);identifier(m.id);integer(m.version,'version',1,10000);
  strings(m.actors,'actors');if(m.actors.some(x=>!['codex','deepseek'].includes(x))||!m.actors.includes(m.planner))throw Error('Invalid planner/actor');
  if(!['operator','checks','legacy'].includes(m.review))throw Error('Invalid review policy');
  strings(m.capabilities,'capabilities');for(const id of m.capabilities)if(!this.capabilities.has(`${id}@1`))throw Error(`Unknown capability ${id}`);
  if(m.review==='legacy'&&(m.actors.join()!=='deepseek'||m.capabilities.join()!=='coding'))throw Error('Legacy capability policy is coding-only');
  const key=`${m.id}@${m.version}`;if(this.modes.has(key))throw Error('Mode version already exists');this.modes.set(key,m);return clone(m);
 }
 mode(id='collaborative',version){const choices=[...this.modes.values()].filter(m=>m.id===id&&(!version||m.version===version)).sort((a,b)=>b.version-a.version);if(!choices.length)throw Error('Unknown mode');return clone(choices[0]);}
 snapshot(){return {capabilities:clone([...this.capabilities.values()]),modes:clone([...this.modes.values()]),workflows:clone([...this.workflows.values()])};}
 registerWorkflow(raw){keys(raw,['id','version','mode','tasks'],'workflow');identifier(raw.id);integer(raw.version,'version',1,10000);this.mode(raw.mode);if(!Array.isArray(raw.tasks)||!raw.tasks.length||raw.tasks.length>10)throw Error('Invalid workflow tasks');for(const t of raw.tasks){keys(t,['key','kind','dependsOn','objective','acceptance'],'workflow task');identifier(t.key);if(!this.capabilities.has(`${t.kind}@1`))throw Error('Unknown capability');text(t.objective,'objective');strings(t.acceptance,'acceptance');}const key=`${raw.id}@${raw.version}`;if(this.workflows.has(key))throw Error('Workflow already exists');this.workflows.set(key,clone(raw));return clone(raw);}
}
export function sourceScope(raw={}) {
 keys(raw,['seedUrls','includeDomains','excludeDomains'],'source scope');
 const scope={seedUrls:[],includeDomains:[],excludeDomains:[],...raw};
 for(const k of Object.keys(scope))strings(scope[k],k,{empty:true,max:100});
 for(const url of scope.seedUrls){let u;try{u=new URL(url);}catch{throw Error('Invalid source URL');}if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))throw Error('Public HTTPS source URL required');}
 for(const d of [...scope.includeDomains,...scope.excludeDomains])if(!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(d))throw Error('Invalid source domain');
 return clone(scope);
}
export function normalizeGoal(raw,registry=new Registry()){
 keys(raw,['submissionId','objective','acceptance','project','mode','modeVersion','scope','limits','environment'],'goal');
 const environment=raw.environment??'live';if(!['live','fixture'].includes(environment))throw Error('Invalid execution environment');
 const mode=registry.mode(raw.mode,raw.modeVersion),limits={hours:8,maxTasks:10,reviewAgentRuns:mode.review==='operator'?2:0,...raw.limits};
 if(raw.limits)keys(raw.limits,['hours','maxTasks','reviewAgentRuns'],'goal limits');
 integer(limits.hours,'hours',1,24);integer(limits.maxTasks,'maxTasks',1,100);integer(limits.reviewAgentRuns,'reviewAgentRuns',0,10);
 if(mode.review!=='operator'&&limits.reviewAgentRuns)throw Error('Mode prohibits Codex review agents');
 let project=null;
 if(raw.project){keys(raw.project,['repo','baseCommit','readPaths','writePaths','checks'],'project');project=clone(raw.project);text(project.repo,'repository');if(!path.isAbsolute(project.repo))throw Error('Repository must be absolute');if(!/^[a-f0-9]{40}$/.test(project.baseCommit??''))throw Error('Invalid base commit');validatePermissions(project);}
 return {schema:1,environment,submissionId:identifier(raw.submissionId,'submissionId'),objective:text(raw.objective,'objective'),acceptance:strings(raw.acceptance,'acceptance'),project,mode,capabilities:registry.snapshot().capabilities.filter(c=>mode.capabilities.includes(c.id)),scope:sourceScope(raw.scope),limits};
}
const TASK_LIMITS={coding:{seconds:28800,attempts:5,modelCalls:50,reviews:2,questions:3},research:{seconds:7200,attempts:20,modelCalls:20,reviews:2,questions:3,searches:30,downloads:50},consult:{seconds:600,attempts:1,modelCalls:1,reviews:0,questions:0},learning:{seconds:600,attempts:2,modelCalls:6,reviews:0,questions:0}};
export function normalizeTask(raw,goal,registry=new Registry()) {
 keys(raw,['submissionId','kind','actor','objective','context','acceptance','dependsOn','priority','permissions','scope','limits'],'task');
 if(!goal.mode.capabilities.includes(raw.kind)||!TASK_LIMITS[raw.kind])throw Error('Mode prohibits capability');
 const actor=raw.actor??(goal.mode.actors.includes('deepseek')?'deepseek':'codex');if(!goal.mode.actors.includes(actor))throw Error('Mode prohibits actor');
 if(!goal.capabilities.find(c=>c.id===raw.kind&&c.actors.includes(actor)))throw Error('Pinned capability prohibits actor');
 const max=TASK_LIMITS[raw.kind],limits={...max,...raw.limits};if(raw.limits)keys(raw.limits,Object.keys(max),'task limits');for(const [k,v]of Object.entries(limits))integer(v,k,k==='questions'||k==='reviews'?0:1,max[k]);
 const priority=raw.priority??(raw.kind==='learning'?'background':'normal');if(!['blocking','normal','background'].includes(priority))throw Error('Invalid priority');
 if(raw.kind==='learning'&&priority!=='background')throw Error('Learning priority must remain background');
 let permissions={readPaths:[],writePaths:[],checks:[]};
 if(raw.kind==='coding'){
  if(!goal.project)throw Error('Coding needs an approved project');
  permissions=clone(raw.permissions??{readPaths:goal.project.readPaths,writePaths:goal.project.writePaths,checks:goal.project.checks.map(c=>c.id)});
  keys(permissions,['readPaths','writePaths','checks'],'permissions');
  for(const k of ['readPaths','writePaths']){strings(permissions[k],k);for(const s of permissions[k]){relativePath(s.endsWith('/')?s.slice(0,-1):s);const f=s.endsWith('/')?s+'placeholder':s;if(!matches(f,goal.project[k]))throw Error('Task expands scope');}}
  strings(permissions.checks,'checks');if(permissions.checks.some(id=>!goal.project.checks.find(c=>c.id===id)))throw Error('Unknown check');
 }else if(raw.permissions&&canonical(raw.permissions)!==canonical(permissions))throw Error('Non-coding task cannot grant file write scope');
 const scope=sourceScope(raw.scope??goal.scope);
 if(goal.scope.includeDomains.length&&(!scope.includeDomains.length||scope.includeDomains.some(d=>!goal.scope.includeDomains.includes(d))))throw Error('Task expands source scope');
 if(goal.scope.excludeDomains.some(d=>!scope.excludeDomains.includes(d)))throw Error('Task removes source exclusion');
 return {submissionId:identifier(raw.submissionId,'submissionId'),kind:raw.kind,actor,objective:text(raw.objective,'objective'),context:raw.context===undefined?'':text(raw.context,'context',40000),acceptance:strings(raw.acceptance,'acceptance'),dependsOn:strings(raw.dependsOn??[],'dependencies',{empty:true,max:100}),priority,permissions,scope,limits};
}
