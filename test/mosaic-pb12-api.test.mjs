import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {digest} from '../src/harness/contracts.mjs';
import {createReviewTransport} from '../src/harness/review/transports/factory.mjs';

const verdict={decision:'accept',feedback:'Scoped checks and diff reviewed.',findings:[]};
const verdictJson=JSON.stringify(verdict);
const evidence={binding:{candidateHash:'a'.repeat(64)},checks:[{id:'unit',passed:true}],files:[{path:'src/app.mjs',diff:'+export const n=1;'}]};
// Independently authored provider envelopes: do not use the production serializer
// to construct either successful or adverse responses.
const chat={id:'chatcmpl_fixture',object:'chat.completion',model:'alias-2026-10-01',choices:[{index:0,message:{role:'assistant',content:verdictJson,refusal:null},finish_reason:'stop'}],usage:{prompt_tokens:53,completion_tokens:18,total_tokens:71}};
const responses={id:'resp_fixture',object:'response',status:'completed',error:null,incomplete_details:null,model:'alias-2026-10-02',output:[{id:'rs_fixture',type:'reasoning',summary:[]},{id:'msg_fixture',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:verdictJson,annotations:[]}]}],usage:{input_tokens:61,output_tokens:25,total_tokens:86}};
const anthropic={id:'msg_fixture',type:'message',role:'assistant',model:'alias-2026-10-03',content:[{type:'text',text:verdictJson}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:43,output_tokens:21}};
const examples={'openai-chat':chat,'openai-responses':responses,'anthropic-messages':anthropic};
function profile(baseUrl,transport='openai-chat',extra={}){return {schema:1,id:'reviewer',revision:'fixture-v1',displayName:'Fixture reviewer',transport,baseUrl,model:'requested-alias',roles:['reviewer'],capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]},maxContextTokens:20000,maxOutputTokens:500,concurrency:1,capacityGroup:'fixture',credentialRef:'dummy-review-key',streaming:false,...extra};}
async function server(t,handler){const received=[];const s=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const record={url:req.url,headers:req.headers,raw:Buffer.concat(chunks).toString()};received.push(record);await handler(req,res,record);});s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);}));return {baseUrl:`http://127.0.0.1:${s.address().port}/v1`,received};}
function reply(res,body,status=200){res.writeHead(status,{'content-type':'application/json'});res.end(typeof body==='string'?body:JSON.stringify(body));}
function registry(p,credentialResolver=()=> 'fixture-secret'){return ProviderRegistry({profiles:[p],credentialResolver});}
function bound(r,p){return {version:1,providerId:p.id,revision:p.revision,profileHash:digest(r.get(p.id,p.revision)),policyHash:'b'.repeat(64)};}
async function failure(promise,outcome,pattern){await assert.rejects(promise,e=>{assert.equal(e.requestOutcome,outcome);if(pattern)assert.match(e.message,pattern);return true;});}

for(const part of [{type:'thinking',thinking:'private-thinking-canary',signature:'fixture-signature'},{type:'redacted_thinking',data:'opaque-private-canary'}])test(`Anthropic ${part.type} is discarded while final text supplies the verdict`,async t=>{
 let content=[part,{type:'text',text:verdictJson}];
 const f=await server(t,(_q,res)=>reply(res,{...anthropic,content})),p=profile(f.baseUrl,'anthropic-messages'),r=registry(p),client=r.createReviewer(bound(r,p));
 const got=await client.review({evidence});
 assert.deepEqual(JSON.parse(got.content),verdict);
 assert.equal(JSON.stringify(got).includes('private-'),false);
 content=[part];await failure(client.review({evidence}),'completed');
 content=[part,{type:'tool_use',id:'tool_fixture',name:'exec',input:{}},{type:'text',text:verdictJson}];
 await failure(client.review({evidence}),'completed',/tools|unsupported/);
});

