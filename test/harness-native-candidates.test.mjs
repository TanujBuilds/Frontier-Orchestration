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
async function saveReceipt(name,value){if(!process.env.HARNESS_NATIVE_EVIDENCE_DIR)return;await mkdir(process.env.HARNESS_NATIVE_EVIDENCE_DIR,{recursive:true});await writeFile(path.join(process.env.HARNESS_NATIVE_EVIDENCE_DIR,name+'.json'),JSON.stringify(value,null,2));}
const task={submissionId:'code',kind:'coding',objective:'Implement42',acceptance:['Protected check passes']};
const provider=(value=42)=>({complete:async messages=>{const input=JSON.parse(messages.at(-1).content),file=input.files.find(x=>x.path==='src/answer.mjs');return {content:JSON.stringify({type:'submit_changes',paths:[],edits:[{path:file.path,action:'write',baseHash:file.hash,content:`export const answer=${value};\n`}],summary:'Candidate'})};}});

test('candidate_v1 isolates two native writers and separates finish from acceptance',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task,actor:'codex'},'s1'),b=f.c.submitTask({goalId:f.g.id,...task,submissionId:'b',actor:'codex'},'s2');
 const first=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'n1'),second=await f.integration.startNative({taskId:b.id,layout:'candidate_v1'},'n2');
 assert.notEqual(first.native.worktree,second.native.worktree);assert.equal(first.native.baseCommit,second.native.baseCommit);assert.equal(f.c.getGoal(f.g.id).integrationOwner??null,null);
 assert.notEqual(first.native.worktree,f.c.getGoal(f.g.id).integration.worktree);assert.equal(await f.integration.executionBase(f.g.id),first.native.baseCommit);
 await writeFile(path.join(first.native.worktree,'src/answer.mjs'),'export const answer=42;\n');
 const done=await f.integration.finishNative({taskId:a.id,summary:'Checked candidate'},'finish');assert.equal(done.status,'awaiting_review');assert.equal(done.native.writerActive,false);
 assert.equal(await f.integration.executionBase(f.g.id),first.native.baseCommit);
 const accepted=await f.integration.accept({taskId:a.id,feedback:'Reviewed actual diff'},'accept');assert.equal(accepted.status,'accepted');assert.equal(accepted.integration.candidateCommit,done.native.commit);
 assert.equal((await f.integration.accept({taskId:a.id,feedback:'Reviewed actual diff'},'accept')).integration.commit,accepted.integration.commit);
 assert.equal(await f.integration.executionBase(f.g.id),accepted.integration.commit);
});
test('execution base rejects legacy writer, sealed partial and unknown target HEAD',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s'),native=await f.integration.startNative({taskId:a.id},'n');
 await assert.rejects(f.integration.executionBase(f.g.id),/native|owner/i);
 f.c.control({taskId:a.id,action:'stop'},'stop');await f.integration.releaseNative({taskId:a.id,reason:'Confirmed host stopped'},'release');await assert.rejects(f.integration.executionBase(f.g.id),/retired|partial/);
});
test('candidate revisions keep original base and budgets and never dispatch to DeepSeek',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task},'s');const worker=new Worker({...f,provider:provider(7)});await worker.tick();f.c.control({taskId:a.id,action:'stop'},'stop');await worker.tick();
 const first=await f.integration.takeover({taskId:a.id,reason:'Complete correction',layout:'candidate_v1'},'take');
 await writeFile(path.join(first.native.worktree,'src/answer.mjs'),'export const answer=42;\n');const finished=await f.integration.finishNative({taskId:a.id,summary:'Candidate'},'finish');
 const revised=f.c.review({taskId:a.id,decision:'revise',feedback:'Add explanatory comment'},'review');assert.equal(revised.status,'codex_ready');assert.equal(f.c.claimNext('wrong-worker'),null);
 const again=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'restart');assert.equal(again.native.worktree,first.native.worktree);assert.equal(again.native.baseCommit,first.native.baseCommit);assert.equal(again.deadline,first.deadline);assert.deepEqual(again.spent,finished.spent);
 await writeFile(path.join(again.native.worktree,'src/answer.mjs'),'// Explained\nexport const answer=42;\n');const final=await f.integration.finishNative({taskId:a.id,summary:'Revised'},'finish2');assert.notEqual(final.native.commit,finished.native.commit);assert.equal(final.reviews,1);
});
test('candidate release preserves its partial without retiring independent integration',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s'),n=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'n');
 f.c.control({taskId:a.id,action:'stop'},'stop');assert.equal(f.c.getTask(a.id).native.writerActive,true);
 const released=await f.integration.releaseNative({taskId:a.id,reason:'Main host confirmed child interrupted'},'release');assert.equal(released.status,'partial');assert.equal(released.native.writerActive,false);assert.equal(f.c.getGoal(f.g.id).integrationSealed,undefined);assert.equal(await f.integration.executionBase(f.g.id),n.native.baseCommit);
});
test('failed combined check retains integration intent and rejects another candidate or base',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task,actor:'codex'},'submit-a'),b=f.c.submitTask({goalId:f.g.id,...task,actor:'codex',submissionId:'b'},'b');
 for(const [id,key]of [[a.id,'a'],[b.id,'b']]){const n=await f.integration.startNative({taskId:id,layout:'candidate_v1'},'n'+key);await writeFile(path.join(n.native.worktree,'src/answer.mjs'),'export const answer=42;\n');await f.integration.finishNative({taskId:id,summary:'Candidate'},'f'+key);}
 const failing=new Integration({c:f.c,checksFactory:w=>w.root.includes('/integration/')?{verify:async()=>({fixture:true}),run:async()=>[{id:'verify',passed:false}]}:f.checksFactory(w)});
 await assert.rejects(failing.accept({taskId:a.id,feedback:'Reviewed'},'accept-a'),/Integrated checks failed/);assert.equal(f.c.getGoal(f.g.id).integrationPending.taskId,a.id);
 await assert.rejects(f.integration.executionBase(f.g.id),/pending|recover/i);await assert.rejects(f.integration.accept({taskId:b.id,feedback:'Reviewed'},'accept-b'),/pending|another/i);
 assert.throws(()=>new Goals(f.c).finalize({goalId:f.g.id,summary:'Partial',partial:true},'final'),/owners/);
 const recovered=await f.integration.accept({taskId:a.id,feedback:'Reviewed'},'accept-a');assert.equal(recovered.status,'accepted');assert.equal(f.c.getGoal(f.g.id).integrationPending,null);
});
test('execution base rejects unrecorded target commits and dirty or incomplete journal state',async t=>{
 const f=await fixture(t);await f.integration.executionBase(f.g.id);const root=f.c.getGoal(f.g.id).integration.worktree;
 await writeFile(path.join(root,'src/answer.mjs'),'export const answer=2;\n');await assert.rejects(f.integration.executionBase(f.g.id),/outside|changed|uncommitted/);
 await git(root,'add','.');await git(root,'commit','-qm','unrecorded');await assert.rejects(f.integration.executionBase(f.g.id),/HEAD|checkpoint/);
});
test('strict agent registry validates models and progress never authorizes completion',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'submit-a');
 const {Dispatcher}=await import('../src/harness/tools.mjs'),d=new Dispatcher({c:f.c,worker:new Worker({...f}),config:{nativeModels:['supported'],nativeRoleModels:{explorer:'supported'}}});
 const input={version:1,taskId:a.id,hostAgentId:'host-one',role:'implementer',actor:'codex'};
 const agent=await d.invoke('agent_register',{...input,idempotencyKey:'reg'});assert.deepEqual(agent.model,{requested:null,resolved:null});assert.equal(agent.modelSource,'inherited');
 assert.equal((await d.invoke('agent_register',{...input,idempotencyKey:'reg'})).id,agent.id);
 await assert.rejects(d.invoke('agent_register',{...input,version:undefined,idempotencyKey:'missing'}),/Missing|version/);
 await assert.rejects(d.invoke('agent_register',{...input,hostAgentId:'host-two',model:{requested:'unsupported'},idempotencyKey:'bad'}),/unsupported|available/i);
 const report=await d.invoke('agent_report',{version:1,agentId:agent.id,status:'completed',summary:'Host says done',idempotencyKey:'report'});assert.equal(report.lastReport.status,'completed');assert.equal(f.c.getTask(a.id).status,'codex_ready');assert.equal(f.c.getGoal(f.g.id).reviewerRuns.length,0);
 const b=f.c.submitTask({goalId:f.g.id,...task,submissionId:'b'},'b');await assert.rejects(d.invoke('agent_register',{...input,taskId:b.id,idempotencyKey:'duplicate'}),/host|correlation/i);
 const defaulted=await d.invoke('agent_register',{version:1,taskId:b.id,role:'explorer',actor:'codex',idempotencyKey:'default'});assert.equal(defaulted.model.requested,'supported');assert.equal(defaulted.model.resolved,null);
 assert.equal((await d.invoke('agents_list',{goalId:f.g.id})).length,2);
});
test('linked help uses normal task cap, prevents cycles and blocks answer until acceptance',async t=>{
 const f=await fixture(t),parent=f.c.submitTask({goalId:f.g.id,submissionId:'parent',kind:'coding',objective:'Parent',acceptance:['Answer']},'parent');f.c.claimNext('owner');f.c.ask(parent.id,'Need focused help',{phase:'model'},'owner');
 const before=f.c.getTask(parent.id),helper=f.c.submitTask({goalId:f.g.id,submissionId:'helper',kind:'consult',actor:'codex',objective:'Focused help',acceptance:['Evidence']},'helper');
 const {Dispatcher}=await import('../src/harness/tools.mjs'),d=new Dispatcher({c:f.c,worker:new Worker({...f})}),link={version:1,taskId:parent.id,questionId:before.questions[0].id,helperTaskId:helper.id,reason:'Focused analysis'};
 const circular=f.c.submitTask({goalId:f.g.id,submissionId:'circular',kind:'consult',actor:'codex',objective:'Bad helper',acceptance:['Evidence'],dependsOn:[parent.id]},'circular');
 await assert.rejects(d.invoke('help_link',{...link,helperTaskId:circular.id,idempotencyKey:'cycle'}),/cycle|depends/);
 await d.invoke('help_link',{...link,idempotencyKey:'link'});assert.throws(()=>f.c.answer({taskId:parent.id,answer:'Premature',responder:'codex'},'early'),/helper|accepted/);
 f.c.startNativeText({taskId:helper.id},'start-helper');f.c.finishNativeText({taskId:helper.id,content:'Bounded evidence'},'finish-helper');assert.equal(f.c.store.all('help_link')[0].status,'ready');assert.equal(f.c.getTask(parent.id).feedback.at(-1).helperTaskId,helper.id);
 const resumed=f.c.answer({taskId:parent.id,answer:'Use this evidence',responder:'codex'},'answer');assert.equal(resumed.status,'queued');assert.equal(resumed.deadline,before.deadline);assert.deepEqual(resumed.spent,before.spent);assert.equal(resumed.answers[0].helperTaskId,helper.id);assert.equal(f.c.getGoal(f.g.id).tasks.length,3);
});
test('overlapping candidates conflict without poisoning target and can revise same native task',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task,actor:'codex'},'s1'),b=f.c.submitTask({goalId:f.g.id,...task,actor:'codex',submissionId:'b'},'s2');
 for(const [id,label]of [[a.id,'first'],[b.id,'second']]){const n=await f.integration.startNative({taskId:id,layout:'candidate_v1'},'n-'+label);await writeFile(path.join(n.native.worktree,'src/answer.mjs'),`// ${label}\nexport const answer=42;\n`);await f.integration.finishNative({taskId:id,summary:label},'f-'+label);}
 const accepted=await f.integration.accept({taskId:a.id,feedback:'Reviewed first'},'accept-first');await assert.rejects(f.integration.accept({taskId:b.id,feedback:'Reviewed second'},'accept-second'),/conflict/);
 assert.equal(await f.integration.executionBase(f.g.id),accepted.integration.commit);assert.match(await readFile(path.join(accepted.integration.worktree,'src/answer.mjs'),'utf8'),/first/);
 const before=f.c.getTask(b.id),rev=f.c.review({taskId:b.id,decision:'revise',feedback:'Resolve overlap preserving first accepted result'},'rev-overlap');assert.equal(rev.status,'codex_ready');assert.equal(rev.deadline,before.deadline);
});
test('candidate startup is registered before dispatch and refuses implicit legacy migration',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s');const n=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');
 const agents=f.c.store.all('agent');assert.equal(agents.length,1);assert.equal(agents[0].taskId,a.id);assert.equal(n.native.agentId,agents[0].id);assert.equal(agents[0].modelSource,'inherited');
 const b=f.c.submitTask({goalId:f.g.id,...task,submissionId:'b'},'b');await f.integration.startNative({taskId:b.id},'legacy');await assert.rejects(f.integration.startNative({taskId:b.id,layout:'candidate_v1'},'migrate'),/layout/);
});
test('native candidate refuses protected/untracked out-of-scope files and mode/dependency/deadline violations',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task,limits:{seconds:1}},'s'),n=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'n');
 await writeFile(path.join(n.native.worktree,'checks/verify.mjs'),'process.exit(0);\n');await assert.rejects(f.integration.finishNative({taskId:a.id,summary:'Bad'},'bad-check'),/scope/);
 await writeFile(path.join(n.native.worktree,'checks/verify.mjs'),"import {answer} from '../src/answer.mjs';if(answer!==42)process.exit(1);\n");await writeFile(path.join(n.native.worktree,'outside.txt'),'bad');await assert.rejects(f.integration.finishNative({taskId:a.id,summary:'Bad'},'bad-path'),/scope/);await rm(path.join(n.native.worktree,'outside.txt'));
 const b=f.c.submitTask({goalId:f.g.id,...task,submissionId:'b',dependsOn:[a.id]},'b');await assert.rejects(f.integration.startNative({taskId:b.id,layout:'candidate_v1'},'deps'),/Dependencies/);
 f.c.now=()=>n.deadline+1;await assert.rejects(f.integration.finishNative({taskId:a.id,summary:'Late'},'late'),/deadline/);assert.equal(f.c.getTask(a.id).native.writerActive,true);
 const other=await fixture(t,'deepseek_only'),d=other.c.submitTask({goalId:other.g.id,...task},'s');await assert.rejects(other.integration.startNative({taskId:d.id,layout:'candidate_v1'},'forbidden'),/Mode/);
});
test('candidate takeover freezes genuine saved worker edits, not a fabricated checkout',async t=>{
 const f=await fixture(t),a=f.c.submitTask({goalId:f.g.id,...task,limits:{attempts:1}},'s'),worker=new Worker({...f,provider:provider(7)});await worker.drain();const before=f.c.getTask(a.id);
 const n=await f.integration.takeover({taskId:a.id,layout:'candidate_v1',reason:'Repair saved partial'},'take');assert.notEqual(n.native.worktree,n.native.workerWorktree);assert.match(await readFile(path.join(n.native.worktree,'src/answer.mjs'),'utf8'),/answer=7/);assert.deepEqual(n.spent,before.spent);assert.equal(n.attempts,before.attempts);assert.equal(n.deadline,before.deadline);
 await writeFile(path.join(n.native.worktree,'src/answer.mjs'),'export const answer=42;\n');await writeFile(path.join(n.native.workerWorktree,'src/answer.mjs'),'export const answer=99;\n');await assert.rejects(f.integration.finishNative({taskId:a.id,summary:'Changed frozen worker'},'finish'),/Frozen/);
});

