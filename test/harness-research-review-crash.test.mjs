import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import path from 'node:path';import {fixture} from './fixtures/research-review-binding.mjs';
const driver=fileURLToPath(new URL('./fixtures/research-review-crash.mjs',import.meta.url));
const run=(root,point,action)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[driver,root,point,action],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.once('error',reject);p.once('exit',(code,signal)=>resolve({code,signal,out,err}));});
for(const point of ['beforeReservation','afterReservation','beforeSubmitIntent','afterSubmitIntent','remoteSaved','afterAckBeforeCommit','afterLocalCommit','beforeCollection','afterCollectionBeforeCompletion','afterCompletion'])test('SIGKILL recovery at '+point,async t=>{
 const f=await fixture(t),before=f.c.getTask(f.task.id),reserve=['beforeReservation','afterReservation'].includes(point),collect=['beforeCollection','afterCollectionBeforeCompletion','afterCompletion'].includes(point);
 if(!reserve)await f.reserve();if(collect)await f.accept();
 await writeFile(path.join(f.root,'remote.json'),JSON.stringify({taskId:f.task.id,packet:f.packet,tickets:f.tickets,remote:f.remote,reserveDispatches:f.tickets.length,submitDispatches:collect?1:0}));f.c.close();f.c.close=()=>{};
 const killed=await run(f.root,point,reserve?'reserve':collect?'collect':'submit');assert.equal(killed.signal,'SIGKILL',killed.err+killed.out);
 const marker=JSON.parse(await readFile(path.join(f.root,'crash-marker.json')));assert.equal(marker.point,point);
 if(['beforeReservation','afterReservation','beforeSubmitIntent','afterSubmitIntent','remoteSaved','afterAckBeforeCommit'].includes(point))assert.equal(marker.task.researchReviewAcceptance,undefined);
 if(['afterSubmitIntent','remoteSaved','afterAckBeforeCommit'].includes(point))assert.equal(marker.task.researchReviewTickets[0].submissionIntent.state,'pending');
 if(point==='beforeReservation')assert.equal(marker.reviewers.length,0);
 if(reserve){const r=await run(f.root,'none','reserve');assert.equal(r.code,0,r.err);}
 if(!collect){const r=await run(f.root,'none','submit');assert.equal(r.code,0,r.err);}
 const result=await run(f.root,'none','collect');assert.equal(result.code,0,result.err);const data=JSON.parse(result.out);
 assert.equal(data.task.status,'accepted');assert.equal(data.task.id,before.id);assert.equal(data.task.goalId,before.goalId);assert.equal(data.task.deadline,before.deadline);assert.equal(data.task.reviews,1);assert.equal(data.reviewers.length,1);assert.equal(data.remote.reserveDispatches,1);assert.equal(data.remote.submitDispatches,1);assert.deepEqual(data.task.spent,before.spent);assert.equal(data.acceptedEvents,1);
 const replay=await run(f.root,'none','collect');assert.equal(replay.code,0,replay.err);const after=JSON.parse(replay.out);assert.deepEqual(after.task,data.task);assert.deepEqual(after.remote,data.remote);assert.equal(after.acceptedEvents,1);
 if(process.env.FRONTIER_REVIEW_CRASH_EVIDENCE){await mkdir(process.env.FRONTIER_REVIEW_CRASH_EVIDENCE,{recursive:true});await writeFile(path.join(process.env.FRONTIER_REVIEW_CRASH_EVIDENCE,point+'.json'),JSON.stringify({point,killed:{code:killed.code,signal:killed.signal},before,marker,recovered:data,replay:after},null,2)+'\n');}
});
