import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {ResearchAdapter,ResearchClient} from '../src/harness/research.mjs';
import {command} from '../src/project/process.mjs';
import {fileURLToPath} from 'node:url';
import {NativeResearch} from '../src/harness/native-research.mjs';

test('research adapter submits exact manifest and collects real fixture artifacts',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-research-'));const c=new Coordinator({root:path.join(root,'parent')});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const fixture=path.join(root,'fixture.json'),configFile=path.join(root,'config.json');
 await writeFile(fixture,JSON.stringify({source_url:'https://www.sqlite.org/wal.html',text:'All processes must be on the same host computer.'}));
 await writeFile(configFile,JSON.stringify({mode:'fixture',fixture_file:fixture}));
 const config={environment:'fixture',research:{python:process.env.FRONTIER_TEST_PYTHON??'python3',dataDir:path.join(root,'research'),mode:'fixture',pollMs:0}};
 const g=c.prepareGoal({submissionId:'research',environment:'fixture',objective:'Compare durable queues',acceptance:['Cited report'],project:null},'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const task=c.submitTask({goalId:g.id,submissionId:'r',kind:'research',objective:'Compare SQLite WAL queues',acceptance:['Saved cited report']},'submit');
 const worker=new Worker({c,config});await worker.tick();await worker.tick();
 const linked=c.getTask(task.id);assert.ok(linked.checkpoint.remoteJobId);
 const result=await command([config.research.python,fileURLToPath(new URL('../.agents/skills/deep-research/scripts/research_cli.py',import.meta.url)),'--data-dir',config.research.dataDir,'worker','--config',configFile]);assert.equal(result.code,0,result.stderr);
 await worker.drain();const done=c.getTask(task.id);assert.equal(done.status,'accepted');assert.ok(done.spent.model>=3);assert.equal(done.result.checksumsVerified,true);
 assert.match(await readFile(path.join(done.result.directory,'report.md'),'utf8'),/FIXTURE/);
 assert.ok(done.deadline<=c.getGoal(g.id).deadline);
});
test('research uncertainty keeps global slot instead of dispatching another task',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-rpc-'));const c=new Coordinator({root});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const g=c.prepareGoal({submissionId:'g',objective:'Research',acceptance:['Report'],project:null},'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');
 const task=c.submitTask({goalId:g.id,submissionId:'r',kind:'research',objective:'Research queue',acceptance:['Report']},'r');
 const worker=new Worker({c,provider:{},config:{research:{}},adapters:{}});
 worker.adapters.research=new ResearchAdapter(worker,{rpc:async req=>{if(req.command==='prepare_manifest')return {manifest:req.manifest,hash:'a'.repeat(64)};throw Error('SSH transport disconnected after send');}});
 await worker.drain();assert.equal(c.getTask(task.id).status,'uncertain');assert.equal(c.claimNext('other'),null);
});
test('Codex-only uses actual deterministic research tools and collects a report with zero DeepSeek calls',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-native-research-')),c=new Coordinator({root:path.join(root,'parent')});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const fixture=path.join(root,'fixture.json'),providerConfig=path.join(root,'providers.json'),url='https://www.sqlite.org/wal.html',text='All processes must be on the same host computer.';
 await writeFile(fixture,JSON.stringify({source_url:url,text}));await writeFile(providerConfig,JSON.stringify({mode:'fixture',fixture_file:fixture}));
 const config={environment:'fixture',research:{python:process.env.FRONTIER_TEST_PYTHON??'python3',dataDir:path.join(root,'research'),providerConfig}};
 const g=c.prepareGoal({submissionId:'native',mode:'codex_only',environment:'fixture',objective:'Read SQLite primary evidence',acceptance:['Saved cited report'],scope:{seedUrls:[url]}},'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');
 const task=c.submitTask({goalId:g.id,submissionId:'r',kind:'research',objective:'Read SQLite WAL constraints',acceptance:['Cited claim']},'r'),native=new NativeResearch({c,config});
 await native.start({taskId:task.id},'start');const source=await native.action({taskId:task.id,action:{action:'read',url}},'read');assert.equal(source.source_id,'S001');
 const report={title:'WAL constraints',complete:true,claims:[{id:'C1',kind:'fact',text:'Processes use the same host.',evidence:[{source_id:'S001',quote:text}]}],summary:['C1'],comparisons:[],recommendations:[],contradictions:[],unanswered:[]};
 const done=await native.action({taskId:task.id,action:{action:'finish',report}},'finish');assert.equal(done.status,'accepted');assert.equal(done.spent.model,0);assert.equal(done.spent.download,1);assert.ok(done.result.checksumsVerified);
 assert.deepEqual(await native.action({taskId:task.id,action:{action:'finish',report}},'finish'),done);
 const receipt=JSON.parse(await readFile(path.join(done.result.directory,'receipt.json'),'utf8'));assert.equal(receipt.model_self_check,'not_run_operator_mode');
});
test('research stop retains global ownership until the backend confirms quiescence',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-research-stop-')),c=new Coordinator({root});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const g=c.prepareGoal({submissionId:'g',objective:'Research',acceptance:['Report']},'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');
 const task=c.submitTask({goalId:g.id,submissionId:'r',kind:'research',objective:'Research queue',acceptance:['Report']},'r');c.claimNext('owner');
 c.boundary(task.id,{phase:'poll',remoteJobId:'remote',remoteHash:'hash'},'owner');c.control({taskId:task.id,action:'stop'},'stop');
 const worker=new Worker({c,owner:'owner',config:{research:{pollMs:0}}});let quiescent=false;
 worker.adapters.research=new ResearchAdapter(worker,{rpc:async request=>request.command==='status'?{status:'stopped',quiescent,manifest_hash:'hash',counters:{model:1,search:0,download:0}}:{status:'stopped'}});
 await worker.adapters.research.step(c.getTask(task.id),'owner');assert.equal(c.getTask(task.id).status,'running');assert.equal(c.getTask(task.id).owner,'owner');
 c.submitTask({goalId:g.id,submissionId:'later',kind:'consult',objective:'Later work',acceptance:['Answer']},'later');assert.equal(c.claimNext('other'),null);
 quiescent=true;await worker.adapters.research.step(c.getTask(task.id),'owner');assert.equal(c.getTask(task.id).status,'stopped');assert.equal(c.getTask(task.id).owner,null);
});

