import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getHost,hostRegistry,normalizeHostSettings} from '../src/beta/hosts/index.mjs';
import {normalizeAgentRegistration} from '../src/harness/collaboration-contracts.mjs';
import {Agents} from '../src/harness/agents.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {locations,privateDirectories,saveJson} from '../src/beta/files.mjs';
import {readSettings} from '../src/beta/setup.mjs';
import {digest} from '../src/harness/contracts.mjs';

const ids=['codex','claude-code','cursor','antigravity'];
const paths={home:'/fixture home',configDir:'/fixture home/Library/Application Support/Mosaic Beta/config'};
const launcher="/fixture home/.local/bin/Mosaic's launcher";
const mixed={theme:'dark',mcpServers:{database:{command:'node',args:['/tools/db server.mjs'],env:{MODE:'readonly'}},remote:{url:'https://example.invalid/mcp',headers:{'X-Workspace':'test'}}},projects:{'/work/project':{trusted:true}}};
function ioFixture(value){
 let config=structuredClone(value),receipt=null;
 const calls=[];
 return {calls,get config(){return structuredClone(config);},set config(v){config=structuredClone(v);},get receipt(){return structuredClone(receipt);},
  async read(){return structuredClone(config);},async write(v){calls.push('write');config=structuredClone(v);},
  async compareAndSwap(v,target,{expectedHash}){if(digest(config)!==expectedHash)return false;calls.push('write');config=structuredClone(v);return true;},
  async readReceipt(){return structuredClone(receipt);},async writeReceipt(v){calls.push(v.state);receipt=structuredClone(v);},async removeReceipt(){calls.push('remove-receipt');receipt=null;}};
}
for(const id of ids){
 test(`${id} adapter previews exact argv/config without touching unrelated config`,async()=>{
  const adapter=getHost(id),existing=id==='codex'?{registration:null,unrelated:{...mixed,rawToml:'# comments and user config preserved by CLI'}}:mixed;
  const preview=adapter.previewRegistration({paths,launcher,existing});
  assert.equal(preview.hostId,id);assert.equal(preview.transport,'stdio');assert.equal(preview.reviewDelivery,'pull');
  assert.equal(preview.entry.command,launcher);assert.deepEqual(preview.entry.args,['mcp']);
  assert.match(preview.instructions,/review_inbox/);assert.match(preview.instructions,/closed|inactive|disconnected/);
  assert.equal(preview.evidenceLevel,'fixture-tested');
  const io=ioFixture(existing),receipt=await adapter.applyRegistration(preview,{io});
  assert.equal(receipt.state,'complete');assert.deepEqual(io.calls,['pending','write','complete']);
  if(id==='codex')assert.deepEqual(io.config.unrelated,existing.unrelated);
  else {assert.deepEqual(io.config.mcpServers.database,mixed.mcpServers.database);assert.deepEqual(io.config.projects,mixed.projects);}
  assert.deepEqual(await adapter.applyRegistration(preview,{io}),receipt);
  assert.equal(io.calls.filter(v=>v==='write').length,1);
  const removed=await adapter.removeRegistration({io});assert.equal(removed.removed,true);assert.deepEqual(io.config,existing);
 });
 test(`${id} adapter rejects stale/tampered/foreign previews and preserves changed ownership`,async()=>{
  const adapter=getHost(id),existing=id==='codex'?{registration:null,unrelated:{theme:'dark'}}:mixed;
  const preview=adapter.previewRegistration({paths,launcher,existing}),io=ioFixture(existing);
  await assert.rejects(adapter.applyRegistration({...preview,entry:{command:'/unexpected',args:['mcp']}},{io}),/preview|identity/i);
  const stale=structuredClone(existing);stale.additional='new';io.config=stale;
  await assert.rejects(adapter.applyRegistration(preview,{io}),/changed|stale/i);
  assert.equal(io.calls.length,0);io.config=existing;await adapter.applyRegistration(preview,{io});
  const changed=io.config;if(id==='codex')changed.registration.command='/owner/replacement';else changed.mcpServers['mosaic-beta'].command='/owner/replacement';io.config=changed;
  assert.deepEqual(await adapter.removeRegistration({io}),{removed:false,reason:'modified-owned-entry'});assert.deepEqual(io.config,changed);
  await assert.rejects(adapter.applyRegistration(preview),/manual|injected/i);
 });
 test(`${id} interrupted apply resumes only the exact owned entry and preview`,async()=>{
  const adapter=getHost(id),existing=id==='codex'?{registration:null,unrelated:{}}:mixed;
  const preview=adapter.previewRegistration({paths,launcher,existing}),io=ioFixture(existing),writeReceipt=io.writeReceipt;
  io.writeReceipt=async v=>{if(v.state==='complete')throw Error('owned fixture interruption');return writeReceipt(v);};
  await assert.rejects(adapter.applyRegistration(preview,{io}),/interruption/);assert.equal(io.receipt.state,'pending');
  io.writeReceipt=writeReceipt;
  const resumed=await adapter.applyRegistration(preview,{io});assert.equal(resumed.state,'complete');assert.equal(io.calls.filter(v=>v==='write').length,1);
  assert.equal((await adapter.removeRegistration({io})).removed,true);
 });
}
test('host schema is enumerated, credential free and descriptor copies cannot mutate registry',()=>{
 assert.deepEqual(hostRegistry.list().map(x=>x.id),ids);
 for(const id of ids){const x=hostRegistry.get(id);assert.equal(x.schema,1);assert.equal(x.reviewDelivery,'pull');assert.equal(x.capabilities.evidenceLevel,'fixture-tested');x.id='poison';assert.equal(hostRegistry.get(id).id,id);}
 for(const value of [{id:'unknown'},{id:'cursor',options:{command:'sh'}},{id:'cursor',token:'secret'}])assert.throws(()=>normalizeHostSettings(value));
 assert.deepEqual(normalizeHostSettings({id:'cursor'}),{id:'cursor',options:{}});
 for(const id of ['claude-code','cursor','antigravity'])assert.throws(()=>getHost(id).previewRegistration({paths,launcher,existing:'{malformed'}),/config|JSON/i);
 assert.throws(()=>getHost('cursor').previewRegistration({paths,launcher,existing:{mcpServers:{'mosaic-beta':{command:'foreign'}}}}),/foreign|owned/i);
});
test('new registration distinguishes host-reported model identity while historical normalization is unchanged',()=>{
 const legacy={version:1,taskId:'task-1',hostAgentId:null,actor:'codex',role:'reviewer',model:{requested:null,resolved:null}};
 assert.deepEqual(normalizeAgentRegistration(legacy),legacy);
 const host=normalizeAgentRegistration({...legacy,hostId:'claude-code',model:{resolved:'reported-alias'}});
 assert.equal(host.actor,'codex');assert.equal(host.hostId,'claude-code');assert.equal(host.model.resolved,'reported-alias');
 assert.throws(()=>normalizeAgentRegistration({...legacy,hostId:'imaginary'}),/host/i);
});
test('host-aware settings load without pretending Codex host authentication and reject arbitrary registration options',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'mosaic-host-settings-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const p=locations(home,true);await privateDirectories(p);
 await saveJson(p.config,{schema:1,host:{id:'cursor'},worker:null});
 assert.deepEqual((await readSettings(p)).host,{id:'cursor',options:{}});
 await saveJson(p.config,{schema:1,host:{id:'cursor',options:{command:'sh'}},worker:null});await assert.rejects(readSettings(p),/host|option/i);
});
test('host preview CLI emits bounded JSON and invokes no host executable or settings changes',()=>{
 const cli=fileURLToPath(new URL('../src/beta/cli.mjs',import.meta.url));
 const run=spawnSync(process.execPath,[cli,'--home','/never-created mosaic fixture','host-preview','--host','cursor'],{encoding:'utf8',timeout:10000});
 assert.equal(run.status,0,run.stderr);const preview=JSON.parse(run.stdout);assert.equal(preview.hostId,'cursor');assert.equal(preview.entry.command,'/never-created mosaic fixture/.local/bin/mosaic');assert.match(preview.instructions,/manual/i);
});
test('other hosts report aliases without inheriting or claiming verified Codex model usage',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-host-identity-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const c=new Coordinator({root});t.after(()=>c.close());
 const g=c.prepareGoal({submissionId:'host-identity',objective:'Keep identity honest',acceptance:['unknown means unknown'],environment:'fixture',mode:'codex_only'},'identity-prepare');
 c.activateGoal({goalId:g.id,hash:g.hash},'identity-activate');
 const task=c.submitTask({goalId:g.id,submissionId:'host-identity-task',kind:'consult',actor:'codex',objective:'Inspect fixture',acceptance:['identity only']},'identity-task');
 const agents=new Agents({c,config:{nativeModels:['codex-model'],nativeRoleModels:{reviewer:'codex-model'}}});
 const reported=agents.register({version:1,taskId:task.id,hostId:'claude-code',actor:'codex',role:'reviewer',model:{requested:'family',resolved:'provider-alias'}},'report-alias');
 assert.equal(reported.actor,'codex');assert.equal(reported.hostId,'claude-code');assert.equal(reported.model.resolved,'provider-alias');assert.equal(reported.modelProvenance,'reported');assert.equal(reported.accounting.tokens,null);assert.equal(reported.accounting.source,'unavailable');
 const unknown=agents.register({version:1,taskId:task.id,hostId:'antigravity',actor:'codex',role:'reviewer'},'report-unknown');
 assert.deepEqual(unknown.model,{requested:null,resolved:null});assert.equal(unknown.modelProvenance,'unknown');assert.equal(unknown.modelSource,'unknown');
});
for(const id of ['claude-code','cursor','antigravity'])test(`${id} injected file adapter preserves mixed configuration and unrelated later edits on selective uninstall`,async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),`mosaic-${id}-file-`));t.after(()=>rm(home,{recursive:true,force:true}));
 const p=locations(home,true),adapter=getHost(id),preview=adapter.previewRegistration({paths:p,launcher:p.launcher,existing:mixed});
 await mkdir(path.dirname(preview.target),{recursive:true});await mkdir(path.dirname(preview.receiptFile),{recursive:true});
 await writeFile(preview.target,JSON.stringify(mixed));
 // Owned single-process fixture: synchronous CAS provides its atomic mutation
 // point. This is not a writer for files concurrently owned by an actual app.
 const io={async read(target){return JSON.parse(await readFile(target,'utf8'));},async write(value,target){await saveJson(target,value);},
  compareAndSwap(value,target,{expectedHash}){if(digest(JSON.parse(readFileSync(target,'utf8')))!==expectedHash)return false;const temporary=target+'.fixture-cas';writeFileSync(temporary,JSON.stringify(value)+'\n',{mode:0o600});renameSync(temporary,target);return true;},async readReceipt(target){try{return JSON.parse(await readFile(target,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},async writeReceipt(value,target){await saveJson(target,value);},async removeReceipt(target){await rm(target);}};
 await adapter.applyRegistration(preview,{io});
 const changed=await io.read(preview.target);changed.editor={fontSize:16};changed.mcpServers['another-local']={command:'node',args:['new.mjs']};await io.write(changed,preview.target);
 assert.equal((await adapter.removeRegistration({io,receiptFile:preview.receiptFile})).removed,true);
 const removed=await io.read(preview.target);assert.equal(removed.mcpServers['mosaic-beta'],undefined);assert.deepEqual(removed.editor,{fontSize:16});assert.deepEqual(removed.mcpServers.database,mixed.mcpServers.database);assert.deepEqual(removed.mcpServers['another-local'],{command:'node',args:['new.mjs']});
});
for(const id of ids)test(`${id} SDK stdio fixture discovers, reviews and reconnects to durable state (not installed-host certification)`,async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const root=await mkdtemp(path.join(os.tmpdir(),`mosaic-${id}-protocol-`));t.after(()=>rm(root,{recursive:true,force:true}));
 const script=fileURLToPath(new URL('./fixtures/mosaic-pb12/host-protocol-server.mjs',import.meta.url));
 const protocolErrors=[];
 async function connect(){
  const errors=protocolErrors,client=new Client({name:`${id}-simulated-client`,version:'fixture-1'}),transport=new StdioClientTransport({command:process.execPath,args:[script,root,id],stderr:'pipe'});
  client.onerror=error=>errors.push(error.message);await client.connect(transport);
  return {client,errors,async call(name,args={}){const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,result.content[0]?.text);return JSON.parse(result.content[0].text);}};
 }
 let connection=await connect();t.after(()=>connection.client.close());
 const listed=await connection.client.listTools();for(const name of ['goal_prepare','review_inbox','review_reserve','review_submit'])assert.ok(listed.tools.some(tool=>tool.name===name),name);
 const goal=await connection.call('goal_prepare',{idempotencyKey:'host-preparation',manifest:{submissionId:'host-protocol-goal',objective:'Review a saved fixture consultation',acceptance:['Candidate-bound host verdict saved once'],environment:'fixture',mode:'collaborative',reviewPolicy:{version:1,source:'host',hostId:id,fallback:'wait'}}});
 assert.equal(goal.manifest.reviewPolicy.hostId,id);
 await connection.call('goal_activate',{idempotencyKey:'host-activation',goalId:goal.id,hash:goal.hash});
 const task=await connection.call('task_submit',{idempotencyKey:'host-submission',goalId:goal.id,task:{submissionId:'host-protocol-task',kind:'consult',objective:'Produce consultation fixture',acceptance:['Saved result ready']}});
 assert.equal(task.status,'awaiting_review');
 const inbox=await connection.call('review_inbox',{goalId:goal.id,limit:1});assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].taskId,task.id);assert.equal(inbox.items[0].reviewer.hostId,id);assert.equal(inbox.items[0].reviewer.model,null);
 const binding=inbox.items[0].binding;
 const expected=Object.fromEntries(['goalId','goalVersion','goalHash','taskId','candidateHash','checksHash','rubricHash','reviewPolicyHash','generation','expiresAt'].map(key=>[key,binding[key]]));
 const reserved=await connection.call('review_reserve',{idempotencyKey:'host-reservation',taskId:task.id,...expected});
 assert.ok(Buffer.byteLength(JSON.stringify(reserved.evidence))<=32768,'bounded first evidence page');
 await connection.client.close();
 connection=await connect();
 const before=await connection.call('task_get',{taskId:task.id});assert.equal(before.status,'awaiting_review');
 const decision=await connection.call('review_submit',{idempotencyKey:'host-verdict',ticketId:reserved.ticketId,...expected,verdict:{decision:'accept',feedback:'Independent scripted host protocol verdict.',findings:[]}});
 assert.equal(decision.status,'accepted');
 const replay=await connection.call('review_submit',{idempotencyKey:'host-verdict',ticketId:reserved.ticketId,...expected,verdict:{decision:'accept',feedback:'Independent scripted host protocol verdict.',findings:[]}});assert.deepEqual(replay,decision);
 await connection.client.close();connection=await connect();
 const saved=await connection.call('task_get',{taskId:task.id});assert.equal(saved.status,'accepted');assert.equal(saved.reviews,1);assert.deepEqual(connection.errors,[]);
 const empty=await connection.call('review_inbox',{goalId:goal.id,limit:1});assert.equal(empty.items.length,0);
});
test('legacy Codex beta settings supply trusted Codex review default to fresh service preparation',async t=>{
 const {spawn}=await import('node:child_process');const {once}=await import('node:events');const {client}=await import('../src/beta/client.mjs');
 const home=await mkdtemp(path.join(os.tmpdir(),'mosaic-beta-host-default-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const p=locations(home,true);await privateDirectories(p);await saveJson(p.config,{schema:1,codexPath:'/fixture-only/no-executable-codex',worker:null});
 const child=spawn(process.execPath,[fileURLToPath(new URL('../src/beta/cli.mjs',import.meta.url)),'--home',home,'serve'],{stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const ended=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await ended;});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture coordinator startup timeout: '+stderr)),10000);const poll=()=>{if(stdout.includes('"status":"ready"')){clearTimeout(timer);child.stdout.removeListener('data',poll);resolve();}};child.stdout.on('data',poll);poll();child.once('exit',()=>{clearTimeout(timer);reject(Error('Fixture coordinator exited: '+stderr));});});
 const invoke=client(p);const goal=await invoke('goal_prepare',{idempotencyKey:'trusted-legacy-host-default',manifest:{submissionId:'trusted-legacy-host-default',objective:'Prepare with trusted selected app',acceptance:['Host review defaults'],environment:'fixture',mode:'codex_only'}});
 assert.deepEqual(goal.manifest.reviewPolicy,{version:1,source:'host',hostId:'codex',fallback:'wait'});
});
for(const id of ids)test(`${id} uninstall clears an unapplied pending receipt without touching host configuration`,async()=>{
 const adapter=getHost(id),existing=id==='codex'?{registration:null,unrelated:{mode:'strict'}}:mixed;
 const preview=adapter.previewRegistration({paths,launcher,existing}),io=ioFixture(existing);
 io.compareAndSwap=async()=>{throw Error('owned fixture interrupted before write');};
 await assert.rejects(adapter.applyRegistration(preview,{io}),/interrupted before write/);assert.equal(io.receipt.state,'pending');
 const result=await adapter.removeRegistration({io});assert.equal(result.removed,true);assert.equal(io.receipt,null);assert.deepEqual(io.config,existing);
});

for(const id of ids)test(`${id} apply rejects a concurrent unrelated config update at pending receipt await without losing it`,async()=>{
 const adapter=getHost(id),existing=id==='codex'?{registration:null,unrelated:{theme:'dark'}}:mixed;
 const preview=adapter.previewRegistration({paths,launcher,existing}),io=ioFixture(existing),save=io.writeReceipt;
 io.writeReceipt=async receipt=>{await save(receipt);if(receipt.state==='pending'){const current=io.config;current.editor={fontSize:17};io.config=current;}};
 await assert.rejects(adapter.applyRegistration(preview,{io}),/changed|conflict|conditional/i);
 assert.deepEqual(io.config.editor,{fontSize:17});assert.equal(io.receipt.state,'pending');assert.equal(io.calls.filter(v=>v==='write').length,0);
 assert.equal((await adapter.removeRegistration({io})).removed,true);assert.deepEqual(io.config.editor,{fontSize:17});
});
for(const id of ids)test(`${id} uninstall uses atomic conditional IO and preserves a concurrent unrelated update`,async()=>{
 const adapter=getHost(id),existing=id==='codex'?{registration:null,unrelated:{theme:'dark'}}:mixed;
 const preview=adapter.previewRegistration({paths,launcher,existing}),io=ioFixture(existing);await adapter.applyRegistration(preview,{io});
 const originalWrite=io.write,originalCas=io.compareAndSwap;
 const intervene=()=>{const current=io.config;current.editor={fontSize:19};io.config=current;};
 io.write=async(...args)=>{intervene();return originalWrite(...args);};
 io.compareAndSwap=async(...args)=>{intervene();return originalCas(...args);};
 await assert.rejects(adapter.removeRegistration({io}),/changed|conflict|conditional/i);
 assert.deepEqual(io.config.editor,{fontSize:19});assert.equal(io.receipt.state,'complete');
 assert.ok(id==='codex'?io.config.registration:io.config.mcpServers['mosaic-beta']);
 io.compareAndSwap=originalCas;assert.equal((await adapter.removeRegistration({io})).removed,true);assert.deepEqual(io.config.editor,{fontSize:19});
});
test('host apply refuses plain write IO because reread plus atomic replacement cannot prove CAS',async()=>{
 const adapter=getHost('cursor'),io=ioFixture(mixed),preview=adapter.previewRegistration({paths,launcher,existing:mixed});delete io.compareAndSwap;
 await assert.rejects(adapter.applyRegistration(preview,{io}),/conditional|compareAndSwap|atomic/i);assert.deepEqual(io.calls,[]);assert.deepEqual(io.config,mixed);
});
test('persisted legacy no-host correlation reconnect survives trusted host inference and rejects explicit changes',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-host-legacy-reconnect-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let c=new Coordinator({root});t.after(()=>c.close());
 const goal=c.prepareGoal({submissionId:'legacy-agent-goal',objective:'Preserve correlation',acceptance:['Saved identity unchanged'],environment:'fixture',mode:'codex_only'},'legacy-goal');
 c.activateGoal({goalId:goal.id,hash:goal.hash},'legacy-active');
 const task=c.submitTask({goalId:goal.id,submissionId:'legacy-agent-task',kind:'consult',actor:'codex',objective:'Saved legacy task',acceptance:['No new authority']},'legacy-task');
 const input={version:1,taskId:task.id,hostAgentId:'historical-host-correlation',actor:'codex',role:'reviewer',model:{requested:null,resolved:null}};
 const before=new Agents({c}).register(input,'legacy-registration'),savedHash=digest(c.store.get('agent',before.id));
 c.close();c=new Coordinator({root,selectedHost:'codex'});const agents=new Agents({c,config:{nativeModels:['different-model'],nativeRoleModels:{reviewer:'different-model'}}});
 const replay=agents.register(input,'new-key-after-host-upgrade');assert.deepEqual(replay,before);assert.equal(digest(c.store.get('agent',before.id)),savedHash);assert.equal(replay.hostId,undefined);assert.equal(c.store.all('agent').length,1);
 assert.throws(()=>agents.register({...input,hostId:'codex'},'explicit-new-host'),/correlation/);
 assert.throws(()=>agents.register({...input,model:{requested:'different-model',resolved:null}},'explicit-new-model'),/correlation/);
 assert.throws(()=>agents.register({...input,role:'implementer'},'explicit-new-role'),/correlation/);
 const fresh=agents.register({...input,hostAgentId:'fresh-host-correlation'},'fresh-host-inferred');assert.equal(fresh.hostId,'codex');
});

for(const hostId of ['cursor','codex'])test(`historical inherited model survives ${hostId} reconnect with changed defaults`,async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-host-inherited-reconnect-'));
 let c=new Coordinator({root});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const goal=c.prepareLegacyGoal({submissionId:'goal',objective:'Preserve correlation',acceptance:['Preserve original model'],mode:'codex_only',environment:'fixture'},'goal');
 c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
 const task=c.submitTask({goalId:goal.id,submissionId:'task',kind:'consult',actor:'codex',objective:'Historical task',acceptance:['Keep identity']},'task');
 const input={version:1,taskId:task.id,hostAgentId:'historical-default',actor:'codex',role:'reviewer'};
 const previous=new Agents({c,config:{nativeModels:['old-model'],nativeRoleModels:{reviewer:'old-model'}}}).register(input,'old-register');
 assert.equal(previous.modelSource,'role_default');assert.equal(previous.model.requested,'old-model');
 c.close();c=new Coordinator({root,selectedHost:hostId});
 const agents=new Agents({c,config:{nativeModels:['new-model'],nativeRoleModels:{reviewer:'new-model'}}});
 assert.deepEqual(agents.register(input,'reconnect'),previous);
 assert.deepEqual(c.store.get('agent',previous.id),previous);
 assert.throws(()=>agents.register({...input,role:'implementer'},'changed-role'),/correlation|unsupported/);
 assert.throws(()=>agents.register({...input,model:{requested:'new-model'}},'changed-model'),/correlation/);
 assert.throws(()=>agents.register({...input,hostId},'changed-host'),/correlation/);
});
