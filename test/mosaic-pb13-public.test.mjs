import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {Registry,canonical,digest,goalInputSchema,taskInputSchema} from '../src/harness/contracts.mjs';
import {startApi} from '../src/harness/api.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {OvernightPreflight} from '../src/harness/overnight-preflight.mjs';
import {repository,assignment} from './fixtures/mosaic-assignment/repository.mjs';
import {endpoint,profile,fixture,task,counts} from './fixtures/mosaic-pb13/public-fixture.mjs';
const gitEnv={PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:''};

test('released historical schema, approval and real replay identities remain exact canonical bytes',async t=>{
 const baseline=JSON.parse(await readFile(new URL('./fixtures/mosaic-pb13/legacy-baseline.json',import.meta.url),'utf8'));
 assert.equal(canonical(goalInputSchema),baseline.goalSchemaCanonical);assert.equal(canonical(taskInputSchema),baseline.taskSchemaCanonical);assert.equal(canonical(new Registry().snapshot().capabilities),baseline.capabilitiesCanonical);
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)]});
 const c=new Coordinator({root:f.root+'/legacy',now:()=>f.now});t.after(()=>c.close());
 for(const item of baseline.cases){
  const g=c.prepareGoal(item.raw,'legacy-'+item.mode);assert.equal(canonical(g.manifest),item.manifestCanonical);assert.equal(g.hash,item.goalHash);
  assert.equal(c.store.db.prepare('SELECT hash FROM commands WHERE key=?').get('legacy-'+item.mode).hash,item.goalCommand);
  const before=counts(c);assert.deepEqual(c.prepareGoal(item.raw,'legacy-'+item.mode),g);assert.deepEqual(counts(c),before);
  if(item.task){const fixed={...g,id:'historical-goal-fixed'};c.store.put('goal',fixed);c.activateGoal({goalId:fixed.id,hash:fixed.hash},'activate-fixed');
   const saved=c.submitTask(item.task.input,'legacy-task');assert.equal(canonical(saved.spec),item.task.specCanonical);assert.equal(saved.hash,item.task.hash);
   assert.equal(c.store.db.prepare('SELECT hash FROM commands WHERE key=?').get('legacy-task').hash,item.task.commandHash);
   assert.equal(c.store.db.prepare("SELECT hash FROM submissions WHERE kind='task'").get().hash,item.task.submissionHash);
   const before=counts(c);assert.deepEqual(c.submitTask(item.task.input,'legacy-task'),saved);c.submitTask(item.task.input,'new-replay-key');
   const after=counts(c);assert.equal(after.records,before.records);assert.equal(after.submissions,before.submissions);assert.equal(after.events,before.events);assert.equal(Object.hasOwn(saved.spec,'routing'),false);
  }
 }
});

test('Dispatcher preview is read-only and sequential claims pin rule choices and request route hashes',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,{profiles:[profile('a',a.baseUrl),profile('b',b.baseUrl)]}),g=await f.prepare();
 for(const [id,category,provider,endpoint]of [['one','backend','worker-a',a],['two','frontend','worker-b',b]]){
  const spec=task(id,category),before=counts(f.c),preview=await f.d.invoke('routing_preview',{goalId:g.id,task:spec});
  assert.equal(preview.binding.providerId,provider);assert.equal(preview.reasonCode,'availability_unknown');assert.equal(preview.status,'waiting');assert.match(preview.explanation,/Rule/);
  assert.equal(preview.expectedGoalHash,g.hash);assert.equal(preview.expectedGoalVersion,1);assert.deepEqual(counts(f.c),before);assert.equal(a.calls.length+b.calls.length,id==='one'?0:2);
  const submitted=await f.submit(g,spec,id,{expectedGoalHash:preview.expectedGoalHash,expectedGoalVersion:preview.expectedGoalVersion});assert.equal(submitted.providerBinding,undefined);assert.equal(submitted.spec.routing.category,category);
  await f.worker.tick();const result=f.c.getTask(submitted.id);assert.equal(result.result.content,'answer-'+provider.at(-1));assert.equal(result.providerBinding.providerId,provider);
  assert.equal(result.route.decision.reasonCode,'selected_by_rule');assert.equal(result.route.goalHash,g.hash);assert.equal(result.route.taskHash,result.hash);assert.equal(result.routeHash,digest(result.route));
  assert.equal(f.c.store.request(result.id,'consult-1').routeHash,result.routeHash);assert.equal(endpoint.posts().length,1);assert.equal(result.spent.model,1);
 }
});

test('preview guards reject stale approved versions and routing participates in replay identity',async t=>{
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)]}),g=await f.prepare(),spec=task('stale');
 const preview=await f.d.invoke('routing_preview',{goalId:g.id,task:spec}),goals=new Goals(f.c);
 const rev=goals.prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:{...f.raw,acceptance:['Changed approved criterion']}},'revision');goals.activateRevision({revisionId:rev.id,hash:rev.hash},'revision-approve');
 await assert.rejects(f.submit(g,spec,'stale',{expectedGoalHash:preview.expectedGoalHash,expectedGoalVersion:preview.expectedGoalVersion}),/approval|version|hash/i);assert.equal(f.c.store.all('task').length,0);
 const saved=await f.submit(g,spec);await assert.rejects(f.submit(g,task('stale','frontend')),/conflict/i);await assert.rejects(f.submit(g,task('stale','frontend'),'other-command'),/conflict/i);assert.equal(f.c.getTask(saved.id).spent.model,0);
});

