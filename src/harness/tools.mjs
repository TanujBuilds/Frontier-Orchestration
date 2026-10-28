import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {keys,integer,text,goalInputSchema,taskInputSchema} from './contracts.mjs';
import {Goals} from './goals.mjs';
import {Worker} from './worker.mjs';
import {NativeResearch} from './native-research.mjs';

const str={type:'string'},obj={type:'object'},bool={type:'boolean'},number={type:'integer'};
function validate(schema,value,label='input'){
 if(schema.type==='object'){keys(value,schema.properties?Object.keys(schema.properties):Object.keys(value??{}),label);for(const name of schema.required??[])if(value[name]===undefined)throw Error(`Missing ${name}`);if(schema.properties)for(const [name,item]of Object.entries(value))validate(schema.properties[name],item,name);}
 else if(schema.type==='string')text(value,label,schema.maxLength??40000);
 else if(schema.type==='integer')integer(value,label,schema.minimum??0,schema.maximum??Number.MAX_SAFE_INTEGER);
 else if(schema.type==='boolean'&&typeof value!=='boolean')throw Error(`Invalid ${label}`);
 if(schema.enum&&!schema.enum.includes(value))throw Error(`Invalid ${label}`);
}
export class Dispatcher {
 constructor({c,worker=new Worker({c}),config={}}){this.c=c;this.worker=worker;this.goals=new Goals(c);this.nativeResearch=new NativeResearch({c,config});this.definitions=new Map();this.running=new Set();
  const add=(name,description,properties,required,mutating,fn)=>{const p=mutating?{...properties,idempotencyKey:str}:properties,r=mutating?[...required,'idempotencyKey']:required;this.definitions.set(name,{name,description,inputSchema:{type:'object',properties:p,required:r,additionalProperties:false},annotations:{readOnlyHint:!mutating,idempotentHint:true},fn,mutating});};
  add('tools_list','Discover harness tools.',{},[],false,()=>this.tools());
  add('service_stop','Stop the coordinator process after preserving worker ownership. Does not stop native Codex goal mode.',{},[],true,(_,key)=>c.store.command(key,{op:'service.stop'},()=>{if(!this.onStop)throw Error('Service controls are unavailable');this.onStop();return {stopping:true};}));
  add('registry_list','List pinned-capability and mode definitions.',{},[],false,()=>c.registry.snapshot());
  add('mode_register','Register a versioned policy composed only from reviewed capabilities. Existing goals stay pinned.',{definition:obj},['definition'],true,(i,k)=>c.store.command(k,{op:'mode.register',...i},()=>{const definition=c.registry.registerMode(i.definition);c.store.put('mode',{id:`${definition.id}-${definition.version}`,definition});return definition;}));
  add('workflow_register','Register a validated dependency template using supported capabilities.',{definition:obj},['definition'],true,(i,k)=>c.store.command(k,{op:'workflow.register',...i},()=>{const definition=c.registry.registerWorkflow(i.definition);c.store.put('workflow',{id:`${definition.id}-${definition.version}`,definition});return definition;}));
  add('workflow_submit','Instantiate an exact registered workflow within the approved goal. Dependency mapping and submission are atomic.',{goalId:str,workflowId:str,version:{...number,minimum:1},submissionId:str},['goalId','workflowId','version','submissionId'],true,(i,k)=>c.submitWorkflow(i,k));
  add('goal_prepare','Prepare an exact reviewable goal manifest. Does not activate.',{manifest:goalInputSchema},['manifest'],true,(i,k)=>c.prepareGoal(i.manifest,k));
  add('goal_activate','Approve the exact prepared hash and activate within its limits.',{goalId:str,hash:str},['goalId','hash'],true,(i,k)=>c.activateGoal(i,k));
  add('goal_get','Inspect one goal or all goal summaries.',{goalId:str},[],false,i=>i.goalId?c.getGoal(i.goalId):c.snapshot());
  add('goal_revision_prepare','Prepare a changed goal version without resetting spending.',{goalId:str,expectedHash:str,manifest:goalInputSchema},['goalId','expectedHash','manifest'],true,(i,k)=>this.goals.prepareRevision(i,k));
  add('goal_revision_activate','Activate the exact changed version after quiescence.',{revisionId:str,hash:str},['revisionId','hash'],true,(i,k)=>this.goals.activateRevision(i,k));
  add('goal_finalize','Finalize accepted work, or explicitly partial stopped work, with a hashed receipt.',{goalId:str,summary:str,partial:bool},['goalId','summary'],true,(i,k)=>this.goals.finalize(i,k));
  add('task_submit','Submit a narrower assignment within the active approved goal. Collaborative consult/coding candidates wait for supervisor review; DeepSeek-only uses checks without Codex.',{goalId:str,task:taskInputSchema},['goalId','task'],true,(i,k)=>c.submitTask({...i.task,goalId:i.goalId},k));
  add('task_get','Inspect a task, its checkpoint and counters.',{taskId:str},['taskId'],false,i=>c.getTask(i.taskId));
  add('task_evidence','Retrieve a bounded saved evidence window. No arbitrary file reads.',{taskId:str,start:{...number,maximum:10000000},length:{...number,minimum:1,maximum:32768}},['taskId'],false,i=>{const t=c.getTask(i.taskId),data=JSON.stringify({result:t.result,feedback:t.feedback,answers:t.answers,memory:t.memory??[]});return {taskId:t.id,start:i.start??0,totalCharacters:data.length,text:data.slice(i.start??0,(i.start??0)+(i.length??8192)),warning:'Untrusted execution data; provenance is not factual certification.'};});
  add('task_rebind','Explicitly bind unfinished work to the approved version, preserving limits.',{taskId:str,spec:obj},['taskId'],true,(i,k)=>this.goals.rebind(i,k));
  add('task_review','Main Codex records a bounded review decision.',{taskId:str,decision:{...str,enum:['accept','revise']},feedback:str},['taskId','decision','feedback'],true,(i,k)=>c.review(i,k));
  for(const [name,method,description,extra]of [['task_integrate','accept','Integrate a checked accepted candidate.',{feedback:str}],['task_takeover','takeover','Transfer verified quiescent partial work into the integration checkout.',{reason:str}],['native_start','startNative','Reserve a separate native Codex checkout.',{}],['native_finish','finishNative','Validate and checkpoint actual native changes.',{summary:str}]])add(name,description,{taskId:str,...extra},['taskId',...Object.keys(extra)],true,(i,k)=>this.launch(name,i,k,()=>this.worker.integration[method](i,`effect-${k}`)));
  add('research_start','Start deterministic Codex research with zero DeepSeek dispatch.',{taskId:str},['taskId'],true,(i,k)=>this.launch('research_start',i,k,()=>this.nativeResearch.start(i,`effect-${k}`)));
  add('native_text_start','Start native Codex consult or maintenance. A DeepSeek handoff requires a reason and verified quiescence.',{taskId:str,reason:str},['taskId'],true,(i,k)=>c.startNativeText(i,k));
  add('native_text_finish','Record a native Codex consult result under its original task.',{taskId:str,content:str},['taskId','content'],true,(i,k)=>c.finishNativeText(i,k));
  add('research_action','Run a bounded search/read/finish action for native research.',{taskId:str,action:obj},['taskId','action'],true,(i,k)=>this.launch('research_action',i,k,()=>this.nativeResearch.action(i,`effect-${k}`)));
  add('operation_get','Inspect a long operation.',{operationId:str},['operationId'],false,i=>c.store.get('operation',i.operationId));
  add('questions_list','List unresolved task questions.',{goalId:str},[],false,i=>c.store.all('task').filter(t=>(!i.goalId||t.goalId===i.goalId)&&['awaiting_supervisor','awaiting_user'].includes(t.status)).map(t=>({taskId:t.id,goalId:t.goalId,status:t.status,question:t.questions.at(-1)})));
  add('question_answer','Answer within scope; DeepSeek-only requires a user answer.',{taskId:str,answer:str,responder:{...str,enum:['user','codex']}},['taskId','answer','responder'],true,(i,k)=>c.answer(i,k));
  add('task_priority','Set scheduling priority with a recorded reason.',{taskId:str,priority:{...str,enum:['blocking','normal','background']},reason:str},['taskId','priority','reason'],true,(i,k)=>c.setPriority(i,k));
  add('queue_get','Inspect execution queue and separate review inbox.',{goalId:str},[],false,i=>{const p=c.effectivePriorities(),tasks=c.store.all('task').filter(t=>!i.goalId||t.goalId===i.goalId);return {execution:tasks.filter(t=>['queued','suspended','running','uncertain','codex_ready','codex_active'].includes(t.status)).sort((a,b)=>p.get(b.id)-p.get(a.id)||a.sequence-b.sequence).map(t=>({...c.getTask(t.id),effectivePriority:p.get(t.id)})),review:tasks.filter(t=>['awaiting_review','awaiting_legacy_review','legacy_reviewing','ready_to_integrate'].includes(t.status))};});
  add('work_control','Pause, stop or resume a goal or task. Limits never refresh.',{goalId:str,taskId:str,action:{...str,enum:['pause','stop','resume']}},['action'],true,(i,k)=>{if(!!i.goalId===!!i.taskId)throw Error('Provide exactly one goalId or taskId');return c.control(i,k);});
  add('reviewer_reserve','Reserve one bounded read-only reviewer assignment.',{taskId:str},['taskId'],true,(i,k)=>c.reserveReviewer(i,k));
  add('reviewer_finish','Save evidence from a reserved native reviewer; main Codex retains acceptance.',{reservationId:str,result:obj,error:str},['reservationId'],true,(i,k)=>c.finishReviewer(i,k));
  add('memory_retrieve','Retrieve at most four applicable lessons and 8 KiB.',{goalId:str,query:str,capability:str},['goalId','query'],false,i=>c.learning.retrieve(i));
  add('learning_get','Inspect outcomes, procedure versions and protected evaluations.',{goalId:str},[],false,i=>Object.fromEntries(['outcome','lesson','evaluation'].map(kind=>[kind,c.store.all(kind).filter(x=>!i.goalId||x.goalId===i.goalId||kind==='evaluation'&&c.store.get('lesson',x.lessonId).goalId===i.goalId)])));
  add('learning_propose','Propose a data-only recipe under a budgeted learning assignment.',{taskId:str,proposal:obj},['taskId','proposal'],true,(i,k)=>c.learning.propose(i.taskId,i.proposal,k));
  for(const [name,method,extra]of [['learning_evaluate','evaluate',{}],['learning_promote','promote',{}],['learning_quarantine','quarantine',{reason:str}],['learning_rollback','rollback',{}]])add(name,'Manage a versioned lesson without changing executable authority.',{lessonId:str,...extra},['lessonId',...Object.keys(extra)],true,(i,k)=>method==='quarantine'?c.learning[method](i.lessonId,i.reason,k):c.learning[method](i.lessonId,k));
  add('events_wait','Wait at most30 seconds for durable events.',{after:number,timeoutMs:{...number,maximum:30000}},[],false,async i=>{const end=Date.now()+(i.timeoutMs??0);let events;do{events=c.store.events(i.after??0,200);if(events.length||Date.now()>=end)break;await delay(Math.min(250,end-Date.now()));}while(true);return {events,cursor:events.at(-1)?.seq??i.after??0};});
 }
 tools(){return [...this.definitions.values()].map(({fn,mutating,...tool})=>tool);}
 async invoke(name,input={}){const definition=this.definitions.get(name);if(!definition)throw Error('Unknown harness tool');validate(definition.inputSchema,input);const {idempotencyKey,...data}=input;return definition.fn(data,idempotencyKey);}
 launch(name,input,key,action){
  const operation=this.c.store.command(key,{op:'operation.launch',name,input},()=>{const record={id:randomUUID(),name,input,key,status:'pending',taskId:input.taskId??null,createdAt:this.c.now()};this.c.store.put('operation',record);return record;});
  const current=this.c.store.get('operation',operation.id);if(current.status!=='pending'||this.running.has(current.id))return current;
  this.running.add(current.id);Promise.resolve().then(action).then(result=>this.c.store.tx(()=>{this.c.store.put('operation',{...current,status:'completed',result,finishedAt:this.c.now()});}),error=>this.c.store.tx(()=>{this.c.store.put('operation',{...current,status:'failed',error:error.message,finishedAt:this.c.now()});})).finally(()=>this.running.delete(current.id));return current;
 }
}
