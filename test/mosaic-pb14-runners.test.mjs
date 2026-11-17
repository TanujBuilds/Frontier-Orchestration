import test from 'node:test';
import assert from 'node:assert/strict';
import {endpoint,profile,fixture,advance,evidence} from './fixtures/mosaic-pb14/runtime.mjs';
import {capacitySnapshot} from '../src/harness/scheduling/capacity.mjs';

const advertisedProfile=(id,baseUrl)=>{const p=profile(id,baseUrl);return {...p,capabilities:{...p.capabilities,modelDiscovery:'advertised'}};};

async function waitFor(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Barrier not reached')),5000);})]);}finally{clearTimeout(timer);}}

test('bounded supervisor enters two independent loopback requests before releasing either response',{timeout:12000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b');a.state.holdPost=Promise.withResolvers();b.state.holdPost=Promise.withResolvers();
 const f=await fixture(t,[profile('a',a.baseUrl),profile('b',b.baseUrl)]),ta=f.submit('a','worker-a'),tb=f.submit('b','worker-b');
 const tick=f.worker.tick();await waitFor(Promise.all([a.posted.promise,b.posted.promise]));
 assert.equal(a.posts().length,1);assert.equal(b.posts().length,1);assert.equal(capacitySnapshot(f.c).requests.length,2);
 const aa=f.c.getTask(ta.id),bb=f.c.getTask(tb.id);assert.notEqual(aa.owner,bb.owner);assert.equal(aa.ownerLease,bb.ownerLease);assert.equal(aa.runnerGeneration,1);assert.equal(bb.runnerGeneration,1);
 assert.equal(f.worker.runners.size,2);a.state.holdPost.resolve();b.state.holdPost.resolve();await tick;
 await advance(f.worker,()=>[ta,tb].every(x=>f.c.getTask(x.id).status==='awaiting_review'));
 assert.deepEqual([ta,tb].map(x=>f.c.getTask(x.id).spent.model),[1,1]);assert.equal(f.worker.runners.size,0);await evidence('concurrency-timeline',{requests:[...a.posts().map(x=>({provider:'a',...x})),...b.posts().map(x=>({provider:'b',...x}))],tasks:[ta,tb].map(x=>f.c.getTask(x.id)),events:f.c.store.events(0,1000)});
});

test('shared group limit one holds second task without spending while independent configured service allows two',{timeout:12000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b');a.state.holdPost=Promise.withResolvers();
 const pa=profile('a',a.baseUrl),pb={...profile('b',b.baseUrl),capacityGroup:pa.capacityGroup};
 const f=await fixture(t,[pa,pb]),ta=f.submit('a','worker-a'),tb=f.submit('b','worker-b');const tick=f.worker.tick();await waitFor(a.posted.promise);
 assert.equal(b.posts().length,0);assert.equal(f.c.getTask(tb.id).spent.model,0);assert.equal(capacitySnapshot(f.c).requests.length,1);
 a.state.holdPost.resolve();await tick;await advance(f.worker,()=>f.c.getTask(ta.id).status==='awaiting_review');
 // Busy readiness cooldown is bounded, and a committed completion wakes the next admission.
 f.c.store.tx(()=>{const task=f.c.store.get('task',tb.id);delete task.routingWait;f.c.store.put('task',task);});
 await advance(f.worker,()=>f.c.getTask(tb.id).status==='awaiting_review');assert.equal(b.posts().length,1);
});

test('offline selected worker does not starve a later independent selected worker',{timeout:12000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b');a.state.online=false;
 const f=await fixture(t,[advertisedProfile('a',a.baseUrl),profile('b',b.baseUrl)]),ta=f.submit('offline','worker-a'),tb=f.submit('online','worker-b');
 await advance(f.worker,()=>f.c.getTask(tb.id).status==='awaiting_review');
 assert.equal(a.posts().length,0);assert.equal(b.posts().length,1);assert.equal(f.c.getTask(ta.id).spent.model,0);assert.equal(f.c.getTask(ta.id).routingWait.decision.reasonCode,'provider_offline');
});

for(const action of ['pause','stop'])test(action+' during two active requests retains responses without completing cancelled work',{timeout:12000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b');a.state.holdPost=Promise.withResolvers();b.state.holdPost=Promise.withResolvers();
 const f=await fixture(t,[profile('a',a.baseUrl),profile('b',b.baseUrl)]),tasks=[f.submit('a','worker-a'),f.submit('b','worker-b')];
 const tick=f.worker.tick();await waitFor(Promise.all([a.posted.promise,b.posted.promise]));f.c.control({goalId:f.g.id,action},action);
 a.state.holdPost.resolve();b.state.holdPost.resolve();await tick;
 await advance(f.worker,()=>tasks.every(x=>f.c.getTask(x.id).status===(action==='pause'?'paused':'stopped')));
 for(const task of tasks){const saved=f.c.getTask(task.id);assert.equal(saved.result,null);assert.equal(saved.spent.model,1);assert.equal(f.c.store.request(task.id,'consult-1').status,'completed');}
 assert.equal(capacitySnapshot(f.c).requests.length,0);
});


test('a held API reviewer cannot starve a worker on another group or spend a saturated group',{timeout:12000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),pa={...profile('a',a.baseUrl),roles:['worker','reviewer']},pb=profile('b',b.baseUrl),{credentialRef,...reviewer}=pa;
 const f=await fixture(t,[pa,pb],{reviewPolicy:{version:1,source:'api',reviewer,fallback:'wait'}}),candidate=f.submit('candidate','worker-b');
 await advance(f.worker,()=>f.c.getTask(candidate.id).status==='awaiting_review');
 a.state.holdPost=Promise.withResolvers();a.state.reply=JSON.stringify({decision:'accept',feedback:'Checked fixture',findings:[]});
 const review=f.worker.legacyReview.tick();await waitFor(a.posted.promise);
 const busy=f.submit('busy','worker-a'),independent=f.submit('independent','worker-b');
 await advance(f.worker,()=>f.c.getTask(independent.id).status==='awaiting_review');
 assert.equal(a.posts().length,1);assert.equal(b.posts().length,2);assert.equal(f.c.getTask(busy.id).spent.model,0);assert.equal(f.c.getTask(candidate.id).spent.apiReview,1);
 let wait;for(let n=0;n<5;n++){wait=await f.worker.tick();if(wait?.waiting)break;}assert.equal(wait.waiting,true);assert.equal(f.worker.nextIdleCheck(f.c.now())>f.c.now(),true);assert.equal(f.worker.runners.size,0);
 a.state.holdPost.resolve();await review;
});

