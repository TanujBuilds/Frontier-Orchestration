import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {LocalProvider} from '../src/harness/provider.mjs';
import {OvernightPreflight} from '../src/harness/overnight-preflight.mjs';
import {git} from '../src/project/process.mjs';

// Real native HTTP bodies fail after successful headers. Readiness GETs succeed
// so each retry reaches the production fresh-membership/reconnect branch again.
async function loopback(t, outage, {inference=false}={}) {
  const calls=[];
  let readiness=false;
  const server=http.createServer((req,res)=>{
    calls.push(req.method);
    req.resume();
    if(!inference)assert.equal(req.method,'GET','Discovery failures must send zero inference POSTs');
    if(inference&&req.method==='GET'||readiness) {
      readiness=false;
      return res.end(JSON.stringify({data:[{id:'fixture-model'}]}));
    }
    res.writeHead(200,{'content-type':'application/json'});
    res.flushHeaders();
    if(outage==='invalid JSON')return res.end('{');
    res.write('{"data":');
    if(outage==='disconnect')setTimeout(()=>res.destroy(),5);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const provider=new LocalProvider({
    baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model',
    openAICompatible:true,timeoutMs:100,
    capabilities:{protocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'advertised'},
  });
  return {provider,calls,ready:()=>{readiness=true;}};
}

for(const outage of ['disconnect','deadline','invalid JSON'])test(`Worker holds a 200 completion ${outage} as unknown without reconnect or retry`,async t=>{
  const f=await setup(t),wire=await loopback(t,outage,{inference:true}),worker=f.start(wire.provider);
  const saved=await worker.tick();
  assert.equal(saved.status,'uncertain');assert.equal(saved.spent.model,1);
  assert.equal(saved.providerWait,undefined);assert.equal(saved.deadline,f.task.deadline);
  assert.equal(f.c.store.request(f.task.id,'code-1-0').requestOutcome,'unknown');
  assert.deepEqual(wire.calls,['GET','POST']);
  await worker.tick();
  assert.deepEqual(wire.calls,['GET','POST']);
});

async function setup(t,{planning=false,reconnectMs=30000}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'m025-reconnect-'));
  const repo=path.join(root,'repo');
  await mkdir(path.join(repo,'src'),{recursive:true});
  await writeFile(path.join(repo,'src/probe.mjs'),'export const fixture = true;\n');
  for(const args of [['init','-q'],['config','user.email','fixture@example.invalid'],['config','user.name','Fixture'],['add','.'],['commit','-qm','fixture']])await git(repo,...args);
  let now=Date.UTC(2026,10,16);
  const c=new Coordinator({root:path.join(root,'state'),now:()=>now});
  t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
  const project={repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['src/'],writePaths:['src/'],checks:[{id:'probe',argv:[process.execPath,'src/probe.mjs']}]};
  const g=c.prepareGoal({submissionId:'g',objective:'Bounded reconnect fixture',acceptance:['Preserve original limits'],mode:'overnight_review',environment:'fixture',project,overnightPolicy:{preflightCheckIds:['probe'],finalOnlyCheckIds:[],reconnectMs}},'prepare');
  const preflight=new OvernightPreflight({c,config:{codexPath:process.execPath},checksFactory:()=>({verify:async()=>({fixture:true}),run:async checks=>checks.map(({id})=>({id,passed:true}))})});
  assert.equal((await preflight.run({goalId:g.id,hash:g.hash},'preflight')).passed,true);
  c.activateGoal({goalId:g.id,hash:g.hash},'activate');
  c.acquireWorker('fixture-worker');
  let task;
  if(!planning) {
    task=c.submitTask({goalId:g.id,submissionId:'t',kind:'coding',role:'implementation',objective:'No dispatch before membership',acceptance:['No POST'],permissions:{readPaths:['src/'],writePaths:['src/'],checks:['probe']}},'submit');
    c.claimNext('fixture-worker');
    const attempt=c.beginAttempt(task.id,'fixture-worker');
    task=c.boundary(task.id,{phase:'model',attempt,exchange:0,executionBase:project.baseCommit},'fixture-worker');
  }
  const start=provider=>{
    const worker=new Worker({c,provider,owner:'fixture-worker',config:{environment:'fixture'},adapters:{coding:{step:(current,owner)=>worker.model(current,owner,`code-${current.checkpoint.attempt}-${current.checkpoint.exchange}`,[])}}});
    return worker;
  };
  return {c,g,task,start,setNow:value=>{now=value;}};
}

