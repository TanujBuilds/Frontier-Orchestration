import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {LocalProvider} from '../src/harness/provider.mjs';
import {OvernightPreflight} from '../src/harness/overnight-preflight.mjs';
import {git} from '../src/project/process.mjs';
import {adapters, fixture, open, owner, startTime} from './fixtures/mosaic-recovery/fixture.mjs';

const providerError=(message, requestOutcome, httpStatus)=>Object.assign(Error(message),{requestOutcome,httpStatus});
const awaitCall=()=>{
 let signal;
 const called=new Promise(resolve=>{signal=resolve;});
 return {called,signal};
};

async function setup(t,{mode='collaborative',seconds=60,reconnectMs=1800000,submit=true}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-execution-recovery-'));
 let now=Date.UTC(2026,10,10);
 const coordinators=[];
 const open=()=>{
  const c=new Coordinator({root:path.join(root,'state'),now:()=>now});
  coordinators.push(c);
  return c;
 };
 t.after(async()=>{for(const c of coordinators)c.close();await rm(root,{recursive:true,force:true});});
 const c=open(),overnight=mode==='overnight_review';
 const input={submissionId:'g',objective:'Fixture',acceptance:['Recover safely'],mode,environment:'fixture'};
 const assignment={submissionId:'t',kind:'consult',objective:'Saved explanation',acceptance:['A saved response'],limits:{seconds}};
 if(overnight){
  const repo=path.join(root,'repo');await mkdir(path.join(repo,'src'),{recursive:true});
  await writeFile(path.join(repo,'src','test.mjs'),'export const value = 1;\n');
  await git(repo,'init','-q');await git(repo,'config','user.email','fixture@example.invalid');
  await git(repo,'config','user.name','Fixture');await git(repo,'add','.');await git(repo,'commit','-qm','base');
  const paths=['src/'];
  input.project={repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:paths,writePaths:paths,checks:[{id:'probe',argv:[process.execPath,'src/test.mjs']}]};
  input.overnightPolicy={preflightCheckIds:['probe'],finalOnlyCheckIds:[],reconnectMs};
  Object.assign(assignment,{kind:'coding',role:'implementation',permissions:{readPaths:paths,writePaths:paths,checks:['probe']}});
 }
 const g=c.prepareGoal(input,'prepare');
 if(overnight){
  const preflight=new OvernightPreflight({c,config:{codexPath:process.execPath},checksFactory:()=>({verify:async()=>({fixture:true}),run:async checks=>checks.map(({id})=>({id,passed:true}))})});
  assert.equal((await preflight.run({goalId:g.id,hash:g.hash},'preflight')).passed,true);
 }
 c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const task=submit?c.submitTask({goalId:g.id,...assignment},'submit'):null;
 const start=(c,owner,provider,beforeReserve)=>{
  const worker=new Worker({c,owner,provider,config:{environment:'fixture'},adapters:{coding:{
   async step(current,lease){
    if(beforeReserve)await beforeReserve();
    return worker.model(current,lease,`code-${current.checkpoint.attempt}-${current.checkpoint.exchange}`,[]);
   },
  }}});
  return worker;
 };
 const claim=(owner='worker-old')=>{
  c.acquireWorker(owner);c.claimNext(owner);
  if(overnight){
   const attempt=c.beginAttempt(task.id,owner);
   return c.boundary(task.id,{phase:'model',attempt,exchange:0,executionBase:input.project.baseCommit},owner);
  }
  return c.getTask(task.id);
 };
 return {c,open,g,task,claim,start,setNow:value=>{now=value;}};
}

test('a late callback cannot save a spent reservation after its lease is released and replaced',async t=>{
 const f=await setup(t);f.claim();
 const running=awaitCall();
 let finish;
 const result=new Promise(resolve=>{finish=resolve;});
 const old=f.start(f.c,'worker-old',{complete:async()=>{running.signal();return result;}});
 const call=old.model(f.c.getTask(f.task.id),'worker-old','consult-1',[]);
 await running.called;
 const reservation=f.c.store.request(f.task.id,'consult-1');
 f.c.releaseWorker('worker-old');
 const fresh=f.open();fresh.acquireWorker('worker-new');
 finish({content:'Late answer'});
 await assert.rejects(call,/ownership|lease/i);
 assert.equal(fresh.store.request(f.task.id,'consult-1').status,'reserved');
 assert.equal(fresh.getTask(f.task.id).spent.model,1);
 assert.equal(fresh.getTask(f.task.id).status,'uncertain');
 assert.throws(()=>fresh.recoverSaved(f.task.id,'worker-new'),/ambiguous|pending/i);
 assert.equal(fresh.store.request(f.task.id,'consult-1').id,reservation.id);
});

