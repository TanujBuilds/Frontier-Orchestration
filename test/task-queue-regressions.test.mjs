import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
const source=pathToFileURL(path.join(process.cwd(),'src/task-queue.mjs')).href;
const q=await import(source);
const {Journal}=await import(pathToFileURL(path.join(process.cwd(),'src/project/journal.mjs')));
const {digest}=await import(pathToFileURL(path.join(process.cwd(),'src/project/contracts.mjs')));
const base=await mkdtemp(path.join(os.tmpdir(),'queue-regressions-'));

async function fixture(name,limits={}){
 const root=path.join(base,name);await q.initQueue({root,mode:'fake',...limits});return root;
}
async function job(root,priority=0){
 const id=randomUUID();const j=await new Journal(root,id).load();
 const manifest={schemaVersion:1,planVersion:1,mode:'fake',brief:'Independent queue behavior probe',repo:'/unused-with-injected-executor',baseCommit:'a'.repeat(40),permissions:{readPaths:['src/'],writePaths:['src/'],checks:[{id:'marker',argv:['node','checks/marker.mjs']}]},plan:{summary:'Probe',stages:[{id:'verify',kind:'verification',objective:'Probe',deliverable:'Evidence',writePaths:['src/'],acceptance:['check passes'],checks:['marker']}]},limits:{hours:8,attempts:5,reviewRounds:2,contextRequests:10,reconnectMs:1000},initialContext:[]};
 await j.append('project.created',manifest);const hash=digest(manifest);await j.append('project.approved',{hash,planVersion:1});
 await q.enqueue({root,jobId:id,hash,priority});return {id,hash,j,manifest};
}
const results=[];
async function probe(name,fn){await test(name,{timeout:10000},fn);}
await probe('once drains priority/FIFO backlog beyond an invalidated item',async()=>{
 const root=await fixture('drain');const low=await job(root,0),bad=await job(root,30),a=await job(root,10),b=await job(root,10);
 await bad.j.append('project.created',{...bad.manifest,planVersion:2});
 const calls=[];await q.runQueue({root,once:true,runJob:async({job})=>{calls.push(job.jobId??job.id);return{status:'accepted'};}});
 assert.deepEqual(calls,[a.id,b.id,low.id]);
});
await probe('default worker waits empty and picks up newly enqueued work',async()=>{
 const root=await fixture('watch');let ended=false;const calls=[];const control=new AbortController();
 const run=q.runQueue({root,pollMs:10,signal:control.signal,runJob:async({job})=>{calls.push(job.jobId??job.id);return{status:'accepted'};}}).finally(()=>{ended=true;});
 try{await delay(70);assert.equal(ended,false,'worker exited on empty queue');const a=await job(root);for(let n=0;n<50&&!calls.length;n++)await delay(10);assert.deepEqual(calls,[a.id]);}finally{control.abort();await run;}
});
await probe('stop aborts in-flight work promptly and prevents next dispatch',async()=>{
 const root=await fixture('active-stop');await job(root);await job(root);const control=new AbortController();let calls=0,active;
 const fallback=setTimeout(()=>control.abort(),1600);
 const run=q.runQueue({root,pollMs:10,signal:control.signal,runJob:async({signal})=>{calls++;active=signal;await new Promise(r=>signal.aborted?r():signal.addEventListener('abort',r,{once:true}));return{status:'paused'};}});
 try{for(let n=0;n<50&&!active;n++)await delay(10);assert.ok(active,'executor never started');await q.stopQueue({root});await delay(450);assert.equal(active.aborted,true,'queue stop never reached active executor');await run;assert.equal(calls,1);}finally{control.abort();clearTimeout(fallback);await run;}
});
await probe('queue deadline aborts an active job rather than only checking between jobs',async()=>{
 const root=await fixture('deadline',{hours:0.0002});await job(root);const control=new AbortController();let active;const fallback=setTimeout(()=>control.abort(),2000);
 const run=q.runQueue({root,once:true,pollMs:10,signal:control.signal,runJob:async({signal})=>{active=signal;await new Promise(r=>signal.aborted?r():signal.addEventListener('abort',r,{once:true}));return{status:'paused'};}});
 try{await delay(1200);assert.ok(active,'executor did not start');assert.equal(active.aborted,true,'queue deadline did not abort active work');await run;}finally{control.abort();clearTimeout(fallback);await run;}
});
await probe('an explicit restart clears queue stop without resetting deadline or job count',async()=>{
 const root=await fixture('restart');const a=await job(root);await q.stopQueue({root});const before=await q.queueStatus({root});const calls=[];
 await q.runQueue({root,once:true,runJob:async({job})=>{calls.push(job.jobId??job.id);return{status:'accepted'};}});
 const after=await q.queueStatus({root});assert.deepEqual(calls,[a.id]);if(before.deadline)assert.equal(after.deadline,before.deadline);assert.equal(after.jobsUsed,1);
});
await probe('manual retry counts the same distinct job only once',async()=>{
 const root=await fixture('retry-count',{maxJobs:1});const a=await job(root);
 await q.runQueue({root,once:true,runJob:async()=>({status:'failed'})});
 await q.retryItem({root,jobId:a.id,hash:a.hash});let calls=0;
 await q.runQueue({root,once:true,runJob:async()=>{calls++;return{status:'accepted'};}});
 assert.equal(calls,1);assert.equal((await q.queueStatus({root})).jobsUsed,1);
});
await probe('reservation remains spent after a failed reviewer invocation',async()=>{
 const root=await fixture('review-error',{maxReviews:1});await job(root);
 await q.runQueue({root,once:true,runJob:async({reserveReview,job})=>{const r=await reserveReview({jobId:job.jobId??job.id});assert.notEqual(r?.ok,false);throw Error('simulated reviewer transport failure');}});
 assert.equal((await q.queueStatus({root})).reviewsUsed,1);
 await q.runQueue({root,once:true,runJob:async()=>{throw Error('must not rerun terminal item');}});
 assert.equal((await q.queueStatus({root})).reviewsUsed,1);
});
await probe('dead-worker recovery completes the interrupted job at the distinct-job cap',async()=>{
 const root=await fixture('crash',{maxJobs:1});const a=await job(root);const started=path.join(root,'child-started');
 const code=`import{writeFile}from'node:fs/promises';import{runQueue}from ${JSON.stringify(source)};await runQueue({root:${JSON.stringify(root)},once:true,runJob:async()=>{await writeFile(${JSON.stringify(started)},'ready');await new Promise(r=>setTimeout(r,30000));return{status:'accepted'};}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});let err='';child.stderr.on('data',c=>{err+=c;});
 const closed=new Promise(r=>{child.once('close',r);child.once('error',r);});
 try{let ready=false;for(let n=0;n<100;n++){try{await readFile(started);ready=true;break;}catch{}await delay(10);}assert.ok(ready,'child did not dispatch: '+err);child.kill('SIGKILL');await closed;
 const calls=[];await q.runQueue({root,once:true,runJob:async({job})=>{calls.push(job.jobId??job.id);return{status:'accepted'};}});assert.deepEqual(calls,[a.id]);assert.equal((await q.queueStatus({root})).jobsUsed,1);
 }finally{child.kill('SIGKILL');await closed;}
});


await rm(base,{recursive:true,force:true,maxRetries:4,retryDelay:100});
