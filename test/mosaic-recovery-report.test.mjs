import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {digest} from '../src/harness/contracts.mjs';
import {OvernightLifecycle} from '../src/harness/overnight-lifecycle.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {Journal} from '../src/project/journal.mjs';

const start=Date.UTC(2026,10,10,0);
const project={
 repo:'/tmp/mosaic-report-fixture',
 baseCommit:'a'.repeat(40),
 readPaths:['src/','checks/'],
 writePaths:['src/'],
 checks:[{id:'starter',argv:['node','checks/starter.mjs']},{id:'unit',argv:['node','checks/unit.mjs']},{id:'final',argv:['node','checks/final.mjs']}],
};
const power={sync(){},close(){}};

async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-recovery-report-'));
 let at=start,c;
 const reopen=()=>{
  c?.close();
  c=new Coordinator({root,now:()=>at});
  return c;
 };
 reopen();
 t.after(async()=>{c.close();await rm(root,{force:true,recursive:true});});
 const goal=c.prepareGoal({
  submissionId:'report-fixture',objective:'Staged recovery report',acceptance:['Protected checks pass'],
  mode:'overnight_review',environment:'fixture',project,
  overnightPolicy:{preflightCheckIds:['starter'],finalOnlyCheckIds:['final']},
 },'prepare');
 // The fixture begins after activation. Report-only tests do not invoke the preflight.
 Object.assign(goal,{status:'active',activatedAt:at,deadline:at+8*3600000});
 c.store.put('goal',goal);
 const submit=(id,dependsOn=[])=>c.submitTask({
  goalId:goal.id,submissionId:id.toLowerCase().replaceAll(' ','-'),kind:'coding',role:'implementation',objective:id,acceptance:['Fixture stage checks pass'],
  dependsOn,permissions:{readPaths:project.readPaths,writePaths:['src/'],checks:['unit']},
 },'submit-'+id.toLowerCase().replaceAll(' ','-'));
 const readReport=async()=>{
  const run=c.store.get('overnight_run',goal.id);
  return {run,report:JSON.parse(await readFile(run.reportPath,'utf8')),markdown:await readFile(run.markdownPath,'utf8')};
 };
 return {root,goal,get c(){return c;},at:()=>at,setTime:value=>{at=value;},reopen,submit,readReport,
  monitor:(notify=async()=>({fixture:true}))=>new OvernightLifecycle({c,notify,power})};
}

test('report rebuilds the first historical blocker before expiry, even when its question was answered before the first monitor tick',async t=>{
 const f=await fixture(t),task=f.submit('Stage');
 f.c.claimNext('worker');
 f.c.beginAttempt(task.id,'worker');
 const checkpoint={phase:'model',attempt:1,exchange:0};
 const request=f.c.reserve(task.id,{kind:'model',key:'code-1-0'},'worker');
 f.c.saveRequest(request.id,{content:'fixture-only response'});
 f.setTime(start+1000);
 const waiting=f.c.ask(task.id,'Which fixture limit should apply?',checkpoint,'worker');
 f.c.answer({taskId:task.id,responder:'user',answer:'Use the approved limit.'},'answer');
 f.setTime(start+2000);
 f.c.claimNext('worker');
 f.c.reserve(task.id,{kind:'model',key:'code-1-1'},'worker');
 f.c.markUncertain(task.id,'Response stream closed before a terminal result','worker');

 f.setTime(f.goal.deadline);
 await f.monitor().tick();
 const {run,report,markdown}=await f.readReport();
 assert.equal(run.phase,'expired');
 assert.equal(report.recovery.code,'goal_deadline_expired');
 assert.equal(report.recovery.outcome,'unknown');
 assert.match(report.recovery.nextStep.instruction,/new.*authoriz|authoriz.*new/i);
 assert.equal(report.firstBlocker.at,start+1000);
 assert.equal(report.firstBlocker.taskId,task.id);
 assert.equal(report.firstBlocker.questionId,waiting.questions.at(-1).id);
 assert.match(report.firstBlocker.reason,/answer/i);
 assert.match(markdown,/Current reason.*deadline/i);
 assert.match(markdown,/First blocker.*answer/i);
 assert.doesNotMatch(markdown,/Use the approved limit/);

 const saved=report.firstBlocker;
 f.reopen();
 await f.monitor().tick();
 assert.deepEqual((await f.readReport()).report.firstBlocker,saved);
});