test('unsupported requirements and mutated approved routing send zero requests without fallback',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,{profiles:[profile('a',a.baseUrl),profile('b',b.baseUrl)]}),g=await f.prepare();
 for(const routing of [{version:1,preferredProviderId:'outside'},{version:1,minContextTokens:16001},{version:1,maxOutputTokens:4001}])await assert.rejects(f.submit(g,task('invalid','backend',{routing})),/routing|provider|context|output/i);
 assert.equal(f.c.store.all('task').length,0);assert.equal(a.calls.length+b.calls.length,0);
 const saved=await f.submit(g,task('valid')),changed=f.c.store.get('goal',g.id);changed.manifest.routingPolicy.defaultWorkerId='worker-b';f.c.store.put('goal',changed);
 await f.worker.tick();assert.equal(f.c.getTask(saved.id).status,'blocked');assert.equal(a.calls.length+b.calls.length,0);
});

test('read-only preview explains statically ineligible choices as route results',async t=>{
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)]}),g=await f.prepare();
 for(const [routing,reason]of [[{version:1,preferredProviderId:'outside'},'provider_not_approved'],[{version:1,minContextTokens:16001},'context_limit_insufficient'],[{version:1,maxOutputTokens:4001},'output_limit_insufficient']]){
  const before=counts(f.c),preview=await f.d.invoke('routing_preview',{goalId:g.id,task:task('preview-ineligible','backend',{routing})});assert.equal(preview.status,'ineligible');assert.equal(preview.reasonCode,reason);assert.equal(preview.binding,null);assert.equal(preview.expectedGoalHash,g.hash);assert.deepEqual(counts(f.c),before);assert.equal(a.calls.length,0);
 }
});

test('offline readiness probes only the selected endpoint and spends no request or attempts',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,{profiles:[profile('a',a.baseUrl),profile('b',b.baseUrl)]}),g=await f.prepare(),saved=await f.submit(g,task('offline','frontend'));
 b.state.online=false;await f.worker.tick();let waiting=f.c.getTask(saved.id);assert.equal(waiting.status,'queued');assert.equal(waiting.spent.model,0);assert.equal(waiting.attempts,0);assert.equal(waiting.providerBinding,undefined);assert.equal(waiting.routingWait.decision.reasonCode,'provider_offline');assert.equal(b.gets().length,1);assert.equal(a.calls.length,0);
 const before=counts(f.c);await f.worker.tick();assert.deepEqual(counts(f.c),before);assert.equal(b.gets().length,1);
 b.state.online=true;f.advance(15000);await f.worker.tick();waiting=f.c.getTask(saved.id);assert.equal(waiting.result.content,'answer-b');assert.equal(waiting.routingWait,undefined);assert.equal(a.calls.length,0);
});

for(const action of ['pause','stop','deadline'])test('control '+action+' during selected availability await prevents claim and POST',async t=>{
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)]}),g=await f.prepare(),saved=await f.submit(g,task('held'));
 a.state.hold=Promise.withResolvers();const tick=f.worker.tick();await a.entered.promise;
 if(action==='deadline')f.advance(36000000);else f.c.control({goalId:g.id,action},'control');a.state.hold.resolve();await tick;
 assert.equal(a.posts().length,0);assert.equal(f.c.getTask(saved.id).spent.model,0);assert.equal(f.c.getTask(saved.id).providerBinding,undefined);
});

test('CLI call prepare preview submit shares Dispatcher routing and exact request pins',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,{profiles:[profile('a',a.baseUrl),profile('b',b.baseUrl)]});
 const token='dummy-loopback-bearer-'.repeat(3),api=await startApi({dispatcher:f.d,token,headless:true});t.after(()=>api.close());await writeFile(f.root+'/connection.json',JSON.stringify({url:api.url,token}));
 const call=async(name,input)=>JSON.parse((await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../src/harness/cli.mjs',import.meta.url)),'call','--root',f.root,'--tool',name,'--input-json',JSON.stringify(input)],{timeout:10000})).stdout);
 const g=await call('goal_prepare',{manifest:f.raw,idempotencyKey:'cli-prepare'});await call('goal_activate',{goalId:g.id,hash:g.hash,idempotencyKey:'cli-activate'});
 for(const [id,category,provider]of [['cli-a','backend','worker-a'],['cli-b','frontend','worker-b']]){
  const spec=task(id,category),p=await call('routing_preview',{goalId:g.id,task:spec}),saved=await call('task_submit',{goalId:g.id,task:spec,expectedGoalHash:p.expectedGoalHash,expectedGoalVersion:p.expectedGoalVersion,idempotencyKey:id});
  await f.worker.tick();const result=await call('task_get',{taskId:saved.id});assert.equal(result.providerBinding.providerId,provider);assert.equal(f.c.store.request(saved.id,'consult-1').routeHash,result.routeHash);
 }
 assert.equal(a.posts().length,1);assert.equal(b.posts().length,1);
});

test('leased coordinator can atomically claim after a successful selected-provider probe',async t=>{
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)]}),g=await f.prepare(),saved=await f.submit(g,task('leased'));
 f.c.acquireWorker('public-worker');await f.worker.tick();assert.equal(f.c.getTask(saved.id).result?.content,'answer-a');assert.equal(a.posts().length,1);
});

test('explicit goal revision and restart retain original route while the routing preference changes',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),pa=profile('a',a.baseUrl);pa.capabilities.taskKinds=['coding'];
 const f=await fixture(t,{profiles:[pa,profile('b',b.baseUrl)]}),g=await f.prepare(),saved=await f.submit(g,task('pinned','frontend'));
 await f.worker.tick();const before=f.c.getTask(saved.id),goals=new Goals(f.c),rev=goals.prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:{...f.raw,acceptance:['Current rubric'],routingPolicy:{...f.raw.routingPolicy,rules:[]}}},'revision');goals.activateRevision({revisionId:rev.id,hash:rev.hash},'rev-activate');
 const rebound=goals.rebind({taskId:saved.id},'rebind');assert.equal(rebound.goalVersion,2);assert.equal(rebound.route.goalVersion,1);assert.equal(rebound.route.goalHash,g.hash);assert.deepEqual(rebound.route,before.route);assert.deepEqual(rebound.providerBinding,before.providerBinding);assert.equal(rebound.deadline,before.deadline);assert.deepEqual(rebound.spent,before.spent);
 f.reopen();assert.deepEqual(f.c.getTask(saved.id).route,before.route);f.c.verifyWorkerBinding(f.c.getGoal(g.id),f.c.getTask(saved.id));assert.equal(a.posts().length,0);assert.equal(b.posts().length,1);
 const preview=await f.d.invoke('routing_preview',{goalId:g.id,task:task('pinned','frontend')});assert.equal(preview.reasonCode,'budget_exhausted');assert.match(preview.explanation,/worker-b/);
});