test('a fresh owner can resume the saved pre-reservation checkpoint without resetting task state',async t=>{
 const f=await setup(t),before=f.claim();f.c.releaseWorker('worker-old');
 const fresh=f.open();fresh.acquireWorker('worker-new');
 const recovered=fresh.recoverSaved(f.task.id,'worker-new');
 assert.equal(recovered.status,'queued');
 for(const field of ['id','hash','goalVersion','spec','deadline','attempts','reviews','checkpoint','spent'])assert.deepEqual(recovered[field],before[field],field);
 let calls=0;
 const worker=f.start(fresh,'worker-new',{complete:async()=>{calls++;return {content:'New answer',model:'fixture'};}});
 await worker.tick();
 assert.equal(calls,1);
 assert.equal(fresh.getTask(f.task.id).status,'awaiting_review');
});

test('an error with no dispatch evidence stays uncertain even when its text sounds conclusive',async t=>{
 const f=await setup(t),before=f.claim();
 const worker=f.start(f.c,'worker-old',{complete:async()=>{throw Error('Provider reported a malformed terminal payload');}});
 const saved=await worker.tick();
 assert.equal(saved.status,'uncertain');
 assert.equal(saved.spent.model,1);
 assert.equal(saved.deadline,before.deadline);
 assert.equal(f.c.store.request(f.task.id,'consult-1').requestOutcome,'unknown');
});

test('known non-dispatch failure and reconnect checkpoint roll back together',async t=>{
 const f=await setup(t,{mode:'overnight_review'}),before=f.claim();
 const worker=f.start(f.c,'worker-old',{complete:async()=>{throw providerError('provider unavailable','not_dispatched');}});
 f.c.store.db.exec("CREATE TRIGGER fail_wait BEFORE INSERT ON events WHEN NEW.type='task.provider_wait' BEGIN SELECT RAISE(ABORT,'fixture wait commit failure'); END");
 await assert.rejects(worker.model(before,'worker-old','code-1-0',[]),/fixture wait commit failure/);
 const saved=f.c.getTask(f.task.id),request=f.c.store.request(f.task.id,'code-1-0');
 assert.equal(request.status,'reserved');
 assert.equal(saved.status,'running');
 assert.equal(saved.providerWait,undefined);
 assert.deepEqual(saved.checkpoint,before.checkpoint);
 assert.equal(saved.spent.model,1);
});

test('a positively identified rejection can reconnect independent of diagnostic text',async t=>{
 const f=await setup(t,{mode:'overnight_review'});f.claim();
 let calls=0;
 const worker=f.start(f.c,'worker-old',{complete:async()=>{calls++;throw providerError('fixture gateway response','not_dispatched',429);}});
 const saved=await worker.tick();
 assert.equal(saved.status,'suspended');
 assert.equal(saved.checkpoint.exchange,1);
 assert.equal(saved.spent.model,1);
 assert.equal(calls,1);
 assert.equal(f.c.store.request(f.task.id,'code-1-0').requestOutcome,'not_dispatched');
});

for(const condition of ['reconnect cutoff','task deadline','pause','stop']){
 test(`a healthy probe returning after ${condition} starts no new reservation`,async t=>{
  const f=await setup(t,{mode:'overnight_review',reconnectMs:condition==='reconnect cutoff'?30000:1800000});f.claim();
  let calls=0;
  const first=f.start(f.c,'worker-old',{complete:async()=>{calls++;throw providerError('provider unavailable','not_dispatched');}});
  const waited=await first.tick();
  assert.equal(waited.status,'suspended');
  f.c.releaseWorker('worker-old');const fresh=f.open();fresh.acquireWorker('worker-new');
  f.setNow(waited.providerWait.retryAt);
  const probe=awaitCall();let finish;
  const availability=new Promise(resolve=>{finish=resolve;});
  const resumed=f.start(fresh,'worker-new',{availability:async()=>{probe.signal();return availability;},complete:async()=>{calls++;return {content:'Unexpected completion'};}});
  const tick=resumed.tick();await probe.called;
  if(condition==='reconnect cutoff')f.setNow(waited.providerWait.until);
  else if(condition==='task deadline')f.setNow(waited.deadline);
  else fresh.control({taskId:f.task.id,action:condition},'interrupt-probe');
  finish(true);await tick;
  const saved=fresh.getTask(f.task.id);
  assert.equal(saved.status,{'reconnect cutoff':'blocked','task deadline':'partial',pause:'paused',stop:'stopped'}[condition]);
  assert.equal(saved.deadline,waited.deadline);
  assert.equal(saved.providerWait.until,waited.providerWait.until);
  assert.equal(saved.spent.model,1);
  assert.equal(calls,1);
 });
}


