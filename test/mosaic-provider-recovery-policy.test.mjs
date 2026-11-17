import test from 'node:test';
import assert from 'node:assert/strict';
import {server,models,rejection,success,provider,fixture,routedFixture,safeError,assertSpent,MODEL} from './fixtures/mosaic-provider-recovery-policy/harness.mjs';
import {parseRetryAfter,normalizeRetryHint,responseRetryHint,reconnectRetryAt} from '../src/adapters/retry-after.mjs';
import {claimAvailable,routeDecision} from '../src/harness/routing/runtime.mjs';
import {selectRoute} from '../src/harness/routing/router.mjs';

for(const kind of ['worker','planner']){
 test(kind+' manual recovery skips unsupported models and completes one later authorized POST',{timeout:10000},async t=>{
  const s=await server(t,(req,res,n)=>req.method==='GET'?rejection(res,405):n.post===1?rejection(res,429,undefined,'0'):success(res,kind));
  const f=fixture(t,kind,provider(s.baseUrl)),pins=f.pins();await f.tick();
  const wait=f.state().providerWait;assert.ok(wait);f.advance(wait.retryAt-f.now+1);await f.tick();
  assert.equal(f.state().status,kind==='worker'?'running':'completed');assert.equal(s.counts.get,0);assert.equal(s.counts.post,2);
  assert.deepEqual(f.pins(),pins);assertSpent(f,2);
 });
 test(kind+' long Retry-After prevents old fifteen-second eligibility and survives restart',{timeout:10000},async t=>{
  const s=await server(t,(req,res,n)=>req.method==='GET'?models(res):n.post===1?rejection(res):success(res,kind));
  const f=fixture(t,kind,provider(s.baseUrl,'advertised')),pins=f.pins(),start=f.now;await f.tick();
  const counts={...s.counts},wait=f.state().providerWait;
  f.advance(15001);f.restart();await f.tick();assert.deepEqual(s.counts,counts);assert.equal(wait.retryAt,start+60000);assert.deepEqual(f.state().providerWait,wait);
  f.advance(45000);await f.tick();assert.equal(s.counts.post,2);assert.deepEqual(f.pins(),pins);assertSpent(f,2);
 });
 for(const [status,code] of [[401],[403],[400,'context_length_exceeded'],[429,'context_length_exceeded']]){
  for(const streaming of [false,true])test(`${kind} ${streaming?'SSE':'JSON'} completion ${status}/${code??'auth'} is terminal despite Retry-After`,{timeout:10000},async t=>{
   const s=await server(t,(req,res)=>req.method==='GET'?models(res):rejection(res,status,code));
   const f=fixture(t,kind,provider(s.baseUrl,'advertised',{streaming}),{streaming}),pins=f.pins();await f.tick();
   assert.equal(f.state().status,'blocked');const counts={...s.counts};assertSpent(f,1);
   f.advance(60001);f.restart();await f.tick();assert.deepEqual(s.counts,counts);assertSpent(f,1);assert.deepEqual(f.pins(),pins);
   assert.equal(f.state().providerWait,undefined);
  });
  test(`${kind} advertised probe ${status}/${code??'auth'} stops reconnect without another reservation`,{timeout:10000},async t=>{
   const s=await server(t,(req,res,n)=>req.method==='GET'?(n.get===1?models(res):rejection(res,status,code)):rejection(res,429,undefined,'0'));
   const f=fixture(t,kind,provider(s.baseUrl,'advertised')),pins=f.pins();await f.tick();const wait=f.state().providerWait;
   f.advance(wait.retryAt-f.now+1);await f.tick();assert.equal(f.state().status,'blocked');const counts={...s.counts};
   assert.deepEqual(counts,{get:2,post:1});f.advance(60001);f.restart();await f.tick();assert.deepEqual(s.counts,counts);assertSpent(f,1);assert.deepEqual(f.pins(),pins);
  });
 }
 test(kind+' ambiguous completion keeps spent request and ownership despite terminal metadata',{timeout:10000},async t=>{
  let calls=0;const f=fixture(t,kind,{complete:async(_messages,options)=>{calls++;options.onModel?.(MODEL);throw Object.assign(safeError(401,'context_length_exceeded'),{requestOutcome:'unknown'});},availability:async()=>{throw Error('must not probe');}}),pins=f.pins();
  await f.tick();assert.equal(f.state().status,'uncertain');assert.ok(f.state().owner);const before=f.requests();
  f.advance(60001);f.restart();await f.tick();assert.equal(calls,1);assert.deepEqual(f.requests(),before);assert.deepEqual(f.pins(),pins);assert.equal(f.state().providerWait,undefined);
 });
}