test('approved coding permission narrowing preserves route provenance and original repair request budget',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,{profiles:[profile('a',a.baseUrl),profile('b',b.baseUrl)]});
 f.raw.project={repo:'/tmp/pb13-no-code-execution',baseCommit:'a'.repeat(40),readPaths:['src/'],writePaths:['src/'],checks:[{id:'verify',argv:['node','checks/verify.mjs']}]};
 const g=await f.prepare(),saved=await f.submit(g,task('coding','frontend',{kind:'coding',limits:{modelCalls:2}}));
 const {claimAvailable}=await import('../src/harness/routing/runtime.mjs');let claimed=await claimAvailable(f.worker);assert.equal(claimed.providerBinding.providerId,'worker-b');
 await f.worker.model(claimed,'public-worker','original-model',[{role:'user',content:'{}'}]);f.c.control({taskId:saved.id,action:'stop'},'stop-original');f.c.boundary(saved.id,{phase:'attempt'},'public-worker');const stopped=f.c.getTask(saved.id);
 const goals=new Goals(f.c),raw={...f.raw,project:{...f.raw.project,writePaths:['src/a.mjs']},routingPolicy:{...f.raw.routingPolicy,rules:[]}},rev=goals.prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:raw},'narrow');goals.activateRevision({revisionId:rev.id,hash:rev.hash},'narrow-activate');
 const rebound=goals.rebind({taskId:saved.id,spec:{...stopped.spec,permissions:{...stopped.spec.permissions,writePaths:['src/a.mjs']}}},'narrow-task');assert.notEqual(rebound.hash,stopped.hash);assert.deepEqual(rebound.route,stopped.route);assert.equal(rebound.deadline,stopped.deadline);assert.equal(rebound.spent.model,1);
 claimed=f.c.claimNext('public-worker');await f.worker.model(claimed,'public-worker','repair-model',[{role:'user',content:'{}'}]);assert.equal(a.posts().length,0);assert.equal(b.posts().length,2);assert.equal(f.c.store.request(saved.id,'repair-model').routeHash,stopped.routeHash);assert.equal(f.c.getTask(saved.id).spent.model,2);
 await assert.rejects(f.worker.model(claimed,'public-worker','too-many',[{role:'user',content:'{}'}]),/budget/i);assert.equal(b.posts().length,2);
});

test('explicit route output ceiling is transported to the selected worker',async t=>{
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)]}),g=await f.prepare();await f.submit(g,task('bounded','backend',{routing:{version:1,maxOutputTokens:50}}));await f.worker.tick();assert.equal(a.posts()[0].body.max_tokens,50);
});

function spentRequest(c,taskId,{key='prior',binding,kind='model',status='completed'}={}){
 c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run('request-'+key,taskId,key,kind,status,JSON.stringify({...(binding?{[kind==='apiReview'?'reviewerBinding':'providerBinding']:binding}:{}),requestOutcome:status==='reserved'?'unknown':'completed',result:{content:'prior'}}));
}
test('spent budget blocks before even a selected-endpoint readiness GET',async t=>{
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)]}),g=await f.prepare(),saved=await f.submit(g,task('spent'));
 spentRequest(f.c,saved.id);await f.worker.tick();assert.equal(f.c.getTask(saved.id).status,'blocked');assert.equal(a.calls.length,0);assert.equal(f.c.getTask(saved.id).spent.model,1);
});

test('reserved inference on selected group is busy without probing or fallback',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,{profiles:[profile('a',a.baseUrl),profile('b',b.baseUrl)]}),g=await f.prepare(),saved=await f.submit(g,task('busy','frontend'));
 spentRequest(f.c,'unrelated',{key:'review',binding:f.c.providerBinding(f.c.getGoal(g.id),'worker-b'),kind:'apiReview',status:'reserved'});
 const before=counts(f.c),p=await f.d.invoke('routing_preview',{goalId:g.id,task:task('busy','frontend')});assert.equal(p.reasonCode,'provider_busy');assert.deepEqual(counts(f.c),before);
 await f.worker.tick();assert.equal(f.c.getTask(saved.id).routingWait.decision.reasonCode,'provider_busy');assert.equal(a.calls.length+b.calls.length,0);assert.equal(f.c.getTask(saved.id).spent.model,0);
});

