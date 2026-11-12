import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,chmod,lstat,mkdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import {fixture,goal,task,candidate,accept,checksFactory} from './fixtures/mosaic-pb14-integration/fixture.mjs';
import {Integration} from '../src/harness/integration.mjs';
import {git} from '../src/project/process.mjs';

for(const separateGoals of [false,true])test(`disjoint isolated native candidates compose in one checked target (${separateGoals?'two goals':'same goal'})`,{timeout:30000},async t=>{
 const f=await fixture(t),g=goal(f,'one'),h=separateGoals?goal(f,'two'):g,a=await candidate(f,g,'a'),b=await candidate(f,h,'b');
 assert.notEqual(a.started.native.worktree,b.started.native.worktree);assert.equal(a.started.native.baseCommit,f.base);assert.equal(b.started.native.baseCommit,f.base);await a.finish();await b.finish();
 const first=await accept(f,a.task),second=await accept(f,b.task);assert.equal(second.status,'accepted');assert.equal(first.integration.worktree,second.integration.worktree);
 assert.match(await readFile(path.join(second.integration.worktree,'src/a.mjs'),'utf8'),/a=1/);assert.match(await readFile(path.join(second.integration.worktree,'src/b.mjs'),'utf8'),/b=1/);assert.equal(await git(f.repo,'rev-parse','HEAD'),f.base);
});
test('canonical repository lock serializes different goals and a symlink alias including legacy',async t=>{
 const f=await fixture(t),alias=path.join(f.root,'alias');await symlink(f.repo,alias);const g=goal(f,'portable'),h=goal(f,'legacy',{legacy:true,project:{repo:alias}});
 const held=await f.i.lockedGoal(g.id);try{await assert.rejects(f.i.lockedGoal(h.id),/owns|locked|runner/i);}finally{await held.release();}
 const next=await f.i.lockedGoal(h.id);await next.release();assert.notEqual(f.c.getGoal(g.id).integration.worktree,f.c.getGoal(h.id).integration.worktree);
});
test('individually passing cross-goal candidates fail combined checks and preserve both patches and pending ownership', {timeout:30000},async t=>{
 const f=await fixture(t,{check:'if(a+b>1)process.exit(1);'}),g=goal(f,'one'),h=goal(f,'two'),a=await candidate(f,g,'a'),b=await candidate(f,h,'b');await a.finish();await b.finish();const first=await accept(f,a.task);
 await assert.rejects(accept(f,b.task),/Integrated checks failed|combined/i);assert.notEqual(f.c.getTask(b.task.id).status,'accepted');assert.equal(f.c.getGoal(h.id).integrationPending.taskId,b.task.id);
 assert.match(await readFile(path.join(a.started.native.worktree,'src/a.mjs'),'utf8'),/a=1/);assert.match(await readFile(path.join(b.started.native.worktree,'src/b.mjs'),'utf8'),/b=1/);
 await assert.rejects(f.i.lockedGoal(g.id),/pending integration/i);
 await f.i.repair({taskId:b.task.id,reason:'Use saved failed combined check for same bounded correction'},'repair-combined');
 assert.equal(await readFile(path.join(first.integration.worktree,'src/b.mjs'),'utf8'),'export const b=0;\n');assert.equal(f.c.getTask(a.task.id).status,'accepted');
});
test('native admission rejects unresolved autonomous overlap and autonomous admission sees native writers without startedAt',async t=>{
 const f=await fixture(t),g=goal(f,'overlap'),worker=task(f,g,'worker',{actor:'deepseek',scope:'src/a.mjs'}),native=task(f,g,'native',{scope:'src/a.mjs'});
 const claimed=f.c.claimNext('worker-owner');assert.equal(claimed.id,worker.id);await assert.rejects(f.i.startNative({taskId:native.id,layout:'candidate_v1'},'native-overlap'),/overlap|write scope/i);assert.equal(f.c.getTask(native.id).native,undefined);
 f.c.store.tx(()=>{const a=f.c.store.get('task',worker.id);a.status='accepted';a.owner=null;f.c.store.put('task',a);});
 const started=await f.i.startNative({taskId:native.id,layout:'candidate_v1'},'native-clear');f.c.store.tx(()=>{const n=f.c.store.get('task',native.id);delete n.startedAt;f.c.store.put('task',n);});
 const late=task(f,g,'late',{actor:'deepseek',scope:'src/a.mjs'});assert.equal(f.c.claimNext('late-worker'),null);assert.equal(f.c.getTask(late.id).status,'queued');assert.ok(started.native.writerActive);
});
test('workspace text edit preserves existing executable bit and internal mode-only import is journaled',async t=>{
 const f=await fixture(t),g=goal(f,'modes'),target=await f.i.lockedGoal(g.id);try{
 const w=target.workspace,file='src/a.mjs',before=await w.content(file);await chmod(path.join(w.root,file),0o755);await target.journal.append('native.adopted',{snapshot:await w.snapshot()});await w.apply('edit-executable',{writePaths:['src/']},[{path:file,action:'write',baseHash:before.hash,content:'export const a=1;\n'}]);assert.ok((await lstat(path.join(w.root,file))).mode&0o100);
 const current=await w.content(file);await w.apply('mode-only',{writePaths:['src/']},[{path:file,action:'write',baseHash:current.hash,content:current.content,mode:'100644'}]);assert.equal((await lstat(path.join(w.root,file))).mode&0o100,0);assert.equal(target.journal.events.findLast(e=>e.type==='edits.intent').data.changes[0].afterMode,'100644');
 }finally{await target.release();}
});