test('research submission retains the slot when urgent work arrives before remote quiescence',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-submit-yield-')),c=new Coordinator({root});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const g=c.prepareGoal({submissionId:'g',objective:'Research',acceptance:['Report'],environment:'fixture'},'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');
 const task=c.submitTask({goalId:g.id,submissionId:'r',kind:'research',objective:'Research queue',acceptance:['Report']},'r'),worker=new Worker({c,owner:'owner',config:{environment:'fixture',research:{pollMs:0}}});let quiescent=false;
 worker.adapters.research=new ResearchAdapter(worker,{rpc:async request=>{
  if(request.command==='prepare_manifest')return {manifest:request.manifest,hash:'hash'};
  if(request.command==='submit'){c.submitTask({goalId:g.id,submissionId:'urgent',kind:'consult',priority:'blocking',objective:'Urgent repair',acceptance:['Pass']},'urgent');return {id:'remote'};}
  if(request.command==='status')return {manifest_hash:'hash',status:'suspended',quiescent,counters:{model:1}};
  return {};
 }});
 await worker.tick();await worker.tick();assert.equal(c.getTask(task.id).status,'running');assert.equal(c.getTask(task.id).checkpoint.remoteJobId,'remote');assert.equal(c.claimNext('other'),null);
 await worker.tick();assert.equal(c.getTask(task.id).status,'running');quiescent=true;await worker.tick();assert.equal(c.getTask(task.id).status,'suspended');assert.equal(c.claimNext('other').spec.submissionId,'urgent');
});