for(const protocol of Object.keys(examples))test(`${protocol} uses native nonstreaming envelope and keeps requested/reported usage separate`,async t=>{
 const f=await server(t,(_q,res)=>reply(res,examples[protocol])),p=profile(f.baseUrl,protocol),r=registry(p);let reads=0;
 const privateRegistry=registry(p,ref=>{reads++;assert.equal(ref,'dummy-review-key');return 'fixture-secret';});
 const client=privateRegistry.createReviewer(bound(r,p));assert.equal(reads,0);assert.ok(Object.isFrozen(client));
 const got=await client.review({evidence,maxOutputTokens:123});assert.equal(reads,1);assert.deepEqual(JSON.parse(got.content),verdict);assert.equal(got.requestedModel,'requested-alias');assert.equal(got.reportedModel,examples[protocol].model);
 assert.deepEqual(got.usage,protocol==='openai-chat'?{inputTokens:53,outputTokens:18,totalTokens:71}:protocol==='openai-responses'?{inputTokens:61,outputTokens:25,totalTokens:86}:{inputTokens:43,outputTokens:21,totalTokens:64});
 assert.equal(f.received.length,1);const req=f.received[0],body=JSON.parse(req.raw);assert.equal(req.headers.authorization,'Bearer fixture-secret');assert.equal(body.stream,false);assert.equal(body.model,'requested-alias');assert.equal(body.tools,undefined);assert.equal(body.functions,undefined);
 if(protocol==='openai-chat'){assert.equal(req.url,'/v1/chat/completions');assert.equal(body.max_tokens,123);assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(body.messages[1].role,'user');assert.deepEqual(JSON.parse(body.messages[1].content),evidence);}
 if(protocol==='openai-responses'){assert.equal(req.url,'/v1/responses');assert.equal(body.max_output_tokens,123);assert.equal(body.store,false);assert.equal(body.text.format.type,'json_schema');assert.equal(body.text.format.strict,true);assert.equal(body.text.format.schema.additionalProperties,false);assert.deepEqual(JSON.parse(body.input),evidence);}
 if(protocol==='anthropic-messages'){assert.equal(req.url,'/v1/messages');assert.equal(req.headers['anthropic-version'],'2026-10-21');assert.equal(body.max_tokens,123);assert.equal(typeof body.system,'string');assert.deepEqual(JSON.parse(body.messages[0].content),evidence);}
 assert.equal(JSON.stringify(client).includes('fixture-secret'),false);
});

for(const [name,protocol,mutate] of [
 ['chat refusal','openai-chat',x=>{x.choices[0].message.refusal='Refused';}],
 ['chat truncation','openai-chat',x=>{x.choices[0].finish_reason='length';}],
 ['chat tool invocation','openai-chat',x=>{x.choices[0].message.tool_calls=[{function:{name:'exec',arguments:'rm -rf /'}}];}],
 ['responses refusal','openai-responses',x=>{x.output[1].content=[{type:'refusal',refusal:'Refused'}];}],
 ['responses truncation','openai-responses',x=>{x.status='incomplete';x.incomplete_details={reason:'max_output_tokens'};}],
 ['responses tool invocation','openai-responses',x=>{x.output.push({type:'function_call',name:'exec',arguments:'rm -rf /'});}],
 ['anthropic refusal','anthropic-messages',x=>{x.stop_reason='refusal';}],
 ['anthropic refusal details','anthropic-messages',x=>{x.stop_details={type:'refusal',explanation:'declined'};}],
 ['anthropic truncation','anthropic-messages',x=>{x.stop_reason='max_tokens';}],
 ['anthropic tool invocation','anthropic-messages',x=>{x.content.push({type:'tool_use',id:'tool_fixture',name:'exec',input:{cmd:'rm -rf /'}});}],
])test(`${name} cannot yield review content`,async t=>{const x=structuredClone(examples[protocol]);mutate(x);const f=await server(t,(_q,res)=>reply(res,x)),p=profile(f.baseUrl,protocol),r=registry(p);await failure(r.createReviewer(bound(r,p)).review({evidence}),'completed');assert.equal(f.received.length,1);});

for(const protocol of Object.keys(examples))test(`${protocol} blocks malformed JSON/prose and preserves absent telemetry as null`,async t=>{
 let response=structuredClone(examples[protocol]);const set=text=>{if(protocol==='openai-chat')response.choices[0].message.content=text;else if(protocol==='openai-responses')response.output[1].content[0].text=text;else response.content[0].text=text;};
 const f=await server(t,(_q,res)=>reply(res,response)),p=profile(f.baseUrl,protocol),r=registry(p),client=r.createReviewer(bound(r,p));
 for(const text of ['Accepted.','```json\n'+verdictJson+'\n```','{"decision":','[]','null']){set(text);await failure(client.review({evidence}),'completed',/JSON/);}
 set(verdictJson);delete response.usage;delete response.model;const got=await client.review({evidence});assert.equal(got.reportedModel,null);assert.deepEqual(got.usage,{inputTokens:null,outputTokens:null,totalTokens:null});
});

