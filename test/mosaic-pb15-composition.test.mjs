import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {normalizeGoal,digest,goalInputSchema,goalDispatchInputSchema} from '../src/harness/contracts.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {locations,privateDirectories,saveJson} from '../src/beta/files.mjs';
import {readSettings,doctor} from '../src/beta/setup.mjs';
import {assertMaintenanceIdle} from '../src/beta/service.mjs';
import {command} from '../src/project/process.mjs';
import {fileURLToPath} from 'node:url';
const codex={version:1,backend:'codex-sandbox',backendRevision:1};
const native={version:1,backend:'darwin-seatbelt',backendRevision:1};
const legacy={submissionId:'legacy-execution',objective:'Keep legacy execution approval',acceptance:['Checked'],mode:'deepseek_only'};
function fixture(t,options={}){const root=mkdtempSync(path.join(os.tmpdir(),'pb15-composition-'));let c=new Coordinator({root,...options});t.after(()=>{c?.close();rmSync(root,{recursive:true,force:true});});return {root,get c(){return c;},restart(opts={}){c?.close();c=null;c=new Coordinator({root,...opts});return c;}};}

test('execution policy is additive: historical hash and historical public schema remain unchanged',()=>{
 assert.equal(digest(normalizeGoal(legacy)),'5d3cced6c5e0dc23f7ab593224758ade402d4cd50394ea391e39360e651982d8');
 assert.equal(Object.hasOwn(normalizeGoal(legacy),'executionPolicy'),false);
 assert.equal(Object.hasOwn(goalInputSchema.properties,'executionPolicy'),false);
 assert.ok(goalDispatchInputSchema.properties.executionPolicy);
 const a=normalizeGoal({...legacy,executionPolicy:codex}),b=normalizeGoal({...legacy,executionPolicy:native});
 assert.deepEqual(a.executionPolicy,codex);assert.deepEqual(b.executionPolicy,native);assert.notEqual(digest(a),digest(b));
 for(const executionPolicy of [null,{...native,backendRevision:'1'},{...native,backendRevision:2},{...native,version:2},{...native,backend:'shell'},{...native,backendFactory:'unsafe'}])assert.throws(()=>normalizeGoal({...legacy,executionPolicy}),/execution|backend/i);
});

test('configured policy enters only fresh preparation, while legacy commands replay exact saved approvals',t=>{
 const f=fixture(t);const old=f.c.prepareGoal(legacy,'old');
 f.c.executionPolicy=codex;
 assert.deepEqual(f.c.prepareGoal(legacy,'old'),old);
 const fresh=f.c.prepareGoal({...legacy,submissionId:'fresh'},'fresh');assert.deepEqual(fresh.manifest.executionPolicy,codex);
 assert.deepEqual(f.restart({executionPolicy:codex}).prepareGoal({...legacy,submissionId:'fresh'},'fresh'),fresh);
 assert.deepEqual(f.c.prepareGoal(legacy,'old'),old);
 assert.throws(()=>f.c.prepareGoal({...legacy,executionPolicy:native},'old'),/conflict/i);
});

test('unavailable native approval stops before activation and never changes an existing goal backend',t=>{
 const f=fixture(t),g=f.c.prepareGoal({...legacy,executionPolicy:native},'native');
 assert.throws(()=>f.c.activateGoal({goalId:g.id,hash:g.hash},'activate'),/descendant.*containment|containment.*descendant/i);
 assert.equal(f.c.getGoal(g.id).status,'draft');assert.equal(f.c.store.spent(g.id).model??0,0);
 const goals=new Goals(f.c);
 assert.throws(()=>goals.prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:{...legacy,executionPolicy:codex}},'switch'),/execution.*backend|backend.*goal/i);
});

test('restart rejects incompatible settings for prepared and stopped unfinished work but preserves old evidence',t=>{
 const f=fixture(t),g=f.c.prepareGoal(legacy,'goal'),saved={backend:{id:'codex-sandbox',revision:1},readDenied:true};
 const current=f.c.store.get('goal',g.id);current.savedEvidence=saved;f.c.store.put('goal',current);
 assert.throws(()=>f.restart({executionPolicy:native}),/prepared|active|unfinished/i);
 const c=f.restart();assert.deepEqual(c.getGoal(g.id).savedEvidence,saved);
 const stopped=c.store.get('goal',g.id);stopped.status='stopped';stopped.deadline=Date.now()+60000;c.store.put('goal',stopped);
 c.store.put('task',{id:'held',goalId:g.id,status:'stopped',owner:'owned',native:{writerActive:true}});
 assert.throws(()=>f.restart({executionPolicy:native}),/prepared|active|unfinished/i);
});