test('another coordinator cannot impersonate a live lease by reusing its token',async t=>{
 const f=await setup(t);f.claim();
 const lease=f.c.store.get('lease','coordinator'),fresh=f.open();
 assert.throws(()=>fresh.acquireWorker('worker-old'),/worker|ownership/i);
 assert.throws(()=>fresh.releaseWorker('worker-old'),/lease/i);
 assert.deepEqual(fresh.store.get('lease','coordinator'),lease);
 assert.equal(fresh.getTask(f.task.id).status,'running');
});

test('a readiness receipt cannot authorize a request reserved after its original cutoff',async t=>{
 const f=await setup(t,{mode:'overnight_review',reconnectMs:30000});f.claim();
 const initial=f.start(f.c,'worker-old',{complete:async()=>{throw providerError('provider unavailable','not_dispatched');}});
 const waited=await initial.tick();
 f.setNow(waited.providerWait.retryAt);
 const context=awaitCall();let resumeContext,calls=0;
 const contextualWork=new Promise(resolve=>{resumeContext=resolve;});
 const resumed=f.start(f.c,'worker-old',{availability:async()=>true,complete:async()=>{calls++;return {content:'Unexpected completion'};}},async()=>{context.signal();await contextualWork;});
 const tick=resumed.tick();await context.called;
 f.setNow(waited.providerWait.until);
 resumeContext();await tick;
 const saved=f.c.getTask(f.task.id);
 assert.equal(saved.status,'blocked');
 assert.equal(saved.providerWait.until,waited.providerWait.until);
 assert.equal(saved.spent.model,1);
 assert.equal(calls,0);
});

test('known non-dispatch remains spent and does not prevent replay of a subsequent saved response',async t=>{
 const f=await setup(t,{mode:'overnight_review'});const before=f.claim();
 let calls=0;
 const initial=f.start(f.c,'worker-old',{complete:async()=>{calls++;throw providerError('provider unavailable','not_dispatched');}});
 const waited=await initial.tick(),failed=f.c.store.request(f.task.id,'code-1-0');
 f.setNow(waited.providerWait.retryAt);
 const result={content:'Saved replacement',model:'fixture'};
 const resumed=f.start(f.c,'worker-old',{availability:async()=>true,complete:async()=>{calls++;return result;}});
 assert.deepEqual(await resumed.tick(),result);
 const replacement=f.c.store.request(f.task.id,'code-1-1');
 f.c.releaseWorker('worker-old');const fresh=f.open();fresh.acquireWorker('worker-new');
 const recovered=fresh.recoverSaved(f.task.id,'worker-new');
 assert.equal(recovered.status,'queued');
 assert.equal(recovered.deadline,before.deadline);
 assert.equal(recovered.attempts,before.attempts);
 assert.equal(recovered.checkpoint.exchange,1);
 assert.equal(recovered.spent.model,2);
 const replay=f.start(fresh,'worker-new',{complete:async()=>assert.fail('Saved completion must be reused')});
 assert.deepEqual(await replay.tick(),result);
 assert.equal(calls,2);
 assert.equal(fresh.store.request(f.task.id,'code-1-0').id,failed.id);
 assert.equal(fresh.store.request(f.task.id,'code-1-1').id,replacement.id);
 assert.equal(fresh.store.request(f.task.id,'code-1-1').status,'completed');
});