for(const protocol of Object.keys(examples))test(`${protocol} redacts credentials from successful output and provider errors`,async t=>{
 let status=200;const response=structuredClone(examples[protocol]);const secret='fixture-secret';const secretContent=JSON.stringify({...verdict,feedback:'quoted '+secret});
 if(protocol==='openai-chat')response.choices[0].message.content=secretContent;else if(protocol==='openai-responses')response.output[1].content[0].text=secretContent;else response.content[0].text=secretContent;response.model='alias-'+secret;
 const f=await server(t,(_q,res)=>reply(res,status===200?response:{type:'error',error:{type:'authentication_error',message:'bad '+secret}},status)),p=profile(f.baseUrl,protocol),r=registry(p),client=r.createReviewer(bound(r,p));
 const got=await client.review({evidence:{...evidence,accidentalSecret:secret}});assert.equal(JSON.stringify(got).includes(secret),false);assert.equal(f.received[0].raw.includes(secret),false);assert.match(JSON.parse(got.content).feedback,/redacted/);
 status=401;await assert.rejects(client.review({evidence}),e=>{assert.equal(e.requestOutcome,'completed');assert.equal(e.httpStatus,401);assert.equal(JSON.stringify({message:e.message,...e}).includes(secret),false);return true;});assert.equal(f.received.length,2);
});

test('cancelled credential resolution never performs HTTP, including late resolver success',async t=>{
 const f=await server(t,(_q,res)=>reply(res,chat)),p=profile(f.baseUrl);let resolve,reads=0;const r=registry(p,()=>{reads++;return new Promise(r=>{resolve=r;});}),client=r.createReviewer(bound(r,p));
 const already=new AbortController();already.abort();await failure(client.review({evidence,signal:already.signal}),'not_dispatched');assert.equal(reads,0);
 const control=new AbortController(),pending=client.review({evidence,signal:control.signal});await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);control.abort();await failure(pending,'not_dispatched');resolve('fixture-secret');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.received.length,0);
});
test('disconnect after POST is ambiguous and transport never retries or falls back',async t=>{const f=await server(t,(req)=>req.socket.destroy()),p=profile(f.baseUrl),r=registry(p);await failure(r.createReviewer(bound(r,p)).review({evidence}),'ambiguous');assert.equal(f.received.length,1);assert.equal(f.received[0].url,'/v1/chat/completions');});
test('body size and timeout bounds fail closed after dispatch',async t=>{
 let action='oversize';const f=await server(t,(_q,res)=>{if(action==='oversize')reply(res,'x'.repeat(2048));else {res.writeHead(200,{'content-type':'application/json'});res.write('{');}}),p=profile(f.baseUrl);
 const client=createReviewTransport({profile:p,apiKey:'fixture-secret',maxResponseBytes:1024,timeoutMs:100});await failure(client.review({evidence}),'completed',/bound/);action='timeout';await failure(client.review({evidence}),'ambiguous',/timed out/);
});
test('redirects do not forward auth or dispatch a second request',async t=>{const f=await server(t,(_q,res)=>{res.writeHead(307,{location:'/worker/chat/completions'});res.end();}),p=profile(f.baseUrl),r=registry(p);await failure(r.createReviewer(bound(r,p)).review({evidence}),'completed',/HTTP 307/);assert.equal(f.received.length,1);});
test('binding, role, output limits and secret identity reject before HTTP',async t=>{
 const f=await server(t,(_q,res)=>reply(res,chat)),p=profile(f.baseUrl),r=registry(p),binding=bound(r,p);assert.throws(()=>r.createReviewer({...binding,profileHash:'0'.repeat(64)}),/identity/);assert.throws(()=>r.createReviewer({...binding,extra:true}),/binding/);
 const client=r.createReviewer(binding);for(const maxOutputTokens of [0,-1,501,NaN,Infinity,1.5])await failure(client.review({evidence,maxOutputTokens}),'not_dispatched');
 const leaking=profile(f.baseUrl,'openai-chat',{model:'fixture-secret'}),leakRegistry=registry(leaking);await failure(leakRegistry.createReviewer(bound(leakRegistry,leaking)).review({evidence}),'not_dispatched');
 assert.equal(f.received.length,0);
});
test('credential rotation is denied across overlapping reviewer requests',async t=>{
 let release;const f=await server(t,async(_q,res)=>{await new Promise(resolve=>{release=resolve;});reply(res,chat);}),p=profile(f.baseUrl);let secret='first-key';const r=registry(p,()=>secret),client=r.createReviewer(bound(r,p));
 const pending=client.review({evidence});while(!release)await new Promise(resolve=>setImmediate(resolve));secret='second-key';await failure(client.review({evidence}),'not_dispatched',/rotation/);release();await pending;assert.equal(f.received.length,1);
});