test('private settings parse strict policy and prepared work blocks incompatible maintenance',async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-settings-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const paths=locations(root,true);await privateDirectories(paths);
 const settings={schema:1,host:{id:'cursor'},executionPolicy:native};await saveJson(paths.config,settings);
 assert.deepEqual((await readSettings(paths)).executionPolicy,native);
 await saveJson(paths.config,{...settings,executionPolicy:{...native,backendRevision:'1'}});await assert.rejects(readSettings(paths),/execution|backend/i);
 const c=new Coordinator({root:paths.state});t.after(()=>c.close());c.prepareGoal(legacy,'draft');await assert.rejects(assertMaintenanceIdle(paths),/prepared|active/i);
});

test('actual native product path has no Codex dependency and fails closed before checks or model POST', {timeout:30000},async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-no-codex-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const bin=path.join(root,'bin');mkdirSync(bin);writeFileSync(path.join(bin,'codex'),'unexpected codex',{mode:0o600});
 const script=fileURLToPath(new URL('./fixtures/mosaic-pb15-composition/no-codex.mjs',import.meta.url));
 const result=await command([process.execPath,script,root],{env:{PATH:'/usr/bin:/bin',TMPDIR:os.tmpdir()},timeoutMs:20000});
 assert.equal(result.code,0,result.stderr);const outcome=JSON.parse(result.stdout);assert.equal(outcome.codexPresent,false);assert.equal(outcome.modelPosts,0);assert.equal(outcome.checkMarker,false);assert.equal(outcome.lifecycle,'BLOCKED');assert.match(outcome.reason,/descendant.*containment|containment.*descendant/i);
});

test('every check factory receives the immutable workspace policy and rejects a mismatched runner',async()=>{
 const {approvedChecks}=await import('../src/harness/execution.mjs');
 const workspace={root:'/tmp/fixture',manifest:{executionPolicy:codex}},seen=[];
 const runner={backendIdentity:{id:'codex-sandbox',revision:1},verify:async()=>({fixture:true})};
 assert.equal(approvedChecks(workspace,{checksFactory:(w,options)=>{seen.push([w,options]);return runner;},config:{codexPath:process.execPath}}),runner);
 assert.deepEqual(seen[0][1],{codex:process.execPath,backend:'codex-sandbox'});
 assert.throws(()=>approvedChecks(workspace,{checksFactory:()=>({backendIdentity:{id:'darwin-seatbelt',revision:1}}),config:{codexPath:process.execPath}}),/identity.*approved/i);
 let injected=0;assert.throws(()=>approvedChecks({root:'/tmp/fixture',manifest:{executionPolicy:native}},{checksFactory:()=>{injected++;return runner;}}),/containment/i);assert.equal(injected,0);
});

 test('native diagnostics report containment prerequisite without unrelated Codex sign-in advice',async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-doctor-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const paths=locations(root,true);await privateDirectories(paths);await saveJson(paths.config,{schema:1,host:{id:'cursor'},executionPolicy:native});
 let output='';assert.equal(await doctor(paths,{write:text=>{output+=text;}}),false);assert.match(output,/containment/i);assert.doesNotMatch(output,/codex login|Codex sign-in|Install the Codex CLI/i);
 });

test('overnight source identity includes the actual backend implementation bytes',async t=>{
 const {cp,appendFile}=await import('node:fs/promises');
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-runtime-identity-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 await cp(fileURLToPath(new URL('../src',import.meta.url)),path.join(root,'src'),{recursive:true});
 const copied=await import(new URL('file://'+path.join(root,'src/harness/overnight-preflight.mjs')).href);
 const before=copied.overnightRuntimeIdentity();
 await appendFile(path.join(root,'src/project/check-backends/codex-sandbox.mjs'),'\n// disposable enforcement change\n');
 assert.notEqual(copied.overnightRuntimeIdentity(),before,'Backend code mutation must invalidate prior preflight receipts');
});

