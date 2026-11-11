import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {canonical,digest} from '../src/harness/contracts.mjs';
import {workerProfile} from '../src/harness/worker-profile.mjs';
import {LocalProvider} from '../src/harness/provider.mjs';
import {normalizeProfile,normalizeProviderPolicy,profileIdentity,normalizeLegacyWorkerProfile} from '../src/harness/providers/contracts.mjs';
import {ProviderRegistry,isRegistryClient} from '../src/harness/providers/registry.mjs';

const profile=(overrides={})=>({schema:1,id:'worker-a',revision:'revision-1',displayName:'Fixture worker',
 transport:'openai-chat',baseUrl:'https://fixture.invalid/v1',model:'fixture-model',roles:['worker'],
 capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding','consult']},
 maxContextTokens:null,maxOutputTokens:4096,concurrency:1,capacityGroup:'fixture-service',credentialRef:null,streaming:false,...overrides});
const policy=workers=>({version:1,workers,plannerWorkerId:'worker-a',defaultWorkerId:'worker-a',
 capacityGroups:[{id:'fixture-service',limit:1}]});
const binding=p=>({version:1,providerId:p.id,revision:p.revision,profileHash:digest(profileIdentity(p)),policyHash:'a'.repeat(64)});

async function endpoint(t,{hold=false,sse=false,content='fixture answer'}={}){
 const calls=[];let release;
 const gate=hold?new Promise(resolve=>{release=resolve;}):Promise.resolve();
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  calls.push({url:req.url,auth:req.headers.authorization,body:body?JSON.parse(body):null});
  if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;}
  await gate;
  if(sse){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({model:'reported-model',choices:[{delta:{content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;}
  res.end(JSON.stringify({model:'reported-model',choices:[{message:{content:'fixture answer'},finish_reason:'stop'}]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{release?.();server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 return {baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',calls,release};
}

test('portable profile canonicalizes unordered declarations without retaining its input',()=>{
 const raw=profile({baseUrl:'HTTPS://Fixture.Invalid:443/v1///',roles:['reviewer','worker'],
  capabilities:{workerProtocol:'mosaic-structured-v1',transports:['sse','json'],modelDiscovery:'manual',taskKinds:['consult','coding']}});
 const actual=normalizeProfile(raw);
 assert.equal(actual.baseUrl,'https://fixture.invalid/v1');
 assert.deepEqual(actual.roles,['worker','reviewer']);
 assert.deepEqual(actual.capabilities.transports,['json','sse']);
 assert.deepEqual(actual.capabilities.taskKinds,['coding','consult']);
 raw.capabilities.taskKinds.length=0;
 assert.deepEqual(actual.capabilities.taskKinds,['coding','consult']);
});

test('portable profiles reject unknown fields, unsafe numbers, invalid endpoints and credentials in URLs',()=>{
 const invalid=[{apiKey:'dummy-secret'},{credentialRef:'bad/ref'},{id:'invalid/id'},{revision:''},
  {model:'bad\nmodel'},{displayName:'x'.repeat(81)},{baseUrl:'ftp://fixture.invalid/v1'},
  {baseUrl:'https://user:password@fixture.invalid/v1'},{baseUrl:'https://fixture.invalid/v1?api_key=dummy'},
  {baseUrl:'https://fixture.invalid/v1#secret'},{maxContextTokens:0},{maxContextTokens:Infinity},
  {maxContextTokens:Number.MAX_SAFE_INTEGER+1},{maxOutputTokens:NaN},{maxOutputTokens:0},
  {concurrency:0},{concurrency:5},{concurrency:1.5},{streaming:'false'},{credentialRef:undefined}];
 for(const fields of invalid)assert.throws(()=>normalizeProfile(profile(fields)));
 const raw=profile();raw[Symbol('secret')]='dummy';assert.throws(()=>normalizeProfile(raw));
});

test('role and transport capabilities fail closed without advertising unsupported image input',()=>{
 for(const fields of [{roles:[]},{roles:['worker','worker']},{roles:['planner']},{transport:'vendor-custom'},
  {transport:'openai-responses'},{transport:'anthropic-messages'},
  {capabilities:{workerProtocol:'anything',transports:['json'],modelDiscovery:'manual',taskKinds:['coding']}},
  {capabilities:{...profile().capabilities,imageInput:true}},
  {capabilities:{...profile().capabilities,taskKinds:['research']}},
  {capabilities:{...profile().capabilities,taskKinds:[]}},
  {capabilities:{...profile().capabilities,transports:['json','json']}},
  {capabilities:{...profile().capabilities,modelDiscovery:'auto'}},
  {streaming:true}])assert.throws(()=>normalizeProfile(profile(fields)));
 const reviewer=profile({roles:['reviewer'],transport:'anthropic-messages',
  capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]}});
 assert.deepEqual(normalizeProfile(reviewer).roles,['reviewer']);
 assert.throws(()=>normalizeProfile({...reviewer,streaming:true}));
 assert.throws(()=>normalizeProfile({...reviewer,capabilities:{...reviewer.capabilities,transports:['json','sse']}}));
});

test('public identity excludes credential references and changes with immutable provider fields',()=>{
 const raw=profile({credentialRef:'private-a'}),identity=profileIdentity(raw);
 assert.equal(Object.hasOwn(identity,'credentialRef'),false);
 assert.equal(digest(identity),digest(profileIdentity({...raw,credentialRef:'private-b'})));
 assert.equal(digest(identity),digest(profileIdentity(identity)));
 for(const fields of [{revision:'revision-2'},{model:'different-model'},{baseUrl:'https://other.invalid/v1'},
  {capabilities:{...raw.capabilities,taskKinds:['consult']}},{concurrency:2},{maxContextTokens:8192}])
  assert.notEqual(digest(identity),digest(profileIdentity({...raw,...fields})));
 assert.equal(raw.credentialRef,'private-a');
});

test('explicit schema1 adapter preserves legacy bytes and rejects implicit legacy normalization',()=>{
 const legacy={schema:1,codexPath:'/fixture/codex',worker:{profile:{baseUrl:'https://fixture.invalid/v1',model:'fixture-model',
  displayName:'Legacy fixture',revision:'old revision',streaming:false},apiKey:'dummy-legacy-secret'}};
 const before=canonical(legacy),oldProfile=workerProfile(legacy.worker.profile);
 const adapted=normalizeLegacyWorkerProfile(legacy,{id:'worker-a',capacityGroup:'fixture-service',credentialRef:'legacy-key'});
 assert.equal(canonical(legacy),before);
 assert.deepEqual(workerProfile(legacy.worker.profile),oldProfile);
 assert.equal(Object.hasOwn(oldProfile,'capabilities'),false);
 assert.equal(adapted.revision,'old revision');assert.equal(adapted.maxContextTokens,null);
 assert.equal(adapted.capabilities.workerProtocol,'mosaic-structured-v1');
 assert.equal(adapted.capabilities.modelDiscovery,'manual');
 assert.equal(JSON.stringify(adapted).includes('dummy-legacy-secret'),false);
 assert.throws(()=>normalizeProfile(legacy.worker.profile));
 assert.throws(()=>normalizeLegacyWorkerProfile({...legacy,schema:2},{id:'worker-a',capacityGroup:'fixture-service'}));
 for(const fields of [{maxOutputTokens:null},{concurrency:null},{maxOutputTokens:undefined},{concurrency:undefined}])
  assert.throws(()=>normalizeLegacyWorkerProfile(legacy,{id:'worker-a',capacityGroup:'fixture-service',...fields}));
});

test('legacy adapter rejects malformed optional bearer values without returning private details',()=>{
 const legacy={schema:1,worker:{profile:{baseUrl:'https://fixture.invalid/v1',model:'fixture-model',
  displayName:'Legacy fixture',revision:'old revision',streaming:false}}};
 const options={id:'worker-a',capacityGroup:'fixture-service'};
 for(const apiKey of ['',null,42,{},'dummy secret','dummy\nsecret','dummy\u007fsecret','x'.repeat(2049)]){
  const raw={...legacy,worker:{...legacy.worker,apiKey}},before=structuredClone(raw);
  assert.throws(()=>normalizeLegacyWorkerProfile(raw,options),error=>
   typeof error.message==='string'&&(!apiKey||!error.message.includes(String(apiKey))),`credential ${typeof apiKey} must reject`);
  assert.deepEqual(raw,before);
 }
 const before=canonical(legacy),adapted=normalizeLegacyWorkerProfile(legacy,options);
 assert.equal(canonical(legacy),before);assert.equal(adapted.credentialRef,null);assert.equal(adapted.maxOutputTokens,12000);
});

test('legacy adapter rejects known bearer duplicated into profile fields or supplied identifiers before snapshots',()=>{
 const secret='dummy-legacy-secret',old={baseUrl:'https://fixture.invalid/v1',model:'fixture-model',
  displayName:'Legacy fixture',revision:'old revision',streaming:false};
 const options={id:'worker-a',capacityGroup:'fixture-service',credentialRef:'legacy-key'};
 const cases=[
  {profile:{displayName:'Fixture '+secret}},{profile:{model:'model-'+secret}},
  {profile:{revision:'revision-'+secret}},{profile:{baseUrl:'https://fixture.invalid/v1/'+secret}},
  {options:{id:'worker-'+secret}},{options:{capacityGroup:'service-'+secret}},
  {options:{credentialRef:secret}}
 ];
 let resolutions=0;
 for(const row of cases){
  const raw={schema:1,worker:{profile:{...old,...row.profile},apiKey:secret}},before=canonical(raw);
  assert.throws(()=>{
   const adapted=normalizeLegacyWorkerProfile(raw,{...options,...row.options});
   return ProviderRegistry({profiles:[adapted],credentialResolver:()=>{resolutions++;return secret;}})
    .snapshot([{id:adapted.id,revision:adapted.revision}]);
  },error=>!error.message.includes(secret));
  assert.equal(canonical(raw),before);
 }
 assert.equal(resolutions,0);
});

test('legacy adapter rejects encoded URL and JSON-escaped bearer copies before publication',()=>{
 for(const secret of ['dummy-legacy-secret','dummy"\\secret']){
  const encoded=[...secret].map(character=>'%'+character.charCodeAt(0).toString(16).padStart(2,'0')).join('');
  const old={baseUrl:'https://fixture.invalid/v1',model:'fixture-model',displayName:'Legacy fixture',revision:'old revision',streaming:false};
  for(const fields of [{baseUrl:'https://fixture.invalid/v1/'+encoded},{displayName:'Fixture '+secret}]){
   const raw={schema:1,worker:{profile:{...old,...fields},apiKey:secret}},before=canonical(raw);
   assert.throws(()=>normalizeLegacyWorkerProfile(raw,{id:'worker-a',capacityGroup:'fixture-service'}),error=>
    !error.message.includes(secret)&&!error.message.includes(encoded));
   assert.equal(canonical(raw),before);
  }
 }
});

test('approved policy uses trusted credential-free snapshots and preserves absent legacy policy',()=>{
 const catalog=ProviderRegistry({profiles:[profile({credentialRef:'private-a'})]});
 const snapshots=catalog.snapshot([{id:'worker-a',revision:'revision-1'}]);
 const normalized=normalizeProviderPolicy(policy(snapshots),catalog);
 assert.equal(normalized.maxConcurrentTasks,1);
 assert.equal(Object.hasOwn(normalized.workers[0],'credentialRef'),false);
 assert.equal(normalizeProviderPolicy(undefined,catalog),undefined);
 assert.throws(()=>normalizeProviderPolicy(policy([profile()]),catalog));
 assert.throws(()=>normalizeProviderPolicy(policy([{...snapshots[0],model:'swapped-model'}]),catalog));
 assert.throws(()=>normalizeProviderPolicy({...policy(snapshots),workers:[{id:'worker-a',revision:'revision-1'}]},catalog));
 snapshots[0].model='mutated';
 assert.equal(catalog.get('worker-a','revision-1').model,'fixture-model');
});

test('pool identities, canonical endpoint capacity groups and sequential stage limits are enforced',()=>{
 const one=profileIdentity(profile()),two=profileIdentity(profile({id:'worker-b',baseUrl:'https://other.invalid/v1'}));
 const invalid=[{workers:[]},{workers:Array(17).fill(one)},{workers:[one,one]},
  {workers:[one,{...one,revision:'revision-2'}]},
  {workers:[one,{...two,capacityGroup:'unknown'}]},
  {defaultWorkerId:'missing'},{plannerWorkerId:'missing'},{maxConcurrentTasks:2},
  {maxConcurrentTasks:Infinity},{maxConcurrentTasks:null},{maxConcurrentTasks:undefined},{capacityGroups:[{id:'fixture-service',limit:0}]},
  {capacityGroups:[{id:'fixture-service',limit:5}]},{capacityGroups:[{id:'fixture-service',limit:1.5}]},
  {capacityGroups:[{id:'fixture-service',limit:1},{id:'fixture-service',limit:1}]},
  {capacityGroups:[{id:'fixture-service',limit:1,extra:true}]},{extra:true}];
 for(const fields of invalid)assert.throws(()=>normalizeProviderPolicy({...policy([one]),...fields}));
 const conflicting=profile({id:'worker-b',baseUrl:'HTTPS://FIXTURE.INVALID:443/v1/',capacityGroup:'other-group'});
 assert.throws(()=>ProviderRegistry({profiles:[profile(),conflicting]}));
 assert.throws(()=>ProviderRegistry({profiles:[profile(),{...profile(),model:'swapped-model'}]}));
 assert.throws(()=>ProviderRegistry({profiles:[profile(),profile()]}));
 assert.doesNotThrow(()=>ProviderRegistry({profiles:[profile(),profile({revision:'revision-2',model:'next-model'})]}));
 assert.doesNotThrow(()=>normalizeProviderPolicy(policy([one,two])));
});

test('clients validate full binding before resolving credentials or dispatching',async()=>{
 let reads=0;const raw=profile({credentialRef:'key-a'});
 const registry=ProviderRegistry({profiles:[raw],credentialResolver:()=>{reads++;return 'dummy-key';}});
 const valid=binding(raw),client=registry.createClient(valid);
 assert(client instanceof LocalProvider);assert(isRegistryClient(client));assert.equal(isRegistryClient(new LocalProvider({baseUrl:raw.baseUrl,model:raw.model})),false);
 assert.equal(reads,0);assert.equal(registry.createClient({...valid}),client);
 assert.notEqual(registry.createClient({...valid,policyHash:'b'.repeat(64)}),client);
 for(const fields of [{version:2},{revision:'missing'},{profileHash:'f'.repeat(64)},{policyHash:'not-a-hash'},{extra:'dummy'}])
  assert.throws(()=>registry.createClient({...valid,...fields}));
 assert.equal(reads,0);
 const reviewer=profile({id:'reviewer-a',roles:['reviewer'],capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]}});
 assert.throws(()=>ProviderRegistry({profiles:[reviewer]}).createClient(binding(reviewer)));
});

test('request-time credentials and distinct clients never share authentication or reported aliases',async t=>{
 const a=await endpoint(t),b=await endpoint(t);let reads=0;
 const pa=profile({baseUrl:a.baseUrl,credentialRef:'key-a'}),pb=profile({id:'worker-b',baseUrl:b.baseUrl,model:'other-model',credentialRef:'key-b',capacityGroup:'other-service'});
 const registry=ProviderRegistry({profiles:[pa,pb],credentialResolver:ref=>{reads++;return ref==='key-a'?'dummy-a':'dummy-b';}});
 const ca=registry.createClient(binding(pa)),cb=registry.createClient(binding(pb));assert.equal(reads,0);
 const ma=[],mb=[];
 const ra=await ca.complete([{role:'user',content:'a'}],{onModel:model=>ma.push(model)});
 const rb=await cb.complete([{role:'user',content:'b'}],{onModel:model=>mb.push(model)});
 assert.equal(reads,2);assert.deepEqual(ma,['fixture-model']);assert.deepEqual(mb,['other-model']);
 assert.equal(ra.requestedModel,'fixture-model');assert.equal(rb.requestedModel,'other-model');assert.equal(ra.model,'reported-model');
 assert.equal(a.calls[0].auth,'Bearer dummy-a');assert.equal(b.calls[0].auth,'Bearer dummy-b');
 assert.equal(a.calls[0].body.model,'fixture-model');assert.equal(b.calls[0].body.model,'other-model');
 for(const artifact of [registry,ca,registry.get(pa.id,pa.revision),registry.snapshot([{id:pa.id,revision:pa.revision}])])
  assert.equal(/dummy-a|dummy-b|key-a|key-b/.test(JSON.stringify(artifact)),false);
});

test('credential rotation cannot replace authentication for an in-flight profile and can proceed afterward',{timeout:5000},async t=>{
 const server=await endpoint(t,{hold:true});let key='dummy-before';
 const raw=profile({baseUrl:server.baseUrl,credentialRef:'private-key'}),registry=ProviderRegistry({profiles:[raw],credentialResolver:()=>key});
 const a=registry.createClient(binding(raw)),b=registry.createClient({...binding(raw),policyHash:'b'.repeat(64)});
 const first=a.complete([{role:'user',content:'first'}]);
 while(server.calls.length===0)await new Promise(resolve=>setImmediate(resolve));
 key='dummy-after';
 await assert.rejects(b.complete([{role:'user',content:'second'}]),error=>error.requestOutcome==='not_dispatched'&&!error.message.includes(key));
 assert.equal(server.calls.length,1);server.release();await first;
 await b.complete([{role:'user',content:'second'}]);
 assert.deepEqual(server.calls.map(call=>call.auth),['Bearer dummy-before','Bearer dummy-after']);
});

test('resolver failures do not expose private credentials in errors',async()=>{
 const raw=profile({credentialRef:'private-key'}),registry=ProviderRegistry({profiles:[raw],credentialResolver:()=>{throw Error('dummy-secret-private-key');}});
 await assert.rejects(registry.createClient(binding(raw)).complete([]),error=>
  error.requestOutcome==='not_dispatched'&&!/dummy-secret|private-key/.test(error.message));
});

test('SSE callbacks belong to the current request and credentials are redacted by the existing adapter',async t=>{
 const server=await endpoint(t,{sse:true,content:'fixture dummy-secret answer'});const raw=profile({baseUrl:server.baseUrl,streaming:true,credentialRef:'private-key',
  capabilities:{...profile().capabilities,transports:['json','sse']}});
 const registry=ProviderRegistry({profiles:[raw],credentialResolver:()=> 'dummy-secret'}),client=registry.createClient(binding(raw));
 let first='',second='';await client.complete([],{onContent:part=>{first+=part;}});
 await client.complete([],{onContent:part=>{second+=part;}});
 assert.equal(first,'fixture [redacted] answer');assert.equal(second,'fixture [redacted] answer');
 assert.equal(server.calls.length,2);assert.equal(server.calls[0].body.stream,true);
});
