import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {Integration} from '../src/harness/integration.mjs';
import {NativeCandidates} from '../src/harness/native-candidates.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';

const executionPolicy={version:1,backend:'codex-sandbox',backendRevision:1};
const original='private fixture executable A; never launched';
const raw={submissionId:'runtime',objective:'Keep the approved runtime',acceptance:['Bound identity'],mode:'collaborative',environment:'fixture',executionPolicy};
function fixture(t,{alias=false,...options}={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-runtime-fence-')),executable=path.join(root,'sandbox'),a=path.join(root,'a'),b=path.join(root,'b');
 if(alias){writeFileSync(a,original,{mode:0o700});writeFileSync(b,'replacement',{mode:0o700});symlinkSync(a,executable);}else writeFileSync(executable,original,{mode:0o700});
 let c=new Coordinator({root:path.join(root,'state'),selectedHost:'cursor',codexPath:executable,...options});
 t.after(()=>{c?.close();rmSync(root,{recursive:true,force:true});});
 return {root,executable,get c(){return c;},mutate(){if(alias){rmSync(executable);symlinkSync(b,executable);}else writeFileSync(executable,'changed private runtime bytes',{mode:0o700});},restore(){if(alias){rmSync(executable);symlinkSync(a,executable);}else writeFileSync(executable,original,{mode:0o700});},restart(codexPath=executable){c?.close();c=null;c=new Coordinator({root:path.join(root,'state'),selectedHost:'cursor',codexPath,...options});return c;}};
}

for(const alias of [false,true])test(`live goal authority rejects ${alias?'a retargeted executable symlink':'changed executable bytes'} without refreshing its saved identity`,t=>{
 const f=fixture(t,{alias}),g=f.c.preparePortableGoal(raw,'prepare'),identity=f.c.store.get('execution_configuration','coordinator');
 f.mutate();assert.throws(()=>f.c.activateGoal({goalId:g.id,hash:g.hash},'activate-changed'),/execution.*runtime.*changed/i);
 assert.throws(()=>f.c.verifyWorkerBinding(g),/execution.*runtime.*changed/i);
 assert.deepEqual(f.c.store.get('execution_configuration','coordinator'),identity);assert.equal(f.c.getGoal(g.id).hash,g.hash);assert.equal(f.c.getGoal(g.id).status,'draft');
 f.restore();assert.equal(f.c.activateGoal({goalId:g.id,hash:g.hash},'activate-restored').status,'active');
});

test('native start and integration checks reject changed runtime before opening a writer or runner',async t=>{
 const f=fixture(t),project={repo:f.root,baseCommit:'a'.repeat(40),readPaths:['src/'],writePaths:['src/'],checks:[{id:'check',argv:[process.execPath,'src/check.mjs']}]};
 const g=f.c.preparePortableGoal({...raw,mode:'codex_only',project},'prepare');f.c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const task=f.c.submitTask({goalId:g.id,submissionId:'code',kind:'coding',objective:'Bounded edit',acceptance:['Checked']},'task');
 let bases=0,factories=0;const config={codexPath:f.executable};
 const native=new NativeCandidates({c:f.c,config,executionBase:async()=>{bases++;throw Error('Unexpected execution-base access');}});
 const integration=new Integration({c:f.c,config,checksFactory:()=>{factories++;return {backendIdentity:{id:'codex-sandbox',revision:1}};}});
 f.mutate();await assert.rejects(native.start(task.id),/execution.*runtime.*changed/i);
 assert.throws(()=>integration.checks({root:f.root,manifest:{executionPolicy}}),/execution.*runtime.*changed/i);
 assert.equal(bases,0);assert.equal(factories,0);assert.equal(f.c.getTask(task.id).status,'codex_ready');assert.equal(f.c.getTask(task.id).native,undefined);
});

for(const phase of ['worker','planner','reviewer'])test(`${phase} refuses an executable replacement during credential lookup before POST and retains original spend`,async t=>{
 let f,posts=0,lookups=0,observed;
 const server=createServer(async(req,res)=>{for await(const chunk of req){}posts++;const content=phase==='worker'?'Fixture answer':phase==='planner'?JSON.stringify({tasks:[{key:'answer',kind:'consult',objective:'Bounded answer',acceptance:['Clear'],dependsOn:[]}]}):JSON.stringify({decision:'accept',feedback:'Fixture review',findings:[]});res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({model:'fixture-model',choices:[{message:{role:'assistant',content},finish_reason:'stop'}]}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const reviewer=phase==='reviewer',profile={schema:1,id:'provider',revision:'r1',displayName:'Private fixture',transport:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model',roles:[reviewer?'reviewer':'worker'],capabilities:{workerProtocol:reviewer?null:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:reviewer?[]:['coding','consult']},maxContextTokens:32000,maxOutputTokens:2048,concurrency:1,capacityGroup:'fixture',credentialRef:'dummy',streaming:false};
 const providers=ProviderRegistry({profiles:[profile],credentialResolver:async()=>{lookups++;await new Promise(resolve=>setImmediate(resolve));const row=f.c.store.db.prepare('SELECT id,task_id,key,data FROM requests').get();observed={...row,data:JSON.parse(row.data)};f.mutate();return 'private-fixture-token';}});
 f=fixture(t,{providerRegistry:providers});f.c.acquireWorker('owner');
 const policy=reviewer?{reviewPolicy:{version:1,source:'api',reviewer:providers.get('provider','r1'),fallback:'wait'}}:{providerPolicy:{version:1,workers:providers.snapshot([{id:'provider',revision:'r1'}]),plannerWorkerId:'provider',defaultWorkerId:'provider',maxConcurrentTasks:1,capacityGroups:[{id:'fixture',limit:1}]}};
 const g=f.c.preparePortableGoal({...raw,mode:phase==='planner'?'deepseek_only':'collaborative',...policy},'prepare');f.c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const identity=f.c.store.get('execution_configuration','coordinator'),worker=new Worker({c:f.c,owner:'owner',config:{environment:'fixture'}});let task,binding;
 if(phase==='planner')await worker.planner.tick({goalId:g.id});
 else{task=f.c.submitTask({goalId:g.id,submissionId:'answer',kind:'consult',actor:'deepseek',objective:'Fixture answer',acceptance:['Clear']},'task');const claimed=f.c.claimNext('owner');if(reviewer){f.c.completeTask(task.id,{content:'Saved answer'},'owner',{reviewRequired:true});binding=(await f.c.reviewService.inbox({goalId:g.id})).items[0].binding;await assert.rejects(f.c.reviewService.runApi(binding,'review'),/reservation remains spent|no fallback/i);}else await worker.executeTask(claimed);}
 assert.equal(posts,0);assert.equal(lookups,1);assert.ok(observed);
 const saved=f.c.store.request(observed.task_id,observed.key);assert.equal(saved.id,observed.id);assert.equal(saved.status,'failed');assert.equal(saved.requestOutcome,'not_dispatched');assert.equal(saved.reservedAt,observed.data.reservedAt);assert.deepEqual(saved.providerBinding??saved.reviewerBinding,observed.data.providerBinding??observed.data.reviewerBinding);
 assert.equal(f.c.store.spent(observed.task_id)[reviewer?'apiReview':'model'],1);assert.deepEqual(f.c.store.get('execution_configuration','coordinator'),identity);assert.equal(f.c.getGoal(g.id).hash,g.hash);
 f.restore();if(phase==='planner')await worker.planner.tick({goalId:g.id});else if(reviewer)await assert.rejects(f.c.reviewService.runApi(binding,'review'),/spent|retry/i);else await worker.executeTask(f.c.getTask(task.id));
 assert.equal(posts,0);assert.equal(lookups,1);assert.equal(f.c.store.db.prepare('SELECT count(*) AS n FROM requests').get().n,1);assert.equal(f.c.store.spent(observed.task_id)[reviewer?'apiReview':'model'],1);
});

test('stopping pending review cannot rebind runtime on restart, while unchanged restart resumes the original approval',t=>{
 const f=fixture(t),g=f.c.preparePortableGoal(raw,'prepare');f.c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const task=f.c.submitTask({goalId:g.id,submissionId:'answer',kind:'consult',actor:'deepseek',objective:'Fixture answer',acceptance:['Clear']},'task');f.c.claimNext('owner');f.c.completeTask(task.id,{content:'Saved answer'},'owner',{reviewRequired:true});
 f.c.control({goalId:g.id,action:'stop'},'stop');const before=f.c.getTask(task.id),identity=f.c.store.get('execution_configuration','coordinator');assert.equal(before.status,'stopped');assert.equal(before.controlReturnStatus,'awaiting_review');
 const b=path.join(f.root,'other-runtime');writeFileSync(b,'unused replacement',{mode:0o700});
 assert.throws(()=>f.restart(b),/execution.*settings|runtime.*changed/i);
 f.restart();assert.deepEqual(f.c.store.get('execution_configuration','coordinator'),identity);f.c.control({goalId:g.id,action:'resume'},'resume');
 const resumed=f.c.getTask(task.id);assert.equal(resumed.status,'awaiting_review');assert.deepEqual(resumed.result,before.result);assert.deepEqual(resumed.spent,before.spent);assert.equal(f.c.getGoal(g.id).hash,g.hash);
});

test('the CLI service pins its actual PATH default when codexPath is omitted',async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-path-runtime-')),executable=path.join(root,'codex'),config=path.join(root,'config.json'),state=path.join(root,'state');
 writeFileSync(executable,original,{mode:0o700});writeFileSync(config,JSON.stringify({environment:'fixture',hostId:'cursor'}),{mode:0o600});
 const cli=fileURLToPath(new URL('../src/harness/cli.mjs',import.meta.url)),child=spawn(process.execPath,[cli,'serve','--root',state,'--config',config,'--port','0'],{env:{...process.env,PATH:root+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exit;}rmSync(root,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(Error('Service ready timeout: '+errors)),5000);child.stdout.on('data',b=>{output+=b;if(output.includes('\n')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>errors+=b);child.once('exit',code=>{clearTimeout(timer);if(!output.includes('\n'))reject(Error('Service exited '+code+': '+errors));});});
 const connection=JSON.parse(await readFile(path.join(state,'connection.json'),'utf8'));
 const invoke=async(name,input)=>{const response=await fetch(connection.url+'/api/invoke',{method:'POST',headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'},body:JSON.stringify({name,input})});return {status:response.status,body:await response.json()};};
 const prepared=await invoke('goal_prepare',{idempotencyKey:'prepare',manifest:raw});assert.equal(prepared.status,200,JSON.stringify(prepared.body));
 writeFileSync(executable,'changed PATH-selected private runtime',{mode:0o700});
 const activated=await invoke('goal_activate',{idempotencyKey:'activate',goalId:prepared.body.id,hash:prepared.body.hash});
 assert.equal(activated.status,400);assert.match(activated.body.error,/execution.*runtime.*changed/i);
});

test('an explicitly configured Codex backend pins the PATH default without inferring a legacy runner-only path',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-default-policy-')),executable=path.join(root,'codex'),oldPath=process.env.PATH;writeFileSync(executable,original,{mode:0o700});process.env.PATH=root+path.delimiter+oldPath;
 let c;t.after(()=>{c?.close();process.env.PATH=oldPath;rmSync(root,{recursive:true,force:true});});
 c=new Coordinator({root:path.join(root,'explicit-state'),selectedHost:'cursor',executionPolicy});const g=c.preparePortableGoal(raw,'prepare');
 writeFileSync(executable,'changed default runtime bytes',{mode:0o700});assert.throws(()=>c.activateGoal({goalId:g.id,hash:g.hash},'activate'),/execution.*runtime.*changed/i);
 c.close();c=new Coordinator({root:path.join(root,'legacy-state')});assert.equal(c.store.get('execution_configuration','coordinator').identity.runtime,null);
 c.prepareLegacyGoal({submissionId:'legacy',objective:'Keep legacy runtime',acceptance:['Saved'],mode:'deepseek_only'},'legacy');c.close();
 c=new Coordinator({root:path.join(root,'legacy-state'),executionPolicy});assert.equal(c.store.get('execution_configuration','coordinator').identity.runtime,null);
});

test('normalized private Beta settings pin the actual PATH runtime without a Codex path',async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-path-runtime-')),executable=path.join(root,'codex'),config=path.join(root,'config.json'),state=path.join(root,'state');
 writeFileSync(executable,original,{mode:0o700});
 const moduleUrl=name=>new URL('../src/beta/'+name,import.meta.url).href;
 const driver=`import {locations,privateDirectories,saveJson} from ${JSON.stringify(moduleUrl('files.mjs'))};import {readSettings} from ${JSON.stringify(moduleUrl('setup.mjs'))};import {serveBeta} from ${JSON.stringify(moduleUrl('service.mjs'))};const paths=locations(${JSON.stringify(root)},true);await privateDirectories(paths);await saveJson(paths.config,{schema:1,host:{id:'cursor',options:{}},executionPolicy:${JSON.stringify(executionPolicy)}});await serveBeta(paths,await readSettings(paths));`;
 const child=spawn(process.execPath,['--input-type=module','-e',driver],{env:{...process.env,PATH:root+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exit;}rmSync(root,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(Error('Service ready timeout: '+errors)),5000);child.stdout.on('data',b=>{output+=b;if(output.includes('\n')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>errors+=b);child.once('exit',code=>{clearTimeout(timer);if(!output.includes('\n'))reject(Error('Service exited '+code+': '+errors));});});
 const connection=JSON.parse(await readFile(path.join(root,'Library','Application Support','Mosaic Beta','state','connection.json'),'utf8'));
 const invoke=async(name,input)=>{const response=await fetch(connection.url+'/api/invoke',{method:'POST',headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'},body:JSON.stringify({name,input})});return {status:response.status,body:await response.json()};};
 const prepared=await invoke('goal_prepare',{idempotencyKey:'prepare',manifest:{...raw,mode:'codex_only'}});assert.equal(prepared.status,200,JSON.stringify(prepared.body));
 writeFileSync(executable,'changed PATH-selected private runtime',{mode:0o700});
 const activated=await invoke('goal_activate',{idempotencyKey:'activate',goalId:prepared.body.id,hash:prepared.body.hash});
 assert.equal(activated.status,400);assert.match(activated.body.error,/execution.*runtime.*changed/i);
});

