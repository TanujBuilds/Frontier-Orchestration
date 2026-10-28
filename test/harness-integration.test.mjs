import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {git,command} from '../src/project/process.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {Integration} from '../src/harness/integration.mjs';

async function fixture(t,mode='collaborative'){
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-integrate-')),repo=path.join(root,'repo');await mkdir(path.join(repo,'src'),{recursive:true});await mkdir(path.join(repo,'checks'));
 await writeFile(path.join(repo,'src/answer.mjs'),'export const answer=0;\n');await writeFile(path.join(repo,'checks/verify.mjs'),"import {answer} from '../src/answer.mjs';if(answer!==42)process.exit(1);\n");
 for(const a of [['init','-q'],['config','user.email','fixture@example.invalid'],['config','user.name','Fixture'],['add','.'],['commit','-qm','base']])await git(repo,...a);
 const c=new Coordinator({root:path.join(root,'state')});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const g=c.prepareGoal({submissionId:'g',objective:'Implement42',acceptance:['All checks pass'],mode,environment:'fixture',project:{repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'verify',argv:[process.execPath,'checks/verify.mjs']}]}},'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');
 const checksFactory=w=>({verify:async()=>({fixture:true}),run:async checks=>Promise.all(checks.map(async check=>{const r=await command(check.argv,{cwd:w.root});return {...r,id:check.id,passed:r.code===0,screenshots:[]};}))});
 const integration=new Integration({c,checksFactory});return {root,repo,c,g,checksFactory,integration,config:{environment:'fixture'}};
}
const task={submissionId:'code',kind:'coding',objective:'Implement42',acceptance:['Protected check passes']};
const provider=(value=42)=>({complete:async messages=>{const input=JSON.parse(messages.at(-1).content),file=input.files.find(x=>x.path==='src/answer.mjs');return {content:JSON.stringify({type:'submit_changes',paths:[],edits:[{path:file.path,action:'write',baseHash:file.hash,content:`export const answer=${value};\n`}],summary:'Candidate'})};}});
test('operator acceptance imports candidate once and reruns combined checks',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task},'s');await new Worker({...f,provider:provider()}).drain();
 const accepted=await f.integration.accept({taskId:a.id,feedback:'Actual diff and checks meet acceptance'},'accept');assert.equal(accepted.status,'accepted');assert.ok(accepted.integration.commit);
 const again=await f.integration.accept({taskId:a.id,feedback:'Actual diff and checks meet acceptance'},'accept');assert.equal(again.integration.commit,accepted.integration.commit);
 assert.equal(await readFile(path.join(f.repo,'src/answer.mjs'),'utf8'),'export const answer=0;\n');
 assert.equal(await readFile(path.join(accepted.integration.worktree,'src/answer.mjs'),'utf8'),'export const answer=42;\n');
});
test('DeepSeek-only automatically integrates passing code with zero operator reviews',async t=>{
 const f=await fixture(t,'deepseek_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s');await new Worker({...f,provider:provider()}).drain();
 const done=f.c.getTask(a.id);assert.equal(done.status,'accepted');assert.equal(done.reviews,0);assert.ok(done.integration.commit);assert.equal(done.integration.review,'none');
});
test('revision preserves spending and starts a fresh attempt instead of replaying candidate',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task},'s'),worker=new Worker({...f,provider:provider()});await worker.drain();
 f.c.review({taskId:a.id,decision:'revise',feedback:'Recheck the result against this clarification'},'revise');await worker.drain();
 const candidate=f.c.getTask(a.id);assert.equal(candidate.status,'awaiting_review');assert.equal(candidate.attempts,2);assert.equal(candidate.spent.model,2);
 const done=await f.integration.accept({taskId:a.id,feedback:'Verified revised candidate'},'accept');assert.equal(done.reviews,2);
});
test('takeover preserves partial worker tree and counters; Codex edits integration tree',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task,limits:{attempts:1}},'s');await new Worker({...f,provider:provider(7)}).drain();
 assert.equal(f.c.getTask(a.id).status,'blocked');
 const native=await f.integration.takeover({taskId:a.id,reason:'Finish the remaining correction'},'takeover');
 assert.equal(native.status,'codex_active');assert.match(await readFile(path.join(native.native.worktree,'src/answer.mjs'),'utf8'),/answer=7/);
 await writeFile(path.join(native.native.worktree,'src/answer.mjs'),'export const answer=42;\n');
 const done=await f.integration.finishNative({taskId:a.id,summary:'Fixed the remaining constant'},'finish');assert.equal(done.status,'accepted');assert.equal(done.attempts,1);assert.equal(done.spent.model,1);
 assert.match(await readFile(path.join(done.native.workerWorktree,'src/answer.mjs'),'utf8'),/answer=7/);
});
test('Codex-only finalization rejects protected check edits',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s');const native=await f.integration.startNative({taskId:a.id},'start');
 await writeFile(path.join(native.native.worktree,'checks/verify.mjs'),'process.exit(0)');
 await assert.rejects(f.integration.finishNative({taskId:a.id,summary:'Done'},'finish'),/scope|protected|outside/);
 assert.equal(f.c.getTask(a.id).status,'codex_active');
});
