// Historical no-policy workflows explicitly select the legacy preparation tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,mkdir,symlink,rename,cp,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {packageHarness,renderLaunchAgent,verifyPackage} from '../src/harness/package.mjs';

const sourceRoot=fileURLToPath(new URL('..',import.meta.url));
const execute=promisify(execFile);
async function portableSource(root){
 const source=path.join(root,'source');await mkdir(source);
 for(const item of ['src','package.json','package-lock.json',...['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only','deep-research'].map(name=>'.agents/skills/'+name)])await cp(path.join(sourceRoot,item),path.join(source,item),{recursive:true,filter:file=>!file.includes('__pycache__')&&!file.includes('local-config.json')});
 // The placeholder config is reviewed package data, unlike adjacent private config.
 await cp(path.join(sourceRoot,'.agents/skills/frontier-harness/examples/local-config.json'),path.join(source,'.agents/skills/frontier-harness/examples/local-config.json'));
 await execute('git',['init','-q'],{cwd:source});await execute('git',['add','.'],{cwd:source});await execute('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','portable source fixture'],{cwd:source});return source;
}
test('portable skill bundle resolves one shared runtime after relocation and excludes private configuration',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-layout-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const original=path.join(root,'version'),relocated=path.join(root,'relocated');
 const manifest=await packageHarness({sourceRoot,destination:original,dependencies:true,offline:true});await rename(original,relocated);
 for(const name of ['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only']){
  const skill=path.join(relocated,'skills',name),metadata=await readFile(path.join(skill,'agents/openai.yaml'),'utf8');
  assert.match(metadata,/value: "frontier-harness"/);assert.match(metadata,/transport: "stdio"/);assert.doesNotMatch(metadata,/url:|allow_implicit_invocation: false/);
  const body=await readFile(path.join(skill,'SKILL.md'),'utf8');for(const match of body.matchAll(/\]\(([^)]+\.md)\)/g))await readFile(path.resolve(skill,match[1]));
 }
 const compatibilityBody=await readFile(path.join(relocated,'SKILL.md'),'utf8');for(const match of compatibilityBody.matchAll(/\]\(([^)]+\.md)\)/g))await readFile(path.resolve(relocated,match[1]));
 for(const entry of ['scripts/harness.mjs','skills/frontier-harness/scripts/harness.mjs']){
  const result=await new Promise(resolve=>{const p=spawn(process.execPath,[path.join(relocated,entry),'--help'],{cwd:root,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('exit',code=>resolve({code,stdout,stderr}));});
  assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/Mosaic/);
 }
 const missingRuntimeConfig=path.join(root,'private-binding.json');await writeFile(missingRuntimeConfig,JSON.stringify({runtimeRoot:path.join(root,'missing-runtime')}));
 const unavailable=await execute(process.execPath,[path.join(relocated,'scripts/harness.mjs'),'--help'],{cwd:root,env:{PATH:process.env.PATH,FRONTIER_HARNESS_CONFIG:missingRuntimeConfig}}).then(()=>null,error=>error);assert.ok(unavailable);assert.match(unavailable.stderr,/Cannot find module|runtime unavailable/);
 assert.equal(manifest.layout,'shared-runtime-v1');assert.deepEqual(manifest.skills,['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only']);
 assert.ok(manifest.files.some(f=>f.path==='roles/implementer.toml'));assert.ok(manifest.files.some(f=>f.path==='examples/local-config.json'));
 assert.equal(manifest.files.filter(f=>f.path.endsWith('/src/harness/cli.mjs')).length,1);
 assert.ok(manifest.files.every(f=>!/(?:^|\/)(?:connection|local-config)\.json$/.test(f.path)||f.path.endsWith('examples/local-config.json')));
 assert.equal(await verifyPackage(relocated),true);
 for(const file of ['roles/reviewer.toml','skills/frontier-collaborate/SKILL.md','runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js']){const original=await readFile(path.join(relocated,file));await writeFile(path.join(relocated,file),'tampered');await assert.rejects(verifyPackage(relocated),/checksum/);await writeFile(path.join(relocated,file),original);}
});

