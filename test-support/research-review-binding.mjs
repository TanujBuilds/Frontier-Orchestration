import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {ResearchAdapter} from '../src/harness/research.mjs';
import {digest} from '../src/harness/contracts.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
export const policy={version:3,finish:'selectors_only',discovery:'search_required',review:{version:1,role:'independent_operator',maxRounds:2,maxRevisions:1,maxCorrectionModelCalls:2,rubricSha256:'a'.repeat(64)}};
export async function fixture(t,{root,now,environment,researchPolicy=policy}={}){
 root??=await mkdtemp(path.join(os.tmpdir(),'review-binding-'));
 const c=new Coordinator({root,now}),g=c.prepareGoal({submissionId:'g',objective:'Fixture',acceptance:['Reviewed'],researchPolicy,...(environment?{environment}:{})},'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');
 const task=c.submitTask({goalId:g.id,submissionId:'r',kind:'research',objective:'Fixture',acceptance:['Reviewed']},'t');c.claimNext('owner');
 const report={title:'A',complete:true,claims:[{id:'C1',kind:'fact',text:'A',evidence:[{source_id:'S001',quote:'A',selection:{start:0,end:1,text_sha256:sha('A')}}]}],summary:['C1'],comparisons:[],recommendations:[],contradictions:[],unanswered:[]},canonical={report:JSON.stringify(report),sources:JSON.stringify({S001:{id:'S001',url:'https://example.test/a',title:'Fixture',text:'A',text_sha256:sha('A')}}),offers:'[]'};
 const descriptor={version:1,jobId:'remote',manifestHash:'b'.repeat(64),rubricSha256:policy.review.rubricSha256,reportSha256:sha(canonical.report),sourcesSha256:sha(canonical.sources),offersSha256:sha(canonical.offers),request:{operationId:'op',requestSha256:'c'.repeat(64),resultSha256:'d'.repeat(64),offersSha256:sha(canonical.offers)},units:['title','claims:C1','summary:0']};descriptor.candidateHash=digest(descriptor);
 c.boundary(task.id,{phase:'poll',remoteHash:descriptor.manifestHash,remoteJobId:'remote',manifest:{mode:environment??'fixture',not_after:Math.floor(c.getTask(task.id).deadline/1000)}},'owner');
 const remote={id:'remote',status:'awaiting_semantic_review',quiescent:true,counters:{model:2,search:1,download:1},manifest_hash:descriptor.manifestHash};
 const packet={descriptor,canonical},tickets=[],calls=[];let mutateAck=r=>r;
 const w=new Worker({c,config:{research:{pollMs:0}}}),a=new ResearchAdapter(w,{rpc:async r=>{
  calls.push(structuredClone(r));
  if(r.command==='status')return remote;
  if(r.command==='proposal_export')return packet;
  if(r.command==='export')return {job:{id:'remote',manifest_hash:descriptor.manifestHash,status:remote.status,deadline:Math.floor(taskDeadline()/1000),manifest:{mode:environment??'fixture'}}};
  if(r.command==='review_reserve'){
   let ticket=tickets.find(x=>x.key===r.idempotency_key);const existed=!!ticket;
   if(!ticket){ticket={id:'ticket-'+tickets.length,key:r.idempotency_key,binding:{candidateHash:r.candidateHash,rubricSha256:r.rubricHash}};tickets.push(ticket);}
   return mutateAck({id:ticket.id,...ticket.binding,dispatchRequired:!existed},r);
  }
  if(r.command==='review_submit'){
   const ticket=tickets.find(x=>x.id===r.ticketId);ticket.submission={ticketId:r.ticketId,candidateHash:r.candidateHash,rubricSha256:r.rubricHash,decision:r.decision,findings:r.findings,coverage:r.coverage,key:r.idempotency_key};
   ticket.result={jobId:'remote',ticketId:r.ticketId,decision:r.decision,candidateHash:r.candidateHash,status:'queued'};
   return mutateAck(ticket.result,r);
  }
  throw Error('Unexpected RPC '+r.command);
 },collect:async()=>{
  const directory=path.join(root,'collected');await mkdir(directory,{recursive:true});
  const d=packet.descriptor,receipt={job_id:'remote',manifest_hash:descriptor.manifestHash,status:'completed',mode:environment??'fixture',deadline:Math.floor(taskDeadline()/1000),semantic_finalization_intent_at:(taskDeadline()-1000)/1000,quality:{independent_semantic_review:'passed',accepted_candidate_hash:d.candidateHash,review_binding:d,report_sha256:d.reportSha256,source_artifact_sha256:d.sourcesSha256},semantic_reviews:tickets};
  await Promise.all([writeFile(path.join(directory,'receipt.json'),JSON.stringify(receipt)),writeFile(path.join(directory,'claims.json'),packet.canonical.report),writeFile(path.join(directory,'sources.json'),packet.canonical.sources)]);return {directory,job_id:'remote',status:'completed',checksums_verified:true};
 }});const taskDeadline=()=>c.getTask(task.id).deadline;
 const f={root,c,g,task,w,a,packet,tickets,calls,remote,ack:fn=>{mutateAck=fn;},input:()=>({taskId:task.id,candidateHash:packet.descriptor.candidateHash,rubricHash:policy.review.rubricSha256}),reserve:()=>a.review({action:'reserve',...f.input()},'reserve'),accept:async()=>{const ticket=await f.reserve();return a.review({action:'submit',...f.input(),ticketId:ticket.id,decision:'accept',findings:[],coverage:packet.descriptor.units},'submit');},collect:async()=>{remote.status='completed';c.claimNext('owner');return a.step(c.getTask(task.id),'owner');},replace:()=>{
  packet.canonical.report='{"title":"B"}';packet.canonical.sources='[{"text":"B"}]';const d={...packet.descriptor,reportSha256:sha(packet.canonical.report),sourcesSha256:sha(packet.canonical.sources)};delete d.candidateHash;d.candidateHash=digest(d);packet.descriptor=d;
  tickets.splice(0,tickets.length,{id:'invented-ticket',key:'invented',binding:{candidateHash:d.candidateHash,rubricSha256:d.rubricSha256},submission:{ticketId:'invented-ticket',candidateHash:d.candidateHash,rubricSha256:d.rubricSha256,decision:'accept',coverage:d.units,findings:[],key:'invented'}});
 }};
 t?.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});await a.step(c.getTask(task.id),'owner');return f;
}