test('overnight inputs record explicit execution policy while absent-policy inputs retain their shape',async t=>{
 const {overnightInputs}=await import('../src/harness/overnight-preflight.mjs');
 const {git}=await import('../src/project/process.mjs');
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-inputs-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(path.join(root,'input.txt'),'disposable');await git(root,'init','-q');await git(root,'add','.');await git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Base');
 const project={repo:root,baseCommit:await git(root,'rev-parse','HEAD'),readPaths:['input.txt']};
 const a=overnightInputs({project},process.execPath),b=overnightInputs({project,executionPolicy:codex},process.execPath);
 assert.equal(Object.hasOwn(a,'executionPolicy'),false);assert.deepEqual(b.executionPolicy,codex);
 assert.deepEqual(b.sandboxRuntime,{...a.sandboxRuntime,id:'codex-sandbox',revision:1});
});

test('running settings bind the trusted Codex sandbox executable path as well as backend identity',async()=>{
 const {configuredExecutionIdentity}=await import('../src/beta/service.mjs');
 const initial={executionPolicy:codex,codexPath:'/tmp/fixture-a/codex'};
 assert.notEqual(configuredExecutionIdentity(initial),configuredExecutionIdentity({...initial,codexPath:'/tmp/fixture-b/codex'}));
 assert.equal(configuredExecutionIdentity({executionPolicy:native,codexPath:'/unused/a'}),configuredExecutionIdentity({executionPolicy:native,codexPath:'/unused/b'}));
});

test('approved Codex execution prerequisite rejects a directory or removed executable without spawning it',async t=>{
 const {assertExecutionAvailable}=await import('../src/harness/execution.mjs');
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-executable-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.throws(()=>assertExecutionAvailable({executionPolicy:codex},{codexPath:root}),/executable.*unavailable/i);
 const removed=path.join(root,'removed');writeFileSync(removed,'must not execute',{mode:0o700});rmSync(removed);
 assert.throws(()=>assertExecutionAvailable({executionPolicy:codex},{codexPath:removed}),/executable.*unavailable/i);
 assert.doesNotThrow(()=>assertExecutionAvailable({executionPolicy:codex},{codexPath:process.execPath}));
});

test('native prepared policy survives restart as blocked approval and cannot activate a stored switching revision',t=>{
 const f=fixture(t,{executionPolicy:native}),g=f.c.prepareGoal(legacy,'native-prepared');
 assert.deepEqual(g.manifest.executionPolicy,native);
 assert.deepEqual(f.restart({executionPolicy:native}).prepareGoal(legacy,'native-prepared'),g);
 const manifest=normalizeGoal({...legacy,executionPolicy:codex}),revision={id:'switching',goalId:g.id,previousHash:g.hash,version:2,manifest,hash:digest(manifest),status:'draft'};
 f.c.store.put('goal_revision',revision);
 assert.throws(()=>new Goals(f.c).activateRevision({revisionId:revision.id,hash:revision.hash},'stored-switch'),/execution.*backend|backend.*goal/i);
 assert.deepEqual(f.c.getGoal(g.id).manifest.executionPolicy,native);
});