for(const planning of [false,true])for(const outage of ['disconnect','deadline','invalid JSON']) {
  test(`${planning?'Planner':'Worker'} reconnects after 200 membership ${outage} within its original cutoff`,async t=>{
    const f=await setup(t,{planning}),wire=await loopback(t,outage),worker=f.start(wire.provider);
    const before=f.c.getGoal(f.g.id),tick=()=>planning?worker.planner.tick():worker.tick();
    await tick();
    const first=planning?f.c.getGoal(f.g.id).planning:f.c.getTask(f.task.id);
    assert.equal(first.status,planning?'queued':'suspended');
    assert.equal(planning?first.spent:first.spent.model,1);
    assert.deepEqual(wire.calls,['GET']);
    const firstRequest=f.c.store.request(planning?f.g.id:f.task.id,planning?'plan-1':'code-1-0');
    assert.equal(firstRequest.requestOutcome,'not_dispatched');
    const until=first.providerWait.until;
    wire.ready();f.setNow(first.providerWait.retryAt);
    await tick();
    const second=planning?f.c.getGoal(f.g.id).planning:f.c.getTask(f.task.id);
    assert.equal(second.status,'blocked');
    assert.match(second.reason,planning?/No eligible planner retry remains in original reconnect window/:/No eligible provider retry remains in original reconnect window/);
    assert.equal(second.providerWait.until,until);
    assert.equal(planning?second.spent:second.spent.model,2);
    assert.deepEqual(wire.calls,['GET','GET','GET']);
    assert.equal(f.c.getGoal(f.g.id).deadline,before.deadline);
    assert.deepEqual(f.c.getGoal(f.g.id).manifest.limits,before.manifest.limits);
    const secondRequest=f.c.store.request(planning?f.g.id:f.task.id,planning?'plan-2':'code-1-1');
    assert.equal(secondRequest.reconnectUntil,until);
    assert.equal(secondRequest.requestOutcome,'not_dispatched');
    f.setNow(until);await tick();
    const stopped=planning?f.c.getGoal(f.g.id).planning:f.c.getTask(f.task.id);
    assert.equal(stopped.status,'blocked');
    assert.equal(planning?stopped.spent:stopped.spent.model,2);
    assert.deepEqual(wire.calls,['GET','GET','GET']);
    assert.equal(f.c.store.request(planning?f.g.id:f.task.id,planning?'plan-1':'code-1-0').id,firstRequest.id);
    if(!planning) {
      assert.equal(stopped.deadline,f.task.deadline);
      assert.equal(stopped.attempts,f.task.attempts);
      assert.equal(stopped.checkpoint.exchange,2);
    }
  });
}

test('Planner still stops after three spent membership requests before the reconnect cutoff',async t=>{
  const f=await setup(t,{planning:true,reconnectMs:120000}),wire=await loopback(t,'disconnect'),worker=f.start(wire.provider);
  let until;
  for(let attempt=1;attempt<=3;attempt++) {
    await worker.planner.tick();
    const p=f.c.getGoal(f.g.id).planning;
    assert.equal(p.attempt,attempt);assert.equal(p.spent,attempt);
    assert.equal(p.status,attempt===3?'blocked':'queued');
    until??=p.providerWait.until;
    assert.equal(p.providerWait.until,until);
    wire.ready();f.setNow(p.providerWait.retryAt);
  }
  await worker.planner.tick();
  assert.equal(f.c.getGoal(f.g.id).planning.spent,3);
  assert.deepEqual(wire.calls,['GET','GET','GET','GET','GET']);
  assert.equal(f.c.getGoal(f.g.id).tasks.length,0);
});
