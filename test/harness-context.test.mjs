import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { command,git } from '../src/project/process.mjs';
import { Coordinator } from '../src/harness/coordinator.mjs';
import { Worker } from '../src/harness/worker.mjs';

async function setup(t,mode='collaborative'){
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-adapter-')),repo=path.join(root,'repo');await mkdir(path.join(repo,'src'),{recursive:true});await mkdir(path.join(repo,'checks'));
 await writeFile(path.join(repo,'src/answer.mjs'),'export const answer=0;\n');await writeFile(path.join(repo,'checks/verify.mjs'),"import {answer} from '../src/answer.mjs'; if(answer!==42)process.exit(1);\n");
 await git(repo,'init','-q');await git(repo,'config','user.email','fixture@example.invalid');await git(repo,'config','user.name','Fixture');await git(repo,'add','.');await git(repo,'commit','-qm','base');
 const c=new Coordinator({root:path.join(root,'state')});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const g=c.prepareGoal({submissionId:'goal',objective:'Implement the answer',acceptance:['Answer equals42'],mode,environment:'fixture',project:{repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'verify',argv:[process.execPath,'checks/verify.mjs']}]}},'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const checksFactory=workspace=>({verify:async()=>({fixture:true}),run:async checks=>Promise.all(checks.map(async check=>{const r=await command(check.argv,{cwd:workspace.root});return {...r,id:check.id,passed:r.code===0,screenshots:[]};}))});
 return {c,g,root,repo,checksFactory,config:{environment:'fixture'}};
}
function answer(messages){const p=JSON.parse(messages.at(-1).content),file=p.files.find(f=>f.path==='src/answer.mjs');return {content:JSON.stringify({type:'submit_changes',paths:[],edits:[{path:'src/answer.mjs',action:'write',baseHash:file.hash,content:'export const answer=42;\n'}],summary:'Implemented answer'}),model:'fixture',usage:{total_tokens:10}};}
const coding=(id='code')=>({submissionId:id,kind:'coding',objective:'Implement answer42',acceptance:['Protected verification passes']});

function isolatedWorker(f,provider,owner){const worker=new Worker({...f,provider,owner});worker.integration.executionBase=async()=>f.g.manifest.project.baseCommit;return worker;}
test('source and test reads survive restart and failed check; repair sees fresh hashes',async t=>{
 const f=await setup(t),task=f.c.submitTask({goalId:f.g.id,...coding()},'submit');let calls=0,oldHash;
 const provider={complete:async messages=>{
  const input=JSON.parse(messages.at(-1).content);calls++;
  if(calls===1)return {content:JSON.stringify({type:'read_files',paths:['src/answer.mjs'],edits:[],summary:'Read source'})};
  if(calls===2)return {content:JSON.stringify({type:'read_files',paths:['checks/verify.mjs'],edits:[],summary:'Read test'})};
  assert.deepEqual(new Set(input.files.map(f=>f.path)),new Set(['src/answer.mjs','checks/verify.mjs']));
  const file=input.files.find(f=>f.path==='src/answer.mjs');
  if(calls===3){oldHash=file.hash;return {content:JSON.stringify({type:'submit_changes',paths:[],edits:[{path:file.path,action:'write',baseHash:file.hash,content:'export const answer=1;\n'}],summary:'First attempt'})};}
  assert.equal(file.content,'export const answer=1;\n');assert.notEqual(file.hash,oldHash);
  return answer(messages);
 }};
 let worker=isolatedWorker(f,provider);
 while(calls<2)await worker.tick();
 const checkpoint=f.c.getTask(task.id).checkpoint;assert.equal(checkpoint.workingSet.version,1);assert.equal(checkpoint.workingSet.executionBase,f.g.manifest.project.baseCommit);
 worker=isolatedWorker(f,provider,worker.owner);await worker.drain();
 const done=f.c.getTask(task.id);assert.equal(done.status,'awaiting_review');assert.equal(done.attempts,2);assert.equal(calls,4);assert.equal(done.spent.model,4);
});
test('saved completed model response emits no duplicate request events on restart',async t=>{
 const f=await setup(t),task=f.c.submitTask({goalId:f.g.id,...coding()},'submit');let calls=0;
 let worker=isolatedWorker(f,{complete:async m=>{calls++;f.c.control({taskId:task.id,action:'stop'},'stop');return answer(m);}});
 await worker.drain();f.c.control({taskId:task.id,action:'resume'},'resume');worker=isolatedWorker(f,{complete:async()=>{throw Error('duplicate');}},worker.owner);await worker.drain();
 assert.equal(calls,1);const events=f.c.store.events(0,1000).filter(e=>e.task_id===task.id);
 assert.equal(events.filter(e=>e.type==='model.request.started').length,1);assert.equal(events.filter(e=>e.type==='model.request.completed').length,1);
 for(const e of events.filter(e=>e.type.startsWith('model.request.')))assert.equal(typeof e.data.requestId,'string');
 assert.ok(events.some(e=>e.type==='coding.edit.applied'));assert.ok(events.some(e=>e.type==='coding.checks.passed'));
});
test('resolver refusal blocks coding without substituting current HEAD',async t=>{
 const f=await setup(t),task=f.c.submitTask({goalId:f.g.id,...coding()},'submit');let calls=0;
 const worker=isolatedWorker(f,{complete:async()=>{calls++;return {};}});worker.integration.executionBase=async()=>{throw Error('Legacy writer active');};await worker.drain();
 assert.equal(f.c.getTask(task.id).status,'blocked');assert.match(f.c.getTask(task.id).reason,/Legacy writer/);assert.equal(calls,0);assert.equal(f.c.getTask(task.id).checkpoint.executionBase,undefined);
});
