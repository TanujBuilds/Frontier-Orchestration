import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {digest} from '../src/harness/contracts.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {profileIdentity} from '../src/harness/providers/contracts.mjs';

const methods={
 complete:(client,signal)=>client.complete([],{signal}),
 listModels:(client,signal)=>client.listModels(signal),
 availability:(client,signal)=>client.availability(signal),
 execute:(client,signal)=>client.execute({step:{},attempt:1,signal}),
};

async function fixture(t,resolver){
 const requests=[];
 const server=http.createServer((req,res)=>{
  requests.push({url:req.url,auth:req.headers.authorization});req.resume();
  res.end(JSON.stringify(req.url.endsWith('/models')?{data:[{id:'fixture-model'}]}:
   {model:'fixture-model',choices:[{message:{content:'fixture answer'},finish_reason:'stop'}]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const p={schema:1,id:'credential-worker',revision:'v1',displayName:'Credential fixture',transport:'openai-chat',
  baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model',roles:['worker'],
  capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding','consult']},
  maxContextTokens:null,maxOutputTokens:2000,concurrency:1,capacityGroup:'credential-fixture',credentialRef:'private-ref',streaming:false};
 const client=ProviderRegistry({profiles:[p],credentialResolver:resolver}).createClient({version:1,providerId:p.id,
  revision:p.revision,profileHash:digest(profileIdentity(p)),policyHash:'a'.repeat(64)});
 return {client,requests};
}

for(const [name,call] of Object.entries(methods))test(`${name} aborts an unresolved credential lookup without dispatch or late replay`,{timeout:5000},async t=>{
 let release,entered;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 let resolutions=0;
 const {client,requests}=await fixture(t,()=>{resolutions++;entered();return held;});
 t.after(()=>release('dummy-late-key'));
 const controller=new AbortController();
 let outcome='pending',error;
 const pending=call(client,controller.signal).then(()=>{outcome='completed';},e=>{outcome='rejected';error=e;});
 await started;controller.abort(Error('private-abort-reason'));
 await nextTurn();
 assert.equal(outcome,'rejected','Cancellation must settle without waiting for the credential resolver');
 assert.equal(error.requestOutcome,'not_dispatched');
 assert.doesNotMatch(error.message,/private-abort-reason|private-ref|dummy-late-key/);
 release('dummy-late-key');await pending;await nextTurn();
 assert.equal(resolutions,1);assert.equal(requests.length,0,'Late credential resolution must not start HTTP');
});

test('already-aborted requests do not read credentials and a later request remains usable',async t=>{
 let resolutions=0;const {client,requests}=await fixture(t,()=>{resolutions++;return 'dummy-current-key';});
 const controller=new AbortController();controller.abort();
 await assert.rejects(client.complete([],{signal:controller.signal}),error=>error.requestOutcome==='not_dispatched');
 assert.equal(resolutions,0);assert.equal(requests.length,0);
 const result=await client.complete([]);
 assert.equal(result.content,'fixture answer');assert.equal(resolutions,1);assert.equal(requests.length,1);
});
