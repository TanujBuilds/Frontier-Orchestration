import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {git,command} from '../src/project/process.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {Integration} from '../src/harness/integration.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {spawn} from 'node:child_process';

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
test('SIGKILL after the Git checkpoint but before SQLite acceptance reuses the exact integration commit',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task},'s');await new Worker({...f,provider:provider()}).drain();const before=f.c.getTask(a.id);f.c.close();
 const script=`import {Coordinator} from ${JSON.stringify(new URL('../src/harness/coordinator.mjs',import.meta.url).href)};import {Integration} from ${JSON.stringify(new URL('../src/harness/integration.mjs',import.meta.url).href)};import {command} from ${JSON.stringify(new URL('../src/project/process.mjs',import.meta.url).href)};
 const c=new Coordinator({root:process.argv[1]}),emit=c.emit.bind(c);c.emit=(type,g,id,data)=>{if(type==='task.integrated'){console.log(JSON.stringify({commit:data.commit,task:c.getTask(id)}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return emit(type,g,id,data);};
 const checksFactory=w=>({verify:async()=>({fixture:true}),run:async checks=>Promise.all(checks.map(async check=>{const r=await command(check.argv,{cwd:w.root});return {...r,id:check.id,passed:r.code===0,screenshots:[]};}))});await new Integration({c,checksFactory}).accept({taskId:process.argv[2],feedback:'Reviewed actual diff and checks'},'crash-accept');`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,path.join(f.root,'state'),a.id],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const checkpoint=await new Promise((resolve,reject)=>{let out='',err='';child.stderr.on('data',b=>err+=b);child.stdout.on('data',b=>{out+=b;if(out.includes('\n'))resolve(JSON.parse(out.split('\n')[0]));});child.on('exit',()=>reject(Error('Child ended before checkpoint: '+err)));});
 const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await ended;const recovered=new Coordinator({root:path.join(f.root,'state')});try{
  const saved=recovered.getTask(a.id);assert.equal(saved.status,'ready_to_integrate');assert.equal(saved.reviews,1);assert.equal(saved.spent.model,before.spent.model);assert.equal(saved.deadline,before.deadline);
  const integration=new Integration({c:recovered,checksFactory:f.checksFactory}),done=await integration.accept({taskId:a.id,feedback:'Reviewed actual diff and checks'},'crash-accept');assert.equal(done.status,'accepted');assert.equal(done.integration.commit,checkpoint.commit);assert.equal(done.reviews,1);assert.equal(done.deadline,before.deadline);assert.equal(done.spent.model,1);
 }finally{recovered.close();}
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
test('safe stop permits explicit takeover and native pause resumes the same ownership',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task},'s'),worker=new Worker({...f,provider:provider()});
 await worker.tick();
 f.c.control({taskId:a.id,action:'stop'},'stop');await worker.tick();
 const stopped=f.c.getTask(a.id);assert.equal(stopped.status,'stopped');assert.equal(stopped.stopRequested,true);
 const native=await f.integration.takeover({taskId:a.id,reason:'Finish after the verified safe stop'},'takeover');
 assert.equal(native.status,'codex_active');assert.equal(native.stopRequested,false);
 f.c.control({taskId:a.id,action:'pause'},'pause');assert.equal(f.c.getTask(a.id).status,'paused');
 await assert.rejects(f.integration.finishNative({taskId:a.id,summary:'Paused'},'paused-finish'),/ownership|paused/);
 f.c.control({taskId:a.id,action:'resume'},'resume');assert.equal(f.c.getTask(a.id).status,'codex_active');
 assert.equal(f.c.claimNext('other-worker'),null);assert.equal(f.c.getTask(a.id).deadline,stopped.deadline);
 await writeFile(path.join(native.native.worktree,'src/answer.mjs'),'export const answer=42;\n');
 const done=await f.integration.finishNative({taskId:a.id,summary:'Completed under native ownership'},'finish');assert.equal(done.status,'accepted');assert.equal(done.spent.model,0);
});
test('takeover finalization rejects a modified frozen worker checkout',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task,limits:{attempts:1}},'s');await new Worker({...f,provider:provider(7)}).drain();
 const native=await f.integration.takeover({taskId:a.id,reason:'Repair remaining constant'},'takeover');
 await writeFile(path.join(native.native.workerWorktree,'src/answer.mjs'),'export const answer=99;\n');
 await writeFile(path.join(native.native.worktree,'src/answer.mjs'),'export const answer=42;\n');
 await assert.rejects(f.integration.finishNative({taskId:a.id,summary:'Done'},'finish'),/frozen|worker.*changed/i);
 assert.equal(f.c.getTask(a.id).status,'codex_active');
});
test('expanded assignment reads require an approved goal version and keep execution history',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task,permissions:{readPaths:['src/answer.mjs','checks/'],writePaths:['src/answer.mjs'],checks:['verify']}},'s'),worker=new Worker({...f,provider:provider()});
 await worker.tick();const before=f.c.getTask(a.id);f.c.control({taskId:a.id,action:'stop'},'stop');await worker.tick();
 const spec={...before.spec,permissions:{...before.spec.permissions,readPaths:['src/','checks/']}},goals=new Goals(f.c);
 assert.throws(()=>goals.rebind({taskId:a.id,spec},'unapproved'),/version|approval|exact/);
 const revision=goals.prepareRevision({goalId:f.g.id,expectedHash:f.g.hash,manifest:{submissionId:'g',objective:'Implement42 with approved combined-check source reads',acceptance:['All checks pass'],mode:'collaborative',environment:'fixture',project:f.g.manifest.project}},'prepare-revision');goals.activateRevision({revisionId:revision.id,hash:revision.hash},'approve-revision');
 const rebound=goals.rebind({taskId:a.id,spec},'rebind');assert.equal(rebound.attempts,before.attempts);assert.deepEqual(rebound.checkpoint,before.checkpoint);assert.equal(rebound.deadline,before.deadline);assert.equal(rebound.goalVersion,2);
 await worker.drain();assert.equal(f.c.getTask(a.id).status,'awaiting_review');assert.equal(f.c.getTask(a.id).attempts,1);
 const opened=await worker.adapters.coding.open(f.c.getTask(a.id));assert.deepEqual(opened.manifest.permissions.readPaths,['src/','checks/']);
});
test('overnight review spends bounded check-gated calls then integrates a revised candidate',async t=>{
 const f=await fixture(t,'overnight_review'),a=f.c.submitTask({goalId:f.g.id,...task},'s');let reviews=0;
 const worker=new Worker({...f,provider:provider(),reviewer:{reviewCode:async input=>{assert.ok(input.evidence.checks.every(c=>c.passed));assert.deepEqual(input.evidence.sandbox,{fixture:true});assert.equal(input.evidence.sourceFixture.unchanged,true);assert.ok(input.evidence.modelContext.some(ctx=>ctx.files.some(file=>file.path==='checks/verify.mjs')));return {decision:++reviews===1?'revise':'accept',feedback:'Recheck and then accept',unverified:[]};}}});await worker.drain();
 const done=f.c.getTask(a.id);assert.equal(done.status,'accepted');assert.equal(done.attempts,2);assert.equal(done.spent.codexReview,2);assert.equal(reviews,2);assert.equal(done.integration.review,'codex_legacy');
});
test('DeepSeek-only refuses a configured Codex reviewer even when code passes',async t=>{
 const f=await fixture(t,'deepseek_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s');let calls=0;
 await new Worker({...f,provider:provider(),reviewer:{reviewCode:async()=>{calls++;throw Error('Forbidden review');}}}).drain();
 assert.equal(f.c.getTask(a.id).status,'accepted');assert.equal(calls,0);assert.equal(f.c.getTask(a.id).spent.codexReview,0);
});