for(const streaming of [false,true])test(`${streaming?'SSE':'JSON'} native HTTP retains only normalized bounded retry hint`,{timeout:10000},async t=>{
 const s=await server(t,(_req,res)=>rejection(res,429,'context_length_exceeded'));
 await assert.rejects(provider(s.baseUrl,'manual',{streaming}).complete([]),e=>{
  assert.equal(e.httpStatus,429);assert.equal(e.requestOutcome,'not_dispatched');assert.equal(e.providerErrorCode,'context_length_exceeded');
  assert.deepEqual(e.retryHint,{kind:'delay',milliseconds:60000});assert.doesNotMatch(JSON.stringify(e),/private provider text|retry-after/);return true;
 });assert.deepEqual(s.counts,{get:0,post:1});
});
test('injected Fetch retains Retry-After and known HTTP status',{timeout:10000},async()=>{
 let calls=0;const local=provider('http://127.0.0.1:1/v1','manual',{fetchImpl:async()=>{calls++;return new Response(JSON.stringify({error:{code:'context_length_exceeded'}}),{status:429,headers:{'retry-after':'60'}});}});
 await assert.rejects(local.complete([]),e=>{assert.deepEqual(e.retryHint,{kind:'delay',milliseconds:60000});assert.equal(e.providerErrorCode,'context_length_exceeded');assert.equal(e.requestOutcome,'not_dispatched');return true;});assert.equal(calls,1);
});

test('pure Retry-After parser enforces byte, syntax, calendar and safe integer boundaries',()=>{
 const now=Date.UTC(2026,10,17,10,0,0),delay=milliseconds=>({kind:'delay',milliseconds});
 for(const [input,expected] of [['0',delay(0)],['15',delay(15000)],['00060',delay(60000)],['0'.repeat(128),delay(0)],['9'.repeat(128),{kind:'beyond_safe_time'}],['9007199254740',delay(9007199254740000)],['9007199254741',{kind:'beyond_safe_time'}],['Tue, 17 Nov 2026 10:01:00 GMT',delay(60000)],['Tue, 17 Nov 2026 09:00:00 GMT',delay(0)]])assert.deepEqual(parseRetryAfter(input,now),expected,input);
 for(const input of [undefined,null,15,[],['60'],{},'', ' 60','60 ','+60','-1','0.1','1e3','Infinity','60, 70','60\r\n','60\t','60\u0085','é'.repeat(65),'0'.repeat(129),'2026-11-17T10:01:00Z','Tuesday, 17-Nov-26 10:01:00 GMT','Tue Nov 17 10:01:00 2026','Mon, 17 Nov 2026 10:01:00 GMT','Tue, 31 Nov 2026 10:01:00 GMT','Tue, 17 Nov 2026 25:01:00 GMT','Tue, 17 Nov 2026 10:01:00 UTC'])assert.equal(parseRetryAfter(input,now),null,String(input));
 assert.equal(parseRetryAfter('60',NaN),null);assert.equal(parseRetryAfter('60',0.5),null);
 assert.deepEqual(parseRetryAfter('Thu, 29 Feb 2024 00:00:00 GMT',Date.UTC(2024,1,28)),delay(86400000));
 assert.equal(parseRetryAfter('Sat, 29 Feb 2025 00:00:00 GMT',now),null);
});
test('normalized custom hints cannot add fields, shorten floor, overflow or retain raw data',()=>{
 const at=Number.MAX_SAFE_INTEGER-100000,until=at+90000;
 for(const value of [null,undefined,[],{},'60',{kind:'delay',milliseconds:-1},{kind:'delay',milliseconds:0.1},{kind:'delay',milliseconds:Infinity},{kind:'delay',milliseconds:60000,raw:'private'},{kind:'beyond_safe_time',milliseconds:1}]){
  assert.equal(normalizeRetryHint(value),null);assert.equal(reconnectRetryAt(at,until,value),at+15000);
 }
 for(const milliseconds of [0,1000,15000,60000])assert.equal(reconnectRetryAt(at,until,{kind:'delay',milliseconds}),at+Math.max(15000,milliseconds));
 for(const value of [{kind:'delay',milliseconds:Number.MAX_SAFE_INTEGER},{kind:'delay',milliseconds:90000},{kind:'beyond_safe_time'}])assert.equal(reconnectRetryAt(at,until,value),until);
 const throwing={get kind(){throw Error('untrusted optional metadata');}};
 assert.equal(normalizeRetryHint(throwing),null);
});
test('Fetch rejects combined or unsupported headers and native raw headers reject duplicates',()=>{
 const now=Date.UTC(2026,10,17,10);
 assert.equal(responseRetryHint({rawHeaders:['Retry-After','60','retry-after','90']},now),null);
 assert.deepEqual(responseRetryHint({rawHeaders:['Retry-After','60']},now),{kind:'delay',milliseconds:60000});
 for(const header of ['60, 90','Tue, 17 Nov 2026 10:01:00 GMT, Tue, 17 Nov 2026 10:02:00 GMT'])assert.equal(responseRetryHint({headers:new Headers({'Retry-After':header})},now),null);
 assert.equal(responseRetryHint({headers:{'retry-after':'60'}},now),null);
 assert.deepEqual(responseRetryHint({headers:new Headers({'Retry-After':'Tue, 17 Nov 2026 10:01:00 GMT'})},now),{kind:'delay',milliseconds:60000});
 class UnsupportedHeaders extends Headers{get(){throw Error('unsupported optional header access');}}
 assert.equal(responseRetryHint({headers:new UnsupportedHeaders()},now),null);
});

