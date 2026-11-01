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
const stringSchema={type:'string'},stringsSchema={type:'array',items:stringSchema};
const objectSchema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const TASK_LIMITS={coding:{seconds:28800,attempts:5,modelCalls:50,reviews:2,questions:3},research:{seconds:7200,attempts:20,modelCalls:20,reviews:2,questions:3,searches:30,downloads:50},consult:{seconds:600,attempts:1,modelCalls:1,reviews:2,questions:0},learning:{seconds:600,attempts:2,modelCalls:6,reviews:0,questions:0}};
const taskCeilingsInputSchema=objectSchema(Object.fromEntries(Object.entries(TASK_LIMITS).map(([kind,limits])=>[
 kind,objectSchema(Object.fromEntries(Object.entries(limits).map(([name,max])=>[name,{type:'integer',minimum:name==='questions'||name==='reviews'?0:1,maximum:max}]))),
])));
export const researchPolicySchema=objectSchema({version:{type:'integer',enum:[1,2]},finish:{type:'string',enum:['selectors_only']},discovery:{type:'string',enum:['search_required']}},['version','finish','discovery']);
export const scopeInputSchema=objectSchema({seedUrls:stringsSchema,includeDomains:stringsSchema,excludeDomains:stringsSchema});
export const goalInputSchema=objectSchema({
 submissionId:stringSchema,objective:stringSchema,acceptance:stringsSchema,mode:{...stringSchema,description:'Registered mode id; collaborative is the default.'},modeVersion:{type:'integer',minimum:1},environment:{type:'string',enum:['live','fixture']},scope:scopeInputSchema,researchPolicy:researchPolicySchema,
 limits:objectSchema({hours:{type:'integer',minimum:1,maximum:24},maxTasks:{type:'integer',minimum:1,maximum:100},reviewAgentRuns:{type:'integer',minimum:0,maximum:10},taskLimits:{...taskCeilingsInputSchema,description:'Optional per-kind assignment ceilings. Omitted task limits inherit these values; explicit task limits may only narrow them.'}}),
 project:{anyOf:[{type:'null'},objectSchema({repo:{...stringSchema,description:'Absolute clean committed repository root.'},baseCommit:{...stringSchema,description:'Exact40-character Git base revision.'},readPaths:stringsSchema,writePaths:stringsSchema,checks:{type:'array',items:objectSchema({id:stringSchema,argv:stringsSchema,timeoutMs:{type:'integer',minimum:100,maximum:600000},screenshots:stringsSchema,env:{type:'object'}},['id','argv'])}},['repo','baseCommit','readPaths','writePaths','checks'])]},
},['submissionId','objective','acceptance']);
export const taskInputSchema=objectSchema({submissionId:stringSchema,kind:{type:'string',enum:['coding','research','consult','learning']},actor:{type:'string',enum:['codex','deepseek']},objective:stringSchema,context:stringSchema,acceptance:stringsSchema,dependsOn:stringsSchema,priority:{type:'string',enum:['blocking','normal','background']},permissions:objectSchema({readPaths:stringsSchema,writePaths:stringsSchema,checks:stringsSchema},['readPaths','writePaths','checks']),scope:scopeInputSchema,researchPolicy:researchPolicySchema,limits:{type:'object'}},['submissionId','kind','objective','acceptance']);
const baseModes=[
 {id:'collaborative',version:1,planner:'codex',actors:['codex','deepseek'],review:'operator',capabilities:['coding','research','consult','learning']},
 {id:'deepseek_only',version:1,planner:'deepseek',actors:['deepseek'],review:'checks',capabilities:['coding','research','consult','learning']},
 {id:'codex_only',version:1,planner:'codex',actors:['codex'],review:'operator',capabilities:['coding','research','consult','learning']},
 {id:'overnight_review',version:1,planner:'deepseek',actors:['deepseek'],review:'legacy',capabilities:['coding']},
];
export class Registry {
 constructor(){
  this.capabilities=new Map();this.modes=new Map();this.workflows=new Map();
  for(const id of ['coding','research','consult','learning'])this.capabilities.set(`${id}@1`,{
   id,version:1,actors:['deepseek','codex'],handler:id,
   inputSchema:{type:'object',required:['submissionId','kind','objective','acceptance'],additionalProperties:false,properties:{submissionId:{type:'string'},kind:{const:id},actor:{enum:['deepseek','codex']},objective:{type:'string'},context:{type:'string'},acceptance:{type:'array',items:{type:'string'}},dependsOn:{type:'array',items:{type:'string'}},priority:{enum:['blocking','normal','background']},permissions:{type:'object'},scope:{type:'object'},limits:{type:'object'}}},
   outputSchema:{type:'object',description:'Saved bounded evidence; model text never grants authority'},
   permissions:{filesystem:id==='coding'?'approved-subset':'none',network:id==='research'?'approved-public-scope':'configured-model-only',acceptance:id==='coding'?'protected-checks-and-pinned-mode':'pinned-mode',executableAuthority:'reviewed-adapter-only'},limits:clone(TASK_LIMITS[id]),
  });
  // Preserve research@1 verbatim: its full schema participates in legacy goal hashes.
  const research=clone(this.capabilities.get('research@1'));
  research.version=2;research.actors=['deepseek'];
  research.inputSchema.properties.actor={enum:['deepseek']};
  research.inputSchema.properties.researchPolicy=clone(researchPolicySchema);
  research.inputSchema.properties.researchPolicy.properties.version.enum=[1];
  this.capabilities.set('research@2',research);
  const supportResearch=clone(research);supportResearch.version=3;
  supportResearch.inputSchema.properties.researchPolicy.properties.version.enum=[2];
  this.capabilities.set('research@3',supportResearch);
  for(const m of baseModes)this.registerMode(m);
 }
 registerMode(raw){
  keys(raw,['id','version','planner','actors','review','capabilities'],'mode');
  const m=clone(raw);identifier(m.id);integer(m.version,'version',1,10000);
  strings(m.actors,'actors');if(m.actors.some(x=>!['codex','deepseek'].includes(x))||!m.actors.includes(m.planner))throw Error('Invalid planner/actor');
  if(!['operator','checks','legacy'].includes(m.review))throw Error('Invalid review policy');
  if(m.review==='operator'&&!m.actors.includes('codex'))throw Error('Operator review requires the Codex actor');
  strings(m.capabilities,'capabilities');for(const id of m.capabilities)if(!this.capabilities.has(`${id}@1`))throw Error(`Unknown capability ${id}`);
  if(m.review==='legacy'&&(m.actors.join()!=='deepseek'||m.capabilities.join()!=='coding'))throw Error('Legacy capability policy is coding-only');
  const key=`${m.id}@${m.version}`;if(this.modes.has(key))throw Error('Mode version already exists');this.modes.set(key,m);return clone(m);
 }
 mode(id='collaborative',version){const choices=[...this.modes.values()].filter(m=>m.id===id&&(!version||m.version===version)).sort((a,b)=>b.version-a.version);if(!choices.length)throw Error('Unknown mode');return clone(choices[0]);}
 snapshot(){return {capabilities:clone([...this.capabilities.values()]),modes:clone([...this.modes.values()]),workflows:clone([...this.workflows.values()])};}
 registerWorkflow(raw){
  keys(raw,['id','version','mode','tasks'],'workflow');identifier(raw.id);integer(raw.version,'version',1,10000);const mode=this.mode(raw.mode);
  if(!Array.isArray(raw.tasks)||!raw.tasks.length||raw.tasks.length>10)throw Error('Invalid workflow tasks');const tasks=new Map();
  for(const t of raw.tasks){keys(t,['key','kind','dependsOn','objective','acceptance'],'workflow task');identifier(t.key);if(tasks.has(t.key))throw Error('Duplicate workflow task');if(!mode.capabilities.includes(t.kind))throw Error('Mode prohibits workflow capability');text(t.objective,'objective');strings(t.acceptance,'acceptance');strings(t.dependsOn??[],'dependencies',{empty:true});tasks.set(t.key,t);}
  const visited=new Set(),visiting=new Set(),visit=key=>{if(visiting.has(key))throw Error('Workflow dependency cycle');if(visited.has(key))return;const task=tasks.get(key);if(!task)throw Error('Unknown workflow dependency');visiting.add(key);for(const dep of task.dependsOn??[])visit(dep);visiting.delete(key);visited.add(key);};for(const key of tasks.keys())visit(key);
  const key=`${raw.id}@${raw.version}`;if(this.workflows.has(key))throw Error('Workflow already exists');this.workflows.set(key,clone(raw));return clone(raw);
 }
}
export function sourceScope(raw={}) {
 keys(raw,['seedUrls','includeDomains','excludeDomains'],'source scope');
 const scope={seedUrls:[],includeDomains:[],excludeDomains:[],...raw};
 for(const k of Object.keys(scope))strings(scope[k],k,{empty:true,max:100});
 for(const url of scope.seedUrls){let u;try{u=new URL(url);}catch{throw Error('Invalid source URL');}if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))throw Error('Public HTTPS source URL required');}
 for(const d of [...scope.includeDomains,...scope.excludeDomains])if(!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(d))throw Error('Invalid source domain');
 return clone(scope);
}
export function normalizeResearchPolicy(raw){
 keys(raw,['version','finish','discovery'],'research policy');
 if(![1,2].includes(raw.version)||raw.finish!=='selectors_only'||raw.discovery!=='search_required')throw Error('Unsupported research policy');
 return clone(raw);
}
export function normalizeGoal(raw,registry=new Registry()){
 keys(raw,['submissionId','objective','acceptance','project','mode','modeVersion','scope','limits','environment','researchPolicy'],'goal');
 const environment=raw.environment??'live';if(!['live','fixture'].includes(environment))throw Error('Invalid execution environment');
 const mode=registry.mode(raw.mode,raw.modeVersion),policy=Object.hasOwn(raw,'researchPolicy')?normalizeResearchPolicy(raw.researchPolicy):undefined;
 if(policy&&(!mode.capabilities.includes('research')||!mode.actors.includes('deepseek')))throw Error('Research policy requires autonomous research capability');
 const limits={hours:8,maxTasks:10,reviewAgentRuns:mode.review==='operator'?2:0,...raw.limits};
 if(raw.limits)keys(raw.limits,['hours','maxTasks','reviewAgentRuns','taskLimits'],'goal limits');
 if(Object.hasOwn(limits,'taskLimits')){
  keys(limits.taskLimits,Object.keys(TASK_LIMITS),'goal task limits');const ceilings={};
  for(const [kind,partial]of Object.entries(limits.taskLimits)){
   keys(partial,Object.keys(TASK_LIMITS[kind]),`${kind} task ceilings`);
   for(const [name,value]of Object.entries(partial))integer(value,name,name==='questions'||name==='reviews'?0:1,TASK_LIMITS[kind][name]);
   ceilings[kind]=clone(partial);
  }
  limits.taskLimits=ceilings;
 }
 integer(limits.hours,'hours',1,24);integer(limits.maxTasks,'maxTasks',1,100);integer(limits.reviewAgentRuns,'reviewAgentRuns',0,10);
 if(mode.review!=='operator'&&limits.reviewAgentRuns)throw Error('Mode prohibits Codex review agents');
 let project=null;
 if(raw.project){keys(raw.project,['repo','baseCommit','readPaths','writePaths','checks'],'project');project=clone(raw.project);text(project.repo,'repository');if(!path.isAbsolute(project.repo))throw Error('Repository must be absolute');if(!/^[a-f0-9]{40}$/.test(project.baseCommit??''))throw Error('Invalid base commit');validatePermissions(project);}
 return {schema:1,environment,submissionId:identifier(raw.submissionId,'submissionId'),objective:text(raw.objective,'objective'),acceptance:strings(raw.acceptance,'acceptance'),project,mode,capabilities:registry.snapshot().capabilities.filter(c=>mode.capabilities.includes(c.id)&&c.version===(policy&&c.id==='research'?policy.version+1:1)),scope:sourceScope(raw.scope),limits,...(policy?{researchPolicy:policy}:{})};
}
export function normalizeTask(raw,goal,registry=new Registry()) {
 keys(raw,['submissionId','kind','actor','objective','context','acceptance','dependsOn','priority','permissions','scope','limits','researchPolicy'],'task');
 if(!goal.mode.capabilities.includes(raw.kind)||!TASK_LIMITS[raw.kind])throw Error('Mode prohibits capability');
 const actor=raw.actor??(goal.mode.actors.includes('deepseek')?'deepseek':'codex');if(!goal.mode.actors.includes(actor))throw Error('Mode prohibits actor');
 const policy=Object.hasOwn(goal,'researchPolicy')&&raw.kind==='research'?normalizeResearchPolicy(goal.researchPolicy):undefined;
 if(Object.hasOwn(raw,'researchPolicy')){
  const explicit=normalizeResearchPolicy(raw.researchPolicy);
  if(!policy||canonical(explicit)!==canonical(policy))throw Error('Task research policy must equal the approved goal policy');
 }
 if(policy&&actor!=='deepseek')throw Error('Research policy requires an autonomous research actor');
 if(!goal.capabilities.find(c=>c.id===raw.kind&&c.actors.includes(actor)))throw Error('Pinned capability prohibits actor');
 const max={...TASK_LIMITS[raw.kind],...goal.limits?.taskLimits?.[raw.kind]},limits={...max,...raw.limits};if(raw.limits)keys(raw.limits,Object.keys(max),'task limits');for(const [k,v]of Object.entries(limits))integer(v,k,k==='questions'||k==='reviews'?0:1,max[k]);
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
 return {submissionId:identifier(raw.submissionId,'submissionId'),kind:raw.kind,actor,objective:text(raw.objective,'objective'),context:raw.context===undefined||raw.context===''?'':text(raw.context,'context',40000),acceptance:strings(raw.acceptance,'acceptance'),dependsOn:strings(raw.dependsOn??[],'dependencies',{empty:true,max:100}),priority,permissions,scope,limits,...(policy?{researchPolicy:policy}:{})};
}