test('expired automatic integration becomes partial without starving independent queued work',async t=>{
 const f=await fixture(t,'deepseek_only'),a=f.c.submitTask({goalId:f.g.id,...task,limits:{seconds:1}},'s');f.c.claimNext('owner');f.c.completeTask(a.id,{checks:[]},'owner');const deadline=f.c.getTask(a.id).deadline;f.c.now=()=>deadline+1;
 const other=f.c.submitTask({goalId:f.g.id,submissionId:'other',kind:'consult',objective:'Independent answer',acceptance:['Answer']},'other');
 await new Worker({...f,provider:{complete:async()=>({content:'Answer'})}}).tick();assert.equal(f.c.getTask(a.id).status,'partial');assert.equal(f.c.getTask(other.id).status,'accepted');assert.equal(f.c.getTask(a.id).deadline,deadline);
});
test('native finalization rechecks controls after protected checks and preserves the partial files',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s'),native=await f.integration.startNative({taskId:a.id},'start');await writeFile(path.join(native.native.worktree,'src/answer.mjs'),'export const answer=42;\n');
 const integration=new Integration({c:f.c,checksFactory:w=>({verify:async()=>({fixture:true}),run:async checks=>{const result=await f.checksFactory(w).run(checks);f.c.control({taskId:a.id,action:'stop'},'stop-during-check');return result;}})});
 await assert.rejects(integration.finishNative({taskId:a.id,summary:'Done'},'finish'),/stopped|ownership|active/);assert.equal(f.c.getTask(a.id).status,'stopped');assert.equal(f.c.getTask(a.id).integration,undefined);assert.equal(await readFile(path.join(native.native.worktree,'src/answer.mjs'),'utf8'),'export const answer=42;\n');
});
test('stopped expired native work can be preserved and explicitly released for partial finalization',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task,limits:{seconds:1}},'s'),native=await f.integration.startNative({taskId:a.id},'start');await writeFile(path.join(native.native.worktree,'src/answer.mjs'),'export const answer=7;\n');const before=f.c.getTask(a.id);f.c.now=()=>before.deadline+1;f.c.control({taskId:a.id,action:'stop'},'stop');
 const {Dispatcher}=await import('../src/harness/tools.mjs'),dispatcher=new Dispatcher({c:f.c,worker:new Worker({...f})}),operation=await dispatcher.invoke('native_release',{taskId:a.id,reason:'Native editing stopped; preserve expired partial work',idempotencyKey:'release'});await dispatcher.whenIdle();assert.equal(f.c.store.get('operation',operation.id).status,'completed');
 const released=f.c.getTask(a.id);assert.equal(released.status,'partial');assert.equal(released.deadline,before.deadline);assert.deepEqual(released.spent,before.spent);assert.equal(f.c.getGoal(f.g.id).integrationOwner,null);assert.equal(await readFile(path.join(native.native.worktree,'src/answer.mjs'),'utf8'),'export const answer=7;\n');
 const done=new Goals(f.c).finalize({goalId:f.g.id,summary:'Expired native work preserved',partial:true},'partial');assert.equal(done.status,'partial');assert.ok(released.result.savedNative);
});
test('native acceptance survives the accepted-task to effect-completion interruption',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s'),native=await f.integration.startNative({taskId:a.id},'start');await writeFile(path.join(native.native.worktree,'src/answer.mjs'),'export const answer=42;\n');
 const put=f.c.store.put.bind(f.c.store);f.c.store.put=(kind,value)=>{if(kind==='effect'&&value.id==='finish'&&value.status==='completed')throw Error('Simulated interruption');return put(kind,value);};
 await assert.rejects(f.integration.finishNative({taskId:a.id,summary:'Done'},'finish'),/interruption/);f.c.store.put=put;const accepted=f.c.getTask(a.id);assert.equal(accepted.status,'accepted');new Goals(f.c).finalize({goalId:f.g.id,summary:'Complete'},'final');
 const recovered=await f.integration.finishNative({taskId:a.id,summary:'Done'},'finish');assert.equal(recovered.integration.commit,accepted.integration.commit);assert.equal(f.c.store.get('effect','finish').status,'completed');
});

