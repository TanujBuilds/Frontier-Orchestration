import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Journal } from '../src/project/journal.mjs';
import { createProject, approveProject, templatePlanner, stopProject } from '../src/project/service.mjs';
import { runProject } from '../src/project/runner.mjs';
import { FakeProjectLocal } from '../src/project/fake.mjs';
import { git } from '../src/project/process.mjs';
import { digest, Pause } from '../src/project/contracts.mjs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { summarize } from '../src/project/runner.mjs';
import { initQueue, enqueue, runQueue, retryItem, queueStatus, QUEUE_ID } from '../src/task-queue.mjs';
const permissions={readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'marker',argv:['node','checks/test.mjs']}]};
async function setup(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'queue-auth-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const repo=path.join(dir,'repo'),root=path.join(dir,'data');await mkdir(path.join(repo,'src'),{recursive:true});await mkdir(path.join(repo,'checks'));
 await writeFile(path.join(repo,'src/start.txt'),'start\n');await writeFile(path.join(repo,'checks/test.mjs'),'console.log("ok")\n');await writeFile(path.join(repo,'.gitignore'),'.overnight-output/\ndist/\n');
 await git(repo,'init','-q');await git(repo,'config','user.name','Queue Test');await git(repo,'config','user.email','test@example.invalid');await git(repo,'add','.');await git(repo,'commit','-qm','baseline');
 const make=async()=>{const c=await createProject({root,repo,brief:'Disposable authorization test',permissions,planner:templatePlanner,mode:'fake'});const journal=await new Journal(root,c.jobId).load();await approveProject(journal,c.planHash);return{journal,...c};};
 await initQueue({root,mode:'fake'});return{root,make};
}
test('queued hash is checked under the project lock before any budget or provider work',async t=>{
 const {make}=await setup(t),job=await make();let authorized=false;
 const result=await runProject(job.journal,{expectedHash:'b'.repeat(64),authorizeRun:()=>{authorized=true;},keepAwake:false});
 assert.equal(result.status,'paused');assert.match(result.reason,/hash/i);assert.equal(authorized,false);assert.equal(job.journal.last('budget.started'),undefined);assert.equal(result.codexCalls,0);
});
test('queue authorization hook runs while the project lock is held',async t=>{
 const {root,make}=await setup(t),job=await make();let called=false;
 const result=await runProject(job.journal,{expectedHash:job.planHash,keepAwake:false,authorizeRun:async()=>{
  called=true;const other=await new Journal(root,job.jobId).load();await assert.rejects(other.lock(),/runner|lock/i);throw new Pause('Declined inside lock','approval');
 }});assert.ok(called);assert.equal(result.status,'paused');assert.equal(job.journal.last('budget.started'),undefined);
});
test('denied queue review permit spends no project review round and calls no frontier',async t=>{
 const {make}=await setup(t),job=await make();let calls=0;
 const result=await runProject(job.journal,{expectedHash:job.planHash,keepAwake:false,local:new FakeProjectLocal(),frontier:{reviewCode:async()=>{calls++;throw Error('must not call');}},
  checks:{verify:async()=>({simulated:true}),run:async checks=>checks.map(c=>({id:c.id,passed:true,code:0,screenshots:[]}))},
  beforeReview:()=>{throw new Pause('Queue review-call budget exhausted','needs_review');}});
 assert.equal(result.status,'needs_review');assert.equal(calls,0);assert.equal(result.codexCalls,0);assert.equal(result.stages[0].codexReviews,0);
});
test('new enqueue rejects historical and manually stopped jobs without adding approvals',async t=>{
 const {root,make}=await setup(t);
 for(const entry of [{type:'run.finished',data:{status:'paused'}},{type:'run.finished',data:{status:'accepted'}},{type:'budget.started',data:{deadline:Date.now()+10000}},{type:'manual-stop'}]){
  const job=await make();if(entry.type==='manual-stop')await stopProject(job.journal);else await job.journal.append(entry.type,entry.data);
  await assert.rejects(enqueue({root,jobId:job.jobId,hash:job.planHash}),/fresh|historical|stopped/i);
  const log=await new Journal(root,job.jobId).load();assert.equal(log.events.filter(e=>e.type==='project.approved').length,1);
 }
 assert.equal((await queueStatus({root})).items.length,0);
});
test('retry and duplicate add cannot silently bind a newly approved plan hash',async t=>{
 const {root,make}=await setup(t),job=await make();await enqueue({root,jobId:job.jobId,hash:job.planHash});await runQueue({root,once:true,keepAwake:false,runJob:async()=>({status:'failed'})});
 const log=await new Journal(root,job.jobId).load(),manifest={...log.last('project.created'),planVersion:2,brief:'Different approved scope'};await log.append('project.created',manifest);const hash=digest(manifest);await approveProject(log,hash);
 await assert.rejects(retryItem({root,jobId:job.jobId,hash}),/original|hash/i);await assert.rejects(enqueue({root,jobId:job.jobId,hash}),/rebound|hash/i);
 assert.equal((await queueStatus({root})).items[0].hash,job.planHash);
});
test('a long live transaction lock is never deleted by a competing enqueue',async t=>{
 const {root,make}=await setup(t),job=await make();const journal=await new Journal(path.join(root,'task-queue'),QUEUE_ID).load();const release=await journal.lock();let finished=false;
 const adding=enqueue({root,jobId:job.jobId,hash:job.planHash}).finally(()=>{finished=true;});
 try{await delay(650);assert.equal(finished,false,'live transaction lock was bypassed');}finally{await release();}
 await adding;assert.equal((await queueStatus({root})).items.length,1);
});
test('competing dead-worker recoverers elect only one new worker',async t=>{
 const {root,make}=await setup(t),job=await make();await enqueue({root,jobId:job.jobId,hash:job.planHash});
 const journal=await new Journal(path.join(root,'task-queue'),QUEUE_ID).load();const release=await journal.lock();const state=journal.events.findLast(e=>e.data.state).data.state;state.worker={pid:999999999,token:'dead',active:true};await journal.append('queue.test.fixture',{state});await release();
 let enter,finish;const entered=new Promise(r=>{enter=r;}),gate=new Promise(r=>{finish=r;});const first=runQueue({root,once:true,keepAwake:false,runJob:async()=>{enter();await gate;return{status:'accepted'};}});
 await entered;try{await assert.rejects(runQueue({root,once:true,keepAwake:false}),/worker|lease/i);}finally{finish();await first;}
 assert.equal((await queueStatus({root})).jobsUsed,1);
});

