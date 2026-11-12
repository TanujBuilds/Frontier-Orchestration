import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {endpoint,profile,fixture,open,advance} from './fixtures/mosaic-pb14/runtime.mjs';
import {capacitySnapshot} from '../src/harness/scheduling/capacity.mjs';
const script=fileURLToPath(new URL('./fixtures/mosaic-pb14/child.mjs',import.meta.url));
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' did not arrive')),5000);})]);}finally{clearTimeout(timer);}}
for(const point of ['before-response','response-saved'])test('two-runner SIGKILL '+point+' retains original ownership, spend and safe recovery',{timeout:15000},async t=>{
 const a=await endpoint(t,'a'),b=await endpoint(t,'b');a.state.holdPost=Promise.withResolvers();b.state.holdPost=Promise.withResolvers();
 const profiles=[profile('a',a.baseUrl),profile('b',b.baseUrl)],f=await fixture(t,profiles),tasks=[f.submit('a','worker-a'),f.submit('b','worker-b')];
 f.c.releaseWorker(f.owner);
 const child=spawn(process.execPath,[script,JSON.stringify({root:f.root,profiles,point})],{env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR??'/tmp'},stdio:['ignore','ignore','pipe','pipe']});
 const exited=once(child,'close');let stderr='',messages=[];child.stderr.setEncoding('utf8').on('data',x=>{stderr+=x;});
 const saved=Promise.withResolvers();let data='';child.stdio[3].setEncoding('utf8').on('data',chunk=>{data+=chunk;let end;while((end=data.indexOf('\n'))!==-1){const message=JSON.parse(data.slice(0,end));data=data.slice(end+1);messages.push(message);if(message.point==='response-saved')saved.resolve(message);}});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
 await bounded(Promise.race([Promise.all([a.posted.promise,b.posted.promise]),exited.then(()=>{throw Error('Child exited early: '+stderr);})]),'both POSTs');
 const before=tasks.map(x=>f.c.getTask(x.id)),requests=tasks.map(x=>f.c.store.request(x.id,'consult-1'));
 assert.equal(new Set(before.map(x=>x.owner)).size,2);assert.equal(capacitySnapshot(f.c).requests.length,2);
 if(point==='response-saved'){a.state.holdPost.resolve();await bounded(Promise.race([saved.promise,exited.then(()=>{throw Error('Child exited before save: '+stderr);})]),'saved response');}
 child.kill('SIGKILL');const result=await exited;assert.deepEqual(result,[null,'SIGKILL']);
 const reopened=open(f.root,profiles,{owner:'replacement-parallel'});t.after(async()=>{await reopened.worker.close();if(reopened.c.workerLease)reopened.c.releaseWorker(reopened.owner);reopened.c.close();});
 const after=tasks.map(x=>reopened.c.getTask(x.id));for(let n=0;n<tasks.length;n++){assert.equal(after[n].status,'uncertain');assert.equal(after[n].deadline,before[n].deadline);assert.equal(after[n].attempts,before[n].attempts);assert.equal(after[n].spent.model,1);assert.equal(after[n].routeHash,before[n].routeHash);assert.deepEqual(after[n].providerBinding,before[n].providerBinding);assert.equal(reopened.c.store.request(tasks[n].id,'consult-1').id,requests[n].id);}
 if(point==='response-saved'){
  const recovered=reopened.c.recoverSaved(tasks[0].id,reopened.owner);assert.equal(recovered.status,'queued');await advance(reopened.worker,()=>reopened.c.getTask(tasks[0].id).status==='awaiting_review');
  assert.equal(reopened.c.getTask(tasks[0].id).runnerGeneration,before[0].runnerGeneration+1);assert.equal(a.posts().length,1);
 }else assert.throws(()=>reopened.c.recoverSaved(tasks[0].id,reopened.owner),/ambiguous|pending/i);
 assert.throws(()=>reopened.c.recoverSaved(tasks[1].id,reopened.owner),/ambiguous|pending/i);assert.equal(b.posts().length,1);assert.equal(capacitySnapshot(reopened.c).requests.length,point==='response-saved'?1:2);
 const dir=path.resolve('.data/portable-beta/14/evidence');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'restart-'+point+'.json'),JSON.stringify({point,child:{pid:child.pid,exitCode:result[0],signal:result[1],markers:messages},before:before.map(({id,owner,runnerGeneration,deadline,routeHash,spent})=>({id,owner,runnerGeneration,deadline,routeHash,spent})),after:tasks.map(x=>reopened.c.getTask(x.id)),events:reopened.c.store.events(0,1000).filter(e=>['task.claimed','request.reserved','request.saved','task.interrupted','task.uncertain','task.recovered'].includes(e.type)),posts:{a:a.posts().length,b:b.posts().length},capacityHeld:capacitySnapshot(reopened.c).requests.length},null,2));
});