test('accepted legacy private state prevents incompatible new shared target without discarding either candidate', {timeout:30000},async t=>{
 const f=await fixture(t),legacy=goal(f,'legacy',{legacy:true}),a=await candidate(f,legacy,'a');await a.finish();const done=await accept(f,a.task);const portable=goal(f,'portable');
 await assert.rejects(f.i.executionBase(portable.id),/incompatible.*integration|separate.*integration/i);assert.equal(await git(done.integration.worktree,'rev-parse','HEAD'),done.integration.commit);assert.equal(f.c.getTask(a.task.id).status,'accepted');assert.equal(await git(f.repo,'rev-parse','HEAD'),f.base);
});

test('native mode-only candidate imports checked executable bit into current target', {timeout:30000},async t=>{
 const f=await fixture(t),g=goal(f,'mode-candidate'),a=await candidate(f,g,'a');await writeFile(path.join(a.started.native.worktree,'src/a.mjs'),'export const a=0;\n');await chmod(path.join(a.started.native.worktree,'src/a.mjs'),0o755);await a.finish();const done=await accept(f,a.task);assert.equal((await git(done.integration.worktree,'ls-tree','HEAD','--','src/a.mjs')).split(' ')[0],'100755');assert.ok((await lstat(path.join(done.integration.worktree,'src/a.mjs'))).mode&0o100);
});

test('dependency cannot start from finished or reviewed candidate; accepted parent supplies execution base', {timeout:30000},async t=>{
 const f=await fixture(t),g=goal(f,'dependencies'),a=await candidate(f,g,'a'),b=task(f,g,'b',{dependsOn:[a.task.id]});await a.finish();await assert.rejects(f.i.startNative({taskId:b.id,layout:'candidate_v1'},'dependent-too-soon'),/Dependencies/);assert.equal(f.c.getTask(a.task.id).status,'ready_to_integrate');const done=await accept(f,a.task),started=await f.i.startNative({taskId:b.id,layout:'candidate_v1'},'dependent-start');assert.equal(started.native.baseCommit,done.integration.commit);assert.match(await readFile(path.join(started.native.worktree,'src/a.mjs'),'utf8'),/a=1/);
});

test('original cross-goal protected checks retain their exact specification and permissions', {timeout:30000},async t=>{
 const runs=[],f=await fixture(t,{onRun:async(w,checks,key)=>{if(key.startsWith('integrate-'))runs.push({writePaths:w.manifest.permissions.writePaths,checks});}}),g=goal(f,'one',{project:{writePaths:['src/a.mjs']}}),h=goal(f,'two',{project:{writePaths:['src/b.mjs'],checks:[{id:'verify',argv:[process.execPath,'checks/verify.mjs'],timeoutMs:9000}]}}),a=await candidate(f,g,'a'),b=await candidate(f,h,'b');await a.finish();await b.finish();await accept(f,a.task);runs.length=0;const done=await accept(f,b.task);
 assert.deepEqual(runs.map(r=>r.writePaths),[['src/a.mjs'],['src/b.mjs']]);assert.deepEqual(runs.map(r=>r.checks),[g.manifest.project.checks,h.manifest.project.checks]);assert.equal(done.integration.combinedEvidence.length,2);assert.equal(await git(done.integration.worktree,'show','HEAD:checks/verify.mjs'),await git(f.repo,'show',f.base+':checks/verify.mjs'));
});