test('actual Codex backend honors explicit approval through worker candidate and combined integration despite mutable defaults', {timeout:30000},async t=>{
 const {git}=await import('../src/project/process.mjs');
 const {Worker}=await import('../src/harness/worker.mjs');
 const {CheckRunner}=await import('../src/project/sandbox.mjs');
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-codex-approved-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const repo=path.join(root,'repo');mkdirSync(path.join(repo,'src'),{recursive:true});mkdirSync(path.join(repo,'checks'));
 writeFileSync(path.join(repo,'src/value.mjs'),'export const value=0;\n');writeFileSync(path.join(repo,'checks/check.mjs'),"import {value} from '../src/value.mjs';if(value!==42)process.exit(1);\n");
 await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Base');
 const c=new Coordinator({root:path.join(root,'state')});t.after(()=>c.close());
 const g=c.prepareGoal({submissionId:'explicit',objective:'Check and integrate 42',acceptance:['Protected output'],mode:'deepseek_only',executionPolicy:codex,environment:'fixture',project:{repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'check',argv:[process.execPath,'checks/check.mjs'],timeoutMs:1000}]}},'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const task=c.submitTask({goalId:g.id,submissionId:'code',kind:'coding',objective:'Set42',acceptance:['Check passes']},'submit');
 c.executionPolicy=native;const seen=[];
 const worker=new Worker({c,config:{environment:'fixture',executionPolicy:native},checksFactory:(workspace,options)=>{seen.push({policy:workspace.manifest.executionPolicy,options,root:workspace.root});return new CheckRunner(workspace,options);},provider:{complete:async messages=>{const input=JSON.parse(messages.at(-1).content),file=input.files.find(file=>file.path==='src/value.mjs');return {content:JSON.stringify({type:'submit_changes',paths:[],summary:'Fixture42',edits:[{path:file.path,action:'write',baseHash:file.hash,content:'export const value=42;\n'}]})};}}});
 await worker.drain();const saved=c.getTask(task.id);assert.equal(saved.status,'accepted',saved.reason);assert.ok(seen.some(item=>item.root.includes('/coding/')));assert.ok(seen.some(item=>item.root.includes('/integration/')));
 for(const item of seen){assert.deepEqual(item.policy,codex);assert.equal(item.options.backend,'codex-sandbox');}
 for(const checks of [saved.result.checks,saved.integration.checks])for(const check of checks){assert.equal(check.passed,true);assert.equal(check.backend.id,'codex-sandbox');assert.equal(check.backend.revision,1);}
 assert.equal(saved.result.sandbox.backend.id,'codex-sandbox');assert.equal(c.getGoal(g.id).manifest.executionPolicy.backend,'codex-sandbox');
});

for(const mutation of ['executable','settings'])test(`API review ${mutation} change during credential lookup blocks POST and preserves the original spent reservation`,async t=>{
 const {createServer}=await import('node:http');
 const {ProviderRegistry}=await import('../src/harness/providers/registry.mjs');
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-dispatch-fence-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const executable=path.join(root,'sandbox'),settingsFile=path.join(root,'settings.json');writeFileSync(executable,'never executed',{mode:0o700});
 const originalSettings={executionPolicy:codex,codexPath:executable};writeFileSync(settingsFile,JSON.stringify(originalSettings));
 const {readFileSync}=await import('node:fs');let posts=0,lookups=0,c,observed;
 const server=createServer(async(req,res)=>{for await(const chunk of req){}posts++;res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({decision:'accept',feedback:'Fixture review',findings:[]})},finish_reason:'stop'}]}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const profile={schema:1,id:'reviewer',revision:'r1',displayName:'Fixture reviewer',transport:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model',roles:['reviewer'],capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]},maxContextTokens:null,maxOutputTokens:2048,concurrency:1,capacityGroup:'fixture',credentialRef:'fixture-key-ref',streaming:false};
 const providers=ProviderRegistry({profiles:[profile],credentialResolver:async()=>{lookups++;await new Promise(resolve=>setImmediate(resolve));observed={ticket:c.store.all('review_ticket')[0],request:c.store.db.prepare("SELECT id,key FROM requests WHERE kind='apiReview'").get()};if(mutation==='executable')rmSync(executable);else writeFileSync(settingsFile,JSON.stringify({...originalSettings,executionPolicy:native}));return 'private-fixture-token';}});
 c=new Coordinator({root:path.join(root,'state'),selectedHost:'cursor',providerRegistry:providers,codexPath:executable,verifyCurrentWorker:()=>{if(digest(JSON.parse(readFileSync(settingsFile,'utf8')))!==digest(originalSettings))throw Error('Disposable execution settings changed');}});t.after(()=>c.close());c.acquireWorker('owner');
 const goal=c.preparePortableGoal({submissionId:'review-fence',objective:'Review bounded answer',acceptance:['Clear'],mode:'collaborative',environment:'fixture',executionPolicy:codex,reviewPolicy:{version:1,source:'api',reviewer:providers.get('reviewer','r1'),fallback:'wait'},limits:{hours:1,maxTasks:1,reviewAgentRuns:2}},'prepare');c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
 const task=c.submitTask({goalId:goal.id,submissionId:'answer',kind:'consult',actor:'deepseek',objective:'Fixture answer',acceptance:['Clear']},'task');assert.equal(c.claimNext('owner').id,task.id);c.completeTask(task.id,{content:'Bounded fixture answer'},'owner',{reviewRequired:true});
 const binding=(await c.reviewService.inbox({goalId:goal.id})).items[0].binding;
 await assert.rejects(c.reviewService.runApi(binding,'review-fence'),/reservation remains spent|no fallback/i);
 assert.equal(posts,0);assert.equal(lookups,1);assert.equal(c.getTask(task.id).reviews,1);assert.equal(c.store.spent(task.id).apiReview,1);assert.equal(c.store.spent(task.id).model??0,0);
 const saved=c.store.request(task.id,observed.request.key),ticket=c.store.get('review_ticket',observed.ticket.id);assert.equal(saved.id,observed.request.id);assert.equal(saved.status,'failed');assert.equal(saved.requestOutcome,'not_dispatched');
 assert.deepEqual(ticket,observed.ticket);assert.equal(c.getTask(task.id).status,'awaiting_review');assert.equal(c.getTask(task.id).reviewed,false);
 writeFileSync(executable,'never executed',{mode:0o700});writeFileSync(settingsFile,JSON.stringify(originalSettings));
 await assert.rejects(c.reviewService.runApi(binding,'review-fence'),/spent|retry/i);assert.equal(posts,0);assert.equal(lookups,1);assert.equal(c.store.all('review_ticket').length,1);assert.equal(c.store.spent(task.id).apiReview,1);
});