test('owned supervisor close aborts both dispatched requests and preserves remote uncertainty',{timeout:12000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b');a.state.holdPost=Promise.withResolvers();b.state.holdPost=Promise.withResolvers();
 const f=await fixture(t,[profile('a',a.baseUrl),profile('b',b.baseUrl)]),tasks=[f.submit('a','worker-a'),f.submit('b','worker-b')];const tick=f.worker.tick();await waitFor(Promise.all([a.posted.promise,b.posted.promise]));
 await f.worker.close();await tick;assert.equal(f.worker.runners.size,0);assert.equal(f.worker.auxiliary.size,0);
 for(const task of tasks){const current=f.c.getTask(task.id);assert.equal(current.status,'uncertain');assert.equal(current.spent.model,1);assert.equal(f.c.store.request(task.id,'consult-1').requestOutcome,'unknown');}
 assert.equal(capacitySnapshot(f.c).requests.length,2);
});


test('default service one skips a known opted-in planner wait for eligible work on another group',{timeout:10000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,[profile('a',a.baseUrl),profile('b',b.baseUrl)],{serviceLimit:1,goalLimit:1});
 const planner=f.c.prepareGoal({...f.raw,submissionId:'planner-goal',mode:'deepseek_only'},'planner-prepare');f.c.activateGoal({goalId:planner.id,hash:planner.hash},'planner-activate');
 f.c.store.tx(()=>f.c.store.put('planning',{id:planner.id,goalId:planner.id,status:'uncertain',attempt:1,owner:'old-planner',providerBinding:f.c.store.get('goal',planner.id).manifest.plannerBinding}));
 const task=f.submit('independent','worker-b');await f.worker.tick();assert.equal(f.c.getTask(task.id).status,'awaiting_review');assert.equal(b.posts().length,1);assert.equal(a.posts().length,0);assert.equal(f.c.store.get('planning',planner.id).status,'uncertain');
});