for(const streaming of [false,true]){
 test(`${streaming?'SSE':'JSON'} duplicate native Retry-After headers are discarded before normalization`,{timeout:10000},async t=>{
  const s=await server(t,(_req,res)=>{res.writeHead(429,['Retry-After','30','retry-after','60']);res.end('{}');});
  await assert.rejects(provider(s.baseUrl,'manual',{streaming}).complete([]),e=>{assert.equal(e.httpStatus,429);assert.equal(e.retryHint,undefined);return true;});assert.equal(s.counts.post,1);
 });
 for(const body of ['oversize','slow','abort'])test(`${streaming?'SSE':'JSON'} ${body} optional error body retains status and hint`,{timeout:10000},async t=>{
  const s=await server(t,(_req,res)=>{res.writeHead(429,{'retry-after':'60'});res.flushHeaders();if(body==='oversize')res.end('x'.repeat(4097));else if(body==='abort'){res.write('{');res.destroy();}});
  await assert.rejects(provider(s.baseUrl,'manual',{streaming,timeoutMs:body==='slow'?500:100}).complete([]),e=>{assert.equal(e.httpStatus,429);assert.equal(e.requestOutcome,'not_dispatched');assert.deepEqual(e.retryHint,{kind:'delay',milliseconds:60000});assert.equal(e.providerErrorCode,undefined);return true;});
  assert.equal(s.counts.post,1);
 });
}