test('unchanged native default restarts an explicitly approved Codex goal without rebinding it',t=>{
 const options={executionPolicy:native,codexPath:process.execPath},f=fixture(t,options);
 const raw={...legacy,executionPolicy:codex},goal=f.c.prepareGoal(raw,'override');f.c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
 const before=f.c.getGoal(goal.id);assert.deepEqual(f.restart(options).getGoal(goal.id),before);assert.deepEqual(f.c.prepareGoal(raw,'override'),goal);
});

test('unchanged absent default restarts an explicitly native draft while retaining its containment block',t=>{
 const f=fixture(t),raw={...legacy,executionPolicy:native},goal=f.c.prepareGoal(raw,'blocked-override');
 assert.throws(()=>f.c.activateGoal({goalId:goal.id,hash:goal.hash},'activate'),/containment/i);
 assert.deepEqual(f.restart().prepareGoal(raw,'blocked-override'),goal);assert.throws(()=>f.c.activateGoal({goalId:goal.id,hash:goal.hash},'activate-again'),/containment/i);
});

test('restart detects trusted executable byte and path changes independently of goal overrides',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-config-runtime-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const a=path.join(root,'sandbox-a'),b=path.join(root,'sandbox-b');writeFileSync(a,'unused A',{mode:0o700});writeFileSync(b,'unused B',{mode:0o700});
 const options={executionPolicy:native,codexPath:a},f=fixture(t,options),goal=f.c.prepareGoal({...legacy,executionPolicy:codex},'override');
 const before=f.c.getGoal(goal.id);assert.throws(()=>f.restart({...options,codexPath:b}),/execution.*settings|runtime.*changed/i);
 assert.deepEqual(f.restart(options).getGoal(goal.id),before);
 writeFileSync(a,'changed unused A',{mode:0o700});assert.throws(()=>f.restart(options),/execution.*settings|runtime.*changed/i);
 writeFileSync(a,'unused A',{mode:0o700});assert.deepEqual(f.restart(options).getGoal(goal.id),before);
});

async function exactPreflightFixture(t,{legacyConfig=false}={}){
 const {git}=await import('../src/project/process.mjs');const {OvernightPreflight}=await import('../src/harness/overnight-preflight.mjs');
 const root=mkdtempSync(path.join(os.tmpdir(),'pb15-preflight-runtime-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo'),a=path.join(root,'sandbox-a'),b=path.join(root,'sandbox-b');mkdirSync(path.join(repo,'src'),{recursive:true});mkdirSync(path.join(repo,'checks'));writeFileSync(path.join(repo,'src/value.mjs'),'export const value=1;\n');writeFileSync(path.join(repo,'checks/check.mjs'),'never executed');writeFileSync(a,'unused A',{mode:0o700});writeFileSync(b,'unused B',{mode:0o700});
 await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Base');
 const options=legacyConfig?{}:{codexPath:a};const c=new Coordinator({root:path.join(root,'state'),...options});t.after(()=>c.close());
 const raw={submissionId:'overnight-exact',objective:'Exact preflight',acceptance:['Checked'],mode:'overnight_review',environment:'fixture',executionPolicy:codex,project:{repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'starter',argv:[process.execPath,'checks/check.mjs']},{id:'final',argv:[process.execPath,'checks/check.mjs']}]},overnightPolicy:{preflightCheckIds:['starter'],finalOnlyCheckIds:['final']}};
 const goal=c.prepareGoal(raw,'prepare');let runs=0;const preflight=new OvernightPreflight({c,config:{codexPath:a},checksFactory:()=>({backendIdentity:{id:'codex-sandbox',revision:1},verify:async()=>({fixture:true}),run:async specs=>{runs++;return specs.map(check=>({id:check.id,passed:true,code:0}));}})});
 const receipt=await preflight.run({goalId:goal.id,hash:goal.hash},'preflight');assert.equal(receipt.passed,true);assert.deepEqual(await preflight.run({goalId:goal.id,hash:goal.hash},'replay'),receipt);assert.equal(runs,1);
 return {c,raw,goal,receipt,preflight,a,b};
}