for(const resource of ['selected profile','shared group'])test('resumed pin waits on already-busy '+resource+' and later uses the same original route',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),profiles=[profile('a',a.baseUrl),profile('b',b.baseUrl)].map(p=>resource==='shared group'?{...p,capacityGroup:'shared'}:p),f=await fixture(t,{profiles}),g=await f.prepare(),spec=task('resume-busy','frontend'),saved=await f.submit(g,spec);
 const {claimAvailable,previewRoute}=await import('../src/harness/routing/runtime.mjs'),claimed=await claimAvailable(f.worker);f.c.control({taskId:saved.id,action:'pause'},'pause-pin');f.c.boundary(saved.id,{},'public-worker');
 // A new approved preference must not replace the started pin during a wait.
 const goals=new Goals(f.c),rev=goals.prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:{...f.raw,routingPolicy:{...f.raw.routingPolicy,rules:[]}}},'new-route');goals.activateRevision({revisionId:rev.id,hash:rev.hash},'new-route-active');goals.rebind({taskId:saved.id},'same-pin-rebind');
 const binding=f.c.providerBinding(f.c.getGoal(g.id),resource==='shared group'?'worker-a':'worker-b');spentRequest(f.c,'other-task',{key:'busy-resume',binding,kind:'apiReview',status:'reserved'});assert.equal(previewRoute(f.c,{goalId:g.id,task:spec}).reasonCode,'provider_busy');
 await f.worker.tick();let current=f.c.getTask(saved.id);assert.equal(b.posts().length,0);assert.equal(a.calls.length,0);assert.equal(b.gets().length,1);assert.equal(current.status,'queued');assert.equal(current.attempts,0);assert.equal(current.spent.model,0);assert.deepEqual(current.providerBinding,claimed.providerBinding);assert.deepEqual(current.route,claimed.route);assert.equal(current.routeHash,claimed.routeHash);assert.equal(current.deadline,claimed.deadline);assert.equal(current.routingWait.decision.reasonCode,'provider_busy');assert.equal(current.routingWait.decision.binding.providerId,'worker-b');
 f.c.store.db.prepare("UPDATE requests SET status='completed' WHERE key='busy-resume'").run();f.advance(15000);await f.worker.tick();current=f.c.getTask(saved.id);assert.equal(current.result.content,'answer-b');assert.equal(b.posts().length,1);assert.equal(a.calls.length,0);assert.equal(b.gets().length,1);assert.equal(current.routeHash,claimed.routeHash);assert.deepEqual(current.route,claimed.route);assert.equal(current.routingWait,undefined);assert.equal(current.spent.model,1);assert.equal(current.deadline,claimed.deadline);assert.equal(f.c.store.request(saved.id,'consult-1').routeHash,claimed.routeHash);assert.equal(f.c.store.events(0,1000).filter(e=>e.type==='task.routed'&&e.task_id===saved.id).length,1);
});

test('busy resource cannot block exact completed response replay at exhausted original budget',async t=>{
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)]}),g=await f.prepare(),saved=await f.submit(g,task('cached-busy')),{claimAvailable}=await import('../src/harness/routing/runtime.mjs'),claimed=await claimAvailable(f.worker);f.c.beginAttempt(saved.id,'public-worker');
 await f.worker.model(claimed,'public-worker','consult-1',[{role:'user',content:'{}'}]);const request=f.c.store.request(saved.id,'consult-1');f.c.control({taskId:saved.id,action:'pause'},'pause-cached');f.c.boundary(saved.id,{phase:'response-saved'},'public-worker');f.c.control({taskId:saved.id,action:'resume'},'resume-cached');spentRequest(f.c,'other-task',{key:'busy-cached',binding:claimed.providerBinding,kind:'apiReview',status:'reserved'});
 await f.worker.tick();const current=f.c.getTask(saved.id);assert.equal(current.result.content,'answer-a');assert.equal(current.status,'awaiting_review');assert.equal(current.spent.model,1);assert.equal(current.attempts,1);assert.equal(a.posts().length,1);assert.equal(a.gets().length,1);assert.equal(current.routeHash,claimed.routeHash);assert.equal(current.deadline,claimed.deadline);assert.equal(current.routingWait,undefined);assert.equal(f.c.store.request(saved.id,'consult-1').id,request.id);assert.equal(f.c.store.request('other-task','busy-cached').status,'reserved');
});

test('cached coding replay can advance locally but the next fresh exchange waits on the original busy pin',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,{profiles:[profile('a',a.baseUrl),profile('b',b.baseUrl)]});f.raw.project={repo:'/tmp/pb13-cached-step-fixture',baseCommit:'a'.repeat(40),readPaths:['src/'],writePaths:['src/'],checks:[{id:'verify',argv:['node','checks/verify.mjs']}]};
 const g=await f.prepare(),saved=await f.submit(g,task('cached-code','frontend',{kind:'coding',limits:{modelCalls:2}})),{claimAvailable}=await import('../src/harness/routing/runtime.mjs'),claimed=await claimAvailable(f.worker);f.c.beginAttempt(saved.id,'public-worker');const cp={phase:'model',attempt:1,exchange:0,executionBase:'a'.repeat(40)};f.c.boundary(saved.id,cp,'public-worker');await f.worker.model(f.c.getTask(saved.id),'public-worker','code-1-0',[{role:'user',content:'{}'}]);
 f.c.control({taskId:saved.id,action:'pause'},'pause-code');f.c.boundary(saved.id,cp,'public-worker');f.c.control({taskId:saved.id,action:'resume'},'resume-code');spentRequest(f.c,'other-task',{key:'busy-code',binding:claimed.providerBinding,kind:'apiReview',status:'reserved'});
 f.worker.adapters.coding={step:async(current,owner)=>{await f.worker.model(current,owner,`code-1-${current.checkpoint.exchange}`,[{role:'user',content:'{}'}]);return f.c.boundary(current.id,{...current.checkpoint,exchange:current.checkpoint.exchange+1},owner);}};
 await f.worker.tick();assert.equal(f.c.getTask(saved.id).checkpoint.exchange,1);assert.equal(b.posts().length,1);await f.worker.tick();let current=f.c.getTask(saved.id);assert.equal(b.posts().length,1);assert.equal(current.status,'suspended');assert.equal(current.spent.model,1);assert.equal(current.attempts,1);assert.equal(current.owner,null);assert.equal(current.routeHash,claimed.routeHash);assert.equal(current.routingWait.decision.reasonCode,'provider_busy');
 f.c.store.db.prepare("UPDATE requests SET status='completed' WHERE key='busy-code'").run();f.advance(15000);await f.worker.tick();current=f.c.getTask(saved.id);assert.equal(b.posts().length,2);assert.equal(a.calls.length,0);assert.equal(current.spent.model,2);assert.equal(current.attempts,1);assert.equal(current.routeHash,claimed.routeHash);assert.equal(current.deadline,claimed.deadline);assert.equal(current.routingWait,undefined);
});