test('slow opted-in planner and independent worker enter separate groups under one supervisor',{timeout:12000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b');a.state.holdPost=Promise.withResolvers();a.state.reply=JSON.stringify({tasks:[{key:'answer',kind:'consult',objective:'Explain bounded planning',acceptance:['Answer']} ]});
 const f=await fixture(t,[profile('a',a.baseUrl),profile('b',b.baseUrl)]),task=f.submit('worker','worker-b'),planner=f.c.prepareGoal({...f.raw,submissionId:'parallel-plan',mode:'deepseek_only'},'parallel-plan-prepare');f.c.activateGoal({goalId:planner.id,hash:planner.hash},'parallel-plan-activate');
 const tick=f.worker.tick();await waitFor(Promise.all([a.posted.promise,b.posted.promise]));await tick;await advance(f.worker,()=>f.c.getTask(task.id).status==='awaiting_review');
 assert.equal(f.c.store.get('planning',planner.id).status,'running');assert.equal(f.c.store.spent(planner.id).model,1);assert.equal(f.c.getTask(task.id).spent.model,1);
 a.state.holdPost.resolve();await advance(f.worker,()=>f.c.store.get('planning',planner.id).status==='completed');assert.equal(a.posts().length,1);assert.equal(b.posts().length,1);
});


test('two independent API reviewers enter before either response and retain exact review receipts',{timeout:12000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),profiles=[{...profile('a',a.baseUrl),roles:['worker','reviewer']},{...profile('b',b.baseUrl),roles:['worker','reviewer']}],publicProfile=p=>{const {credentialRef,...value}=p;return value;};
 const f=await fixture(t,profiles,{reviewPolicy:{version:1,source:'api',reviewer:publicProfile(profiles[0]),fallback:'wait'}}),g2=f.c.prepareGoal({...f.raw,submissionId:'second-review-goal',reviewPolicy:{version:1,source:'api',reviewer:publicProfile(profiles[1]),fallback:'wait'}},'second-review-prepare');f.c.activateGoal({goalId:g2.id,hash:g2.hash},'second-review-active');
 const tasks=[f.submit('first','worker-a'),f.c.submitTask({goalId:g2.id,submissionId:'second',kind:'consult',objective:'Explain independent review',acceptance:['Answer'],routing:{version:1,preferredProviderId:'worker-b'}},'second-task')];
 const {claimAvailable}=await import('../src/harness/routing/runtime.mjs');
 for(let n=0;n<2;n++){const owner='candidate-'+n,context=f.worker.taskContext(owner),claimed=await claimAvailable(context);f.c.beginAttempt(claimed.id,owner);const result=await context.model(claimed,owner,'consult-1',[{role:'user',content:'{}'}]);f.c.completeTask(claimed.id,result,owner,{reviewRequired:true});}
 for(const ep of [a,b]){ep.state.holdPost=Promise.withResolvers();ep.state.reply=JSON.stringify({decision:'accept',feedback:'Independent exact candidate review',findings:[]});}
 // New barriers specifically await the reviewer POST, rather than the completed worker request.
 const entered=Promise.withResolvers();let arrivals=0;for(const ep of [a,b])ep.state.onPost=()=>{if(++arrivals===2)entered.resolve();};
 const tick=f.worker.tick();await waitFor(entered.promise);assert.equal(capacitySnapshot(f.c).requests.length,2);
 a.state.holdPost.resolve();b.state.holdPost.resolve();await tick;await advance(f.worker,()=>tasks.every(x=>f.c.getTask(x.id).status==='accepted'));
 for(const task of tasks){const saved=f.c.getTask(task.id);assert.equal(saved.spent.apiReview,1);assert.equal(saved.spent.model,1);assert.equal(saved.reviewAcceptance.source,'api');}
});

