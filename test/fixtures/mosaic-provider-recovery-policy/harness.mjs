import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Worker} from '../../../src/harness/worker.mjs';
import {LocalProvider} from '../../../src/harness/provider.mjs';
import {ProviderRegistry} from '../../../src/harness/providers/registry.mjs';

export const MODEL='fixture-model';
export const capabilities=discovery=>({protocol:'mosaic-structured-v1',modelDiscovery:discovery,transports:['json','sse']});
export const plan={tasks:[
 {key:'a',kind:'coding',role:'implementation',objective:'Owned fixture',acceptance:['Source checks'],dependsOn:[],permissions:{readPaths:['src/','checks/'],writePaths:['src/'],checks:['unit']}},
 {key:'z',kind:'coding',role:'final',objective:'Final fixture',acceptance:['All checks'],dependsOn:['a'],permissions:{readPaths:['src/','checks/'],writePaths:['src/'],checks:['starter','unit','final']}}
]};

export async function server(t,handler){
 const counts={get:0,post:0};
 const s=http.createServer(async(req,res)=>{
  req.setTimeout(1000,()=>req.destroy());res.setTimeout(1000,()=>res.destroy());
  let bytes=0;for await(const b of req){bytes+=b.length;if(bytes>65536){req.destroy();return;}}
  if(req.method==='GET')counts.get++;else if(req.method==='POST')counts.post++;
  handler(req,res,counts);
 });
 await new Promise(r=>s.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));
 return {counts,baseUrl:`http://127.0.0.1:${s.address().port}/v1`};
}
export function models(res){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:MODEL}]}));}
export function rejection(res,status=429,code,header='60'){
 res.writeHead(status,{'content-type':'application/json','retry-after':header});res.end(JSON.stringify({error:{code,message:'private provider text'}}));
}
export function success(res,kind,streaming=false){
 const content=kind==='planner'?JSON.stringify(plan):'bounded fixture result';
 if(streaming){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({model:MODEL,choices:[{delta:{content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}
 else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:MODEL,choices:[{message:{content},finish_reason:'stop'}]}));}
}
export function provider(baseUrl,discovery='manual',extra={}){return new LocalProvider({baseUrl,model:MODEL,capabilities:capabilities(discovery),timeoutMs:500,...extra});}

export function fixture(t,kind,local,{streaming=false,modelCalls=6}={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'mosaic-recovery-policy-'));
 t.diagnostic('retained fixture root: '+root);
 let now=1800000000000;const opened=[];
 const open=()=>{const c=new Coordinator({root});c.now=()=>now;opened.push(c);return c;};
 let c=open();t.after(()=>{for(const c of opened)c.close();});
 const project={repo:root,baseCommit:'a'.repeat(40),readPaths:['src/','checks/'],writePaths:['src/'],checks:['starter','unit','final'].map(id=>({id,argv:[process.execPath,'checks/'+id+'.mjs']}))};
 const prepared=c.prepareGoal({submissionId:'goal',objective:'Bounded recovery fixture',acceptance:['No unsafe replay'],mode:'overnight_review',environment:'fixture',project,overnightPolicy:{preflightCheckIds:['starter'],finalOnlyCheckIds:['final']},limits:{taskLimits:{coding:{modelCalls}}}},'prepare');
 c.store.tx(()=>{const g=c.store.get('goal',prepared.id);Object.assign(g,{status:'active',activatedAt:now,deadline:now+3600000});c.store.put('goal',g);});
 let task;
 if(kind==='worker'){
  task=c.submitTask({goalId:prepared.id,submissionId:'task',kind:'coding',role:'implementation',objective:'Bounded recovery',acceptance:['Safe state'],permissions:{readPaths:project.readPaths,writePaths:project.writePaths,checks:['unit']}},'submit');
  c.store.tx(()=>{const x=c.store.get('task',task.id);x.attempts=1;x.deadline=now+3600000;x.providerModel=MODEL;x.checkpoint={phase:'model',attempt:1,exchange:0,executionBase:project.baseCommit};c.store.put('task',x);});
 }
 let worker;
 const make=()=>{
  const w=new Worker({c,provider:local,config:{environment:'fixture',deepseekStreaming:streaming},adapters:{coding:{step:async(task,owner)=>{
   const result=await w.model(task,owner,'exchange-'+task.checkpoint.exchange,[],{maxTokens:20});
   return c.boundary(task.id,{...task.checkpoint,phase:'checks',result},owner);
  }}}});
  return w;
 };
 worker=make();
 return {root,id:prepared.id,taskId:task?.id,get c(){return c;},get worker(){return worker;},get now(){return now;},advance(ms){now+=ms;},
  state(){return kind==='worker'?c.getTask(task.id):c.store.get('planning',prepared.id);},
  async tick(){return kind==='worker'?worker.tick():worker.planner.tick();},
  restart(){c.close();opened.splice(opened.indexOf(c),1);c=open();worker=make();},
  requests(){return c.store.db.prepare('SELECT * FROM requests WHERE task_id=? ORDER BY rowid').all(task?.id??prepared.id).map(x=>({...x,...JSON.parse(x.data)}));},
  pins(){const g=c.getGoal(prepared.id),s=kind==='worker'?c.getTask(task.id):null;return {hash:g.hash,manifest:g.manifest,deadline:g.deadline,...(s?{taskHash:s.hash,taskDeadline:s.deadline,attempts:s.attempts,model:s.providerModel,limits:s.spec.limits}:{})};}
 };
}
export function safeError(status=429,code){return Object.assign(Error('scripted rejection'),{requestOutcome:'not_dispatched',httpStatus:status,providerErrorCode:code,retryHint:{kind:'delay',milliseconds:60000}});}
export function assertSpent(f,n,outcome='not_dispatched'){
 assert.equal(f.requests().length,n);assert.equal(f.requests()[0].requestOutcome,outcome);
 assert.equal(f.requests()[0].status,'failed');
}

export function routedFixture(t,baseUrl,discovery){
 const root=mkdtempSync(path.join(os.tmpdir(),'mosaic-recovery-route-'));t.diagnostic('retained fixture root: '+root);
 const profile={schema:1,id:'worker-a',revision:'r1',displayName:'Scripted worker',transport:'openai-chat',baseUrl,model:MODEL,roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:discovery,taskKinds:['consult']},maxContextTokens:16000,maxOutputTokens:4000,concurrency:1,capacityGroup:'fixture-group',credentialRef:'dummy-key',streaming:false};
 const registry=ProviderRegistry({profiles:[profile],credentialResolver:()=> 'dummy-bearer'}),c=new Coordinator({root,providerRegistry:registry,selectedHost:'codex'});t.after(()=>c.close());
 const {credentialRef,...publicProfile}=profile;
 const g=c.prepareGoal({submissionId:'route',objective:'Manual route eligibility',acceptance:['Truthful durable explanation'],mode:'collaborative',modeVersion:1,environment:'fixture',providerPolicy:{version:1,workers:[publicProfile],plannerWorkerId:profile.id,defaultWorkerId:profile.id,maxConcurrentTasks:1,capacityGroups:[{id:profile.capacityGroup,limit:1}]},routingPolicy:{version:1,rules:[],defaultWorkerId:profile.id}},'prepare');
 c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const task=c.submitTask({goalId:g.id,submissionId:'task',kind:'consult',objective:'Assigned topic',acceptance:['Bounded answer'],routing:{version:1,category:'backend'}},'submit');
 return {c,g,task,worker:new Worker({c,config:{environment:'fixture'}})};
}