async function crashOperation(t,f,{taskId,method,input,key,event,journalKind='native-candidates'}){
 const script=`import {writeSync} from 'node:fs';
 import {Coordinator} from ${JSON.stringify(new URL('../src/harness/coordinator.mjs',import.meta.url).href)};
 import {Integration} from ${JSON.stringify(new URL('../src/harness/integration.mjs',import.meta.url).href)};
 import {Journal} from ${JSON.stringify(new URL('../src/project/journal.mjs',import.meta.url).href)};
 import {command,git} from ${JSON.stringify(new URL('../src/project/process.mjs',import.meta.url).href)};
 const c=new Coordinator({root:process.argv[1]}),args=JSON.parse(process.argv[2]);
 const append=Journal.prototype.append;Journal.prototype.append=async function(type,data){if(this.root.endsWith(args.journalKind)&&type===args.event&&(type!=='operation.completed'||data.key.endsWith('/checkpoint'))){const root=this.dir+'/worktree';writeSync(1,JSON.stringify({head:await git(root,'rev-parse','HEAD'),task:c.getTask(args.taskId),journal:this.file})+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return append.call(this,type,data);};
 const checksFactory=w=>({verify:async()=>({fixture:true}),run:async checks=>Promise.all(checks.map(async check=>{const r=await command(check.argv,{cwd:w.root});return {...r,id:check.id,passed:r.code===0,screenshots:[]};}))});
 await new Integration({c,checksFactory})[args.method](args.input,args.key);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,path.join(f.root,'state'),JSON.stringify({taskId,method,input,key,event,journalKind})],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const checkpoint=await new Promise((resolve,reject)=>{let out='',err='';const timer=setTimeout(()=>reject(Error('Crash boundary timeout: '+err)),15000);child.stderr.on('data',b=>err+=b);child.stdout.on('data',b=>{out+=b;if(out.includes('\n')){clearTimeout(timer);resolve(JSON.parse(out.split('\n')[0]));}});child.on('exit',()=>{clearTimeout(timer);reject(Error('Child ended before crash boundary: '+err));});});
 const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await ended;return checkpoint;
}
for(const boundary of [
 {name:'worktree Git effect before creation journal',method:'startNative',event:'workspace.created'},
 {name:'candidate checks before evidence save',method:'finishNative',event:'native.checks'},
 {name:'candidate Git commit before checkpoint save',method:'finishNative',event:'operation.completed'},
 {name:'imported edits before applied journal save',method:'accept',event:'edits.applied',journalKind:'integration'},
 {name:'target Git commit before checkpoint save',method:'accept',event:'operation.completed',journalKind:'integration'}
])test(`SIGKILL recovery: ${boundary.name}`,async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s');let native;
 if(boundary.method!=='startNative'){native=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');await writeFile(path.join(native.native.worktree,'src/answer.mjs'),'export const answer=42;\n');}
 if(boundary.method==='accept')await f.integration.finishNative({taskId:a.id,summary:'Candidate'},'finish');
 const before=f.c.getTask(a.id),input=boundary.method==='startNative'?{taskId:a.id,layout:'candidate_v1'}:boundary.method==='finishNative'?{taskId:a.id,summary:'Candidate'}:{taskId:a.id,feedback:'Reviewed actual candidate'},key='crash-'+boundary.method;
 const killed=await crashOperation(t,f,{...boundary,taskId:a.id,input,key});
 const after=await f.integration[boundary.method](input,key);assert.equal(after.deadline,killed.task.deadline);assert.deepEqual(after.spent,before.spent);
 if(boundary.event==='operation.completed')assert.equal(boundary.method==='accept'?after.integration.commit:after.native.commit,killed.head);
 const replay=await f.integration[boundary.method](input,key);assert.deepEqual(replay,after);await saveReceipt('crash-'+boundary.method+'-'+boundary.event,{fixture:true,boundary:boundary.name,taskId:a.id,goalId:f.g.id,interruptedHead:killed.head,recoveredCommit:after.integration?.commit??after.native.commit??null,baseCommit:after.native.baseCommit,deadlineBefore:killed.task.deadline,deadlineAfter:after.deadline,spentBefore:before.spent,spentAfter:after.spent,status:after.status});
 if(boundary.method==='startNative'){assert.equal(after.status,'codex_active');assert.equal(after.native.writerActive,true);assert.equal(f.c.store.all('agent').length,1);}
 if(boundary.method==='finishNative'){assert.equal(after.status,'awaiting_review');assert.equal(after.native.writerActive,false);}
 if(boundary.method==='accept'){assert.equal(after.status,'accepted');assert.equal(after.reviews,1);assert.equal(f.c.getGoal(f.g.id).integrationPending,null);}
});

test('two actual native writer processes run beside one DeepSeek fixture with distinct checkouts',async t=>{
 const f=await fixture(t),first=f.c.submitTask({goalId:f.g.id,...task,actor:'codex'},'n1'),second=f.c.submitTask({goalId:f.g.id,...task,actor:'codex',submissionId:'second'},'n2'),local=f.c.submitTask({goalId:f.g.id,...task,submissionId:'local'},'local');
 const natives=[];
 for(const item of [first,second])natives.push(await f.integration.startNative({taskId:item.id,layout:'candidate_v1'},'start-'+item.id));
 let modelStarted,releaseModel;const started=new Promise(r=>modelStarted=r),gate=new Promise(r=>releaseModel=r),fixtureProvider=provider();
 const worker=new Worker({...f,provider:{complete:async messages=>{modelStarted();await gate;return fixtureProvider.complete(messages);}}});await worker.tick();const running=worker.tick();await started;
 assert.equal(f.c.getTask(local.id).status,'running');assert.equal(f.c.claimNext('competing-worker'),null);
 const children=natives.map(n=>spawn(process.execPath,['--input-type=module','-e',"import {writeFile} from 'node:fs/promises';await writeFile('src/answer.mjs','export const answer=42;\\n');console.log('saved');process.stdin.resume();process.stdin.once('data',()=>process.exit(0));"],{cwd:n.native.worktree,stdio:['pipe','pipe','pipe']}));
 t.after(()=>children.forEach(c=>{if(c.exitCode===null)c.kill('SIGKILL');}));await Promise.all(children.map(child=>new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);})));
 const coding=await worker.adapters.coding.open(f.c.getTask(local.id));assert.equal(new Set([...natives.map(n=>n.native.worktree),coding.workspace.root,f.c.getGoal(f.g.id).integration.worktree]).size,4);
 await Promise.all(children.map(child=>new Promise(resolve=>{child.once('exit',resolve);child.stdin.end('host confirms done');})));releaseModel();await running;await worker.drain();
 for(const n of natives)assert.equal((await f.integration.finishNative({taskId:n.id,summary:'Host confirms child exited after write'},'finish-'+n.id)).status,'awaiting_review');
 const inputs=natives.map(n=>({taskId:n.id,feedback:'Reviewed child output and checks'}));
 const attempts=await Promise.allSettled(inputs.map((input,i)=>f.integration.accept(input,'integrate-'+i)));assert.ok(attempts.some(r=>r.status==='fulfilled'));
 for(let i=0;i<inputs.length;i++)await f.integration.accept(inputs[i],'integrate-'+i);
 const done=await f.integration.accept({taskId:local.id,feedback:'Reviewed fixture result'},'integrate-local');assert.equal(done.spent.model,1);assert.equal(done.status,'accepted');assert.equal(f.c.getGoal(f.g.id).reviewerRuns.length,0);
 await saveReceipt('concurrent-writers',{fixture:true,goalId:f.g.id,nativeProcessIds:children.map(c=>c.pid),tasks:[...natives,done].map(n=>{const current=f.c.getTask(n.id);return {id:current.id,deadline:current.deadline,attempts:current.attempts,reviews:current.reviews,spent:current.spent,baseCommit:current.native?.baseCommit??current.checkpoint.executionBase,candidateCommit:current.integration.candidateCommit,integrationCommit:current.integration.commit,candidateWorktree:current.native?.worktree??coding.workspace.root,status:current.status,checks:current.integration.checks.map(c=>({id:c.id,passed:c.passed})),agentId:current.native?.agentId??null};}),integrationWorktree:done.integration.worktree,actualModelHttpRequests:0,nativeTokens:null});
});
test('helper dependency cannot become cyclic through later task rebind',async t=>{
 const f=await fixture(t),parent=f.c.submitTask({goalId:f.g.id,...task},'parent');f.c.claimNext('owner');f.c.ask(parent.id,'Need help',{},'owner');const helper=f.c.submitTask({goalId:f.g.id,submissionId:'helper',kind:'consult',actor:'codex',objective:'Help',acceptance:['Evidence']},'helper');
 const {Agents}=await import('../src/harness/agents.mjs');new Agents({c:f.c}).linkHelp({version:1,taskId:parent.id,questionId:f.c.getTask(parent.id).questions[0].id,helperTaskId:helper.id,reason:'Focused'},'link');
 assert.throws(()=>new Goals(f.c).rebind({taskId:helper.id,spec:{...helper.spec,dependsOn:[parent.id]}},'rebind-cycle'),/cycle/);
});
test('explicit model changes on an existing native candidate are not silently ignored',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s');await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');
 await assert.rejects(f.integration.startNative({taskId:a.id,layout:'candidate_v1',registration:{version:1,taskId:a.id,role:'implementer',actor:'codex',model:{requested:'unavailable'}}},'override'),/conflict|unsupported|available/i);
});
test('native stop report never releases writer ownership or permits partial finalization',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s'),n=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');
 const {Agents}=await import('../src/harness/agents.mjs');new Agents({c:f.c}).report({version:1,agentId:n.native.agentId,status:'stopped',summary:'Reported stop'},'report');f.c.control({taskId:a.id,action:'stop'},'stop');assert.equal(f.c.getTask(a.id).native.writerActive,true);
 assert.throws(()=>new Goals(f.c).finalize({goalId:f.g.id,partial:true,summary:'Partial'},'premature'),/owners/);
 const before=f.c.getTask(a.id);f.c.now=()=>before.deadline+1;await f.integration.releaseNative({taskId:a.id,reason:'Main confirms host process exited'},'release');assert.equal(f.c.getTask(a.id).native.writerActive,false);assert.equal(new Goals(f.c).finalize({goalId:f.g.id,partial:true,summary:'Released partial'},'final').status,'partial');
});
test('busy integration lock leaves asynchronous native start retryable with the same key',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s');await f.integration.executionBase(f.g.id);const target=await f.integration.goalWorkspace(f.g.id),release=await target.journal.lock();
 const {Dispatcher}=await import('../src/harness/tools.mjs'),d=new Dispatcher({c:f.c,worker:new Worker({...f})}),input={taskId:a.id,layout:'candidate_v1',idempotencyKey:'same-start'};
 try{const op=await d.invoke('native_start',input);await d.whenIdle();assert.equal(f.c.store.get('operation',op.id).status,'retryable');}finally{await release();}
 const op=await d.invoke('native_start',input);await d.whenIdle();assert.equal(f.c.store.get('operation',op.id).status,'completed');assert.equal(f.c.getTask(a.id).native.writerActive,true);assert.equal(f.c.store.all('agent').length,1);
});
test('agent and helper operations enforce mode, live question identity, same goal and task caps',async t=>{
 const f=await fixture(t,'deepseek_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s');const {Agents}=await import('../src/harness/agents.mjs'),agents=new Agents({c:f.c});
 assert.throws(()=>agents.register({version:1,taskId:a.id,role:'implementer',actor:'codex'},'wrong-mode'),/Mode/);assert.throws(()=>agents.register({version:1,taskId:'unknown',role:'implementer',actor:'deepseek'},'unknown'),/Unknown|not found/i);
 const c=f.c,g=c.prepareGoal({submissionId:'collab',objective:'Help',acceptance:['Answer'],mode:'collaborative',limits:{maxTasks:2},environment:'fixture',project:f.g.manifest.project},'collab');c.activateGoal({goalId:g.id,hash:g.hash},'activate-collab');
 const parent=c.submitTask({goalId:g.id,...task},'parent');c.control({taskId:a.id,action:'stop'},'stop-old');c.claimNext('owner');c.ask(parent.id,'Need help',{},'owner');const helper=c.submitTask({goalId:g.id,...task,submissionId:'helper',actor:'codex'},'helper');
 const link={version:1,taskId:parent.id,questionId:c.getTask(parent.id).questions[0].id,helperTaskId:helper.id,reason:'Focused'};
 assert.throws(()=>agents.linkHelp({...link,questionId:'wrong-question'},'stale'),/live/);assert.throws(()=>agents.linkHelp({...link,helperTaskId:a.id},'cross'),/stopped|same goal/);
 agents.linkHelp(link,'link');assert.throws(()=>c.submitTask({goalId:g.id,...task,submissionId:'extra'},'extra'),/cap/);const deadline=c.getTask(parent.id).deadline;c.now=()=>deadline+1;assert.throws(()=>c.answer({taskId:parent.id,answer:'Late',responder:'codex'},'late'),/deadline/);assert.equal(c.getTask(parent.id).deadline,deadline);
});
test('native scope validation detects staged renames of protected files before adoption',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s'),n=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');
 await git(n.native.worktree,'mv','checks/verify.mjs','src/copied-check.mjs');const opened=await f.integration.candidate(f.c.getTask(a.id));
 await assert.rejects(f.integration.finishNative({taskId:a.id,summary:'Staged rename'},'finish'),/scope/);
 await opened.journal.load();assert.equal(opened.journal.last('native.adopted'),undefined);
});
test('host can release expired candidate intent when interruption happened before checkout creation',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task,limits:{seconds:1}},'s');const original=f.integration.nativeCandidates.open.bind(f.integration.nativeCandidates);
 f.integration.nativeCandidates.open=async task=>{const candidate=await original(task);candidate.workspace.initialize=async()=>{throw Error('Interrupted before checkout creation');};return candidate;};
 await assert.rejects(f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start'),/Interrupted/);f.integration.nativeCandidates.open=original;const before=f.c.getTask(a.id);assert.equal(before.native.writerActive,true);f.c.now=()=>before.deadline+1;f.c.control({taskId:a.id,action:'stop'},'stop');
 const released=await f.integration.releaseNative({taskId:a.id,reason:'Host confirms no writer was dispatched'},'release');assert.equal(released.status,'partial');assert.equal(released.native.writerActive,false);assert.equal(released.result.savedNative.initialized,false);assert.equal(released.deadline,before.deadline);
});

test('omitted layout cannot migrate an existing native candidate after revision',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s'),n=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');await writeFile(path.join(n.native.worktree,'src/answer.mjs'),'export const answer=42;\n');await f.integration.finishNative({taskId:a.id,summary:'Candidate'},'finish');f.c.review({taskId:a.id,decision:'revise',feedback:'Clarify'},'revise');
 await assert.rejects(f.integration.startNative({taskId:a.id},'omitted'),/layout/);assert.equal(f.c.getTask(a.id).native.worktree,n.native.worktree);assert.equal(f.c.getGoal(f.g.id).integrationOwner??null,null);
});
test('stale native start cannot resurrect an accepted task after execution-base await',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s'),original=f.integration.executionBase.bind(f.integration);let reached,unblock;const atBase=new Promise(r=>reached=r),gate=new Promise(r=>unblock=r);let first=true;
 f.integration.executionBase=async id=>{const base=await original(id);if(first){first=false;reached();await gate;}return base;};
 const slow=f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'slow');const outcome=slow.then(value=>({value}),error=>({error}));await atBase;
 const fast=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'fast');await writeFile(path.join(fast.native.worktree,'src/answer.mjs'),'export const answer=42;\n');await f.integration.finishNative({taskId:a.id,summary:'Done'},'finish');const accepted=await f.integration.accept({taskId:a.id,feedback:'Reviewed'},'accept');unblock();
 const result=await outcome;assert.match(result.error?.message??'',/changed|quiescent|terminal|state/i);assert.deepEqual(f.c.getTask(a.id),accepted);assert.equal(f.c.getTask(a.id).native.writerActive,false);
});
async function combinedFixture(t,limits={}){
 const f=await fixture(t,'codex_only');await writeFile(path.join(f.repo,'src/a.mjs'),'export const a=0;\n');await writeFile(path.join(f.repo,'src/b.mjs'),'export const b=0;\n');await writeFile(path.join(f.repo,'checks/verify.mjs'),"import {a} from '../src/a.mjs';import {b} from '../src/b.mjs';if(a+b>1)process.exit(1);\n");await git(f.repo,'add','.');await git(f.repo,'commit','-qm','combined fixture');
 const g=f.c.prepareGoal({submissionId:'combined',objective:'Combined condition',acceptance:['a+b<=1'],mode:'codex_only',environment:'fixture',project:{...f.g.manifest.project,baseCommit:await git(f.repo,'rev-parse','HEAD')}},'combined');f.c.activateGoal({goalId:g.id,hash:g.hash},'activate-combined');f.g=g;
 const tasks=[];for(const name of ['a','b']){const a=f.c.submitTask({goalId:g.id,...task,submissionId:name,limits},'task-'+name),n=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start-'+name);await writeFile(path.join(n.native.worktree,'src/'+name+'.mjs'),`export const ${name}=1;\n`);tasks.push(await f.integration.finishNative({taskId:a.id,summary:name},'finish-'+name));}
 await f.integration.accept({taskId:tasks[0].id,feedback:'Reviewed a'},'accept-a');await assert.rejects(f.integration.accept({taskId:tasks[1].id,feedback:'Reviewed b'},'accept-b'),/Integrated checks failed/);return {...f,first:tasks[0],second:tasks[1]};
}
test('supervised failed-import repair restores only pending edits and corrects the same native task',async t=>{
 const f=await combinedFixture(t),before=f.c.getTask(f.second.id),head=f.c.getTask(f.first.id).integration.commit;
 const repaired=await f.integration.repair({taskId:before.id,reason:'Correct deterministic combined check failure'},'repair');assert.equal(repaired.status,'codex_ready');assert.equal(repaired.reviews,before.reviews);assert.equal(repaired.deadline,before.deadline);assert.deepEqual(repaired.spent,before.spent);assert.equal(await f.integration.executionBase(f.g.id),head);assert.equal(f.c.getGoal(f.g.id).integrationPending,null);assert.equal(repaired.integrationFailures.length,1);
 assert.match(await readFile(path.join(f.c.getGoal(f.g.id).integration.worktree,'src/b.mjs'),'utf8'),/b=0/);assert.match(await readFile(path.join(f.c.getGoal(f.g.id).integration.worktree,'src/a.mjs'),'utf8'),/a=1/);
 const n=await f.integration.startNative({taskId:before.id,layout:'candidate_v1'},'correct');await writeFile(path.join(n.native.worktree,'src/b.mjs'),'export const b=0;\n');await f.integration.finishNative({taskId:n.id,summary:'Corrected b'},'correct-finish');const accepted=await f.integration.accept({taskId:n.id,feedback:'Reviewed corrected candidate'},'correct-accept');assert.equal(accepted.status,'accepted');assert.equal(accepted.reviews,2);assert.equal(accepted.deadline,before.deadline);assert.deepEqual(accepted.spent,before.spent);
});
test('failed-import repair rejects unjournaled target modifications and retains ownership',async t=>{
 const f=await combinedFixture(t),target=f.c.getGoal(f.g.id).integration.worktree;await writeFile(path.join(target,'src/a.mjs'),'export const a=99;\n');await assert.rejects(f.integration.repair({taskId:f.second.id,reason:'Do not discard external edits'},'repair'),/changed|snapshot|preimage/);assert.equal(f.c.getGoal(f.g.id).integrationPending.taskId,f.second.id);assert.match(await readFile(path.join(target,'src/a.mjs'),'utf8'),/99/);
});
function approvedNativeRebind(f,taskId,project,permissions,key){
 const goals=new Goals(f.c),g=f.c.getGoal(f.g.id),revision=goals.prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:{submissionId:g.manifest.submissionId,objective:g.manifest.objective,acceptance:g.manifest.acceptance,mode:g.manifest.mode.id,environment:'fixture',project}},'prepare-'+key);goals.activateRevision({revisionId:revision.id,hash:revision.hash},'activate-'+key);const before=f.c.getTask(taskId);return goals.rebind({taskId,spec:{...before.spec,permissions}},'rebind-'+key);
}
test('approved scope widening creates a new generation with frozen old candidate and original limits',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task,permissions:{readPaths:['src/answer.mjs','checks/'],writePaths:['src/answer.mjs'],checks:['verify']}},'s'),old=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');await writeFile(path.join(old.native.worktree,'src/answer.mjs'),'export const answer=42;\n');const done=await f.integration.finishNative({taskId:a.id,summary:'Candidate'},'finish');
 const rebound=approvedNativeRebind(f,a.id,f.g.manifest.project,{readPaths:['src/','checks/'],writePaths:['src/'],checks:['verify']},'wide');assert.equal(rebound.status,'codex_ready');assert.equal(rebound.result,null);assert.ok(rebound.native.needsGeneration);assert.equal(rebound.nativeGenerations.length,1);
 const next=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'new-generation');assert.notEqual(next.native.worktree,old.native.worktree);assert.equal(next.native.generation,2);assert.equal(next.native.baseCommit,await f.integration.executionBase(f.g.id));assert.equal(next.deadline,done.deadline);assert.deepEqual(next.spent,done.spent);assert.equal(next.reviews,done.reviews);assert.equal(await git(old.native.worktree,'rev-parse','HEAD'),done.native.commit);assert.match(await readFile(path.join(next.native.worktree,'src/answer.mjs'),'utf8'),/42/);
 await writeFile(path.join(next.native.worktree,'src/new.mjs'),'export const extra=true;\n');await f.integration.finishNative({taskId:a.id,summary:'Wider candidate'},'finish-new');assert.equal((await f.integration.accept({taskId:a.id,feedback:'Reviewed new scope'},'accept-new')).status,'accepted');
});
test('approved scope narrowing and check change reverify new manifest without mutating frozen source',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s'),old=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');await writeFile(path.join(old.native.worktree,'src/answer.mjs'),'export const answer=42;\n');const done=await f.integration.finishNative({taskId:a.id,summary:'Candidate'},'finish');
 const project={...f.g.manifest.project,readPaths:['src/answer.mjs','checks/'],writePaths:['src/answer.mjs'],checks:[...f.g.manifest.project.checks,{id:'second',argv:[process.execPath,'checks/verify.mjs']}]};approvedNativeRebind(f,a.id,project,{readPaths:project.readPaths,writePaths:project.writePaths,checks:['verify','second']},'narrow');
 let probes=0;f.integration.checksFactory=w=>{const runner=f.checksFactory(w);return {...runner,verify:async()=>{probes++;assert.equal(w.manifest.permissions.checks.length,2);return {fixture:true};}};};
 const next=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'new-generation');assert.equal(probes,1);assert.notEqual(next.native.worktree,old.native.worktree);assert.equal(await git(old.native.worktree,'rev-parse','HEAD'),done.native.commit);assert.equal(next.deadline,done.deadline);
});
test('new generation rejects old edits outside narrowed approval and retains frozen evidence',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task},'s'),old=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');await writeFile(path.join(old.native.worktree,'src/answer.mjs'),'export const answer=42;\n');await writeFile(path.join(old.native.worktree,'src/extra.mjs'),'export const extra=1;\n');const done=await f.integration.finishNative({taskId:a.id,summary:'Candidate'},'finish');
 const project={...f.g.manifest.project,readPaths:['src/','checks/'],writePaths:['src/answer.mjs']};approvedNativeRebind(f,a.id,project,{readPaths:project.readPaths,writePaths:project.writePaths,checks:['verify']},'narrow');await assert.rejects(f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'new-generation'),/scope/);assert.equal(await git(old.native.worktree,'rev-parse','HEAD'),done.native.commit);assert.equal(f.c.getTask(a.id).deadline,done.deadline);assert.deepEqual(f.c.getTask(a.id).spent,done.spent);
});
for(const event of ['integration.repair.intent','edits.applied','integration.repaired'])test(`SIGKILL failed-import rollback recovery at ${event}`,async t=>{
 const f=await combinedFixture(t),before=f.c.getTask(f.second.id),input={taskId:before.id,reason:'Supervised combined failure repair'},key='repair-crash';
 await crashOperation(t,f,{taskId:before.id,method:'repair',input,key,event,journalKind:'integration'});const repaired=await f.integration.repair(input,key);assert.equal(repaired.status,'codex_ready');assert.equal(repaired.reviews,before.reviews);assert.equal(repaired.deadline,before.deadline);assert.deepEqual(repaired.spent,before.spent);assert.equal(repaired.integrationFailures.length,1);assert.equal(await f.integration.executionBase(f.g.id),f.c.getTask(f.first.id).integration.commit);assert.deepEqual(await f.integration.repair(input,key),repaired);
});
test('repair with exhausted review budget restores target but cannot refresh task execution',async t=>{
 const f=await combinedFixture(t,{reviews:1}),before=f.c.getTask(f.second.id),after=await f.integration.repair({taskId:before.id,reason:'Preserve exhausted correction'},'repair');assert.equal(after.status,'blocked');assert.equal(after.reviews,1);assert.equal(after.deadline,before.deadline);assert.deepEqual(after.spent,before.spent);assert.equal(f.c.getGoal(f.g.id).integrationPending,null);await assert.rejects(f.integration.startNative({taskId:before.id,layout:'candidate_v1'},'restart'),/budget/);
});
for(const event of ['workspace.created','edits.applied','generation.transferred'])test(`SIGKILL approved generation recovers pinned intent at ${event}`,async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task,permissions:{readPaths:['src/answer.mjs','checks/'],writePaths:['src/answer.mjs'],checks:['verify']}},'s'),old=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');await writeFile(path.join(old.native.worktree,'src/answer.mjs'),'export const answer=42;\n');const done=await f.integration.finishNative({taskId:a.id,summary:'Old candidate'},'finish');
 const rebound=approvedNativeRebind(f,a.id,f.g.manifest.project,{readPaths:['src/','checks/'],writePaths:['src/'],checks:['verify']},'wide'),generationId=rebound.native.needsGeneration.id,input={taskId:a.id,layout:'candidate_v1'},key='generation-crash';await crashOperation(t,f,{taskId:a.id,method:'startNative',input,key,event});
 const recovered=await f.integration.startNative(input,key);assert.equal(recovered.native.generationId,generationId);assert.equal(recovered.deadline,done.deadline);assert.deepEqual(recovered.spent,done.spent);assert.equal(recovered.reviews,done.reviews);assert.notEqual(recovered.native.worktree,old.native.worktree);assert.equal(await git(old.native.worktree,'rev-parse','HEAD'),done.native.commit);assert.match(await readFile(path.join(recovered.native.worktree,'src/answer.mjs'),'utf8'),/42/);assert.deepEqual(await f.integration.startNative(input,key),recovered);
});
test('approved generation preimage conflict never overwrites newer accepted integration',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task,permissions:{readPaths:['src/answer.mjs','checks/'],writePaths:['src/answer.mjs'],checks:['verify']}},'s'),old=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');await writeFile(path.join(old.native.worktree,'src/answer.mjs'),'export const answer=42;\n');const done=await f.integration.finishNative({taskId:a.id,summary:'Old candidate'},'finish');
 const other=f.c.submitTask({goalId:f.g.id,...task,submissionId:'other'},'other'),n=await f.integration.startNative({taskId:other.id,layout:'candidate_v1'},'start-other');await writeFile(path.join(n.native.worktree,'src/answer.mjs'),'// accepted other\nexport const answer=42;\n');await f.integration.finishNative({taskId:other.id,summary:'Other'},'finish-other');const accepted=await f.integration.accept({taskId:other.id,feedback:'Reviewed other'},'accept-other');
 approvedNativeRebind(f,a.id,f.g.manifest.project,{readPaths:['src/','checks/'],writePaths:['src/'],checks:['verify']},'wide');await assert.rejects(f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'conflict'),/conflict/);assert.equal(f.c.getTask(a.id).native.baseCommit,accepted.integration.commit);assert.equal(f.c.getTask(a.id).status,'blocked');assert.equal(await f.integration.executionBase(f.g.id),accepted.integration.commit);assert.equal(await git(old.native.worktree,'rev-parse','HEAD'),done.native.commit);
});
test('unapproved and wrong-mode generation rebind cannot change original native task',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task,permissions:{readPaths:['src/answer.mjs','checks/'],writePaths:['src/answer.mjs'],checks:['verify']}},'s'),n=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');await writeFile(path.join(n.native.worktree,'src/answer.mjs'),'export const answer=42;\n');await f.integration.finishNative({taskId:a.id,summary:'Done'},'finish');const before=f.c.getTask(a.id),goals=new Goals(f.c);
 assert.throws(()=>goals.rebind({taskId:a.id,spec:{...before.spec,permissions:{readPaths:['src/','checks/'],writePaths:['src/'],checks:['verify']}}},'unapproved'),/approved goal version/);assert.deepEqual(f.c.getTask(a.id),before);
 const revision=goals.prepareRevision({goalId:f.g.id,expectedHash:f.g.hash,manifest:{submissionId:'g',objective:'DeepSeek only',acceptance:['Checks'],mode:'deepseek_only',environment:'fixture',project:f.g.manifest.project}},'mode');goals.activateRevision({revisionId:revision.id,hash:revision.hash},'activate-mode');assert.throws(()=>goals.rebind({taskId:a.id},'wrong-mode'),/Mode/);assert.deepEqual(f.c.getTask(a.id),before);
});
test('stale native finish cannot finalize a newer approved generation',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task,permissions:{readPaths:['src/answer.mjs','checks/'],writePaths:['src/answer.mjs'],checks:['verify']}},'s'),n=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');await writeFile(path.join(n.native.worktree,'src/answer.mjs'),'export const answer=42;\n');
 const original=f.integration.nativeCandidates.open.bind(f.integration.nativeCandidates);let reached,resume,first=true;const ready=new Promise(r=>reached=r),gate=new Promise(r=>resume=r);f.integration.nativeCandidates.open=async task=>{const opened=await original(task);if(first){first=false;reached();await gate;}return opened;};const slow=f.integration.finishNative({taskId:a.id,summary:'Old slow finish'},'slow-finish').then(value=>({value}),error=>({error}));await ready;
 await f.integration.finishNative({taskId:a.id,summary:'Current finish'},'finish');approvedNativeRebind(f,a.id,f.g.manifest.project,{readPaths:['src/','checks/'],writePaths:['src/'],checks:['verify']},'wide');const next=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'new-start');resume();assert.match((await slow).error?.message??'',/changed|generation|ownership/);assert.deepEqual(f.c.getTask(a.id),next);
});
test('stale integration cannot accept a newer active native generation',async t=>{
 const f=await fixture(t,'codex_only'),a=f.c.submitTask({goalId:f.g.id,...task,permissions:{readPaths:['src/answer.mjs','checks/'],writePaths:['src/answer.mjs'],checks:['verify']}},'s'),n=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'start');await writeFile(path.join(n.native.worktree,'src/answer.mjs'),'export const answer=42;\n');await f.integration.finishNative({taskId:a.id,summary:'Finished'},'finish');f.c.review({taskId:a.id,decision:'accept',feedback:'Reviewed'},'review');
 const original=f.integration.candidate.bind(f.integration);let reached,resume,first=true;const ready=new Promise(r=>reached=r),gate=new Promise(r=>resume=r);f.integration.candidate=async task=>{const opened=await original(task);if(first){first=false;reached();await gate;}return opened;};const slow=f.integration.accept({taskId:a.id,feedback:'Old accept'},'slow-accept').then(value=>({value}),error=>({error}));await ready;
 approvedNativeRebind(f,a.id,f.g.manifest.project,{readPaths:['src/','checks/'],writePaths:['src/'],checks:['verify']},'wide');const next=await f.integration.startNative({taskId:a.id,layout:'candidate_v1'},'new-start');resume();assert.match((await slow).error?.message??'',/changed|generation|ready/);assert.deepEqual(f.c.getTask(a.id),next);
});