test('a loopback gateway timeout on a completion is held as an unknown outcome',async t=>{
 let posts=0;
 const server=http.createServer((request,response)=>{
  response.setHeader('content-type','application/json');
  if(request.url==='/v1/models')return response.end(JSON.stringify({data:[{id:'fixture-model'}]}));
  posts++;
  request.resume();
  response.writeHead(408);
  response.end('{}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const f=await setup(t,{mode:'overnight_review'});f.claim();
 const provider=new LocalProvider({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model'});
 const worker=f.start(f.c,'worker-old',provider);
 const saved=await worker.tick();
 assert.equal(posts,1);
 assert.equal(saved.status,'uncertain');
 assert.equal(saved.spent.model,1);
 assert.equal(saved.providerWait,undefined);
 assert.equal(f.c.store.request(f.task.id,'code-1-0').requestOutcome,'unknown');
 await worker.tick();
 assert.equal(posts,1);
});


test('a saved legacy-format planning response waits for an explicit goal resume',async t=>{
 const f=await setup(t,{mode:'deepseek_only',submit:false});
 f.c.acquireWorker('worker-old');
 // This is the pre-existing on-disk receipt format at the planning.saved crash boundary.
 f.c.store.tx(()=>{
  f.c.store.put('planning',{id:f.g.id,goalId:f.g.id,status:'running',owner:'worker-old',attempt:1,feedback:[]});
  f.c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run('fixture-plan',f.g.id,'plan-1','model','completed',JSON.stringify({
   owner:'worker-old',result:{content:JSON.stringify({tasks:[{key:'explain',kind:'consult',objective:'Explain the saved plan',acceptance:['Bounded answer']}]})},
  }));
 });
 const before=f.c.getGoal(f.g.id);
 f.c.control({goalId:f.g.id,action:'pause'},'pause');
 f.c.releaseWorker('worker-old');
 const fresh=f.open();fresh.acquireWorker('worker-new');
 const parked=fresh.recoverPlanning(f.g.id,'worker-new');
 assert.equal(parked.status,'paused');
 assert.equal(parked.owner,null);
 const worker=f.start(fresh,'worker-new',{complete:async()=>assert.fail('A saved planner response must never be dispatched again')});
 await worker.tick();
 assert.equal(fresh.getGoal(f.g.id).tasks.length,0);
 fresh.control({goalId:f.g.id,action:'resume'},'resume');
 await worker.tick();
 const saved=fresh.getGoal(f.g.id);
 assert.equal(saved.planning.status,'completed');
 assert.equal(saved.planning.spent,1);
 assert.equal(saved.planning.attempt,1);
 assert.equal(saved.tasks.length,1);
 assert.equal(saved.hash,before.hash);
 assert.equal(saved.deadline,before.deadline);
});

test('model discovery finishing after the saved reconnect cutoff sends no completion POST',async t=>{
 const f=await setup(t,{mode:'overnight_review',reconnectMs:30000});f.claim();
 const initial=f.start(f.c,'worker-old',{complete:async()=>{throw providerError('provider unavailable','not_dispatched');}});
 const waited=await initial.tick();
 f.setNow(waited.providerWait.retryAt);
 const discovery=awaitCall();let models=0,posts=0,finishDiscovery;
 const server=http.createServer((request,response)=>{
  response.setHeader('content-type','application/json');
  if(request.url==='/v1/models'){
   const finish=()=>response.end(JSON.stringify({data:[{id:'fixture-model'}]}));
   if(++models===1)finish();
   else{finishDiscovery=finish;discovery.signal();}
  }else{
   posts++;
   request.resume();
   response.end(JSON.stringify({model:'fixture-model',choices:[{message:{content:'Unexpected completion'}}]}));
  }
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const provider=new LocalProvider({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model'});
 const worker=f.start(f.c,'worker-old',provider),tick=worker.tick();
 await discovery.called;
 f.setNow(waited.providerWait.until);
 finishDiscovery();
 await tick;
 const saved=f.c.getTask(f.task.id);
 assert.equal(posts,0);
 assert.equal(saved.status,'blocked');
 assert.equal(saved.providerWait.until,waited.providerWait.until);
 assert.equal(saved.spent.model,2);
 assert.equal(f.c.store.request(f.task.id,'code-1-1').requestOutcome,'not_dispatched');
});


test('a held restart reports the unknown request after provisional interruption',async t=>{
 const f=await setup(t,{mode:'overnight_review'});f.claim();
 const reservation=f.c.reserve(f.task.id,{key:'code-1-0',kind:'model'},'worker-old');
 f.c.releaseWorker('worker-old');
 const fresh=f.open();fresh.acquireWorker('worker-new');
 assert.throws(()=>fresh.recoverSaved(f.task.id,'worker-new'),/ambiguous|pending/i);
 const events=fresh.store.events().filter(event=>event.task_id===f.task.id);
 assert.equal(events.filter(event=>event.type==='task.interrupted').length,1);
 assert.equal(events.filter(event=>event.type==='task.uncertain').length,0);
 assert.equal(fresh.notifications({goalId:f.g.id}).filter(notice=>notice.kind==='blocker').length,0);
 const worker=f.start(fresh,'worker-new',{complete:async()=>assert.fail('Held reservation must never dispatch')});
 await worker.tick();
 await worker.tick();
 const run=fresh.getGoal(f.g.id).overnightRun;
 assert.equal(run.phase,'blocked');
 assert.equal(run.recovery.code,'request_outcome_unknown');
 assert.equal(run.recovery.requestId,reservation.id);
 assert.match(run.firstBlocker.reason,/reconcile/i);
 assert.equal(fresh.notifications({goalId:f.g.id}).filter(notice=>notice.kind==='blocker').length,1);
 assert.equal(fresh.store.all('notification_delivery').length,1);
 assert.equal(fresh.getTask(f.task.id).spent.model,1);
});

for(const action of ['pause','stop']){
 test(`task ${action} during a legacy review saves the verdict but holds integration`,async t=>{
  const f=await fixture(t),c=open(f,startTime);
  t.after(()=>c.close());c.acquireWorker(owner);
  const taskId=f.goal.tasks[0].id,review=awaitCall();
  let finish,reviewCalls=0;
  const verdict=new Promise(resolve=>{finish=resolve;});
  const worker=new Worker({c,owner,...adapters(f.root),reviewer:{
   reviewCode:async()=>{reviewCalls++;review.signal();return verdict;},
  }});
  for(let count=0;count<10&&c.getTask(taskId).status!=='awaiting_legacy_review';count++)await worker.tick();
  assert.equal(c.getTask(taskId).status,'awaiting_legacy_review');
  const reviewing=worker.tick();
  await review.called;
  assert.equal(c.getTask(taskId).status,'legacy_reviewing');
  c.control({taskId,action},'control-active-review');
  finish({decision:'accept',feedback:'Checked candidate accepted',unverified:[]});
  await reviewing;
  const held=c.getTask(taskId);
  assert.equal(held.status,'ready_to_integrate');
  assert.equal(held[action==='pause'?'pauseRequested':'stopRequested'],true);
  assert.equal(held.legacyDecision.decision,'accept');
  assert.equal(held.spent.codexReview,1);
  await worker.tick();
  assert.equal(c.getTask(taskId).status,'ready_to_integrate');
  assert.equal(c.getTask(taskId).integration??null,null);
  c.control({taskId,action:'resume'},'resume-after-review');
  await worker.tick();
  const accepted=c.getTask(taskId);
  assert.equal(accepted.status,'accepted');
  assert.equal(accepted.deadline,held.deadline);
  assert.deepEqual(accepted.spent,held.spent);
  assert.equal(reviewCalls,1);
 });
}

for(const discoveryOutage of ['empty model list','HTTP 408']){
 test(`loopback discovery ${discoveryOutage} certifies no dispatch and reconnects inside the original window`,async t=>{
  let available=false,posts=0;
  const server=http.createServer((request,response)=>{
   response.setHeader('content-type','application/json');
   if(request.url==='/v1/models'){
    if(!available&&discoveryOutage==='HTTP 408')response.writeHead(408);
    return response.end(JSON.stringify({data:available?[{id:'fixture-model'}]:[]}));
   }
   posts++;
   request.resume();
   response.end(JSON.stringify({model:'fixture-model',choices:[{message:{content:'Recovered completion'},finish_reason:'stop'}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const f=await setup(t,{mode:'overnight_review',reconnectMs:30000}),before=f.claim();
  const provider=()=>new LocalProvider({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model'});
  const initial=f.start(f.c,'worker-old',provider()),waited=await initial.tick();
  assert.equal(posts,0);
  assert.equal(waited.status,'suspended');
  assert.equal(waited.spent.model,1);
  const first=f.c.store.request(f.task.id,'code-1-0');
  assert.equal(first.requestOutcome,'not_dispatched');
  f.c.releaseWorker('worker-old');
  const fresh=f.open();fresh.acquireWorker('worker-new');
  f.setNow(waited.providerWait.retryAt);
  available=true;
  const resumed=f.start(fresh,'worker-new',provider()),result=await resumed.tick();
  const saved=fresh.getTask(f.task.id),replacement=fresh.store.request(f.task.id,'code-1-1');
  assert.equal(result.content,'Recovered completion');
  assert.equal(posts,1);
  assert.equal(saved.deadline,before.deadline);
  assert.equal(saved.spent.model,2);
  assert.equal(saved.attempts,before.attempts);
  assert.equal(replacement.reconnectUntil,waited.providerWait.until);
  assert.equal(replacement.status,'completed');
  assert.equal(fresh.store.request(f.task.id,'code-1-0').id,first.id);
 });
}