test('candidate acceptance replays its committed result after the goal is finalized',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task},'s');await new Worker({...f,provider:provider()}).drain();const put=f.c.store.put.bind(f.c.store);f.c.store.put=(kind,value)=>{if(kind==='effect'&&value.id==='accept-gap'&&value.status==='completed')throw Error('Simulated interruption');return put(kind,value);};
 await assert.rejects(f.integration.accept({taskId:a.id,feedback:'Reviewed actual code'},'accept-gap'),/interruption/);f.c.store.put=put;const before=f.c.getTask(a.id);new Goals(f.c).finalize({goalId:f.g.id,summary:'Complete'},'final');const recovered=await f.integration.accept({taskId:a.id,feedback:'Reviewed actual code'},'accept-gap');assert.equal(recovered.integration.commit,before.integration.commit);assert.equal(recovered.reviews,before.reviews);
});
test('expired legacy candidate does not block an eligible review in another goal',async t=>{
 const f=await fixture(t,'overnight_review'),a=f.c.submitTask({goalId:f.g.id,...task,limits:{seconds:1}},'s');f.c.claimNext('owner');f.c.completeTask(a.id,{checks:[]},'owner');f.c.now=()=>f.c.getTask(a.id).deadline+1;let reviews=0;const worker=new Worker({...f,reviewer:{reviewCode:async()=>{reviews++;return {decision:'accept',feedback:'Pass',unverified:[]};}}});await worker.tick();assert.equal(f.c.getTask(a.id).status,'partial');assert.equal(reviews,0);
});

