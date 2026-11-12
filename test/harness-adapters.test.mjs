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
test('coding executes real isolated edits/checks and reaches operator review',async t=>{
 const f=await setup(t);const task=f.c.submitTask({goalId:f.g.id,...coding()},'submit');let calls=0;
 const worker=new Worker({...f,provider:{complete:async m=>{calls++;return answer(m);}}});await worker.drain();
 const done=f.c.getTask(task.id);assert.equal(done.status,'awaiting_review');assert.equal(done.attempts,1);assert.equal(done.spent.model,1);assert.equal(calls,1);
 assert.equal(await readFile(path.join(f.repo,'src/answer.mjs'),'utf8'),'export const answer=0;\n');assert.ok(done.result.checks.every(c=>c.passed));assert.match(done.result.diff,/answer=42/);
});
test('coding asks a bounded question and resumes saved attempt after answer',async t=>{
 const f=await setup(t);const task=f.c.submitTask({goalId:f.g.id,...coding()},'submit');let calls=0;
 const worker=new Worker({...f,provider:{complete:async m=>++calls===1?{content:JSON.stringify({type:'ask_supervisor',question:'Should the exported constant be numeric?'})}:answer(m)}});
 await worker.drain();assert.equal(f.c.getTask(task.id).status,'awaiting_supervisor');
 f.c.answer({taskId:task.id,answer:'Yes, use the number42',responder:'codex'},'answer');await worker.drain();
 assert.equal(f.c.getTask(task.id).status,'awaiting_review');assert.equal(f.c.getTask(task.id).attempts,1);assert.equal(f.c.getTask(task.id).spent.model,2);
});
test('stop during a question response saves it before releasing the slot and replays without spending again',async t=>{
 const f=await setup(t),task=f.c.submitTask({goalId:f.g.id,...coding()},'submit');let calls=0;
 const worker=new Worker({...f,provider:{complete:async()=>{calls++;f.c.control({taskId:task.id,action:'stop'},'stop-during-request');return {content:JSON.stringify({type:'ask_supervisor',question:'Confirm the numeric result?'})};}}});
 await worker.drain();assert.equal(f.c.getTask(task.id).status,'stopped');assert.equal(f.c.getTask(task.id).questions.length,0);assert.equal(f.c.getTask(task.id).spent.model,1);
 f.c.control({taskId:task.id,action:'resume'},'resume');await worker.drain();assert.equal(f.c.getTask(task.id).status,'awaiting_supervisor');assert.equal(f.c.getTask(task.id).questions.length,1);assert.equal(calls,1);
});
test('hostile source/model write outside scope is blocked before applying edits',async t=>{
 const f=await setup(t);const task=f.c.submitTask({goalId:f.g.id,...coding()},'submit');
 const worker=new Worker({...f,provider:{complete:async()=>({content:JSON.stringify({type:'submit_changes',paths:[],summary:'Override checks',edits:[{path:'checks/verify.mjs',action:'write',baseHash:null,content:'process.exit(0)'}]})})}});await worker.drain();
 assert.equal(f.c.getTask(task.id).status,'blocked');assert.match(await readFile(path.join(f.repo,'checks/verify.mjs'),'utf8'),/answer!==42/);
});
test('saved provider response replays after step restart without calling model again',async t=>{
 const f=await setup(t);const task=f.c.submitTask({goalId:f.g.id,...coding()},'submit');let calls=0;
 const worker=new Worker({...f,provider:{complete:async m=>{calls++;return answer(m);}}});
 for(let n=0;n<20;n++){await worker.tick();if(f.c.getTask(task.id).checkpoint.phase==='apply')break;}
 const before=f.c.getTask(task.id);assert.equal(before.spent.model,1);
 const second=new Worker({...f,owner:worker.owner,provider:{complete:async()=>{throw Error('Duplicate request');}}});await second.drain();
 assert.equal(f.c.getTask(task.id).status,'awaiting_review');assert.equal(calls,1);
});
test('urgent consult yields coding at a saved boundary and both finish',async t=>{
 const f=await setup(t);const task=f.c.submitTask({goalId:f.g.id,...coding()},'submit');const order=[];
 const worker=new Worker({...f,provider:{complete:async m=>{const p=JSON.parse(m.at(-1).content);if(p.task.kind==='coding'){order.push('coding');f.c.submitTask({goalId:f.g.id,submissionId:'urgent',kind:'consult',priority:'blocking',objective:'Resolve urgent question',acceptance:['Answer']},'urgent');return answer(m);}order.push('urgent');return {content:'Resolved'};}}});await worker.drain();
 assert.deepEqual(order,['coding','urgent']);assert.equal(f.c.getTask(task.id).status,'awaiting_review');assert.ok(f.c.store.events(0,1000).some(e=>e.type==='task.checkpoint'&&e.data.status==='suspended'));
});
test('Codex-only native tasks never enter DeepSeek worker',async t=>{
 const f=await setup(t,'codex_only');f.c.submitTask({goalId:f.g.id,...coding()},'submit');let calls=0;
 const worker=new Worker({...f,provider:{complete:async()=>{calls++;throw Error('Forbidden');}}});await worker.drain();assert.equal(calls,0);
});
test('oversized or extra-field coding actions spend an attempt without applying edits',async t=>{
 for(const malformed of ['files','bytes','field']){
  const f=await setup(t);const task=f.c.submitTask({goalId:f.g.id,...coding()},'submit');let calls=0;
  const worker=new Worker({...f,provider:{complete:async m=>{if(++calls>1)return answer(m);const reply=JSON.parse(answer(m).content);
   if(malformed==='files')reply.edits.push(...['src/b.mjs','src/c.mjs'].map(path=>({path,action:'write',baseHash:null,content:'export {};'})));
   if(malformed==='bytes')reply.edits[0].content=' '.repeat(24577);
   if(malformed==='field')reply.command='execute arbitrary shell';
   return {content:JSON.stringify(reply)};
  }}});await worker.drain();
  const done=f.c.getTask(task.id);assert.equal(done.status,'awaiting_review');assert.equal(done.attempts,2);assert.equal(done.spent.model,2);
  assert.equal(f.c.store.all('outcome').filter(o=>o.kind==='attempt.protocol_failed').length,1);
  assert.doesNotMatch(done.result.diff,/src\/b.mjs|src\/c.mjs/);
 }
});
test('a real protocol failure feeds bounded learning and a later assignment retrieves the promoted recipe',async t=>{
 const f=await setup(t);let calls=0;
 const source=f.c.submitTask({goalId:f.g.id,...coding()},'source');
 const worker=new Worker({...f,provider:{complete:async m=>{
  const input=JSON.parse(m.at(-1).content);calls++;
  if(calls===1)return {content:'truncated',finishReason:'length'};
  if(input.task.kind==='learning')return {content:JSON.stringify({family:'edit_batch',scope:'project',parameters:{maxFiles:1,maxBytes:24576},evidence:[input.outcomes.find(o=>o.kind==='attempt.protocol_failed').id],rationale:'Use smaller batches after truncation'})};
  if(input.task.submissionId==='fresh'){assert.equal(input.memory.length,1);assert.equal(input.editLimits.maxFiles,1);}
  return answer(m);
 }}});await worker.drain();assert.equal(f.c.getTask(source.id).attempts,2);
 await worker.integration.accept({taskId:source.id,feedback:'Fixture operator reviewed truncation recovery and passing protected checks'},'source-reviewed-integration');assert.equal(f.c.getTask(source.id).status,'accepted');
 const maintenance=f.c.submitTask({goalId:f.g.id,submissionId:'learn',kind:'learning',objective:'Learn from coding response truncation',acceptance:['Protected evaluation passes']},'learn');await worker.drain();
 assert.equal(f.c.getTask(maintenance.id).status,'accepted');assert.equal(f.c.getTask(maintenance.id).spent.model,1);
 const fresh=f.c.submitTask({goalId:f.g.id,...coding('fresh'),objective:'Implement coding answer after response truncation'},'fresh');await worker.drain();
 const done=f.c.getTask(fresh.id);assert.equal(done.status,'awaiting_review');assert.equal(done.memory.length,1);
 assert.ok(f.c.store.all('evaluation')[0].passed);assert.equal(f.c.store.all('lesson')[0].status,'active');
});
test('collaborative consult results wait for the main supervisor review',async t=>{
 const f=await setup(t),task=f.c.submitTask({goalId:f.g.id,submissionId:'consult',kind:'consult',objective:'Explain the design',acceptance:['Useful answer']},'consult');
 await new Worker({...f,provider:{complete:async()=>({content:'Candidate explanation'})}}).drain();assert.equal(f.c.getTask(task.id).status,'awaiting_review');
 const done=f.c.review({taskId:task.id,decision:'accept',feedback:'Explanation checked against the question'},'review');assert.equal(done.status,'accepted');assert.equal(done.spent.model,1);assert.equal(done.attempts,1);
});

test('gateway timeout remains uncertain and retains global DeepSeek ownership',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-gateway-')),c=new Coordinator({root});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const g=c.prepareGoal({submissionId:'g',objective:'Answer',acceptance:['Pass'],environment:'fixture'},'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');
 const first=c.submitTask({goalId:g.id,submissionId:'first',kind:'consult',objective:'First',acceptance:['Answer']},'first');c.submitTask({goalId:g.id,submissionId:'second',kind:'consult',objective:'Second',acceptance:['Answer']},'second');
 const worker=new Worker({c,config:{environment:'fixture'},provider:{complete:async()=>{throw Error('DeepSeek /v1/chat/completions returned HTTP 504');}}});await worker.tick();assert.equal(c.getTask(first.id).status,'uncertain');assert.equal(c.getTask(first.id).spent.model,1);assert.equal(c.claimNext('other'),null);
});