for(const revision of [false,true])test(`exact overnight ${revision?'revision ':''}activation compares the current trusted executable with its saved receipt`,async t=>{
 const f=await exactPreflightFixture(t);let g=f.goal;
 if(revision){f.c.activateGoal({goalId:g.id,hash:g.hash},'activate');const r=new Goals(f.c).prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:{...f.raw,objective:'Revised exact preflight'}},'revision');await f.preflight.run({goalId:g.id,hash:r.hash},'revision-preflight');g={...g,hash:r.hash,revisionId:r.id};}
 const receipt=f.c.store.get('overnight_preflight',g.id);f.c.executionConfig.codexPath=f.b;
 const activate=key=>revision?new Goals(f.c).activateRevision({revisionId:g.revisionId,hash:g.hash},key):f.c.activateGoal({goalId:g.id,hash:g.hash},key);
 assert.throws(()=>activate('wrong-runtime'),/preflight.*changed|runtime.*changed/i);assert.deepEqual(f.c.store.get('overnight_preflight',g.id),receipt);
 f.c.executionConfig.codexPath=f.a;assert.equal(activate('correct-runtime').status,'active');assert.deepEqual(f.c.store.get('overnight_preflight',g.id),receipt);
});

test('legacy caller without trusted executable configuration retains its saved preflight fallback',async t=>{
 const f=await exactPreflightFixture(t,{legacyConfig:true});assert.equal(f.c.executionConfig.codexPath,undefined);assert.equal(f.c.activateGoal({goalId:f.goal.id,hash:f.goal.hash},'activate').status,'active');assert.deepEqual(f.c.store.get('overnight_preflight',f.goal.id),f.receipt);
});

test('actual A-to-B restart rejects prepared overnight work, while unchanged A reuses the exact receipt',async t=>{
 const {OvernightPreflight}=await import('../src/harness/overnight-preflight.mjs');const f=await exactPreflightFixture(t),root=f.c.store.root;f.c.close();
 assert.throws(()=>new Coordinator({root,codexPath:f.b}),/execution.*settings|runtime.*changed/i);
 const restored=new Coordinator({root,codexPath:f.a});t.after(()=>restored.close());
 assert.deepEqual(restored.store.get('overnight_preflight',f.goal.id),f.receipt);
 const replay=new OvernightPreflight({c:restored,config:{codexPath:f.a},checksFactory:()=>{assert.fail('Unchanged successful preflight must reuse its saved receipt');}});
 assert.deepEqual(await replay.run({goalId:f.goal.id,hash:f.goal.hash},'restart-replay'),f.receipt);
 assert.equal(restored.activateGoal({goalId:f.goal.id,hash:f.goal.hash},'activate-after-restart').status,'active');assert.deepEqual(restored.store.get('overnight_preflight',f.goal.id),f.receipt);
});

test('quiescent configuration changes update only trusted defaults and preserve historical goal policy and evidence',t=>{
 const f=fixture(t),goal=f.c.prepareGoal(legacy,'historic'),saved={backend:{id:'codex-sandbox',revision:1},readDenied:true};
 const historical=f.c.store.get('goal',goal.id);historical.status='completed';historical.savedEvidence=saved;f.c.store.put('goal',historical);
 assert.deepEqual(f.restart({executionPolicy:native}).getGoal(goal.id),{...historical,planning:null,tasks:[],reviewerRuns:[]});
 assert.deepEqual(f.c.prepareGoal({...legacy,submissionId:'new'},'new-default').manifest.executionPolicy,native);
});
