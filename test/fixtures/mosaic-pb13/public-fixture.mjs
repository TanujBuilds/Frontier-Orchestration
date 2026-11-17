import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Dispatcher} from '../../../src/harness/tools.mjs';
import {Worker} from '../../../src/harness/worker.mjs';
import {ProviderRegistry} from '../../../src/harness/providers/registry.mjs';

export async function endpoint(t,id){
 const state={online:true,hold:null,holdPost:null,postStatus:200,plan:null},calls=[],entered=Promise.withResolvers(),posted=Promise.withResolvers();
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=raw?JSON.parse(raw):null;calls.push({url:req.url,body,auth:req.headers.authorization});
  if(!body){state.onGet?.();entered.resolve();if(state.hold)await state.hold.promise;
   if(!state.online)return res.writeHead(503).end('offline');
   return res.end(JSON.stringify({data:[{id:'alias-'+id}]}));}
  posted.resolve();if(state.holdPost)await state.holdPost.promise;
  if(state.postStatus!==200)return res.writeHead(state.postStatus).end('fixture rejection');
  const input=JSON.parse(body.messages.at(-1).content);
  const content=input.goal?JSON.stringify(state.plan??{tasks:[{key:'answer',kind:'consult',objective:'Explain',acceptance:['Answer']}]}):state.reply??'answer-'+id;
  res.end(JSON.stringify({model:'reported-'+id,choices:[{message:{role:'assistant',content},finish_reason:'stop'}],usage:{total_tokens:5}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{state.hold?.resolve();state.holdPost?.resolve();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return {state,calls,entered,posted,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,posts:()=>calls.filter(x=>x.body),gets:()=>calls.filter(x=>!x.body)};
}
export const profile=(id,baseUrl)=>({schema:1,id:'worker-'+id,revision:'r1',displayName:'Worker '+id,transport:'openai-chat',baseUrl,model:'alias-'+id,roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding','consult']},maxContextTokens:16000,maxOutputTokens:4000,concurrency:1,capacityGroup:'group-'+id,credentialRef:'dummy-'+id,streaming:false});
export async function fixture(t,{profiles,mode='collaborative',credentialResolver=()=> 'dummy-bearer'}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-pb13-public-'));
 let now=Date.UTC(2026,10,11),c,d,worker;const opened=[];
 const registry=()=>ProviderRegistry({profiles,credentialResolver});
 const open=()=>{c=new Coordinator({root,now:()=>now,providerRegistry:registry(),selectedHost:'codex'});opened.push(c);worker=new Worker({c,owner:'public-worker',config:{environment:'fixture'}});d=new Dispatcher({c,worker});return c;};open();
 t.after(async()=>{for(const item of opened)item.close();await rm(root,{recursive:true,force:true});});
 const publicProfiles=profiles.map(({credentialRef,...p})=>p);
 const raw={submissionId:'routing-goal',objective:'Route explicit worker preferences',acceptance:['Exact endpoint and authority'],mode,modeVersion:1,environment:'fixture',providerPolicy:{version:1,workers:publicProfiles,plannerWorkerId:profiles[0].id,defaultWorkerId:profiles[0].id,maxConcurrentTasks:1,capacityGroups:[...new Set(profiles.map(p=>p.capacityGroup))].map(id=>({id,limit:1}))},routingPolicy:{version:1,rules:[{id:'backend',category:'backend',providerId:profiles[0].id},{id:'frontend',category:'frontend',providerId:profiles[1]?.id??profiles[0].id}],defaultWorkerId:profiles[0].id}};
 return {root,raw,get c(){return c;},get d(){return d;},get worker(){return worker;},get now(){return now;},advance:n=>{now+=n;},reopen(){c.close();return open();},
  async prepare(){const g=await d.invoke('goal_prepare',{manifest:raw,idempotencyKey:'prepare'});await d.invoke('goal_activate',{goalId:g.id,hash:g.hash,idempotencyKey:'activate'});return g;},
  submit(g,spec,key=spec.submissionId,guards={}){return d.invoke('task_submit',{goalId:g.id,task:spec,idempotencyKey:key,...guards});}};
}
export const task=(id,category='backend',extra={})=>({submissionId:id,kind:'consult',objective:'Explain the assigned topic',acceptance:['Bounded useful answer'],routing:{version:1,category},...extra});
export const counts=c=>Object.fromEntries(['records','commands','submissions','events','requests'].map(table=>[table,Number(c.store.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n)]));