test('portable source inclusion omits adjacent secrets and fails closed when locked dependencies are unavailable',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-private-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=await portableSource(root),skill=path.join(source,'.agents/skills/frontier-harness');
 for(const name of ['local-config.json','connection.json','credentials.json','auth.json','state.sqlite','references/private.json'])await writeFile(path.join(skill,name),'PRIVATE_SENTINEL');
 await mkdir(path.join(skill,'.data'));await writeFile(path.join(skill,'.data/saved-source.txt'),'PRIVATE_SENTINEL');
 const destination=path.join(root,'private-free'),manifest=await packageHarness({sourceRoot:source,destination});for(const file of manifest.files)assert.ok(!(await readFile(path.join(destination,file.path),'utf8')).includes('PRIVATE_SENTINEL'),file.path);
 // A failed build remains inspectable, has no valid manifest and is never reused.
 const failed=path.join(root,'failed'),previous=process.env.npm_config_cache;process.env.npm_config_cache=path.join(root,'empty-cache');
 try{await assert.rejects(packageHarness({sourceRoot:source,destination:failed,dependencies:true,offline:true}),/Pinned runtime dependency installation failed/);}finally{if(previous===undefined)delete process.env.npm_config_cache;else process.env.npm_config_cache=previous;}
 await assert.rejects(verifyPackage(failed),/ENOENT/);await assert.rejects(packageHarness({sourceRoot:source,destination:failed}),/already exists/);await readFile(path.join(failed,'runtime/package-lock.json'));
});

test('verification rejects missing or mismatched installed SDK and does not follow source symlinks',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-deps-'));t.after(()=>rm(root,{recursive:true,force:true}));const destination=path.join(root,'version'),manifest=await packageHarness({sourceRoot,destination});
 await writeFile(path.join(destination,'package-manifest.json'),JSON.stringify({...manifest,dependenciesInstalled:true}));await assert.rejects(verifyPackage(destination),/ENOENT/);
 const sdk=path.join(destination,'runtime/node_modules/@modelcontextprotocol/sdk');await mkdir(sdk,{recursive:true});await writeFile(path.join(sdk,'package.json'),JSON.stringify({version:'0.0.0'}));const {createHash}=await import('node:crypto'),{digest}=await import('../src/harness/contracts.mjs'),sdkBytes=await readFile(path.join(sdk,'package.json')),files=[...manifest.files,{path:'runtime/node_modules/@modelcontextprotocol/sdk/package.json',bytes:sdkBytes.length,sha256:createHash('sha256').update(sdkBytes).digest('hex')}];await writeFile(path.join(destination,'package-manifest.json'),JSON.stringify({...manifest,dependenciesInstalled:true,files,contentHash:digest(files)}));await assert.rejects(verifyPackage(destination),/Pinned runtime dependency mismatch/);
 const source=await portableSource(root),script=path.join(source,'.agents/skills/frontier-harness/scripts/harness.mjs');await rm(script);await symlink(path.join(sourceRoot,'.agents/skills/frontier-harness/scripts/harness.mjs'),script);await assert.rejects(packageHarness({sourceRoot:source,destination:path.join(root,'symlink-source')}),/symlink/);
});

