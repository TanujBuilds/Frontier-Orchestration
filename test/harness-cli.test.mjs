// Historical no-policy workflows explicitly select the legacy preparation tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {command} from '../src/project/process.mjs';
const cli=fileURLToPath(new URL('../src/harness/cli.mjs',import.meta.url));
test('CLI help explains connection, persistent root and structured calls without starting a service',async()=>{
 const result=await command([process.execPath,cli,'--help']);assert.equal(result.code,0);assert.match(result.stdout,/--config/);assert.match(result.stdout,/--root/);assert.match(result.stdout,/--input/);
});
test('persistent CLI serves authenticated MCP controls and restarts without duplicating completed work',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-cli-')),config=path.join(root,'config.json');await writeFile(config,JSON.stringify({environment:'fixture',fixtureReply:'Saved fixture answer'}),{mode:0o600});const state=path.join(root,'state'),children=[];
 t.after(async()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');await rm(root,{recursive:true,force:true});});
 const start=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[cli,'serve','--root',state,'--config',config,'--port','0'],{stdio:['ignore','pipe','pipe']});children.push(child);let stdout='',stderr='';const timer=setTimeout(()=>reject(Error('Service did not become ready: '+stderr)),5000);child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>{stdout+=b;if(stdout.includes('\n')){clearTimeout(timer);resolve({child,ready:JSON.parse(stdout.split('\n')[0])});}});child.on('exit',code=>{if(!stdout.includes('\n')){clearTimeout(timer);reject(Error('Service exited: '+code+' '+stderr));}});});
 let service=await start();assert.equal(service.ready.status,'ready');const connection=JSON.parse(await readFile(path.join(state,'connection.json'),'utf8'));assert.equal((await stat(path.join(state,'connection.json'))).mode&0o777,0o600);
 const call=async(name,input)=>{const r=await fetch(connection.url+'/api/invoke',{method:'POST',headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'},body:JSON.stringify({name,input})});const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
 const g=await call('legacy_goal_prepare',{idempotencyKey:'p',manifest:{submissionId:'g',objective:'Return a saved answer',acceptance:['Bounded answer'],environment:'fixture'}});await call('goal_activate',{idempotencyKey:'a',goalId:g.id,hash:g.hash});const task=await call('task_submit',{idempotencyKey:'t',goalId:g.id,task:{submissionId:'t',kind:'consult',objective:'Explain durability',acceptance:['Answer']}});
 let saved;for(let n=0;n<30;n++){saved=await call('task_get',{taskId:task.id});if(saved.status==='awaiting_review')break;await new Promise(r=>setTimeout(r,100));}assert.equal(saved.status,'awaiting_review');assert.equal(saved.spent.model,1);
 await call('task_review',{idempotencyKey:'review',taskId:task.id,decision:'accept',feedback:'Fixture answer verified against the approved outcome'});
 const stopped=new Promise(resolve=>service.child.once('exit',resolve));await call('service_stop',{idempotencyKey:'stop'});await stopped;
 service=await start();const inspected=await command([process.execPath,cli,'call','--root',state,'--tool','task_get','--input-json',JSON.stringify({taskId:task.id})]);assert.equal(inspected.code,0,inspected.stderr);assert.equal(JSON.parse(inspected.stdout).spent.model,1);assert.equal(JSON.parse(inspected.stdout).status,'accepted');
 const exit=new Promise(resolve=>service.child.once('exit',resolve));service.child.kill('SIGTERM');await exit;
 const status=await command([process.execPath,cli,'status','--root',state]);assert.equal(status.code,0,status.stderr);assert.equal(JSON.parse(status.stdout).status,'stopped');
});
