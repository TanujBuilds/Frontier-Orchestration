// Scripted backend, genuine coordinator/reviewer operations. Never live research.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fixture,policy} from './research-review-binding.mjs';
import {readinessFixture} from './readiness-fixture.mjs';
export {policy};
export async function acceptedFixture(t,{environment='live',now}={}){
 const f=await fixture(t,{environment,now});await f.accept();await f.collect();
 const task=f.c.getTask(f.task.id);if(task.status!=='accepted')throw Error('Fixture collection failed: '+JSON.stringify(task));
 const receipt=JSON.parse(await fs.readFile(path.join(task.result.directory,'receipt.json')));
 return {...f,receipt,args:{stateRoot:f.root,taskId:task.id,receipt,policy,reportBytes:Buffer.from(f.packet.canonical.report),sourceBytes:Buffer.from(f.packet.canonical.sources)}};
}
export async function checkerFixture(t,{environment='live',status='passed'}={}){
 const f=await acceptedFixture(t,{environment}),r=await readinessFixture(t);r.receipt.policy=policy;
 const report=await r.artifact('claims.json',f.args.reportBytes.toString(),'report'),source=await r.artifact('sources.json',f.args.sourceBytes.toString(),'source'),review=await r.artifact('review.md','SYNTHETIC prospective-live protocol fixture; no semantic/live certification','review');
 const assessment=await r.artifact('assessment.json',{schema:1,kind:'independent-semantic-assessment',candidate:r.binding,policy,status,reportSha256:report.sha256,sourceSha256s:[source.sha256],reviewSha256:review.sha256,criteria:[{id:'material-claims',status}]},'assessment');
 const worker=await r.artifact('worker.json',f.receipt,'receipt');
 r.receipt.gates.push({name:'live_research_quality',status:'passed',applicability:'current',scope:'live',authority:'independent_native',artifacts:[report,source,review,assessment,worker]});await r.save();
 return {...f,r,opts:{...r.opts,coordinatorStateRoot:f.root,coordinatorTaskId:f.task.id}};
}
