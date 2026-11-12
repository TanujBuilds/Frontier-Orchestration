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
