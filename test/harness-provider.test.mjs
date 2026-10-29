import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LocalProvider } from '../src/harness/provider.mjs';
async function fixture(t,handler,options={}){
 let posts=0;const server=http.createServer(async(req,res)=>{if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:options.model??'fixture'}]}));return;}posts++;let body='';for await(const b of req)body+=b;handler(req,res,JSON.parse(body));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 return {provider:new LocalProvider({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,streaming:options.streaming??true,timeoutMs:options.timeoutMs??1000}),posts:()=>posts};
}
const frame=x=>`data: ${JSON.stringify(x)}\n\n`;
const part=(content,extra={})=>({model:'fixture',choices:[{delta:{content,reasoning_content:'PRIVATE'},finish_reason:null}],...extra});
function success(res,content='{"type":"read_files"}') {res.writeHead(200,{'content-type':'text/event-stream'});res.end(frame(part(content))+frame({model:'fixture',choices:[{delta:{},finish_reason:'stop'}],usage:{total_tokens:5}})+'data: [DONE]\n\n');}
test('streaming is explicit and bounded visible SSE chunks exclude reasoning and preserve UTF8',async t=>{
 const f=await fixture(t,(req,res,body)=>{assert.equal(body.stream,true);res.writeHead(200,{'content-type':'text/event-stream'});const b=Buffer.from(frame(part('hello 🌍'))+frame({model:'fixture',choices:[{delta:{content:'!'},finish_reason:'stop'}]})+'data: [DONE]\r\n\r\n');const cut=b.indexOf(Buffer.from('🌍'))+2;res.write(b.subarray(0,cut));setTimeout(()=>res.end(b.subarray(cut)),5);});
 const chunks=[];const r=await f.provider.complete([],{onContent:c=>chunks.push(c)});assert.equal(r.content,'hello 🌍!');assert.equal(chunks.join(''),r.content);assert.equal(r.model,'fixture');assert.equal(r.finishReason,'stop');assert.doesNotMatch(JSON.stringify(chunks),/PRIVATE/);assert.equal(f.posts(),1);
});
test('default nonstreaming preserves completed response and emits no made-up chunks',async t=>{
 const f=await fixture(t,(req,res,body)=>{assert.equal(body.stream,false);res.end(JSON.stringify({model:'fixture',choices:[{message:{content:'complete'},finish_reason:'stop'}]}));},{streaming:false});let chunks=0;
 assert.equal((await f.provider.complete([],{onContent:()=>chunks++})).content,'complete');assert.equal(chunks,0);
});
for(const [name,handler,pattern] of [
 ['truncated',(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(frame(part('{"type":')));},/terminal|incomplete/i],
 ['malformed',(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {bad}\n\ndata: [DONE]\n\n');},/malformed|invalid/i],
 ['disconnect',(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(frame(part('partial')));setTimeout(()=>res.destroy(),5);},/disconnect|aborted|connection|closed/i],
 ['oversize',(_req,res)=>success(res,'x'.repeat(512*1024+1)),/bound|exceed/i],
 ['unexpectedJSON',(_req,res)=>{res.setHeader('content-type','application/json');res.end('{"choices":[]}');},/stream|SSE/i]
])test(`stream ${name} fails without a second POST or completed action`,async t=>{
 const f=await fixture(t,handler);await assert.rejects(f.provider.complete([]),e=>{assert.equal(e.requestOutcome,'unknown');assert.match(e.message,pattern);return true;});assert.equal(f.posts(),1);
});
for(const status of [400,404,429,500,504])test(`HTTP ${status} preserves dispatch classification and never auto-retries`,async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(status);res.end('error');});await assert.rejects(f.provider.complete([]),e=>{assert.equal(e.httpStatus,status);assert.equal(e.requestOutcome,status>=500?'unknown':'not_dispatched');return true;});assert.equal(f.posts(),1);
});
test('stream request timeout and cancellation remain unknown remote outcomes',async t=>{
 for(const cancel of [false,true]){const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(frame(part('partial')));},{timeoutMs:cancel?1000:20});const controller=new AbortController();if(cancel)setTimeout(()=>controller.abort(),20);await assert.rejects(f.provider.complete([],{signal:controller.signal}),e=>{assert.equal(e.requestOutcome,'unknown');assert.match(e.message,/interrupt|timeout|timed out/i);return true;});assert.equal(f.posts(),1);}
});
test('visible callback capture is capped at128KiB and callback backpressure cannot delay completion',async t=>{
 const f=await fixture(t,(_req,res)=>success(res,'x'.repeat(200*1024)));let captured=0;
 const result=await f.provider.complete([],{onContent:c=>{captured+=Buffer.byteLength(c);return new Promise(()=>{});}});assert.equal(result.content.length,200*1024);assert.equal(captured,128*1024);
});
test('resolved pin mismatch refuses POST; reported response mismatch cannot be executed',async t=>{
 const f=await fixture(t,(_req,res)=>success(res));await assert.rejects(f.provider.complete([],{expectedModel:'previous'}),e=>{assert.equal(e.requestOutcome,'not_dispatched');assert.match(e.message,/model.*pin|pinned.*model/i);return true;});assert.equal(f.posts(),0);
});
test('per-request streaming override works on a provider initialized earlier in completed mode',async t=>{
 const f=await fixture(t,(_req,res,body)=>{assert.equal(body.stream,true);success(res,'visible');},{streaming:false});const result=await f.provider.complete([],{streaming:true});assert.equal(result.content,'visible');assert.equal(f.provider.streaming,false);assert.equal(f.posts(),1);
});
test('bounded SSE framing overhead above512KiB accepts a small valid completed result',async t=>{
 const content='code'.repeat(6000),wire=frame(part('code')).repeat(6000)+frame({model:'fixture',choices:[{delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';
 assert.ok(Buffer.byteLength(wire)>512*1024);assert.ok(Buffer.byteLength(wire)<8*1024*1024);
 const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(wire);});let captured=0;
 const result=await f.provider.complete([],{onContent:chunk=>{captured+=Buffer.byteLength(chunk);}});assert.equal(result.content,content);assert.equal(captured,Buffer.byteLength(content));assert.ok(Buffer.byteLength(JSON.stringify(result))<512*1024);assert.equal(f.posts(),1);
});
test('SSE wire above8MiB fails unknown without retry even when visible content is small',async t=>{
 const wire=(': '+ 'x'.repeat(65530)+'\n\n').repeat(129);assert.ok(Buffer.byteLength(wire)>8*1024*1024);
 const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(wire);});
 await assert.rejects(f.provider.complete([]),error=>{assert.equal(error.requestOutcome,'unknown');assert.match(error.message,/wire.*8 MiB/);return true;});assert.equal(f.posts(),1);
});