for(const kind of ['worker','planner']){
 for(const [label,hint,delay] of [['short',{kind:'delay',milliseconds:1000},15000],['zero',{kind:'delay',milliseconds:0},15000],['invalid',{kind:'delay',milliseconds:'60000'},15000],['long',{kind:'delay',milliseconds:60000},60000],['beyond',{kind:'beyond_safe_time'},null],['overflow',{kind:'delay',milliseconds:Number.MAX_SAFE_INTEGER},null]])test(`${kind} ${label} custom hint respects original scheduling window`,{timeout:10000},async t=>{
  let calls=0;const f=fixture(t,kind,{complete:async()=>{calls++;throw Object.assign(safeError(),{retryHint:hint});}}),pins=f.pins(),start=f.now;
  await f.tick();const state=f.state(),until=state.providerWait.until;
  if(delay===null){assert.equal(state.status,'blocked');assert.match(state.reason,/No eligible.*original reconnect window/);assert.doesNotMatch(state.reason,/exhausted/);}
  else{assert.equal(state.providerWait.retryAt,start+delay);f.advance(delay-1);f.restart();await f.tick();assert.equal(calls,1);}
  assertSpent(f,1);assert.deepEqual(f.pins(),pins);assert.equal(f.state().providerWait.until,until);
 });
 test(kind+' subsequent availability cooldown retains the original start, expiry and spend',{timeout:10000},async t=>{
  let calls=0,probes=0;const f=fixture(t,kind,{complete:async()=>{calls++;throw Object.assign(safeError(),{retryHint:undefined});},availability:async()=>{probes++;throw safeError();}}),pins=f.pins();
  await f.tick();const first=f.state().providerWait;f.advance(first.retryAt-f.now+1);await f.tick();
  const second=f.state().providerWait;assert.equal(second.until,first.until);assert.equal(second.startedAt,first.startedAt);assert.equal(second.retryAt,f.now+60000);
  f.advance(15001);f.restart();await f.tick();assert.equal(probes,1);assert.equal(calls,1);assertSpent(f,1);assert.deepEqual(f.pins(),pins);
  f.advance(second.until-f.now+1);await f.tick();assert.equal(f.state().status,'blocked');assert.equal(probes,1);assert.equal(calls,1);
 });
 for(const action of ['pause','stop'])test(`${kind} ${action} during terminal advertised probe keeps control precedence`,{timeout:10000},async t=>{
  let f,calls=0,probes=0;f=fixture(t,kind,{complete:async()=>{calls++;throw Object.assign(safeError(),{retryHint:undefined});},availability:async()=>{probes++;f.c.control({goalId:f.id,action},'control');throw safeError(401);}});
  await f.tick();f.advance(f.state().providerWait.retryAt-f.now+1);await f.tick();assert.equal(f.c.getGoal(f.id).status,action==='pause'?'paused':'stopped');
  if(kind==='worker')assert.equal(f.state().status,action==='pause'?'paused':'stopped');else assert.notEqual(f.state().status,'blocked');
  f.advance(60001);await f.tick();assert.equal(calls,1);assert.equal(probes,1);assertSpent(f,1);
 });
 test(kind+' late terminal probe preserves original deadline settlement',{timeout:10000},async t=>{
  let f,calls=0;f=fixture(t,kind,{complete:async()=>{calls++;throw Object.assign(safeError(),{retryHint:undefined});},availability:async()=>{f.advance(3600000);throw safeError(403);}});const pins=f.pins();
  await f.tick();f.advance(f.state().providerWait.retryAt-f.now+1);await f.tick();assert.equal(f.state().status,kind==='worker'?'partial':'blocked');assert.match(f.state().reason,/deadline|window/i);assert.equal(calls,1);assertSpent(f,1);assert.deepEqual(f.pins(),pins);
 });
 test(kind+' changed current provider binding blocks recovery before a probe or reservation',{timeout:10000},async t=>{
  let calls=0,probes=0;const f=fixture(t,kind,{complete:async()=>{calls++;throw Object.assign(safeError(),{retryHint:undefined});},availability:async()=>{probes++;return true;}}),pins=f.pins();
  await f.tick();f.advance(f.state().providerWait.retryAt-f.now+1);f.c.verifyCurrentWorker=()=>{throw Error('Approved provider profile changed');};await f.tick();
  assert.equal(f.state().status,'blocked');assert.match(f.state().reason,/profile changed/);assert.equal(calls,1);assert.equal(probes,0);assertSpent(f,1);assert.deepEqual(f.pins(),pins);
 });
}

test('explicit manual eligibility validates identity with zero transport calls and legacy still probes',{timeout:10000},async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return {ok:true,json:async()=>({data:[{id:MODEL}]})};};
 const manual=provider('http://127.0.0.1:1/v1','manual',{apiKey:'fixture-key',fetchImpl});assert.equal(await manual.availability(),true);assert.equal(calls,0);
 manual.resolvedModel=MODEL;
 for(const model of ['', 'bad\nmodel','fixture-key']){manual.model=model;await assert.rejects(manual.availability(),/Invalid configured/);assert.equal(calls,0);}
 const legacy=provider('http://127.0.0.1:1/v1','manual',{capabilities:undefined,fetchImpl});assert.equal(await legacy.availability(),true);assert.equal(calls,1);
});

