import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {LocalProvider} from '../src/harness/provider.mjs';

async function providerFixture(t) {
 const secret='fixture-key-h4Pz';
 const calls=[];
 const server=http.createServer(async(req,res)=>{
  const chunks=[];
  for await (const chunk of req) chunks.push(chunk);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
  calls.push({url:req.url,body,auth:req.headers.authorization});
  if(req.headers.authorization!=='Bearer '+secret){res.writeHead(401).end(secret);return;}
  if(req.url==='/missing/models'){res.writeHead(404).end(secret);return;}
  if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'custom-model'},{id:'other'}]}));return;}
  if(body.stream){
   res.writeHead(200,{'content-type':'text/event-stream'});
   res.write('data: '+JSON.stringify({choices:[{delta:{content:'Hi fixture-key-'},finish_reason:null}]})+'\n\n');
   res.write('data: '+JSON.stringify({choices:[{delta:{content:'h4Pz!'},finish_reason:'stop'}]})+'\n\n');
   res.end('data: [DONE]\n\n'+(req.url.startsWith('/late/')?'data: {"error":"'+secret+'"}\n\n':''));
  }else res.end(JSON.stringify({model:'custom-model',choices:[{message:{content:'Hi '+secret+'!'},finish_reason:'stop'}]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return {secret,calls,base:'http://127.0.0.1:'+server.address().port};
}

test('authenticated discovery and explicit completed model work without a models route',async t=>{
 const {secret,calls,base}=await providerFixture(t);
 const lookup=new LocalProvider({baseUrl:base+'/v1',apiKey:secret,openAICompatible:true});
 assert.deepEqual(await lookup.listModels(),['custom-model','other']);
 const manual=new LocalProvider({baseUrl:base+'/missing',apiKey:secret,openAICompatible:true,model:'custom-model'});
 assert.equal((await manual.complete([{role:'user',content:'Hi'}])).content,'Hi [redacted]!');
 assert.deepEqual(calls.map(x=>x.url),['/v1/models','/missing/chat/completions']);
 assert.equal(calls[1].body.stream,false);
 assert.equal(calls[1].body.chat_template_kwargs,undefined);
});

test('authenticated SSE redacts split secrets and late errors never return completed output or retry',async t=>{
 const {secret,calls,base}=await providerFixture(t);
 const options={apiKey:secret,openAICompatible:true,model:'custom-model',streaming:true};
 const chunks=[];
 const result=await new LocalProvider({...options,baseUrl:base+'/v1'}).complete([], {onContent:chunk=>chunks.push(chunk)});
 assert.equal(result.content,'Hi [redacted]!');
 assert.equal(chunks.join(''),'Hi [redacted]!');
 await assert.rejects(new LocalProvider({...options,baseUrl:base+'/late'}).complete([]),e=>e.requestOutcome==='unknown'&&!e.message.includes(secret));
 assert.equal(calls.length,2);
});

const raw={submissionId:'bound-goal',objective:'Explain WAL',acceptance:['Useful answer']};
const profile={baseUrl:'https://provider.example/v1',model:'custom-model',displayName:'API Model',revision:'revision-a',streaming:false};
function state(t,options={}) {
 const root=mkdtempSync(path.join(os.tmpdir(),'mosaic-beta-provider-'));
 const opened=[];
 const open=options=>{const c=new Coordinator({root,...options});opened.push(c);return c;};
 t.after(()=>{for(const c of opened)c.close();rmSync(root,{recursive:true,force:true});});
 return {c:open(options),open};
}

test('prepared hashes bind the worker and reject changed activation while preserving legacy hashes',t=>{
 const {c,open}=state(t,{beta:true,workerProfile:profile});
 const goal=c.prepareGoal(raw,'prepare');
 assert.deepEqual(goal.manifest.workerProfile,profile);
 assert.notEqual(goal.hash,c.prepareGoal({...raw,submissionId:'native',mode:'codex_only'},'prepare-native').hash);
 c.close();
 const changed=open({beta:true,workerProfile:{...profile,revision:'revision-b'}});
 assert.throws(()=>changed.activateGoal({goalId:goal.id,hash:goal.hash},'activate'),/profile changed/i);
 const {c:legacy}=state(t);
 assert.equal(Object.hasOwn(legacy.prepareGoal(raw,'prepare').manifest,'workerProfile'),false);
 const {c:native}=state(t,{beta:true});
 const nativeGoal=native.prepareGoal(raw,'prepare');
 assert.equal(nativeGoal.manifest.mode.id,'codex_only');
 assert.throws(()=>native.prepareGoal({...raw,mode:'deepseek_only'},'worker'),/configure an API worker/i);
});

test('changed worker profile blocks dispatch before spending and historical profile stays with the task',async t=>{
 const {c,open}=state(t,{beta:true,workerProfile:profile});
 const goal=c.prepareGoal(raw,'prepare');
 c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
 const task=c.submitTask({goalId:goal.id,submissionId:'task',kind:'consult',objective:'Answer',acceptance:['Useful']},'submit');
 c.close();
 const changed=open({beta:true,workerProfile:{...profile,displayName:'Other',revision:'revision-b'}});
 const worker=new Worker({c:changed,provider:{complete:async()=>assert.fail('changed profile dispatched')}});
 await worker.tick();
 assert.equal(changed.getTask(task.id).status,'blocked');
 assert.equal(changed.getTask(task.id).spent.model,0);
 assert.deepEqual(changed.getGoal(goal.id).manifest.workerProfile,profile);
});