test('closing the owning worker interrupts its actual protected-check subprocess',{timeout:15000},async t=>{
 const {repository}=await import('./fixtures/mosaic-assignment/repository.mjs'),{command}=await import('../src/project/process.mjs'),{readFile}=await import('node:fs/promises'),path=await import('node:path');
 const a=await endpoint(t,'a'),f=await fixture(t,[profile('a',a.baseUrl)]),repo=await repository({root:f.root,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}),marker=path.join(f.root,'owned-check-pid');
 const g=f.c.prepareGoal({...f.raw,submissionId:'check-cleanup',project:{repo:repo.root,baseCommit:repo.baseCommit,readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'verify',argv:[process.execPath,'checks/verify.mjs']}] }},'check-prepare');f.c.activateGoal({goalId:g.id,hash:g.hash},'check-active');
 const task=f.c.submitTask({goalId:g.id,submissionId:'check',kind:'coding',objective:'Verify scoped source',acceptance:['Owned cleanup'],permissions:{readPaths:['src/','checks/'],writePaths:['src/'],checks:['verify']},routing:{version:1,preferredProviderId:'worker-a'}},'check-task');
 a.state.reply=JSON.stringify({type:'submit_changes',paths:[],edits:[],summary:'Verify unchanged source'});let checkSignal;
 f.worker.checksFactory=()=>({verify:async()=>({fixture:true}),run:async(checks,key,signal)=>{checkSignal=signal;const result=await command([process.execPath,'-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`],{signal,timeoutMs:10000});return checks.map(({id})=>({id,passed:!result.stopped&&result.code===0,...result}));}});
 await advance(f.worker,()=>f.c.getTask(task.id).checkpoint.phase==='checks');const tick=advance(f.worker,()=>!!checkSignal);let pid;
 for(let n=0;n<200;n++){try{pid=Number(await readFile(marker,'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
 assert.ok(pid);assert.equal(checkSignal,f.worker.shutdown.signal);await f.worker.close();await tick;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.notEqual(f.c.getTask(task.id).status,'accepted');
 await evidence('owned-check-cleanup',{pid,signalAborted:checkSignal.aborted,processAlive:false,status:f.c.getTask(task.id).status,runnersRemaining:f.worker.runners.size,auxiliaryRemaining:f.worker.auxiliary.size});
});

test('an uncertain opted-in planner does not starve another approved planner group',{timeout:10000},async t=>{
 const {inferenceResource}=await import('../src/harness/scheduling/capacity.mjs');
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,[profile('a',a.baseUrl),profile('b',b.baseUrl)]);
 const ga=f.c.prepareGoal({...f.raw,submissionId:'held-plan',mode:'deepseek_only'},'held-plan-prepare');f.c.activateGoal({goalId:ga.id,hash:ga.hash},'held-plan-active');
 const gb=f.c.prepareGoal({...f.raw,submissionId:'healthy-plan',mode:'deepseek_only',providerPolicy:{...f.raw.providerPolicy,plannerWorkerId:'worker-b'}},'healthy-plan-prepare');f.c.activateGoal({goalId:gb.id,hash:gb.hash},'healthy-plan-active');
 const goalA=f.c.store.get('goal',ga.id),binding=goalA.manifest.plannerBinding;
 f.c.store.tx(()=>{f.c.store.put('planning',{id:ga.id,goalId:ga.id,status:'uncertain',attempt:1,owner:'old-plan',providerBinding:binding});f.c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run('held-plan-request',ga.id,'plan-1','model','reserved',JSON.stringify({owner:'old-plan',reservedAt:f.c.now(),providerBinding:binding,capacityResource:inferenceResource(f.c,goalA,binding)}));});
 b.state.reply=JSON.stringify({tasks:[{key:'answer',kind:'consult',objective:'Explain healthy planner',acceptance:['Answer']} ]});
 await advance(f.worker,()=>f.c.store.maybe('planning',gb.id)?.status==='completed');
 assert.equal(a.posts().length,0);assert.equal(b.posts().length,1);assert.equal(f.c.store.get('planning',ga.id).status,'uncertain');assert.equal(f.c.store.spent(ga.id).model,1);assert.equal(f.c.store.request(ga.id,'plan-1').id,'held-plan-request');
});

test('one bounded readiness probe covers queued aliases and yields before probing the next service',{timeout:10000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b');a.state.online=false;const f=await fixture(t,[advertisedProfile('a',a.baseUrl),profile('b',b.baseUrl)]);
 for(let n=0;n<6;n++)f.submit('offline-'+n,'worker-a');const healthy=f.submit('healthy','worker-b');
 await f.worker.tick();assert.equal(a.gets().length,1);assert.equal(b.gets().length,0);assert.equal(f.worker.nextIdleCheck(f.c.now())<=f.c.now()+250,true);
 await advance(f.worker,()=>f.c.getTask(healthy.id).status==='awaiting_review');assert.equal(a.gets().length,1);assert.equal(b.posts().length,1);
});

test('mixed legacy history and opted-in planner have exactly one owning lane',{timeout:10000},async t=>{
 const a=await endpoint(t,'a'),f=await fixture(t,[profile('a',a.baseUrl)]);a.state.holdPost=Promise.withResolvers();a.state.reply=JSON.stringify({tasks:[{key:'answer',kind:'consult',objective:'Explain one planner owner',acceptance:['Answer']}]});
 const {providerPolicy,routingPolicy,...legacy}=f.raw,old=f.c.prepareGoal({...legacy,submissionId:'legacy-history'},'legacy-history-prepare');f.c.activateGoal({goalId:old.id,hash:old.hash},'legacy-history-active');
 const g=f.c.prepareGoal({...f.raw,submissionId:'single-planner',mode:'deepseek_only'},'single-planner-prepare');f.c.activateGoal({goalId:g.id,hash:g.hash},'single-planner-active');
 const tick=f.worker.tick();await waitFor(a.posted.promise);const duplicate=await f.worker.planner.tick({goalId:g.id});assert.equal(duplicate.waiting,true);assert.equal(duplicate.reasonCode,'planner_active');assert.equal(f.c.store.get('planning',g.id).status,'running');a.state.holdPost.resolve();await tick;await advance(f.worker,()=>f.c.store.get('planning',g.id).status==='completed');
 assert.equal(a.posts().length,1);assert.equal(f.c.store.spent(g.id).model,1);assert.equal(f.c.store.request(g.id,'plan-1').status,'completed');assert.equal(f.c.store.all('planning').length,1);
});

test('completed and waiting planner goals before the lane limit cannot starve a later eligible plan',{timeout:10000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,[profile('a',a.baseUrl),profile('b',b.baseUrl)]);const reply=JSON.stringify({tasks:[{key:'answer',kind:'consult',objective:'Explain fair planning',acceptance:['Answer']}]});a.state.reply=reply;b.state.reply=reply;
 const goals=[];for(let n=0;n<5;n++){const g=f.c.prepareGoal({...f.raw,submissionId:'plan-fair-'+n,mode:'deepseek_only',...(n===4?{providerPolicy:{...f.raw.providerPolicy,plannerWorkerId:'worker-b'}}:{})},'plan-fair-prepare-'+n);f.c.activateGoal({goalId:g.id,hash:g.hash},'plan-fair-active-'+n);goals.push(g);if(n<2){const planned=await f.worker.planner.tick({goalId:g.id});assert.equal(planned.status,'completed');f.c.control({taskId:planned.tasks[0],action:'pause'},'plan-fair-pause-'+n);}}
 for(const goal of goals.slice(2,4))f.c.store.tx(()=>f.c.store.put('planning',{id:goal.id,goalId:goal.id,status:'uncertain',attempt:1,owner:'old-planner',providerBinding:f.c.store.get('goal',goal.id).manifest.plannerBinding}));
 f.c.store.waitForChange=async()=>{};for(let n=0;n<15&&f.c.store.maybe('planning',goals[4].id)?.status!=='completed';n++){await f.worker.tick();await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(f.c.store.get('planning',goals[4].id).status,'completed');assert.equal(b.posts().length,1);assert.equal(a.posts().length,2);for(const goal of goals.slice(2,4))assert.equal(f.c.store.get('planning',goal.id).status,'uncertain');
});

test('saturated first review lanes leave later independent reviewer eligible without spending held work',{timeout:10000},async t=>{
 const {inferenceResource}=await import('../src/harness/scheduling/capacity.mjs'),{digest}=await import('../src/harness/contracts.mjs'),{claimAvailable}=await import('../src/harness/routing/runtime.mjs');
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),profiles=[{...profile('a',a.baseUrl),roles:['worker','reviewer']},{...profile('b',b.baseUrl),roles:['worker','reviewer']}],pub=p=>{const {credentialRef,...value}=p;return value;};
 const f=await fixture(t,profiles,{reviewPolicy:{version:1,source:'api',reviewer:pub(profiles[0]),fallback:'wait'}}),g2=f.c.prepareGoal({...f.raw,submissionId:'later-review',reviewPolicy:{version:1,source:'api',reviewer:pub(profiles[1]),fallback:'wait'}},'later-review-prepare');f.c.activateGoal({goalId:g2.id,hash:g2.hash},'later-review-active');
 const tasks=[f.submit('first-held','worker-a'),f.submit('second-held','worker-a'),f.c.submitTask({goalId:g2.id,submissionId:'later-free',kind:'consult',objective:'Explain independent review',acceptance:['Answer'],routing:{version:1,preferredProviderId:'worker-b'}},'later-free-task')];
 for(let n=0;n<3;n++){const owner='review-fair-'+n,context=f.worker.taskContext(owner),claimed=await claimAvailable(context);f.c.beginAttempt(claimed.id,owner);const result=await context.model(claimed,owner,'consult-1',[{role:'user',content:'{}'}]);f.c.completeTask(claimed.id,result,owner,{reviewRequired:true});}
 const goal=f.c.store.get('goal',f.g.id),reviewer=pub(profiles[0]),binding={version:1,providerId:reviewer.id,revision:reviewer.revision,profileHash:digest(reviewer),policyHash:goal.manifest.reviewPolicyHash};
 f.c.store.tx(()=>f.c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run('unknown-review-owner',f.g.id,'unknown-review-owner','model','reserved',JSON.stringify({capacityResource:inferenceResource(f.c,goal,binding)})));
 for(const ep of [a,b])ep.state.reply=JSON.stringify({decision:'accept',feedback:'Checked exact candidate',findings:[]});const before={a:a.posts().length,b:b.posts().length};
 f.c.store.waitForChange=async()=>{};for(let n=0;n<20&&f.c.getTask(tasks[2].id).status!=='accepted';n++){await f.worker.tick();await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(f.c.getTask(tasks[2].id).status,'accepted');assert.equal(b.posts().length-before.b,1);assert.equal(a.posts().length-before.a,0);for(const held of tasks.slice(0,2)){assert.equal(f.c.getTask(held.id).status,'awaiting_review');assert.equal(f.c.getTask(held.id).spent.apiReview,0);}assert.equal(f.c.store.request(f.g.id,'unknown-review-owner').status,'reserved');
});
