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