test('first reviewer blocker preserves saved feedback when the event clock advances after the feedback timestamp',async t=>{
 const f=await fixture(t),task=f.submit('Independent review');
 let clock=start+1000;
 f.c.now=()=>clock++;
 const feedback='The protected check misses the empty-data case';
 f.c.store.tx(()=>{
  const current=f.c.getTask(task.id);
  current.status='blocked';
  current.reviews=1;
  current.legacyDecision={decision:'blocked',feedback};
  current.feedback.push({kind:'legacy_review',decision:'blocked',text:feedback,at:f.c.now()});
  f.c.store.put('task',current);
  f.c.emit('task.legacy_reviewed',f.goal.id,task.id,{decision:'blocked',unverified:[]});
 });
 clock=f.goal.deadline;
 await f.monitor().tick();
 const {report}=await f.readReport();
 assert.equal(report.result,'expired');
 assert.equal(report.firstBlocker.reason,feedback);
 assert.equal(report.firstBlocker.at,start+1001);
});

test('report retains a passing integration and a saved response while it points to the exact unanswered question',async t=>{
 const f=await fixture(t),prior=f.submit('Integrated'),next=f.submit('Waiting',[prior.id]);
 const commit='b'.repeat(40),checks=[{id:'unit',passed:true}];
 const integrated={...f.c.getTask(prior.id),status:'accepted',integration:{commit,checks,review:'codex_legacy'}};
 f.c.store.tx(()=>{f.c.store.put('task',integrated);f.c.emit('task.integrated',f.goal.id,prior.id,integrated.integration);});
 f.setTime(start+1000);
 f.c.claimNext('worker');
 f.c.beginAttempt(next.id,'worker');
 const request=f.c.reserve(next.id,{kind:'model',key:'code-1-0'},'worker');
 f.c.saveRequest(request.id,{content:'sensitive fixture response, never added to the report'});
 const waiting=f.c.ask(next.id,'Choose within the approved scope.',{phase:'model',attempt:1,exchange:1,requestId:request.id},'worker');

 await f.monitor().tick();
 const {report,markdown}=await f.readReport();
 assert.equal(report.result,'waiting-answer');
 assert.equal(report.recovery.code,'owner_answer_required');
 assert.equal(report.recovery.taskId,next.id);
 assert.equal(report.recovery.questionId,waiting.questions.at(-1).id);
 assert.equal(report.recovery.nextStep.tool,'question_answer');
 assert.deepEqual(report.retainedProgress.integratedStages,[{taskId:prior.id,commit}]);
 assert.equal(report.retainedProgress.lastVerifiedCheckpoint.kind,'response_saved');
 assert.equal(report.retainedProgress.lastVerifiedCheckpoint.requestId,request.id);
 assert.equal(report.tasks.find(task=>task.id===next.id).spent.model,1);
 assert.equal(report.tasks.find(task=>task.id===prior.id).checks[0].passed,true);
 assert.match(markdown,new RegExp(commit));
 assert.doesNotMatch(JSON.stringify(report),/sensitive fixture response/);
});

test('provider waiting distinguishes known non-dispatch, reconnect exhaustion and an unknown dispatched response',async t=>{
 const f=await fixture(t),task=f.submit('Provider stage');
 f.c.claimNext('worker');
 f.c.boundary(task.id,{phase:'model',attempt:1,exchange:0},'worker');
 let calls=0;
 const worker=new Worker({c:f.c,config:{environment:'fixture'},owner:'worker',provider:{complete:async()=>{
  calls++;
  throw Object.assign(Error('Fixture provider unavailable before dispatch'),{requestOutcome:'not_dispatched'});
 }}});
 await assert.rejects(worker.model(task,'worker','code-1-0',[]),/unavailable/);
 const wait=f.c.getTask(task.id).providerWait;
 await f.monitor().tick();
 let {report}=await f.readReport();
 assert.equal(report.recovery.code,'provider_unavailable');
 assert.equal(report.recovery.outcome,'not_dispatched');
 assert.equal(report.recovery.reconnectUntil,wait.until);
 assert.equal(report.recovery.nextStep.tool,null);
 assert.match(report.recovery.nextStep.instruction,/automatic.*reconnect|reconnect.*automatic/i);
 assert.equal(report.firstBlocker.phase,'implementation');

 f.setTime(wait.until);
 await worker.executeTick();
 await f.monitor().tick();
 ({report}=await f.readReport());
 assert.equal(report.recovery.code,'provider_reconnect_expired');
 assert.match(report.recovery.nextStep.instruction,/new.*authoriz|authoriz.*new/i);
 assert.equal(report.firstBlocker.at,wait.startedAt);
 assert.equal(calls,1);

 const other=await fixture(t),unknown=other.submit('Ambiguous stage');
 const claim=other.c.claimNext('worker');
 const request=other.c.reserve(unknown.id,{kind:'model',key:'code-1-0'},'worker');
 other.c.markUncertain(unknown.id,'Transport timeout without terminal response','worker');
 await other.monitor().tick();
 ({report}=await other.readReport());
 assert.equal(report.recovery.code,'request_outcome_unknown');
 assert.equal(report.recovery.outcome,'unknown');
 assert.equal(report.recovery.requestId,request.id);
 assert.equal(report.tasks[0].spent.model,1);
 assert.match(report.recovery.nextStep.instruction,/reconcile|verify/i);
 assert.doesNotMatch(report.recovery.nextStep.instruction,/automatic.*reconnect/i);

 other.setTime(claim.deadline);
 await other.monitor().tick();
 ({report}=await other.readReport());
 assert.equal(report.recovery.code,'task_deadline_expired');
 assert.equal(report.recovery.outcome,'unknown');
 assert.equal(report.recovery.requestId,request.id);
});