test('busy unknown request on the owned task retains its running slot without another attempt or dispatch',async t=>{
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)]}),g=await f.prepare(),saved=await f.submit(g,task('own-unknown')),{claimAvailable}=await import('../src/harness/routing/runtime.mjs'),claimed=await claimAvailable(f.worker);spentRequest(f.c,saved.id,{key:'consult-1',binding:claimed.providerBinding,status:'reserved'});
 await f.worker.tick();const current=f.c.getTask(saved.id);assert.equal(a.posts().length,0);assert.equal(current.status,'running');assert.equal(current.owner,'public-worker');assert.equal(current.attempts,0);assert.equal(current.spent.model,1);assert.equal(current.routeHash,claimed.routeHash);assert.equal(current.routingWait,undefined);assert.equal(f.c.store.request(saved.id,'consult-1').status,'reserved');assert.equal(f.c.claimNext('other-owner'),null);
});

for(const mutation of ['revision','budget','busy','catalog'])test(mutation+' arriving during availability cannot authorize a stale claim',async t=>{
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)]}),g=await f.prepare(),saved=await f.submit(g,task('changed'));a.state.hold=Promise.withResolvers();const tick=f.worker.tick();await a.entered.promise;
 if(mutation==='revision'){const goals=new Goals(f.c),rev=goals.prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:{...f.raw,acceptance:['Updated approval']}},'rev');goals.activateRevision({revisionId:rev.id,hash:rev.hash},'rev-active');}
 if(mutation==='catalog')f.c.providerRegistry=ProviderRegistry({profiles:[{...profile('a',a.baseUrl),revision:'r2'}],credentialResolver:()=> 'dummy-bearer'});
 if(mutation==='budget')spentRequest(f.c,saved.id);
 if(mutation==='busy')spentRequest(f.c,'unrelated',{key:'held',binding:f.c.providerBinding(f.c.getGoal(g.id),'worker-a'),kind:'apiReview',status:'reserved'});
 a.state.hold.resolve();await tick;assert.equal(a.posts().length,0);assert.equal(f.c.getTask(saved.id).providerBinding,undefined);
});

for(const action of ['pause','stop','deadline'])test('route claim retains original pre-POST '+action+' guard across credential await',async t=>{
 const credentials=Promise.withResolvers(),entered=Promise.withResolvers();let reads=0;
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)],credentialResolver:async()=>{if(++reads===2){entered.resolve();await credentials.promise;}return 'dummy-bearer';}}),g=await f.prepare(),saved=await f.submit(g,task('credential'));
 const tick=f.worker.tick();await entered.promise;if(action==='deadline')f.advance(36000000);else f.c.control({goalId:g.id,action},'hold');credentials.resolve();await tick;
 assert.equal(a.posts().length,0);assert.equal(f.c.getTask(saved.id).spent.model,1);assert.equal(f.c.store.request(saved.id,'consult-1').requestOutcome,'not_dispatched');assert.ok(f.c.getTask(saved.id).routeHash);
});

test('worker planner keeps its provider pin and validates every proposed route before materializing children',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,{profiles:[profile('a',a.baseUrl),profile('b',b.baseUrl)],mode:'deepseek_only'}),g=await f.prepare();
 a.state.plan={tasks:[{key:'front',kind:'consult',objective:'Explain frontend',acceptance:['Answer'],routing:{version:1,category:'frontend'}}]};
 await f.worker.tick();let current=f.c.getGoal(g.id);assert.equal(current.planning.providerBinding.providerId,'worker-a');assert.equal(current.tasks[0].spec.routing.category,'frontend');assert.equal(current.tasks[0].providerBinding,undefined);await f.worker.tick();assert.equal(f.c.getTask(current.tasks[0].id).result.content,'answer-b');assert.equal(a.posts().length,1);assert.equal(b.posts().length,1);
 const g2=f.c.prepareGoal({...f.raw,submissionId:'bad-plan'},'bad-goal');f.c.activateGoal({goalId:g2.id,hash:g2.hash},'bad-active');a.state.plan={tasks:[{key:'valid',kind:'consult',objective:'A valid first task',acceptance:['Answer']},{key:'outside',kind:'consult',objective:'Outside worker',acceptance:['Answer'],routing:{version:1,preferredProviderId:'outside'}}]};
 for(let n=0;n<3;n++)await f.worker.tick();current=f.c.getGoal(g2.id);assert.equal(current.planning.status,'blocked');assert.equal(current.tasks.length,0);assert.equal(current.planning.spent,3);assert.equal(b.posts().length,1);
 const project={repo:'/tmp/pb13-planner-scope-fixture',baseCommit:'a'.repeat(40),readPaths:['src/'],writePaths:['src/'],checks:[{id:'verify',argv:['node','checks/verify.mjs']}]};
 const g3=f.c.prepareGoal({...f.raw,submissionId:'scope-plan',project},'scope-goal');f.c.activateGoal({goalId:g3.id,hash:g3.hash},'scope-active');a.state.plan={tasks:[{key:'valid',kind:'consult',objective:'Valid child',acceptance:['Answer']},{key:'expanded',kind:'coding',objective:'Forbidden scope',acceptance:['Fail closed'],permissions:{readPaths:['src/'],writePaths:['outside/'],checks:['verify']},routing:{version:1,category:'frontend'}}]};
 for(let n=0;n<3;n++)await f.worker.tick();assert.equal(f.c.getGoal(g3.id).tasks.length,0);assert.equal(f.c.getGoal(g3.id).planning.spent,3);assert.ok(f.c.getGoal(g3.id).planning.feedback.every(message=>/scope/.test(message)));
});