test('package verifier rejects malformed inventories, duplicate entries and symlink parents',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-unsafe-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const destination=path.join(root,'version'),manifest=await packageHarness({sourceRoot,destination});
 const {digest}=await import('../src/harness/contracts.mjs');
 const save=async files=>writeFile(path.join(destination,'package-manifest.json'),JSON.stringify({...manifest,files,contentHash:digest(files)}));
 for(const file of [{path:'../escape',sha256:'a'.repeat(64),bytes:0},{path:'runtime\\escape',sha256:'a'.repeat(64),bytes:0}]){await save([file]);await assert.rejects(verifyPackage(destination),/Invalid package/);}
 await save([manifest.files[0],manifest.files[0]]);await assert.rejects(verifyPackage(destination),/Duplicate/);
 await writeFile(path.join(destination,'package-manifest.json'),JSON.stringify({files:null}));await assert.rejects(verifyPackage(destination),/Invalid package manifest/);
 await writeFile(path.join(destination,'package-manifest.json'),JSON.stringify(manifest));
 const moved=path.join(root,'external-runtime');await rename(path.join(destination,'runtime'),moved);await symlink(moved,path.join(destination,'runtime'));await assert.rejects(verifyPackage(destination),/symlink|regular/);
});

test('standalone snapshot serves installed MCP tools and verifies its checksummed contents',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-package-')),destination=path.join(root,'frontier-harness');let child;const client=new Client({name:'installed-forward',version:'1'});
 t.after(async()=>{await client.close();if(child&&child.exitCode===null&&child.signalCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end;}await rm(root,{recursive:true,force:true});});
 const sourceRoot=fileURLToPath(new URL('..',import.meta.url)),manifest=await packageHarness({sourceRoot,destination,dependencies:true,offline:true});assert.ok(manifest.files.length>30);assert.equal(await verifyPackage(destination),true);
 const state=path.join(root,'state'),config=path.join(root,'config.json');await writeFile(config,JSON.stringify({environment:'fixture',fixtureReply:'Installed fixture answer'}),{mode:0o600});
 const loader=path.join(root,'deny-checkout.mjs');await writeFile(loader,`export async function resolve(specifier,context,next){const resolved=await next(specifier,context);if(resolved.url.startsWith(${JSON.stringify(new URL('../',import.meta.url).href)}))throw Error('Development checkout import forbidden');return resolved;}`);
 const binding=path.join(root,'private-local-config.json');await writeFile(binding,JSON.stringify({dataDir:state}),{mode:0o600});
 const launcher=path.join(destination,'scripts/harness.mjs'),flags=['--experimental-loader',loader],privateEnv={...process.env,FRONTIER_HARNESS_CONFIG:binding};child=spawn(process.execPath,[...flags,launcher,'serve','--config',config,'--port','0'],{cwd:root,env:privateEnv,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let output='',errors='';child.stdout.on('data',b=>{output+=b;if(output.includes('\n'))resolve();});child.stderr.on('data',b=>errors+=b);child.on('exit',code=>reject(Error(`Installed service exited ${code}: ${errors}`)));});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[...flags,launcher,'mcp'],env:privateEnv,cwd:root,stderr:'pipe'}));const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='goal_prepare'));
 const call=async(name,input)=>{const response=await client.callTool({name,arguments:input});assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);};
 const goal=await call('legacy_goal_prepare',{idempotencyKey:'p',manifest:{submissionId:'installed',objective:'Verify installed capability',acceptance:['Native evidence'],mode:'codex_only',environment:'fixture'}});await call('goal_activate',{idempotencyKey:'a',goalId:goal.id,hash:goal.hash});const task=await call('task_submit',{idempotencyKey:'t',goalId:goal.id,task:{submissionId:'native',kind:'consult',objective:'Record an explanation',acceptance:['Saved native answer']}});
 await call('native_text_start',{idempotencyKey:'start',taskId:task.id});const done=await call('native_text_finish',{idempotencyKey:'finish',taskId:task.id,content:'Installed native answer.'});assert.equal(done.spent.model,0);assert.equal(done.status,'accepted');
 const receipt=await call('goal_finalize',{idempotencyKey:'final',goalId:goal.id,summary:'Installed MCP and actor isolation verified'});assert.ok(receipt.receiptHash);
 await writeFile(path.join(destination,'runtime/src/harness/provider.mjs'),'tampered');await assert.rejects(verifyPackage(destination),/checksum/);
});
test('LaunchAgent uses literal escaped arguments and keeps private state outside the runtime',()=>{
 const plist=renderLaunchAgent({node:'/opt/node24/bin/node',entry:'/tmp/Frontier & Test/runtime/src/harness/cli.mjs',root:'/tmp/private state',config:'/tmp/private config.json',port:4332,logs:'/tmp/private logs'});assert.match(plist,/Frontier &amp; Test/);assert.match(plist,/<string>--root<\/string>/);assert.doesNotMatch(plist,/<string>(?:sh|bash|zsh)<\/string>/);assert.match(plist,/<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
});

test('package verifier rejects added nested dependency shadows and unlisted symlinks',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-shadow-'));t.after(()=>rm(root,{recursive:true,force:true}));const destination=path.join(root,'version');await packageHarness({sourceRoot,destination,dependencies:true,offline:true});assert.equal(await verifyPackage(destination),true);
 const nested=path.join(destination,'runtime/src/harness/node_modules'),sdk=path.join(nested,'@modelcontextprotocol/sdk');await mkdir(path.join(sdk,'server'),{recursive:true});await writeFile(path.join(sdk,'package.json'),JSON.stringify({name:'@modelcontextprotocol/sdk',version:'0.0.0',exports:{'./server/index.js':'./server/index.js'}}));await writeFile(path.join(sdk,'server/index.js'),'export const shadow=true;');
 const require=createRequire(path.join(destination,'runtime/src/harness/mcp.mjs'));assert.equal(require.resolve('@modelcontextprotocol/sdk/server/index.js'),await realpath(path.join(sdk,'server/index.js')));await assert.rejects(verifyPackage(destination),/Unlisted|Unexpected|inventory/);
 await rm(nested,{recursive:true});await symlink(path.join(destination,'runtime/node_modules'),nested);await assert.rejects(verifyPackage(destination),/symlink|regular|Unlisted|Unexpected/);
 await rm(nested);await mkdir(path.join(destination,'runtime/src/unlisted-empty'));await assert.rejects(verifyPackage(destination),/Unlisted|Unexpected|inventory/);
});

