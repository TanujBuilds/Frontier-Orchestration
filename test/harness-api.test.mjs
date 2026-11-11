// Historical no-policy workflows explicitly select the legacy preparation tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {startApi} from '../src/harness/api.mjs';

async function fixture(t){const root=mkdtempSync(path.join(os.tmpdir(),'harness-api-')),c=new Coordinator({root}),dispatcher=new Dispatcher({c,config:{environment:'fixture'}}),token='a'.repeat(64),api=await startApi({dispatcher,token});t.after(async()=>{await api.close();c.close();rmSync(root,{recursive:true,force:true});});
 const call=(name,input={},headers={})=>fetch(api.url+'/api/invoke',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:JSON.stringify({name,input})});return {c,dispatcher,token,api,call};}
test('saved long operations recover under the verified current lease and reuse their original mutation key',async t=>{
 const f=await fixture(t);f.c.acquireWorker('recovered');f.c.store.command('original-native-command',{op:'operation.launch',name:'native_start',input:{taskId:'saved-task'}},()=>f.c.store.put('operation',{id:'pending-native',name:'native_start',input:{taskId:'saved-task'},key:'original-native-command',status:'pending',taskId:'saved-task',createdAt:f.c.now()}));let calls=0,seen;
 f.dispatcher.worker.integration.startNative=async(input,key)=>{calls++;seen={input,key};return {id:input.taskId,status:'codex_active'};};
 await assert.rejects(f.dispatcher.recoverOperations('wrong-owner'),/lease|owner/);await f.dispatcher.recoverOperations('recovered');await f.dispatcher.whenIdle();const done=f.c.store.get('operation','pending-native');assert.equal(done.status,'completed');assert.deepEqual(seen,{input:{taskId:'saved-task'},key:'effect-original-native-command'});await f.dispatcher.recoverOperations('recovered');assert.equal(calls,1);
});
test('authenticated tools prepare, activate and control actual durable goals with strict idempotency',async t=>{
 const f=await fixture(t),input={idempotencyKey:'prepare',manifest:{submissionId:'g',objective:'Research a queue',acceptance:['Cited answer'],environment:'fixture'}};
 const response=await f.call('legacy_goal_prepare',input);assert.equal(response.status,200);const g=await response.json();assert.equal((await (await f.call('legacy_goal_prepare',input)).json()).id,g.id);
 assert.equal((await f.call('goal_activate',{idempotencyKey:'activate',goalId:g.id,hash:g.hash})).status,200);
 const task=await (await f.call('task_submit',{idempotencyKey:'task',goalId:g.id,task:{submissionId:'r',kind:'research',objective:'Read evidence',acceptance:['Report']}})).json();
 await f.call('work_control',{idempotencyKey:'pause',taskId:task.id,action:'pause'});assert.equal(f.c.getTask(task.id).status,'paused');
 assert.equal((await f.call('legacy_goal_prepare',{...input,manifest:{...input.manifest,objective:'Changed'}})).status,400);
 assert.equal((await f.call('task_get',{taskId:task.id,shell:'not allowed'})).status,400);
});
test('Host, Origin, authentication and browser CSRF guards precede mutations',async t=>{
 const f=await fixture(t),packet={name:'registry_list',input:{}};
 assert.equal((await fetch(f.api.url+'/api/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(packet)})).status,401);
 const hostileHost=await new Promise((resolve,reject)=>{const request=http.request(f.api.url+'/api/invoke',{method:'POST',headers:{host:'evil.invalid',authorization:'Bearer '+f.token,'content-type':'application/json'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);request.end(JSON.stringify(packet));});assert.equal(hostileHost,403);
 assert.equal((await f.call('registry_list',{}, {origin:'https://evil.invalid'})).status,403);
 const login=await fetch(f.api.url+'/login',{method:'POST',headers:{origin:f.api.url,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:f.token}),redirect:'manual'});assert.equal(login.status,303);
 const cookie=login.headers.get('set-cookie').split(';')[0],session=await fetch(f.api.url+'/api/session',{headers:{cookie}}).then(r=>r.json());assert.ok(session.csrf);
 const request=csrf=>fetch(f.api.url+'/api/invoke',{method:'POST',headers:{cookie,origin:f.api.url,'content-type':'application/json',...(csrf?{'x-csrf-token':csrf}:{})},body:JSON.stringify(packet)});
 assert.equal((await request()).status,403);assert.equal((await request(session.csrf)).status,200);
});
test('tools expose bounded event waits and long operations return promptly',async t=>{
 const f=await fixture(t),tools=await (await f.call('tools_list')).json();assert.ok(tools.some(t=>t.name==='task_takeover'));assert.ok(tools.some(t=>t.name==='memory_retrieve'));
 const prepare=tools.find(t=>t.name==='goal_prepare');assert.ok(prepare.inputSchema.properties.manifest.properties.acceptance);assert.ok(prepare.inputSchema.properties.manifest.properties.project);
 assert.equal((await f.call('events_wait',{after:0,timeoutMs:30001})).status,400);
 const result=await f.dispatcher.launch('fixture_operation',{taskId:'test'},'operation',async()=>{await new Promise(r=>setTimeout(r,20));return {verified:true};});assert.equal(result.status,'pending');
 await new Promise(r=>setTimeout(r,40));const done=await f.dispatcher.invoke('operation_get',{operationId:result.id});assert.equal(done.status,'completed');assert.deepEqual(done.result,{verified:true});
 assert.equal((await f.dispatcher.launch('fixture_operation',{taskId:'test'},'operation',async()=>{throw Error('Duplicate');})).id,result.id);
});
test('a fifth registered research-only preset survives restart and cannot dispatch coding',async t=>{
 const f=await fixture(t),preset={id:'research-brief',version:1,planner:'deepseek',actors:['deepseek'],review:'checks',capabilities:['research']};
 const registered=await f.call('mode_register',{idempotencyKey:'mode',definition:preset});assert.equal(registered.status,200);
 const reopened=new Coordinator({root:f.c.store.root});try{assert.equal(reopened.registry.mode('research-brief').id,'research-brief');}finally{reopened.close();}
 const g=await (await f.call('legacy_goal_prepare',{idempotencyKey:'p',manifest:{submissionId:'narrow',objective:'Research only',acceptance:['Cited answer'],mode:'research-brief',environment:'fixture'}})).json();await f.call('goal_activate',{idempotencyKey:'a',goalId:g.id,hash:g.hash});
 assert.equal((await f.call('task_submit',{idempotencyKey:'bad',goalId:g.id,task:{submissionId:'code',kind:'coding',objective:'Write code',acceptance:['Pass']}})).status,400);
});
