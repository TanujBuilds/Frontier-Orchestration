import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Integration} from '../src/harness/integration.mjs';
import {git} from '../src/project/process.mjs';

async function fixture(t,{legacy=false}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'pb15-native-runtime-race-')),repo=path.join(root,'repo'),executable=path.join(root,'codex');
 await mkdir(path.join(repo,'src'),{recursive:true});await writeFile(path.join(repo,'src/value.mjs'),'export const value=0;\n');await writeFile(executable,'unused fixture executable A',{mode:0o700});
 for(const args of [['init','-q'],['config','user.email','fixture@example.invalid'],['config','user.name','Fixture'],['add','.'],['commit','-qm','base']])await git(repo,...args);
 const c=new Coordinator({root:path.join(root,'state'),selectedHost:'cursor',codexPath:executable});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const raw={submissionId:'native',objective:'Runtime-bound native edit',acceptance:['Bounded edit'],mode:'codex_only',environment:'fixture',project:{repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['src/'],writePaths:['src/'],checks:[{id:'verify',argv:[process.execPath,'--check','src/value.mjs']}]}};
 const g=legacy?c.prepareLegacyGoal(raw,'prepare'):c.preparePortableGoal({...raw,executionPolicy:{version:1,backend:'codex-sandbox',backendRevision:1}},'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const task=c.submitTask({goalId:g.id,submissionId:'edit',kind:'coding',objective:'Bounded edit',acceptance:['Bounded']},'task');
 return {c,g,task,i:new Integration({c,config:{codexPath:executable}}),mutate:()=>writeFile(executable,'unused replacement executable B',{mode:0o700}),restore:()=>writeFile(executable,'unused fixture executable A',{mode:0o700})};
}
for(const legacy of [false,true])test(`native ${legacy?'legacy':'candidate'} reservation rejects runtime replacement during async base preparation`,async t=>{
 const f=await fixture(t,{legacy}),identity=f.c.store.get('execution_configuration','coordinator');
 if(legacy){const original=f.i.lockedGoal.bind(f.i);f.i.lockedGoal=async(...args)=>{const target=await original(...args);await f.mutate();return target;};}
 else{const original=f.i.executionBase.bind(f.i);f.i.executionBase=async(...args)=>{const base=await original(...args);await f.mutate();return base;};}
 await assert.rejects(legacy?f.i.beginNative(f.task.id):f.i.nativeCandidates.start(f.task.id),/execution.*runtime.*changed/i);
 const current=f.c.getTask(f.task.id);assert.equal(current.status,'codex_ready');assert.equal(current.native,undefined);assert.equal(f.c.getGoal(f.g.id).integrationOwner??null,null);
 assert.deepEqual(f.c.store.all('agent'),[]);assert.equal(f.c.getGoal(f.g.id).hash,f.g.hash);assert.deepEqual(f.c.store.get('execution_configuration','coordinator'),identity);
});
test('native post-initialization drift cannot publish an active writer and preserves its reservation for release',async t=>{
 const f=await fixture(t),original=f.i.nativeCandidates.open.bind(f.i.nativeCandidates);
 f.i.nativeCandidates.open=async(...args)=>{const target=await original(...args),initialize=target.workspace.initialize.bind(target.workspace);target.workspace.initialize=async(...options)=>{const result=await initialize(...options);await f.mutate();return result;};return target;};
 await assert.rejects(f.i.nativeCandidates.start(f.task.id),/execution.*runtime.*changed/i);
 const held=f.c.getTask(f.task.id);assert.equal(held.native.status,'starting');assert.equal(held.native.writerActive,true);assert.equal(f.c.getGoal(f.g.id).hash,f.g.hash);
 assert.equal(f.c.store.db.prepare("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.native_started'").get(f.task.id).n,0);
 f.c.control({taskId:f.task.id,action:'stop'},'stop');
 const released=await f.i.nativeCandidates.release({taskId:f.task.id,reason:'Host confirms no writer was dispatched after runtime drift'});
 assert.equal(released.status,'partial');assert.equal(released.native.writerActive,false);assert.equal(released.deadline,held.deadline);assert.deepEqual(released.spent,held.spent);
});