const python=process.env.FRONTIER_TEST_PYTHON??'python3';
function withoutBytecodeSettings(){const env={...process.env};delete env.PYTHONDONTWRITEBYTECODE;delete env.PYTHONPYCACHEPREFIX;return env;}
test('packaged Python entrypoints preserve the immutable inventory without caller bytecode settings',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-python-entry-'));t.after(()=>rm(root,{recursive:true,force:true}));const destination=path.join(root,'version');await packageHarness({sourceRoot,destination});
 const scripts=path.join(destination,'runtime/.agents/skills/deep-research/scripts'),env=withoutBytecodeSettings(),state=path.join(root,'research-state');
 const cli=await execute(python,[path.join(scripts,'research_cli.py'),'--data-dir',state,'status'],{cwd:root,env});assert.deepEqual(JSON.parse(cli.stdout),[]);
 const packet=await new Promise((resolve,reject)=>{const p=spawn(python,[path.join(scripts,'harness_rpc.py'),'--data-dir',state],{cwd:root,env,stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.once('error',reject);p.once('close',code=>code===0?resolve(JSON.parse(out)):reject(Error(err||out)));p.stdin.end(JSON.stringify({command:'status'}));});assert.deepEqual(packet,[]);
 assert.equal(await verifyPackage(destination),true);
});

test('standalone Python imports cannot fall back to the development checkout',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-python-entry-'));t.after(()=>rm(root,{recursive:true,force:true}));const destination=path.join(root,'version');await packageHarness({sourceRoot,destination});
 const scripts=path.join(destination,'runtime/.agents/skills/deep-research/scripts'),env=withoutBytecodeSettings(),state=path.join(root,'research-state');
 // Deny every Python source import from the development checkout. An installed
 // entrypoint that accidentally falls back to it must fail this actual process.
 const guard=path.join(root,'python-import-guard');await mkdir(guard);await writeFile(path.join(guard,'sitecustomize.py'),`import sys, importlib.abc, importlib.machinery
class Guard(importlib.abc.MetaPathFinder):
 def find_spec(self, fullname, path=None, target=None):
  spec=importlib.machinery.PathFinder.find_spec(fullname, path, target)
  if spec and spec.origin and spec.origin.startswith(${JSON.stringify(sourceRoot)}): raise ImportError('Development checkout import forbidden')
  return spec
sys.meta_path.insert(0, Guard())
`);env.PYTHONPATH=guard;

 const cli=await execute(python,['-B',path.join(scripts,'research_cli.py'),'--data-dir',state,'status'],{cwd:root,env});assert.deepEqual(JSON.parse(cli.stdout),[]);
 const packet=await new Promise((resolve,reject)=>{const p=spawn(python,['-B',path.join(scripts,'harness_rpc.py'),'--data-dir',state],{cwd:root,env,stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.once('error',reject);p.once('close',code=>code===0?resolve(JSON.parse(out)):reject(Error(err||out)));p.stdin.end(JSON.stringify({command:'status'}));});assert.deepEqual(packet,[]);
 assert.equal(await verifyPackage(destination),true);
});

test('installed research RPCs and MCP restart preserve the immutable package inventory',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-python-runtime-')),destination=path.join(root,'version'),state=path.join(root,'state'),config=path.join(root,'config.json'),env=withoutBytecodeSettings();let child,client;
 const stop=async()=>{await client?.close();client=null;if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited;}child=null;};t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
 await packageHarness({sourceRoot,destination,dependencies:true,offline:true});assert.equal(await verifyPackage(destination),true);
 const fixture=path.join(root,'fixture.json'),providerConfig=path.join(root,'research-provider.json'),url='https://www.sqlite.org/wal.html',text='All processes must be on the same host computer.';await writeFile(fixture,JSON.stringify({source_url:url,text}));await writeFile(providerConfig,JSON.stringify({mode:'fixture',fixture_file:fixture}));await writeFile(config,JSON.stringify({environment:'fixture',research:{python,dataDir:path.join(root,'research-state'),providerConfig}}));
 const launcher=path.join(destination,'scripts/harness.mjs');
 const start=async()=>{child=spawn(process.execPath,[launcher,'serve','--root',state,'--config',config,'--port','0'],{cwd:root,env,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let output='',err='';child.stdout.on('data',b=>{output+=b;if(output.includes('\n'))resolve();});child.stderr.on('data',b=>err+=b);child.once('exit',code=>reject(Error(`Installed research service exited ${code}: ${err}`)));});client=new Client({name:'installed-research-cache',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[launcher,'mcp','--root',state],env,cwd:root,stderr:'pipe'}));};
 const call=async(name,input)=>{const response=await client.callTool({name,arguments:input});assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);};
 const operation=async(name,input)=>{let value=await call(name,input);for(let i=0;i<250&&value.status==='pending';i++){await new Promise(r=>setTimeout(r,20));value=await call('operation_get',{operationId:value.id});}assert.equal(value.status,'completed',JSON.stringify(value));return value.result;};
 await start();const goal=await call('legacy_goal_prepare',{idempotencyKey:'p',manifest:{submissionId:'research-cache',mode:'codex_only',environment:'fixture',objective:'Inspect installed public-source evidence',acceptance:['Saved cited report'],scope:{seedUrls:[url]}}});await call('goal_activate',{idempotencyKey:'a',goalId:goal.id,hash:goal.hash});const task=await call('task_submit',{idempotencyKey:'t',goalId:goal.id,task:{submissionId:'research',kind:'research',objective:'Read SQLite primary evidence',acceptance:['Saved cited claim']}});
 const started=await operation('research_start',{idempotencyKey:'start',taskId:task.id});assert.ok(started.checkpoint.remoteJobId);assert.equal(await verifyPackage(destination),true);
 const source=await operation('research_action',{idempotencyKey:'read',taskId:task.id,action:{action:'read',url}});assert.equal(source.source_id,'S001');assert.equal(source.text,text);assert.equal(await verifyPackage(destination),true);
 await stop();assert.equal(await verifyPackage(destination),true);await start();
 const report={title:'Installed SQLite evidence',complete:true,claims:[{id:'C1',kind:'fact',text:'WAL processes share one host.',evidence:[{source_id:'S001',quote:text}]}],summary:['C1'],comparisons:[],recommendations:[],contradictions:[],unanswered:[]};const done=await operation('research_action',{idempotencyKey:'finish',taskId:task.id,action:{action:'finish',report}});assert.equal(done.status,'accepted');assert.equal(done.spent.model,0);assert.equal(done.spent.download,1);assert.equal(done.deadline,started.deadline);assert.equal(done.result.checksumsVerified,true);assert.match(await readFile(path.join(done.result.directory,'report.md'),'utf8'),/FIXTURE/);assert.equal(await verifyPackage(destination),true);
 await stop();const help=await execute(process.execPath,[launcher,'--help'],{cwd:root,env});assert.match(help.stdout,/Mosaic/);assert.equal(await verifyPackage(destination),true);
 const cache=path.join(destination,'runtime/.agents/skills/deep-research/scripts/__pycache__');await mkdir(cache);await writeFile(path.join(cache,'unlisted.pyc'),'untrusted bytecode');await assert.rejects(verifyPackage(destination),/Unlisted/);
});