test('SIGKILL after native acceptance before effect completion replays without a second commit',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s'),native=await f.integration.startNative({taskId:a.id},'start');await writeFile(path.join(native.native.worktree,'src/answer.mjs'),'export const answer=42;\n');f.c.close();
 const script=`import {Coordinator} from ${JSON.stringify(new URL('../src/harness/coordinator.mjs',import.meta.url).href)};import {Integration} from ${JSON.stringify(new URL('../src/harness/integration.mjs',import.meta.url).href)};import {command} from ${JSON.stringify(new URL('../src/project/process.mjs',import.meta.url).href)};
 const c=new Coordinator({root:process.argv[1]}),put=c.store.put.bind(c.store);c.store.put=(kind,value)=>{if(kind==='effect'&&value.id==='kill-finish'&&value.status==='completed'){console.log(JSON.stringify({commit:c.getTask(process.argv[2]).integration.commit}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return put(kind,value);};
 const checksFactory=w=>({verify:async()=>({fixture:true}),run:async checks=>Promise.all(checks.map(async check=>{const r=await command(check.argv,{cwd:w.root});return {...r,id:check.id,passed:r.code===0,screenshots:[]};}))});await new Integration({c,checksFactory}).finishNative({taskId:process.argv[2],summary:'Done'},'kill-finish');`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,path.join(f.root,'state'),a.id],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const checkpoint=await new Promise((resolve,reject)=>{let out='',err='';child.stderr.on('data',b=>err+=b);child.stdout.on('data',b=>{out+=b;if(out.includes('\n'))resolve(JSON.parse(out.split('\n')[0]));});child.on('exit',()=>reject(Error('Child ended before acceptance: '+err)));});const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await ended;
 const recovered=new Coordinator({root:path.join(f.root,'state')});try{assert.equal(recovered.getTask(a.id).status,'accepted');assert.equal(recovered.store.get('effect','kill-finish').status,'pending');new Goals(recovered).finalize({goalId:f.g.id,summary:'Complete'},'done');const done=await new Integration({c:recovered,checksFactory:f.checksFactory}).finishNative({taskId:a.id,summary:'Done'},'kill-finish');assert.equal(done.integration.commit,checkpoint.commit);assert.equal(done.spent.model,0);assert.equal(await git(done.integration.worktree,'rev-list','--count',`${f.g.manifest.project.baseCommit}..HEAD`),'1');}finally{recovered.close();}
});