for(const kind of ['worker','planner']){
 test(kind+' advertised preflight cooldown forwards metadata without an initial POST',{timeout:10000},async t=>{
  const s=await server(t,(req,res,n)=>req.method==='GET'?(n.get===1?rejection(res):models(res)):success(res,kind));
  const f=fixture(t,kind,provider(s.baseUrl,'advertised')),pins=f.pins(),start=f.now;await f.tick();
  assert.deepEqual(s.counts,{get:1,post:0});assert.equal(f.state().providerWait.retryAt,start+60000);assertSpent(f,1);
  f.advance(15001);f.restart();await f.tick();assert.deepEqual(s.counts,{get:1,post:0});f.advance(45000);await f.tick();
  assert.deepEqual(s.counts,{get:3,post:1});assertSpent(f,2);assert.deepEqual(f.pins(),pins);
 });
 test(kind+' beyond-window probe hint blocks immediately with original wait retained',{timeout:10000},async t=>{
  let calls=0,probes=0;const f=fixture(t,kind,{complete:async()=>{calls++;throw Object.assign(safeError(),{retryHint:undefined});},availability:async()=>{probes++;throw Object.assign(safeError(),{retryHint:{kind:'beyond_safe_time'}});}});
  await f.tick();const first=f.state().providerWait;f.advance(first.retryAt-f.now+1);await f.tick();
  assert.equal(f.state().status,'blocked');assert.match(f.state().reason,/No eligible.*original reconnect window/);assert.equal(f.state().providerWait.until,first.until);
  f.advance(60001);f.restart();await f.tick();assert.equal(calls,1);assert.equal(probes,1);assertSpent(f,1);
 });
 test(kind+' terminal provider body and invalid secret header never reach durable events',{timeout:10000},async t=>{
  const key='private-fixture-key',s=await server(t,(req,res)=>req.method==='GET'?models(res):rejection(res,401,undefined,key));
  const f=fixture(t,kind,provider(s.baseUrl,'advertised',{apiKey:key}));await f.tick();
  assert.equal(f.state().status,'blocked');const rows=f.c.store.db.prepare('SELECT data FROM events').all();
  assert.doesNotMatch(JSON.stringify([f.state(),f.requests(),rows]),/private-fixture-key|private provider text|retry-after/);assert.equal(s.counts.post,1);assertSpent(f,1);
 });
}
test('planner third safe failure spends its original cap and cannot restart inference',{timeout:10000},async t=>{
 let calls=0;const f=fixture(t,'planner',{complete:async()=>{calls++;throw Object.assign(safeError(),{retryHint:undefined});},availability:async()=>true}),pins=f.pins();
 for(let i=0;i<3;i++){await f.tick();if(i<2)f.advance(f.state().providerWait.retryAt-f.now+1);}
 assert.equal(f.state().status,'blocked');assert.equal(f.state().attempt,3);assertSpent(f,3);const until=f.state().providerWait.until;
 f.advance(15001);f.restart();await f.tick();assert.equal(calls,3);assertSpent(f,3);assert.equal(f.state().providerWait.until,until);assert.deepEqual(f.pins(),pins);
});
test('worker exhausted request budget cannot use manual eligibility for another POST',{timeout:10000},async t=>{
 let calls=0;const f=fixture(t,'worker',{complete:async()=>{calls++;throw Object.assign(safeError(),{retryHint:undefined});},availability:async()=>true},{modelCalls:1}),pins=f.pins();
 await f.tick();f.advance(f.state().providerWait.retryAt-f.now+1);await f.tick();assert.equal(f.state().status,'blocked');assert.match(f.state().reason,/budget/i);assert.equal(calls,1);assertSpent(f,1);assert.deepEqual(f.pins(),pins);
});