test('reviewed onboarding references and Spark unit are inventoried in the standalone layout',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-onboarding-package-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=await portableSource(root),skill=path.join(source,'.agents/skills/frontier-harness');
 for(const name of ['onboarding.md','personal-instructions-template.md'])await writeFile(path.join(skill,'references',name),'REVIEWED_'+name);
 const destination=path.join(root,'version'),manifest=await packageHarness({sourceRoot:source,destination});
 for(const name of ['onboarding.md','personal-instructions-template.md'])for(const prefix of ['references/','skills/frontier-harness/references/']){const relative=prefix+name;assert.ok(manifest.files.some(f=>f.path===relative));assert.equal(await readFile(path.join(destination,relative),'utf8'),'REVIEWED_'+name);}
 const unit='runtime/.agents/skills/deep-research/deploy/deep-research.service.template';assert.ok(manifest.files.some(f=>f.path===unit));assert.equal(await readFile(path.join(destination,unit),'utf8'),await readFile(path.join(source,'.agents/skills/deep-research/deploy/deep-research.service.template'),'utf8'));assert.equal(await verifyPackage(destination),true);
});

test('Overnight v2 bundle includes dedicated routing and makes observer timeout independent of supervision',async t=>{const root=await mkdtemp(path.join(os.tmpdir(),'harness-overnight-package-'));t.after(()=>rm(root,{recursive:true,force:true}));const destination=path.join(root,'bundle');await packageHarness({sourceRoot,destination});const primary=await readFile(path.join(destination,'skills/frontier-harness/SKILL.md'),'utf8');assert.match(primary,/references\/overnight\.md/);assert.doesNotMatch(primary,/After a launch, use one deterministic/);const guide=await readFile(path.join(destination,'skills/frontier-harness/references/overnight.md'),'utf8');assert.match(guide,/overnight_preflight/);assert.match(guide,/independent/i);assert.match(guide,/maxExchanges|forty|40/);assert.match(guide,/not.*supervis|observation only/i);for(const name of ['frontier-collaborate','frontier-deepseek-only','frontier-codex-only'])assert.equal(await readFile(path.join(destination,'skills',name,'SKILL.md'),'utf8'),await readFile(path.join(sourceRoot,'.agents/skills',name,'SKILL.md'),'utf8'));assert.equal(await verifyPackage(destination),true);});