test('shared capacity-group inference is busy even when the selected provider ID differs',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),profiles=[profile('a',a.baseUrl),profile('b',b.baseUrl)].map(p=>({...p,capacityGroup:'shared'})),f=await fixture(t,{profiles}),g=await f.prepare(),saved=await f.submit(g,task('shared','frontend'));
 spentRequest(f.c,g.id,{key:'shared-planner',binding:f.c.providerBinding(f.c.getGoal(g.id),'worker-a'),status:'reserved'});
 await f.worker.tick();assert.equal(f.c.getTask(saved.id).routingWait.decision.reasonCode,'provider_busy');assert.equal(a.calls.length+b.calls.length,0);assert.equal(f.c.getTask(saved.id).spent.model,0);
});

test('unstarted offline task changes preference only after approved revision and explicit rebind',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,{profiles:[profile('a',a.baseUrl),profile('b',b.baseUrl)]}),g=await f.prepare(),saved=await f.submit(g,task('unstarted','frontend'));
 b.state.online=false;await f.worker.tick();const waited=f.c.getTask(saved.id),goalDeadline=f.c.getGoal(g.id).deadline;assert.equal(waited.providerBinding,undefined);assert.equal(waited.startedAt,null);
 const goals=new Goals(f.c),rev=goals.prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:{...f.raw,routingPolicy:{...f.raw.routingPolicy,rules:[]}}},'new-preference');goals.activateRevision({revisionId:rev.id,hash:rev.hash},'new-preference-active');f.advance(15000);await f.worker.tick();assert.equal(a.calls.length,0);assert.equal(f.c.getTask(saved.id).goalVersion,1);
 const rebound=goals.rebind({taskId:saved.id},'explicit-rebind');assert.equal(rebound.routingWait,undefined);assert.equal(rebound.providerBinding,undefined);assert.equal(rebound.spent.model,0);assert.equal(f.c.getGoal(g.id).deadline,goalDeadline);await f.worker.tick();const done=f.c.getTask(saved.id);assert.equal(done.providerBinding.providerId,'worker-a');assert.equal(done.route.goalVersion,2);assert.equal(done.spent.model,1);assert.equal(b.posts().length,0);
});

test('restart with changed catalog blocks on the original pin and never reroutes to a healthy endpoint',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),profiles=[profile('a',a.baseUrl),profile('b',b.baseUrl)],f=await fixture(t,{profiles}),g=await f.prepare(),saved=await f.submit(g,task('catalog','frontend'));
 const {claimAvailable}=await import('../src/harness/routing/runtime.mjs');await claimAvailable(f.worker);const before=f.c.getTask(saved.id);f.reopen();f.c.providerRegistry=ProviderRegistry({profiles:[profiles[0],{...profiles[1],revision:'r2',baseUrl:a.baseUrl,capacityGroup:profiles[0].capacityGroup}],credentialResolver:()=> 'dummy-bearer'});await f.worker.tick();const after=f.c.getTask(saved.id);assert.equal(after.status,'blocked');assert.deepEqual(after.providerBinding,before.providerBinding);assert.equal(after.routeHash,before.routeHash);assert.equal(after.spent.model,0);assert.equal(a.calls.length,0);assert.equal(b.posts().length,0);
});

test('route pre-POST fence rechecks original budget after credential resolution',async t=>{
 const release=Promise.withResolvers(),entered=Promise.withResolvers();let reads=0;
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)],credentialResolver:async()=>{if(++reads===2){entered.resolve();await release.promise;}return 'dummy-bearer';}}),g=await f.prepare(),saved=await f.submit(g,task('budget-race'));
 const tick=f.worker.tick();await entered.promise;spentRequest(f.c,saved.id,{key:'external-spent'});release.resolve();await tick;assert.equal(a.posts().length,0);assert.equal(f.c.store.request(saved.id,'consult-1').requestOutcome,'not_dispatched');
});

for(const point of ['response-saved','request-inflight'])test('owned process restart at '+point+' retains route and original request ownership', {timeout:15000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),profiles=[profile('a',a.baseUrl),profile('b',b.baseUrl)],f=await fixture(t,{profiles}),g=await f.prepare(),saved=await f.submit(g,task('crash','frontend'));
 if(point==='request-inflight')b.state.holdPost=Promise.withResolvers();f.c.close();
 const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/mosaic-pb13/routed-child.mjs',import.meta.url)),JSON.stringify({root:f.root,now:f.now,profiles,point})],{env:{PATH:process.env.PATH,TMPDIR:f.root},stdio:['ignore','ignore','pipe','pipe']});
 const closed=once(child,'close');let errors='';child.stderr.on('data',part=>{errors+=part;});t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;});
 await Promise.race([once(child.stdio[3],'data'),closed.then(()=>{throw Error('Child exited before barrier: '+errors);})]);if(point==='request-inflight')await b.posted.promise;
 child.kill('SIGKILL');assert.deepEqual(await closed,[null,'SIGKILL']);f.reopen();const before=f.c.getTask(saved.id),request=f.c.store.request(saved.id,'consult-1');assert.equal(before.providerBinding.providerId,'worker-b');assert.equal(request.routeHash,before.routeHash);
 // A new configured member/default preference cannot move an already-bound task.
 const unrelated=profile('c','http://127.0.0.1:1/v1');f.c.providerRegistry=ProviderRegistry({profiles:[...profiles,unrelated],credentialResolver:()=> 'rotated-dummy-bearer'});
 f.c.acquireWorker('public-worker');assert.equal(f.c.getTask(saved.id).status,'uncertain');
 if(point==='response-saved'){f.c.recoverSaved(saved.id,'public-worker');await f.worker.tick();assert.equal(f.c.getTask(saved.id).result.content,'answer-b');}
 else{assert.throws(()=>f.c.recoverSaved(saved.id,'public-worker'),/ambiguous|pending/i);await f.worker.tick();assert.equal(f.c.getTask(saved.id).status,'uncertain');}
 const after=f.c.getTask(saved.id);assert.equal(after.routeHash,before.routeHash);assert.deepEqual(after.providerBinding,before.providerBinding);assert.equal(after.deadline,before.deadline);assert.equal(after.spent.model,1);assert.equal(f.c.store.request(saved.id,'consult-1').id,request.id);assert.equal(a.calls.length,0);assert.equal(b.posts().length,1);assert.equal(b.gets().length,1);
});

