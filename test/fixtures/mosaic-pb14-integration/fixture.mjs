import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Integration} from '../../../src/harness/integration.mjs';
import {ProviderRegistry} from '../../../src/harness/providers/registry.mjs';
import {git,command} from '../../../src/project/process.mjs';

export const profile={schema:1,id:'worker',revision:'r1',displayName:'Offline fixture',transport:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',model:'fixture',roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding','consult']},maxContextTokens:32000,maxOutputTokens:2048,concurrency:2,capacityGroup:'fixture',credentialRef:null,streaming:false};
export function checksFactory(onRun){return w=>({verify:async()=>({fixture:true}),run:async(checks,key,signal)=>{await onRun?.(w,checks,key,signal);const results=[];for(const check of checks){const result=await command(check.argv,{cwd:w.root,timeoutMs:check.timeoutMs,signal});results.push({...result,id:check.id,passed:result.code===0,screenshots:[]});}return results;}});}
export function connect(root,options={}){const c=new Coordinator({root:path.join(root,'state'),selectedHost:'cursor',serviceMaxConcurrentTasks:2,providerRegistry:ProviderRegistry({profiles:[profile]})});return {c,i:new Integration({c,checksFactory:checksFactory(options.onRun),signal:options.signal})};}
export async function fixture(t,{check="if(a+b>2)process.exit(1);",onRun}={}){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'mosaic-pb14-integration-'))),repo=path.join(root,'repo');await mkdir(path.join(repo,'src'),{recursive:true});await mkdir(path.join(repo,'checks'));
 for(const name of ['a','b'])await writeFile(path.join(repo,`src/${name}.mjs`),`export const ${name}=0;\n`);
 await writeFile(path.join(repo,'checks/verify.mjs'),"import {a} from '../src/a.mjs';import {b} from '../src/b.mjs';"+check+'\n');
 for(const args of [['init','-q'],['config','user.email','fixture@example.invalid'],['config','user.name','Fixture'],['add','.'],['commit','-qm','base']])await git(repo,...args);
 const base=await git(repo,'rev-parse','HEAD'),f={root,repo,base,...connect(root,{onRun})};t.after(async()=>{f.c.close();await rm(root,{recursive:true,force:true});});return f;
}
export function goal(f,id,{legacy=false,project={}}={}){
 const p={repo:f.repo,baseCommit:f.base,readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'verify',argv:[process.execPath,'checks/verify.mjs'],timeoutMs:10000}],...project};
 const manifest={submissionId:id,objective:'Combine bounded independent checked changes',acceptance:['Protected checks pass'],mode:'collaborative',environment:'fixture',project:p,...(legacy?{}:{providerPolicy:{version:1,workers:f.c.providerRegistry.snapshot([{id:'worker',revision:'r1'}]),plannerWorkerId:'worker',defaultWorkerId:'worker',maxConcurrentTasks:2,capacityGroups:[{id:'fixture',limit:2}]}})};
 const draft=legacy?f.c.prepareLegacyGoal(manifest,'prepare-'+id):f.c.preparePortableGoal(manifest,'prepare-'+id);return f.c.activateGoal({goalId:draft.id,hash:draft.hash},'activate-'+id);
}
export function task(f,g,name,{actor='codex',scope=`src/${name}.mjs`,dependsOn=[]}={}){return f.c.submitTask({goalId:g.id,submissionId:name,kind:'coding',actor,objective:'Change '+name,acceptance:['Checked'],dependsOn,permissions:{readPaths:['src/','checks/'],writePaths:[scope],checks:['verify']}},'task-'+g.id+'-'+name);}
export async function candidate(f,g,name,options={}){
 const t=task(f,g,name,options),started=await f.i.startNative({taskId:t.id,layout:'candidate_v1'},'start-'+t.id);
 await writeFile(path.join(started.native.worktree,`src/${name}.mjs`),`export const ${name}=1;\n`);
 return {task:t,started,finish:async()=>{const ready=await f.i.finishNative({taskId:t.id,summary:'Checked change'},'finish-'+t.id);if(g.manifest.reviewPolicy){const inbox=await f.c.reviewService.inbox({goalId:g.id,limit:10});const item=inbox.items.find(x=>x.taskId===t.id);const ticket=await f.c.reviewService.reserve({taskId:t.id,...item.binding},'reserve-'+t.id);await f.c.reviewService.submit({ticketId:ticket.id??ticket.ticketId,...item.binding,verdict:{decision:'accept',feedback:'Fixture host inspected exact diff and checks',findings:[]}},'submit-'+t.id);}return ready;}};
}
export const accept=(f,t,key='accept-'+t.id)=>f.i.accept({taskId:t.id,feedback:'Import checked candidate'},key);