test('paused planner with a saved response reports the owner control instead of an ambiguous inference',async t=>{
 const f=await fixture(t),requestId='fixture-planning-request';
 f.c.control({goalId:f.goal.id,action:'pause'},'pause');
 f.c.store.tx(()=>{
  f.c.store.put('planning',{id:f.goal.id,goalId:f.goal.id,attempt:1,status:'uncertain',recoveryPending:true,
   reason:'Saved planning response retained while the goal is paused'});
  f.c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(requestId,f.goal.id,'plan-1','model','completed',
   JSON.stringify({savedAt:f.at(),result:{content:'fixture plan'}}));
 });
 await f.monitor(async()=>assert.fail('An explicit pause must not emit a blocker alert')).tick();
 const {report}=await f.readReport();
 assert.equal(report.result,'paused');
 assert.equal(report.recovery.code,'paused');
 assert.equal(report.recovery.outcome,null);
 assert.equal(report.recovery.nextStep.tool,'work_control');
 assert.equal(report.firstBlocker,null);
 assert.equal(report.retainedProgress.lastVerifiedCheckpoint.requestId,requestId);
 assert.deepEqual(f.c.store.all('notification'),[]);
});

test('task deadline closes an unanswered question while the original goal still has time',async t=>{
 const f=await fixture(t),task=f.submit('Wait for a decision');
 const claimed=f.c.claimNext('worker');
 f.c.ask(task.id,'Which fixture option?',{phase:'model'},'worker');
 f.setTime(claimed.deadline);
 f.c.expireQuiescent();
 await f.monitor().tick();
 const {report}=await f.readReport();
 assert.equal(report.recovery.code,'task_deadline_expired');
 assert.equal(report.recovery.deadline,claimed.deadline);
 assert.equal(report.recovery.taskId,task.id);
 assert.equal(report.firstBlocker.phase,'waiting-answer');
 assert.ok(f.at()<f.goal.deadline);
 assert.notEqual(report.recovery.nextStep.tool,'question_answer');
});

test('last verified checkpoint uses the durable edit and check receipts when activity capture was interrupted',async t=>{
 const f=await fixture(t),task=f.submit('Saved journal receipt');
 f.c.claimNext('worker');
 f.c.beginAttempt(task.id,'worker');
 f.c.boundary(task.id,{phase:'apply',attempt:1,batch:0,exchange:0},'worker');
 const journal=await new Journal(path.join(f.root,'coding'),task.id).load();
 await journal.append('edits.applied',{key:task.id+'/attempt-1/batch-0',snapshot:{'src/a.mjs':'fixture hash'}});
 await f.monitor().tick();
 let {report}=await f.readReport();
 assert.equal(report.retainedProgress.lastVerifiedCheckpoint.kind,'edits_saved');
 assert.equal(report.retainedProgress.lastVerifiedCheckpoint.source,'journal');
 assert.equal(report.tasks[0].evidence.journalRoot,journal.root);

 f.c.boundary(task.id,{phase:'checks',attempt:1,batch:1,exchange:1},'worker');
 f.c.emit('coding.checks.failed',f.goal.id,task.id,{outcome:'error'});
 await f.monitor().tick();
 ({report}=await f.readReport());
 assert.notEqual(report.retainedProgress.lastVerifiedCheckpoint.kind,'checks_saved');
 await journal.append('operation.completed',{key:'harness-attempt-1/checks',value:[{id:'unit',passed:true,output:'fixture-only raw check output'}]});
 f.c.markUncertain(task.id,'Coordinator interrupted after check persistence','worker');
 f.reopen();
 await f.monitor().tick();
 ({report}=await f.readReport());
 assert.equal(report.retainedProgress.lastVerifiedCheckpoint.kind,'checks_saved');
 assert.deepEqual(report.retainedProgress.lastVerifiedCheckpoint.checks,[{id:'unit',passed:true}]);
 assert.doesNotMatch(JSON.stringify(report),/fixture-only raw check output/);
 assert.equal(report.recovery.code,'execution_uncertain');
 assert.equal(report.recovery.outcome,null);
});

