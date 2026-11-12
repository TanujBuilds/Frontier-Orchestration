import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {ProviderRegistry} from '../../../src/harness/providers/registry.mjs';
import {Worker} from '../../../src/harness/worker.mjs';
export {profile,task} from '../mosaic-pb13/public-fixture.mjs';
import http from 'node:http';
let sequence=0;
export async function evidence(name,value){const dir=path.resolve('.data/portable-beta/14/evidence');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,name+'.json'),JSON.stringify(value,null,2));}
export async function endpoint(t,id){
 const state={online:true,holdPost:null,reply:null},calls=[],posted=Promise.withResolvers();
 const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):null;const call={url:req.url,body,entered:++sequence};calls.push(call);if(!body)return state.online?res.end(JSON.stringify({data:[{id:'alias-'+id}]})):res.writeHead(503).end('offline');posted.resolve();state.onPost?.(call);if(state.holdPost)await state.holdPost.promise;call.responseReleased=++sequence;res.end(JSON.stringify({model:'reported-'+id,choices:[{message:{role:'assistant',content:state.reply??'answer-'+id},finish_reason:'stop'}],usage:{total_tokens:5}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{state.holdPost?.resolve();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return {state,calls,posted,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,posts:()=>calls.filter(x=>x.body),gets:()=>calls.filter(x=>!x.body)};
}
export const now=Date.UTC(2026,10,11);
export function open(root,profiles,{owner='parallel-supervisor',serviceLimit=2}={}){
 const c=new Coordinator({root,now:()=>now,selectedHost:'codex',serviceMaxConcurrentTasks:serviceLimit,providerRegistry:ProviderRegistry({profiles,credentialResolver:()=> 'dummy-bearer'})});
 c.acquireWorker(owner);const worker=new Worker({c,owner,config:{environment:'fixture'}});return {c,worker,owner};
}
export async function fixture(t,profiles,{serviceLimit=2,goalLimit=2,groups,reviewPolicy,...options}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-pb14-runners-')),opened=open(root,profiles,{serviceLimit,...options});
 const {c,worker}=opened;t.after(async()=>{await worker.close?.();if(c.store?.db){if(c.workerLease)c.releaseWorker(opened.owner);c.close();}await rm(root,{recursive:true,force:true});});
 const publicProfiles=profiles.map(({credentialRef,...p})=>p),raw={submissionId:'parallel-goal',objective:'Bound independent work',acceptance:['Bounded isolation and capacity'],mode:'collaborative',environment:'fixture',...(reviewPolicy?{reviewPolicy}:{}),providerPolicy:{version:1,workers:publicProfiles,plannerWorkerId:profiles[0].id,defaultWorkerId:profiles[0].id,maxConcurrentTasks:goalLimit,capacityGroups:groups??[...new Set(profiles.map(p=>p.capacityGroup))].map(id=>({id,limit:1}))},routingPolicy:{version:1,rules:[],defaultWorkerId:profiles[0].id}};
 const g=c.prepareGoal(raw,'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 return {root,raw,g,...opened,submit(id,providerId,extra={}){return c.submitTask({goalId:g.id,submissionId:id,kind:'consult',objective:'Explain scoped work',acceptance:['Return answer'],routing:{version:1,preferredProviderId:providerId},...extra},'submit-'+id);}};
}
export async function advance(worker,done,{max=30}={}){for(let n=0;n<max;n++){if(done())return;await worker.tick();}if(!done())throw Error('Fixture did not reach expected state');}