test('assignment intake forwards exact routing approval and legacy intake cannot select it',async t=>{
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)]}),repo=await repository({root:f.root,env:gitEnv});
 const raw={...assignment(repo,{mode:'collaborative'}),providerPolicy:f.raw.providerPolicy,routingPolicy:f.raw.routingPolicy,environment:'fixture',limits:{hours:1,maxTasks:2,reviewAgentRuns:2}};
 const prepared=await f.d.invoke('assignment_prepare',{manifest:raw,idempotencyKey:'intake'});assert.equal(prepared.status,'prepared');const g=f.c.getGoal(prepared.goalId);assert.deepEqual(g.manifest.routingPolicy,f.raw.routingPolicy);assert.equal(g.status,'draft');assert.equal(a.calls.length,0);
 const before=counts(f.c);assert.deepEqual(await f.d.invoke('assignment_prepare',{manifest:raw,idempotencyKey:'intake'}),prepared);assert.deepEqual(counts(f.c),before);
 await assert.rejects(f.d.invoke('legacy_assignment_prepare',{manifest:raw,idempotencyKey:'legacy-intake'}),/legacy.*policy/i);
});

test('routing cannot widen host mode, actor, capability or configured pool authority',async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),pa=profile('a',a.baseUrl);pa.capabilities.taskKinds=['coding'];const f=await fixture(t,{profiles:[pa,profile('b',b.baseUrl)]});
 await assert.rejects(f.d.invoke('goal_prepare',{manifest:{...f.raw,mode:'codex_only'},idempotencyKey:'host-only'}),/worker authority/i);
 const g=await f.prepare();await assert.rejects(f.submit(g,task('host','frontend',{actor:'codex'})),/routing/i);await assert.rejects(f.submit(g,task('bad-kind')),/capability/i);
 const before=counts(f.c);await assert.rejects(f.submit(g,task('extra','frontend',{routing:{version:1,requiredCapabilities:['research']}})),/invalid/i);assert.deepEqual(counts(f.c),before);
 const saved=await f.submit(g,task('eligible','frontend'));await f.worker.tick();assert.equal(f.c.getTask(saved.id).result.content,'answer-b');assert.equal(a.calls.length,0);
 const serialized=JSON.stringify(f.c.snapshot());for(const secret of ['credentialRef','dummy-bearer','dummy-a','dummy-b'])assert.equal(serialized.includes(secret),false);
});

test('removed routing approval or tampered request route hash cannot authorize replay',async t=>{
 const a=await endpoint(t,'a'),f=await fixture(t,{profiles:[profile('a',a.baseUrl)]}),g=await f.prepare(),saved=await f.submit(g,task('tamper'));
 const {claimAvailable}=await import('../src/harness/routing/runtime.mjs'),claimed=await claimAvailable(f.worker);await f.worker.model(claimed,'public-worker','consult-1',[{role:'user',content:'{}'}]);
 const row=f.c.store.request(saved.id,'consult-1');f.c.store.db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify({...row,routeHash:'0'.repeat(64)}),row.id);
 await assert.rejects(f.worker.model(claimed,'public-worker','consult-1',[{role:'user',content:'{}'}]),/binding/i);
 const mutated=f.c.store.get('goal',g.id);delete mutated.manifest.routingPolicy;delete mutated.manifest.routingPolicyHash;f.c.store.put('goal',mutated);assert.throws(()=>f.c.verifyWorkerBinding(mutated,f.c.getTask(saved.id)),/hash|route/i);
 delete mutated.manifest.providerPolicy;delete mutated.manifest.providerPolicyHash;f.c.store.put('goal',mutated);assert.throws(()=>f.c.verifyWorkerBinding(mutated,f.c.getTask(saved.id)),/hash|route/i);assert.equal(a.posts().length,1);
});

async function overnight(t,options={}){
 const a=await endpoint(t,'a'),b=await endpoint(t,'b'),f=await fixture(t,{profiles:[profile('a',a.baseUrl),profile('b',b.baseUrl)],...options}),repo=await repository({root:f.root,env:gitEnv});
 Object.assign(f.raw,{mode:'overnight_review',modeVersion:2,project:{...assignment(repo).project,baseCommit:repo.baseCommit},overnightPolicy:{preflightCheckIds:['verify'],finalOnlyCheckIds:[],reconnectMs:30000}});
 const g=await f.d.invoke('goal_prepare',{manifest:f.raw,idempotencyKey:'overnight'});await new OvernightPreflight({c:f.c,config:{codexPath:process.execPath},checksFactory:()=>({verify:async()=>({fixture:true}),run:async checks=>checks.map(({id})=>({id,passed:true}))})}).run({goalId:g.id,hash:g.hash},'preflight');f.c.activateGoal({goalId:g.id,hash:g.hash},'overnight-active');
 const saved=f.c.submitTask({goalId:g.id,...task('overnight','frontend',{kind:'coding',role:'implementation',dependsOn:[],permissions:{readPaths:['src/'],writePaths:['src/'],checks:['verify']}})},'overnight-task');
 const {claimAvailable}=await import('../src/harness/routing/runtime.mjs');const claimed=await claimAvailable(f.worker);f.c.beginAttempt(saved.id,'public-worker');f.c.boundary(saved.id,{phase:'model',attempt:1,exchange:0,executionBase:repo.baseCommit},'public-worker');
 b.state.postStatus=429;await assert.rejects(f.worker.model(claimed,'public-worker','code-1-0',[{role:'user',content:'{}'}]));const waiting=f.c.getTask(saved.id);assert.equal(waiting.status,'suspended');assert.equal(waiting.spent.model,1);
 f.worker.adapters.coding={step:(current,owner)=>f.worker.model(current,owner,`code-1-${current.checkpoint.exchange}`,[{role:'user',content:'{}'}])};return {a,b,f,g,saved,waiting};
}