test('an interrupted background review is spent and remains a distinct unknown request',async t=>{
 const f=await fixture(t),task=f.submit('Interrupted review');
 const requestId='fixture-review-request',key='legacy-review-1';
 f.c.store.tx(()=>{
  f.c.store.put('task',{...f.c.getTask(task.id),status:'blocked',reviews:1,checkpoint:{legacyReviewKey:key},
   reason:'Interrupted Codex review remains spent; operator reconciliation required'});
  f.c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(requestId,task.id,key,'codexReview','reserved','{}');
 });
 await f.monitor().tick();
 const {report}=await f.readReport();
 assert.equal(report.recovery.code,'request_outcome_unknown');
 assert.equal(report.recovery.outcome,'unknown');
 assert.equal(report.recovery.requestId,requestId);
 assert.equal(report.recovery.requestKind,'codexReview');
 assert.equal(report.tasks[0].spent.codexReview,1);
 assert.match(report.recovery.nextStep.instruction,/reconcile/i);
});

test('report restart repairs an incomplete publication and preserves a fully committed report with a reserved alert', {timeout:10000},async t=>{
 const f=await fixture(t),task=f.submit('Durable blocker');
 f.c.claimNext('worker');
 f.c.reserve(task.id,{kind:'model',key:'code-1-0'},'worker');
 f.c.markUncertain(task.id,'Reserved response is unresolved','worker');
 const moduleUrl=file=>new URL('../src/harness/'+file,import.meta.url).href;
 async function crashAt(boundary){
  const script=`
   import fs from 'node:fs/promises';
   import {syncBuiltinESMExports} from 'node:module';
   const boundary=process.argv[1],root=process.argv[2],at=Number(process.argv[3]);
   const barrier=async()=>{process.send(boundary);await new Promise(()=>{});};
   if(boundary==='json-renamed'){
    const rename=fs.rename;
    fs.rename=async(from,to)=>{await rename(from,to);if(to.endsWith('/report.json'))await barrier();};
    syncBuiltinESMExports();
   }
   const {Coordinator}=await import(${JSON.stringify(moduleUrl('coordinator.mjs'))});
   const {OvernightLifecycle}=await import(${JSON.stringify(moduleUrl('overnight-lifecycle.mjs'))});
   const c=new Coordinator({root,now:()=>at});
   await new OvernightLifecycle({c,power:{sync(){},close(){}},notify:barrier}).tick();
   process.exit(3);
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',script,boundary,f.root,String(f.at())],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';
  child.stderr.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;});
  const exit=once(child,'exit');
  try{
   const reached=await Promise.race([once(child,'message',{signal:AbortSignal.timeout(4000)}),exit.then(result=>['exit',result,stderr])]);
   assert.equal(reached[0],boundary,JSON.stringify(reached));
   assert.equal(child.kill('SIGKILL'),true);
   assert.deepEqual(await exit,[null,'SIGKILL']);
  }finally{
   if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
   await exit;
  }
 }

 await crashAt('json-renamed');
 assert.equal(f.c.store.maybe('overnight_run',f.goal.id),null);
 const reportDir=path.join(f.root,'overnight-reports',f.goal.id);
 await stat(path.join(reportDir,'report.json'));
 await assert.rejects(stat(path.join(reportDir,'report.md')),{code:'ENOENT'});
 assert.deepEqual(f.c.store.all('notification_delivery'),[]);

 await crashAt('notify-reserved');
 f.reopen();
 const first=await f.readReport();
 assert.equal(first.run.reportHash,digest(first.report));
 assert.equal(first.report.recovery.code,'request_outcome_unknown');
 assert.match(first.markdown,/unknown|unresolved/i);
 assert.equal(f.c.store.all('notification_delivery')[0].status,'uncertain');
 const beforeRevision=f.c.store.revision();
 const beforeEvents=f.c.store.events();
 const reportFiles=[first.run.reportPath,first.run.markdownPath];
 const mtimes=()=>Promise.all(reportFiles.map(async file=>(await stat(file)).mtimeMs));
 const beforeMtimes=await mtimes();
 f.setTime(start+1000);
 const monitor=f.monitor(async()=>assert.fail('The reserved local alert must never be delivered again'));
 for(let n=0;n<3;n++)await monitor.tick();
 assert.equal(f.c.store.revision(),beforeRevision);
 assert.deepEqual(f.c.store.events(),beforeEvents);
 assert.deepEqual(await f.readReport(),first);
 assert.deepEqual(await mtimes(),beforeMtimes);
});

test('successful recovery of a saved request does not create a blocker or a stale alert',async t=>{
 const f=await fixture(t),task=f.submit('Restart after saved response');
 f.c.acquireWorker('old-worker');
 f.c.claimNext('old-worker');
 f.c.beginAttempt(task.id,'old-worker');
 const checkpoint={phase:'model',attempt:1,exchange:0};
 f.c.boundary(task.id,checkpoint,'old-worker');
 const request=f.c.reserve(task.id,{kind:'model',key:'code-1-0'},'old-worker');
 f.c.saveRequest(request.id,{content:'saved fixture response'},'old-worker');

 f.setTime(start+1000);
 f.c.releaseWorker('old-worker');
 f.reopen();
 f.c.acquireWorker('new-worker');
 assert.equal(f.c.getTask(task.id).status,'uncertain');
 const recovered=f.c.recoverSaved(task.id,'new-worker');
 assert.equal(recovered.status,'queued');
 assert.equal(recovered.spent.model,1);
 assert.equal(f.c.store.request(task.id,'code-1-0').id,request.id);
 const alerts=[];
 const monitor=f.monitor(async kind=>{alerts.push(kind);});
 await monitor.tick();
 let {report}=await f.readReport();
 assert.equal(report.result,'implementation');
 assert.equal(report.firstBlocker,null);
 assert.deepEqual(f.c.store.all('notification'),[]);
 assert.deepEqual(alerts,[]);

 f.setTime(start+2000);
 f.c.claimNext('new-worker');
 const asked=f.c.ask(task.id,'Which fixture decision should apply?',checkpoint,'new-worker');
 await monitor.tick();
 ({report}=await f.readReport());
 assert.equal(report.recovery.code,'owner_answer_required');
 assert.equal(report.firstBlocker.at,start+2000);
 assert.equal(report.firstBlocker.questionId,asked.questions.at(-1).id);
 assert.deepEqual(alerts,['decision']);
});

test('a reviewed import in progress does not become a blocker until the saved import fails',async t=>{
 const f=await fixture(t),task=f.submit('Reviewed import');
 const candidateCommit='b'.repeat(40);
 f.c.store.tx(()=>{
  const saved=f.c.getTask(task.id);
  f.c.store.put('task',{...saved,status:'ready_to_integrate',result:{checks:[{id:'unit',passed:true}]},
   legacyDecision:{decision:'accept',feedback:'Protected candidate checks pass',unverified:[]}});
  f.c.store.put('goal',{...f.goal,integrationPending:{
   taskId:task.id,candidateCommit,importKey:'fixture-import',at:f.at(),
  }});
 });
 const alerts=[];
 const monitor=f.monitor(async kind=>{alerts.push(kind);});
 await monitor.tick();
 let {report}=await f.readReport();
 assert.equal(report.result,'integration');
 assert.equal(report.recovery.taskId,task.id);
 assert.equal(report.firstBlocker,null);
 assert.equal(report.receiptHash,null);
 assert.deepEqual(report.retainedProgress.integratedStages,[]);
 assert.deepEqual(alerts,[]);

 f.setTime(start+1000);
 f.c.store.tx(()=>{
  const saved=f.c.getTask(task.id);
  f.c.store.put('task',{...saved,status:'blocked',reason:'Integrated checks failed'});
  f.c.emit('task.blocked',f.goal.id,task.id,{reason:'Integrated checks failed'});
 });
 await monitor.tick();
 ({report}=await f.readReport());
 assert.equal(report.result,'blocked');
 assert.equal(report.recovery.code,'integration_pending');
 assert.equal(report.recovery.reason,'Integrated checks failed');
 assert.match(report.recovery.nextStep.instruction,/supervised repair/i);
 assert.equal(report.firstBlocker.at,start+1000);
 assert.deepEqual(alerts,['blocker']);
});