test('escaped credential echoes are redacted after JSON decoding, including quoted keys',async t=>{
 const secret='fixture-"\\secret';
 const escaped=JSON.stringify({...verdict,feedback:'token '+secret}).replace('fixture','\\u0066ixture');
 const response=structuredClone(chat);response.choices[0].message.content=escaped;
 const f=await server(t,(_q,res)=>reply(res,response)),p=profile(f.baseUrl),r=registry(p,()=>secret);
 const got=await r.createReviewer(bound(r,p)).review({evidence:{...evidence,accidentalSecret:secret}});
 assert.equal(JSON.parse(got.content).feedback.includes(secret),false);assert.match(JSON.parse(got.content).feedback,/redacted/);
 assert.equal(JSON.parse(JSON.parse(f.received[0].raw).messages[1].content).accidentalSecret,'[redacted]');
});
test('Responses strict nullable line is translated to optional Mosaic finding line',async t=>{
 const response=structuredClone(responses);response.output[1].content[0].text=JSON.stringify({decision:'revise',feedback:'Review this change.',findings:[{path:'src/app.mjs',line:null,message:'Add a null case.'}]});
 const f=await server(t,(_q,res)=>reply(res,response)),p=profile(f.baseUrl,'openai-responses'),r=registry(p);
 assert.deepEqual(JSON.parse((await r.createReviewer(bound(r,p)).review({evidence})).content).findings,[{path:'src/app.mjs',message:'Add a null case.'}]);
});
for(const protocol of Object.keys(examples))test(`${protocol} provider failures and malformed metadata stay bounded and spent`,async t=>{
 let body={},status=200;const f=await server(t,(_q,res)=>reply(res,body,status)),p=profile(f.baseUrl,protocol),r=registry(p),client=r.createReviewer(bound(r,p));
 for(const code of [400,429,500,529]){status=code;body=protocol==='anthropic-messages'?{type:'error',error:{type:'overloaded_error',message:'try later'}}:{error:{message:'rate limit',type:'rate_limit_error',code:'rate_limit'}};await failure(client.review({evidence}),'completed',new RegExp('HTTP '+code));}
 status=200;for(const malformed of [{usage:{input_tokens:-1,prompt_tokens:-1}},{usage:{input_tokens:Number.MAX_SAFE_INTEGER+1,prompt_tokens:Number.MAX_SAFE_INTEGER+1}},{model:'bad\nmodel'},{usage:[]}]){body={...structuredClone(examples[protocol]),...malformed};await failure(client.review({evidence}),'completed');}
 assert.equal(f.received.length,8);
});
test('evidence/request and content bounds reject without a replacement request',async t=>{
 let body=structuredClone(chat);const f=await server(t,(_q,res)=>reply(res,body)),p=profile(f.baseUrl),r=registry(p),client=r.createReviewer(bound(r,p));
 await failure(client.review({evidence:{data:'x'.repeat(1024*1024)}}),'not_dispatched');assert.equal(f.received.length,0);
 body.choices[0].message.content=JSON.stringify({...verdict,feedback:'x'.repeat(64*1024)});await failure(client.review({evidence}),'completed',/bound/);assert.equal(f.received.length,1);
});