test('conflicting historical candidate base preserves both original patches without force overwrite', {timeout:30000},async t=>{
 const f=await fixture(t),g=goal(f,'conflict'),a=await candidate(f,g,'a');await a.finish();const done=await accept(f,a.task),h=goal(f,'second');
 // Restore an earlier persisted execution-base pin as a historical candidate
 // fixture. All writes/checks/checkpoints/review/import below use public paths.
 const executionBase=f.i.executionBase.bind(f.i);f.i.executionBase=async()=>f.base;
 const b=await candidate(f,h,'a');f.i.executionBase=executionBase;await writeFile(path.join(b.started.native.worktree,'src/a.mjs'),'export const a=2;\n');await b.finish();
 await assert.rejects(accept(f,b.task),/Integration conflict/);assert.match(await readFile(path.join(b.started.native.worktree,'src/a.mjs'),'utf8'),/a=2/);assert.match(await readFile(path.join(a.started.native.worktree,'src/a.mjs'),'utf8'),/a=1/);assert.match(await readFile(path.join(done.integration.worktree,'src/a.mjs'),'utf8'),/a=1/);assert.notEqual(f.c.getTask(b.task.id).status,'accepted');
});

async function childAt(t,f,action,id){
 const {spawn}=await import('node:child_process'),script=new URL('./fixtures/mosaic-pb14-integration/child.mjs',import.meta.url),child=spawn(process.execPath,[script.pathname,f.root,action,id],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const marker=await new Promise((resolve,reject)=>{let stdout='',stderr='';const timer=setTimeout(()=>reject(Error('Owned integration child did not reach marker: '+stderr)),10000);child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});child.once('exit',(code,signal)=>{clearTimeout(timer);reject(Error(`Owned integration child exited ${code}/${signal}: ${stderr}`));});});
 return {child,marker,kill:async()=>{const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));child.kill('SIGKILL');return exit;}};
}
async function evidence(name,value){await mkdir('.data/portable-beta/14/evidence',{recursive:true});await writeFile('.data/portable-beta/14/evidence/'+name,JSON.stringify(value,null,2)+'\n');}

test('owned dead lock generation recovers while live and malformed ownership fail closed', {timeout:30000},async t=>{
 const f=await fixture(t),g=goal(f,'lock-restart'),owned=await childAt(t,f,'hold-lock',g.id),lockFile=path.join(f.root,'state','integration-repository-locks','artifacts',owned.marker.repositoryId,'lock.json'),before=JSON.parse(await readFile(lockFile,'utf8'));
 await assert.rejects(f.i.lockedGoal(g.id),/runner|owns|locked/i);const exit=await owned.kill(),recovered=await f.i.lockedGoal(g.id),after=JSON.parse(await readFile(lockFile,'utf8'));assert.notEqual(after.token,before.token);assert.equal(after.pid,process.pid);await recovered.release();
 await writeFile(lockFile,'{"pid":null}');await assert.rejects(f.i.lockedGoal(g.id),/Invalid runner lock/);assert.equal(await readFile(lockFile,'utf8'),'{"pid":null}');
 await evidence('integration-lock-generations.json',{before,childExit:exit,after,liveOwnerRejected:true,malformedOwnerRejected:true});
});