test('routed reconnect retries preserve original cutoff deadline and spend instead of refreshing readiness',async t=>{
 const {a,b,f,saved,waiting}=await overnight(t);b.state.online=false;f.advance(waiting.providerWait.retryAt-f.now);await f.worker.tick();const again=f.c.getTask(saved.id);
 assert.equal(again.providerWait.until,waiting.providerWait.until);assert.equal(again.deadline,waiting.deadline);assert.equal(again.routeHash,waiting.routeHash);assert.equal(again.spent.model,1);assert.equal(again.attempts,1);assert.equal(f.c.store.events(0,1000).filter(e=>e.type==='task.routed'&&e.task_id===saved.id).length,1);assert.equal(b.posts().length,1);assert.equal(a.calls.length,0);
 f.advance(waiting.providerWait.until-f.now);await f.worker.tick();assert.equal(f.c.getTask(saved.id).status,'blocked');assert.equal(b.posts().length,1);assert.equal(f.c.getTask(saved.id).providerWait.until,waiting.providerWait.until);
});

test('busy resumed reconnect waits without probes or spend and still expires at the original cutoff',async t=>{
 const {a,b,f,g,saved,waiting}=await overnight(t);spentRequest(f.c,'other-task',{key:'busy-reconnect',binding:waiting.providerBinding,kind:'apiReview',status:'reserved'});f.advance(waiting.providerWait.retryAt-f.now);await f.worker.tick();const held=f.c.getTask(saved.id);
 assert.equal(held.status,'suspended');assert.equal(held.spent.model,1);assert.equal(held.attempts,1);assert.equal(held.providerWait.until,waiting.providerWait.until);assert.equal(held.deadline,waiting.deadline);assert.equal(held.routeHash,waiting.routeHash);assert.equal(held.routingWait.decision.reasonCode,'provider_busy');assert.equal(b.gets().length,1);assert.equal(b.posts().length,1);assert.equal(a.calls.length,0);
 f.c.store.db.prepare("UPDATE requests SET status='completed' WHERE key='busy-reconnect'").run();f.advance(waiting.providerWait.until-f.now);await f.worker.tick();assert.equal(f.c.getTask(saved.id).status,'blocked');assert.equal(f.c.getTask(saved.id).providerWait.until,waiting.providerWait.until);assert.equal(f.c.getTask(saved.id).spent.model,1);assert.equal(f.c.getGoal(g.id).deadline>f.now,true);assert.equal(b.gets().length,1);assert.equal(b.posts().length,1);
});

test('busy observation after pinned reconnect probe clears readiness without refreshing the cutoff or spending',async t=>{
 const {a,b,f,saved,waiting}=await overnight(t),entered=Promise.withResolvers();b.state.postStatus=200;b.state.hold=Promise.withResolvers();b.state.onGet=()=>entered.resolve();f.advance(waiting.providerWait.retryAt-f.now);const tick=f.worker.tick();await entered.promise;
 spentRequest(f.c,'other-task',{key:'busy-after-probe',binding:waiting.providerBinding,kind:'apiReview',status:'reserved'});b.state.hold.resolve();await tick;const held=f.c.getTask(saved.id);
 assert.equal(held.status,'suspended');assert.equal(held.spent.model,1);assert.equal(held.attempts,1);assert.equal(held.providerWait.until,waiting.providerWait.until);assert.equal(held.providerWait.readyOwner,undefined);assert.equal(held.deadline,waiting.deadline);assert.equal(held.routeHash,waiting.routeHash);assert.equal(held.routingWait.decision.reasonCode,'provider_busy');assert.equal(b.gets().length,2);assert.equal(b.posts().length,1);assert.equal(a.calls.length,0);
 f.advance(waiting.providerWait.until-f.now);await f.worker.tick();assert.equal(f.c.getTask(saved.id).status,'blocked');assert.equal(f.c.getTask(saved.id).spent.model,1);assert.equal(b.gets().length,2);assert.equal(b.posts().length,1);
});

test('reconnectUntil still fences routed POST after credential await and retains both spent reservations',async t=>{
 const release=Promise.withResolvers(),entered=Promise.withResolvers();let reads=0;
 const {b,f,saved,waiting}=await overnight(t,{credentialResolver:async()=>{if(++reads===4){entered.resolve();await release.promise;}return 'dummy-bearer';}});b.state.postStatus=200;f.advance(waiting.providerWait.retryAt-f.now);const tick=f.worker.tick();await entered.promise;f.advance(waiting.providerWait.until-f.now);release.resolve();await tick;
 const final=f.c.getTask(saved.id);assert.equal(final.status,'blocked');assert.equal(final.deadline,waiting.deadline);assert.equal(final.routeHash,waiting.routeHash);assert.equal(final.spent.model,2);assert.equal(b.posts().length,1);assert.equal(f.c.store.request(saved.id,'code-1-1').reconnectUntil,waiting.providerWait.until);assert.equal(f.c.store.request(saved.id,'code-1-1').requestOutcome,'not_dispatched');
});