test('native research collection failure can retry the same public operation without repeating an action',async t=>{
 const {Dispatcher}=await import('../src/harness/tools.mjs');
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-research-collect-')),c=new Coordinator({root});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const g=c.prepareGoal({submissionId:'g',objective:'Research',acceptance:['Report'],mode:'codex_only',environment:'fixture'},'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');
 const task=c.submitTask({goalId:g.id,submissionId:'r',kind:'research',objective:'Read sources',acceptance:['Report']},'r'),dispatcher=new Dispatcher({c,config:{environment:'fixture'}});let collection=0,actions=0;const saved=new Map();
 dispatcher.nativeResearch=new NativeResearch({c,config:{environment:'fixture'},rpc:async r=>{
  if(r.command==='prepare_manifest')return {manifest:r.manifest,hash:'hash'};if(r.command==='submit')return {id:'remote'};
  if(r.command==='operator_action'){if(saved.has(r.idempotency_key))return saved.get(r.idempotency_key);actions++;const result={status:'completed'};saved.set(r.idempotency_key,result);return result;}
  if(r.command==='status')return {id:'remote',status:'completed',manifest_hash:'hash',counters:{model:0,download:1,search:0}};if(r.command==='export')return {};
 },collect:async()=>{if(++collection===1)throw Error('Temporary collection failure');return {directory:path.join(root,'result'),checksums_verified:true};}});
 await dispatcher.nativeResearch.start({taskId:task.id},'start');const input={taskId:task.id,action:{action:'finish',report:{}},idempotencyKey:'finish'},operation=await dispatcher.invoke('research_action',input);await dispatcher.whenIdle();assert.equal(c.getTask(task.id).status,'codex_active');
 const retry=await dispatcher.invoke('research_action',input);assert.equal(retry.id,operation.id);await dispatcher.whenIdle();assert.equal(c.store.get('operation',operation.id).status,'completed');assert.equal(c.getTask(task.id).status,'accepted');assert.equal(actions,1);assert.equal(collection,2);assert.equal(c.getTask(task.id).spent.download,1);assert.equal(c.getTask(task.id).spent.model,0);
});

test('uncertain research reconciles only exact remote identity and verified quiescence without refreshing spending',async t=>{
 const {Dispatcher}=await import('../src/harness/tools.mjs'),root=await mkdtemp(path.join(os.tmpdir(),'harness-reconcile-')),c=new Coordinator({root});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const g=c.prepareGoal({submissionId:'g',objective:'Research',acceptance:['Report'],environment:'fixture'},'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');const task=c.submitTask({goalId:g.id,submissionId:'r',kind:'research',objective:'Read sources',acceptance:['Report']},'r');c.claimNext('old');c.boundary(task.id,{phase:'poll',remoteJobId:'remote',remoteHash:'hash'},'old');c.markUncertain(task.id,'Lost contact','old');const before=c.getTask(task.id);c.acquireWorker('current');
 const worker=new Worker({c,owner:'current',config:{environment:'fixture',research:{pollMs:0}}}),dispatcher=new Dispatcher({c,worker});let hash='wrong',quiescent=false;
 worker.adapters.research=new ResearchAdapter(worker,{rpc:async r=>r.command==='status'?{id:'remote',manifest_hash:hash,status:'suspended',quiescent,counters:{model:2}}:{}});
 const reconcile=async key=>{const op=await dispatcher.invoke('research_reconcile',{taskId:task.id,idempotencyKey:key});await dispatcher.whenIdle();return c.store.get('operation',op.id);};
 assert.equal((await reconcile('wrong')).status,'failed');assert.equal(c.getTask(task.id).status,'uncertain');hash='hash';await reconcile('active');assert.equal(c.getTask(task.id).status,'uncertain');assert.equal(c.claimNext('other'),null);quiescent=true;assert.equal((await reconcile('quiet')).status,'completed');const recovered=c.getTask(task.id);assert.notEqual(recovered.status,'uncertain');assert.equal(recovered.spent.model,2);assert.equal(recovered.deadline,before.deadline);assert.equal(recovered.id,before.id);
});

test('late native research collection preserves a stop instead of accepting stopped work',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-research-late-')),c=new Coordinator({root});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const g=c.prepareGoal({submissionId:'g',objective:'Research',acceptance:['Report'],mode:'codex_only',environment:'fixture'},'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');const task=c.submitTask({goalId:g.id,submissionId:'r',kind:'research',objective:'Read sources',acceptance:['Report']},'r');
 const native=new NativeResearch({c,config:{environment:'fixture'},rpc:async r=>{if(r.command==='prepare_manifest')return {manifest:r.manifest,hash:'hash'};if(r.command==='submit')return {id:'remote'};if(r.command==='status')return {id:'remote',manifest_hash:'hash',status:'completed',counters:{model:0}};return {};},collect:async()=>{c.control({taskId:task.id,action:'stop'},'stop-collection');return {directory:path.join(root,'result'),checksums_verified:true};}});
 await native.start({taskId:task.id},'start');const result=await native.action({taskId:task.id,action:{action:'finish',report:{}}},'finish');assert.equal(result.status,'stopped');assert.equal(result.stopRequested,true);assert.equal(result.result.checksumsVerified,true);
});