test('SIGKILL after combined Git checkpoint recovers exact candidate and repository generation without duplicate acceptance', {timeout:30000},async t=>{
 const f=await fixture(t),g=goal(f,'checkpoint-restart'),a=await candidate(f,g,'a');await a.finish();const before=f.c.getTask(a.task.id);f.c.close();
 const owned=await childAt(t,f,'checkpoint',a.task.id),exit=await owned.kill();const {connect}=await import('./fixtures/mosaic-pb14-integration/fixture.mjs');Object.assign(f,connect(f.root));
 const interrupted=f.c.getTask(a.task.id);assert.equal(interrupted.status,'ready_to_integrate');assert.equal(f.c.getGoal(g.id).integrationPending.taskId,a.task.id);
 const done=await accept(f,a.task,'crash-integrate');assert.equal(done.status,'accepted');assert.equal(done.integration.commit,owned.marker.commit);assert.equal(done.deadline,before.deadline);assert.deepEqual(done.spent,before.spent);assert.equal(done.reviews,before.reviews);
 const replay=await accept(f,a.task,'crash-integrate');assert.deepEqual(replay,done);const events=f.c.store.events(0,1000).filter(e=>e.task_id===a.task.id&&e.type==='task.integrated');assert.equal(events.length,1);
 await evidence('integration-checkpoint-restart.json',{childMarker:owned.marker,childExit:exit,before,interrupted,done,integratedEvents:events});
});