async function killedChild(code, marker) {
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',c=>{errors+=c;});
 const closed=new Promise(r=>{child.once('close',r);child.once('error',r);});
 try{let ready=false;for(let n=0;n<150;n++){try{await readFile(marker);ready=true;break;}catch{}await delay(10);}assert.ok(ready,'child never entered operation: '+errors);}finally{child.kill('SIGKILL');await closed;}
}
test('crash before a retried project starts does not restore its old failure',async t=>{
 const {root,make}=await setup(t),job=await make();await enqueue({root,jobId:job.jobId,hash:job.planHash});
 await runQueue({root,once:true,keepAwake:false,runJob:async()=>{await job.journal.append('run.finished',{status:'failed',reason:'old failure'});return{status:'failed'};}});
 await retryItem({root,jobId:job.jobId,hash:job.planHash});const marker=path.join(root,'retry-claimed');
 const source=pathToFileURL(path.join(process.cwd(),'src/task-queue.mjs')).href;
 await killedChild(`import{runQueue}from ${JSON.stringify(source)};import{writeFile}from'node:fs/promises';await runQueue({root:${JSON.stringify(root)},once:true,keepAwake:false,runJob:async()=>{await writeFile(${JSON.stringify(marker)},'ready');await new Promise(r=>setTimeout(r,30000));return{status:'accepted'};}});`,marker);
 let calls=0;await runQueue({root,once:true,keepAwake:false,runJob:async()=>{calls++;return{status:'accepted'};}});
 assert.equal(calls,1);const item=(await queueStatus({root})).items[0];assert.equal(item.status,'accepted');assert.equal(item.retries,1);assert.equal((await queueStatus({root})).jobsUsed,1);
});
test('a reviewer interrupted by process death still consumes its stage call round',async t=>{
 const {root,make}=await setup(t),job=await make();await job.journal.append('frontier.call',{kind:'review',stageId:'implementation',key:'earlier-call',round:1,durationMs:0,decision:'error'});
 const marker=path.join(root,'review-entered');const src=path.join(process.cwd(),'src');
 const imports={j:pathToFileURL(path.join(src,'project/journal.mjs')).href,r:pathToFileURL(path.join(src,'project/runner.mjs')).href,f:pathToFileURL(path.join(src,'project/fake.mjs')).href};
 const code=`import{Journal}from ${JSON.stringify(imports.j)};import{runProject}from ${JSON.stringify(imports.r)};import{FakeProjectLocal}from ${JSON.stringify(imports.f)};import{writeFile}from'node:fs/promises';const j=await new Journal(${JSON.stringify(root)},${JSON.stringify(job.jobId)}).load();await runProject(j,{keepAwake:false,local:new FakeProjectLocal(),checks:{verify:async()=>({simulated:true}),run:async cs=>cs.map(c=>({id:c.id,passed:true,code:0,screenshots:[]}))},frontier:{reviewCode:async()=>{await writeFile(${JSON.stringify(marker)},'ready');await new Promise(r=>setTimeout(r,30000));return{decision:'accept',feedback:'fake',unverified:[]};}}});`;
 await killedChild(code,marker);const log=await new Journal(root,job.jobId).load();assert.equal(summarize(log).stages[0].codexReviews,2,'interrupted stage review was not charged');
 let reviews=0;const result=await runProject(log,{keepAwake:false,local:new FakeProjectLocal(),checks:{verify:async()=>({simulated:true}),run:async cs=>cs.map(c=>({id:c.id,passed:true,code:0,screenshots:[]}))},frontier:{reviewCode:async()=>{reviews++;return{decision:'accept',feedback:'fake',unverified:[]};}}});
 assert.equal(reviews,0);assert.equal(result.status,'needs_review');assert.equal(result.stages[0].codexReviews,2);
});