for(const kind of ['worker','planner'])test(kind+' throwing error retryHint accessor cannot replace unknown inference ownership',{timeout:10000},async t=>{
 let calls=0;const f=fixture(t,kind,{complete:async(_messages,options)=>{calls++;options.onModel?.(MODEL);const error=Object.assign(safeError(401,'context_length_exceeded'),{requestOutcome:'unknown'});Object.defineProperty(error,'retryHint',{get(){throw Error('optional hint failed');}});throw error;}}),pins=f.pins();
 await f.tick();assert.equal(f.state().status,'uncertain');assert.ok(f.state().owner);const requests=f.requests();
 f.advance(60001);f.restart();await f.tick();assert.equal(calls,1);assert.deepEqual(f.requests(),requests);assert.deepEqual(f.pins(),pins);
});
test('throwing injected response retryHint accessor cannot replace known HTTP status',{timeout:10000},async()=>{
 const local=provider('http://127.0.0.1:1/v1','manual',{fetchImpl:async()=>{const response=new Response('{}',{status:429,headers:{'retry-after':'60'}});Object.defineProperty(response,'retryHint',{get(){throw Error('optional hint failed');}});return response;}});
 await assert.rejects(local.complete([]),error=>{assert.equal(error.httpStatus,429);assert.equal(error.requestOutcome,'not_dispatched');assert.deepEqual(error.retryHint,{kind:'delay',milliseconds:60000});return true;});
});
for(const discovery of ['manual','advertised'])test(`routed ${discovery} admission persists truthful eligibility/probe attribution with no reservation`,{timeout:10000},async t=>{
 const s=await server(t,(req,res)=>discovery==='manual'?rejection(res,405):models(res)),f=routedFixture(t,s.baseUrl,discovery),hash=f.g.hash;
 const claimed=await claimAvailable(f.worker);assert.equal(claimed.id,f.task.id);assert.equal(claimed.status,'running');
 assert.deepEqual(s.counts,{get:discovery==='manual'?0:1,post:0});assert.equal(f.c.store.db.prepare('SELECT count(*) AS n FROM requests').get().n,0);
 assert.equal(f.c.getGoal(f.g.id).hash,hash);assert.equal(claimed.providerBinding.providerId,'worker-a');assert.equal(claimed.route.decision.status,'selected');
 const routed=f.c.store.db.prepare("SELECT data FROM events WHERE type='task.routed'").all();assert.equal(routed.length,1);
 const durable=JSON.stringify([claimed.route.decision,routed]);
 if(discovery==='manual'){assert.match(durable,/configured manual-model.*eligibility/i);assert.match(durable,/no network.*health probe/i);assert.doesNotMatch(durable,/bounded selected-provider availability probe/);}
 else assert.match(durable,/bounded selected-provider availability probe/);
});
for(const discovery of ['manual','advertised'])test(`routing ${discovery} accepts eligibility only for the matching explicit manual pin`,{timeout:10000},async t=>{
 const s=await server(t,(_req,res)=>models(res)),f=routedFixture(t,s.baseUrl,discovery);
 const binding=routeDecision(f.c,f.g,f.task).binding,observation={...binding,status:'eligible',observedAt:new Date(f.c.now()).toISOString(),provenance:'configured manual-model retry eligibility; no network, discovery or health probe'};
 assert.equal(routeDecision(f.c,f.g,f.task,observation).status,discovery==='manual'?'selected':'waiting');
 for(const change of [{providerId:'other-worker'},{revision:'other-revision'},{profileHash:'0'.repeat(64)}])assert.equal(routeDecision(f.c,f.g,f.task,{...observation,...change}).reasonCode,'availability_unknown');
 for(const status of ['available','busy','offline','unknown']){
  const decision=routeDecision(f.c,f.g,f.task,{...observation,status,provenance:'prior supplied observation'});
  assert.equal(decision.status,status==='available'?'selected':'waiting');
 }
 const legacy=structuredClone(f.g);delete legacy.manifest.providerPolicy;
 assert.equal(selectRoute({goal:legacy,task:f.task,availability:{providers:[observation],budget:{remainingModelCalls:1}}}).status,'ineligible');
 assert.deepEqual(s.counts,{get:0,post:0});assert.equal(f.c.store.db.prepare('SELECT count(*) AS n FROM requests').get().n,0);
});
for(const kind of ['worker','planner'])test(kind+' throwing optional terminal code preserves certified failure accounting and cooldown',{timeout:10000},async t=>{
 let calls=0;const f=fixture(t,kind,{complete:async()=>{calls++;const error=safeError(429);Object.defineProperty(error,'providerErrorCode',{get(){throw Error('optional provider code failed');}});throw error;}}),pins=f.pins(),start=f.now;
 await f.tick();assert.equal(f.state().status,kind==='worker'?'suspended':'queued');assert.equal(f.state().providerWait.retryAt,start+60000);assertSpent(f,1);
 f.advance(15001);f.restart();await f.tick();assert.equal(calls,1);assertSpent(f,1);assert.deepEqual(f.pins(),pins);
});