test('owned integration protected check receives shutdown abort signal and preserves pending import', {timeout:30000},async t=>{
 const f=await fixture(t),g=goal(f,'integration-abort'),a=await candidate(f,g,'a');await a.finish();const controller=new AbortController(),entered=Promise.withResolvers();let childPid;
 f.i=new Integration({c:f.c,signal:controller.signal,checksFactory:w=>({verify:async()=>({fixture:true}),run:async(checks,key,signal)=>{
  if(!key.startsWith('integrate-'))return checksFactory()(w).run(checks,key,signal);
  const {command}=await import('../src/project/process.mjs');const pidFile=path.join(f.root,'check.pid');const running=command([process.execPath,'-e',"require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",pidFile],{cwd:w.root,signal});
  for(let n=0;n<100;n++){try{childPid=Number(await readFile(pidFile,'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}assert.ok(childPid);entered.resolve();const result=await running;return [{...result,id:'verify',passed:result.code===0,screenshots:[]}];
 }})});
 const pending=accept(f,a.task).then(value=>({value}),error=>({error}));await entered.promise;controller.abort();const result=await pending;assert.match(result.error?.message??'',/Integrated checks failed/);assert.throws(()=>process.kill(childPid,0),{code:'ESRCH'});assert.notEqual(f.c.getTask(a.task.id).status,'accepted');assert.equal(f.c.getGoal(g.id).integrationPending.taskId,a.task.id);await evidence('integration-check-cleanup.json',{childPid,aborted:controller.signal.aborted,pendingTaskId:f.c.getGoal(g.id).integrationPending.taskId,childGone:true});
});

test('actual cross-goal import check barrier serializes integration and retains both committed changes', {timeout:30000},async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),timeline=[];let held=true;
 const f=await fixture(t,{onRun:async(w,checks,key)=>{if(key.startsWith('integrate-')){timeline.push({event:'entered',key});if(held){held=false;entered.resolve();await release.promise;}timeline.push({event:'released',key});}}}),g=goal(f,'barrier-one'),h=goal(f,'barrier-two'),a=await candidate(f,g,'a'),b=await candidate(f,h,'b');await a.finish();await b.finish();t.after(()=>release.resolve());
 const pending=accept(f,a.task);await entered.promise;await assert.rejects(accept(f,b.task),/runner|owns|locked/i);assert.equal(timeline.filter(e=>e.event==='entered').length,1);assert.equal(f.c.getTask(b.task.id).status,'ready_to_integrate');release.resolve();const first=await pending,second=await accept(f,b.task);assert.equal(first.integration.worktree,second.integration.worktree);assert.match(await readFile(path.join(second.integration.worktree,'src/a.mjs'),'utf8'),/a=1/);assert.match(await readFile(path.join(second.integration.worktree,'src/b.mjs'),'utf8'),/b=1/);
 await evidence('integration-serialized-timeline.json',{timeline,firstCommit:first.integration.commit,combinedCommit:second.integration.commit,target:second.integration.worktree});
});

for(const scope of ['src/','src/*.mjs'])test(`native directory/glob overlap (${scope}) holds until integration`,async t=>{
 const f=await fixture(t),g=goal(f,'glob'),wide=task(f,g,'wide',{scope}),narrow=task(f,g,'narrow',{scope:'src/a.mjs'});await f.i.startNative({taskId:wide.id,layout:'candidate_v1'},'start-wide');await assert.rejects(f.i.startNative({taskId:narrow.id,layout:'candidate_v1'},'start-narrow'),/overlap|write scope/);assert.equal(f.c.getTask(narrow.id).native,undefined);
});

test('legacy native owner without startedAt still fences overlapping autonomous and isolated-native writers',async t=>{
 const f=await fixture(t),g=goal(f,'legacy-writer',{legacy:true}),wide=task(f,g,'wide',{scope:'src/'});await f.i.startNative({taskId:wide.id},'legacy-start');f.c.store.tx(()=>{const saved=f.c.store.get('task',wide.id);delete saved.startedAt;f.c.store.put('task',saved);});
 const h=goal(f,'new-writer'),a=task(f,h,'a',{actor:'deepseek'}),b=task(f,h,'b',{scope:'src/a.mjs'});assert.equal(f.c.claimNext('new-worker'),null);await assert.rejects(f.i.startNative({taskId:b.id,layout:'candidate_v1'},'new-native'),/legacy owner|overlap|write scope/);assert.equal(f.c.getTask(a.id).status,'queued');
});

test('mode mutation during combined checks cannot produce an accepted unchecked commit', {timeout:30000},async t=>{
 const f=await fixture(t,{onRun:async(w,checks,key)=>{if(key.startsWith('integrate-'))await chmod(path.join(w.root,'src/a.mjs'),0o755);}}),g=goal(f,'changed-mode'),a=await candidate(f,g,'a');await a.finish();await assert.rejects(accept(f,a.task),/executable bit changed/i);assert.notEqual(f.c.getTask(a.task.id).status,'accepted');assert.equal(f.c.getGoal(g.id).integrationPending.taskId,a.task.id);assert.equal((await git(a.started.native.worktree,'ls-tree','HEAD','--','src/a.mjs')).split(' ')[0],'100644');
});

test('terminal-looking native writer still reserves scope until explicit host release',async t=>{
 const f=await fixture(t),g=goal(f,'terminal-writer'),native=task(f,g,'native',{scope:'src/a.mjs'});await f.i.startNative({taskId:native.id,layout:'candidate_v1'},'terminal-native');f.c.store.tx(()=>{const saved=f.c.store.get('task',native.id);saved.status='partial';delete saved.startedAt;f.c.store.put('task',saved);});
 const autonomous=task(f,g,'autonomous',{actor:'deepseek',scope:'src/a.mjs'}),other=task(f,g,'other',{scope:'src/a.mjs'});assert.equal(f.c.claimNext('terminal-worker'),null);await assert.rejects(f.i.startNative({taskId:other.id,layout:'candidate_v1'},'terminal-other'),/overlap|write scope/);assert.equal(f.c.getTask(autonomous.id).status,'queued');assert.equal(f.c.getTask(native.id).native.writerActive,true);
});

test('shared combined target binds checked executable mode even without behavioral criteria', {timeout:30000},async t=>{
 const f=await fixture(t),g=goal(f,'checked-mode'),a=await candidate(f,g,'a');await chmod(path.join(a.started.native.worktree,'src/a.mjs'),0o755);await a.finish();await git(f.repo,'config','core.filemode','false');
 await assert.rejects(accept(f,a.task),/core.filemode=false/);assert.notEqual(f.c.getTask(a.task.id).status,'accepted');assert.equal(f.c.getGoal(g.id).integrationPending.taskId,a.task.id);
});

function persistedStage11Goal(f,id,project){
 const prepared=goal(f,id,{project}),saved=f.c.store.get('goal',prepared.id);
 // Older persisted provider-policy records have no reviewPolicy; fresh
 // preparation deliberately cannot select this historical compatibility shape.
 delete saved.manifest.reviewPolicy;delete saved.manifest.reviewPolicyHash;
 return import('../src/harness/contracts.mjs').then(({digest})=>{saved.hash=digest(saved.manifest);f.c.store.put('goal',saved);return f.c.getGoal(saved.id);});
}
for(const historicalFirst of [false,true])test(`persisted stage11 native layout cannot silently share incompatible accepted contracts (${historicalFirst?'historical first':'portable first'})`,{timeout:30000},async t=>{
 const f=await fixture(t,{check:'if(a+b>1)process.exit(1);'});
 const weak={checks:[{id:'verify',argv:[process.execPath,'-e',"import('./src/b.mjs').then(({b})=>{if(b>1)process.exit(1)})"],timeoutMs:10000}]};
 const old=await persistedStage11Goal(f,'stage11',weak),modern=goal(f,'modern');
 if(historicalFirst){
  const b=task(f,old,'b'),native=await f.i.startNative({taskId:b.id},'old-start');await writeFile(path.join(native.native.worktree,'src/b.mjs'),'export const b=1;\n');const done=await f.i.finishNative({taskId:b.id,summary:'Historical checked native result'},'old-finish');assert.equal(done.status,'accepted');
  await assert.rejects(f.i.executionBase(modern.id),/Incompatible independent integration/);assert.match(await readFile(path.join(done.integration.worktree,'src/b.mjs'),'utf8'),/b=1/);assert.equal(f.c.getTask(b.id).status,'accepted');assert.equal(f.c.getGoal(old.id).integration.journalId,undefined);
 }else{
  const a=await candidate(f,modern,'a');await a.finish();const done=await accept(f,a.task),b=task(f,old,'b');await assert.rejects(f.i.startNative({taskId:b.id},'old-after-modern'),/Incompatible independent integration/);assert.equal(f.c.getTask(b.id).native,undefined);assert.match(await readFile(path.join(done.integration.worktree,'src/a.mjs'),'utf8'),/a=1/);assert.equal(f.c.getTask(a.task.id).status,'accepted');
 }
});

test('legacy project reply validator rejects executable mode injection before Workspace applies model edits',async t=>{
 const {validateReply}=await import('../src/project/contracts.mjs'),f=await fixture(t),g=goal(f,'legacy-validator'),target=await f.i.lockedGoal(g.id);
 try{const file='src/a.mjs',before=await target.workspace.content(file),reply={type:'submit_changes',summary:'Untrusted unchanged file',edits:[{path:file,action:'write',baseHash:before.hash,content:before.content,mode:'100755'}]};
  await assert.rejects(async()=>{const approved=validateReply(reply);await target.workspace.apply('legacy-untrusted',{writePaths:['src/']},approved.edits);},/Invalid worker reply|unknown|field/i);assert.equal(await target.workspace.fileMode(file),'100644');assert.equal((await target.workspace.content(file)).hash,before.hash);assert.equal(target.journal.events.some(e=>e.type==='edits.intent'&&e.data.key==='legacy-untrusted'),false);
  const valid=validateReply({...reply,edits:[{path:file,action:'write',baseHash:before.hash,content:'export const a=1;\n'}]});await target.workspace.apply('legacy-valid',{writePaths:['src/']},valid.edits);assert.equal(await target.workspace.fileMode(file),'100644');
 }finally{await target.release();}
});

test('owned approved native generation transfer probe aborts on coordinator shutdown without successful start', {timeout:15000},async t=>{
 const {Goals}=await import('../src/harness/goals.mjs'),{command}=await import('../src/project/process.mjs'),f=await fixture(t),g=goal(f,'rebind-probe'),a=await candidate(f,g,'a');
 f.c.control({taskId:a.task.id,action:'stop'},'rebind-stop');await f.i.releaseNative({taskId:a.task.id,reason:'Fixture host confirms writer ended'},'rebind-release');
 const goals=new Goals(f.c),m=f.c.getGoal(g.id).manifest,raw={submissionId:m.submissionId,objective:m.objective,acceptance:m.acceptance,mode:m.mode.id,modeVersion:m.mode.version,environment:m.environment,project:m.project,providerPolicy:m.providerPolicy,reviewPolicy:m.reviewPolicy,limits:m.limits},revision=goals.prepareRevision({goalId:g.id,expectedHash:f.c.getGoal(g.id).hash,manifest:raw},'rebind-prepare');goals.activateRevision({revisionId:revision.id,hash:revision.hash},'rebind-activate');const before=f.c.getTask(a.task.id),rebound=goals.rebind({taskId:a.task.id,spec:{...before.spec,permissions:{...before.spec.permissions,writePaths:['src/']}}},'rebind-task');assert.ok(rebound.native.needsGeneration);
 const controller=new AbortController(),entered=Promise.withResolvers(),pidFile=path.join(f.root,'rebind-probe.pid');let observedSignal,childPid,processRun,pending;
 t.after(async()=>{controller.abort();if(childPid){try{process.kill(childPid,'SIGKILL');}catch{}}await processRun;await pending;});
 f.i=new Integration({c:f.c,signal:controller.signal,checksFactory:()=>({verify:async signal=>{
  observedSignal=signal;processRun=command([process.execPath,'-e',"require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",pidFile],{signal,timeoutMs:5000});
  for(let n=0;n<200;n++){try{childPid=Number(await readFile(pidFile,'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}assert.ok(childPid);entered.resolve();const result=await processRun;if(signal?.aborted||result.stopped||result.code!==0)throw Error('Native generation probe interrupted');return {fixture:true};
 }})});
 pending=f.i.startNative({taskId:a.task.id,layout:'candidate_v1'},'rebind-probe-start').then(value=>({value}),error=>({error}));await entered.promise;controller.abort();assert.equal(observedSignal,controller.signal);const result=await pending;assert.match(result.error?.message??'',/interrupted/i);assert.throws(()=>process.kill(childPid,0),{code:'ESRCH'});const current=f.c.getTask(a.task.id);assert.equal(current.native.status,'generation_blocked');assert.equal(current.native.writerActive,false);assert.notEqual(current.status,'codex_active');assert.equal(current.deadline,before.deadline);assert.deepEqual(current.spent,before.spent);
 const target=await f.i.candidate(current);await target.journal.load();assert.equal(target.journal.events.some(e=>e.type==='generation.transferred'),false);assert.equal(f.c.store.events(0,1000).some(e=>e.type==='task.native_started'&&e.data.worktree===target.workspace.root),false);await evidence('native-rebind-probe-cleanup.json',{childPid,signalAborted:controller.signal.aborted,childGone:true,status:current.status,nativeStatus:current.native.status,deadline:current.deadline,spent:current.spent,generationTransferred:false});
});

test('checks-only provider-policy goals without review policy retain shared checked target',async t=>{
 const f=await fixture(t),configured=goal(f,'configuration'),m=configured.manifest,ids=[];
 for(const id of ['checks-one','checks-two']){const draft=f.c.preparePortableGoal({submissionId:id,objective:'Checks-only combined work',acceptance:['Protected checks'],mode:'deepseek_only',environment:'fixture',project:m.project,providerPolicy:m.providerPolicy},'prepare-'+id),g=f.c.activateGoal({goalId:draft.id,hash:draft.hash},'activate-'+id);assert.equal(g.manifest.reviewPolicy,undefined);await f.i.executionBase(g.id);ids.push(f.c.getGoal(g.id).integration.journalId);}
 assert.ok(ids[0]);assert.equal(ids[0],ids[1]);
});

test('failed combined import repair restores original executable mode and preserves checked candidate mode', {timeout:30000},async t=>{
 const f=await fixture(t,{check:'if(a+b>1)process.exit(1);'}),g=goal(f,'repair-mode'),a=await candidate(f,g,'a'),b=await candidate(f,g,'b');await chmod(path.join(b.started.native.worktree,'src/b.mjs'),0o755);await a.finish();await b.finish();const first=await accept(f,a.task);await assert.rejects(accept(f,b.task),/Integrated checks failed/);assert.equal((await lstat(path.join(first.integration.worktree,'src/b.mjs'))).mode&0o100,0o100);
 await f.i.repair({taskId:b.task.id,reason:'Restore exact failed content and executable mode preimage'},'repair-mode-failure');assert.equal((await lstat(path.join(first.integration.worktree,'src/b.mjs'))).mode&0o100,0);assert.equal(await readFile(path.join(first.integration.worktree,'src/b.mjs'),'utf8'),'export const b=0;\n');assert.equal((await lstat(path.join(b.started.native.worktree,'src/b.mjs'))).mode&0o100,0o100);assert.equal(f.c.getTask(a.task.id).status,'accepted');
});
