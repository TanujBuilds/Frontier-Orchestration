// Disposable process-death driver. Every boundary uses actual SIGKILL and SQLite.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {ResearchAdapter} from '../src/harness/research.mjs';
const [root,point,action]=process.argv.slice(2),stateFile=path.join(root,'remote.json'),state=JSON.parse(readFileSync(stateFile)),c=new Coordinator({root}),owner='child-'+process.pid;
c.acquireWorker(owner);
const w=new Worker({c,owner,config:{research:{pollMs:0}}});let armed=false;
const die=name=>{if(point===name){writeFileSync(path.join(root,'crash-marker.json'),JSON.stringify({point:name,task:c.getTask(state.taskId),reviewers:c.store.all('reviewer'),remote:state}));process.kill(process.pid,'SIGKILL');}};
const tx=c.store.tx.bind(c.store);c.store.tx=fn=>{if(armed){armed=false;die('afterAckBeforeCommit');const result=tx(fn);die('afterLocalCommit');return result;}return tx(fn);};
const command=c.store.command.bind(c.store);c.store.command=(key,...args)=>{if(key.startsWith('research-intent-'))die('beforeReservation');if(key.startsWith('research-submit-intent-'))die('beforeSubmitIntent');return command(key,...args);};
const a=new ResearchAdapter(w,{rpc:async r=>{
 if(r.command==='status')return state.remote;
 if(r.command==='yield')return {};
 if(r.command==='export')return {job:{id:'remote',manifest_hash:state.packet.descriptor.manifestHash,status:'completed',deadline:Math.floor(c.getTask(state.taskId).deadline/1000),manifest:{mode:'fixture'}}};
 if(r.command==='review_reserve'){
  die('afterReservation');let ticket=state.tickets.find(t=>t.key===r.idempotency_key),old=!!ticket;
  if(!ticket){ticket={id:'ticket-0',key:r.idempotency_key,binding:{candidateHash:r.candidateHash,rubricSha256:r.rubricHash}};state.tickets.push(ticket);state.reserveDispatches++;writeFileSync(stateFile,JSON.stringify(state));}
  return {id:ticket.id,...ticket.binding,dispatchRequired:!old};
 }
 if(r.command==='review_submit'){
  die('afterSubmitIntent');const ticket=state.tickets.find(t=>t.id===r.ticketId);
  const submission={ticketId:r.ticketId,candidateHash:r.candidateHash,rubricSha256:r.rubricHash,decision:r.decision,coverage:r.coverage,findings:r.findings,key:r.idempotency_key};
  if(!ticket.submission){ticket.submission=submission;ticket.result={jobId:'remote',ticketId:ticket.id,decision:r.decision,candidateHash:r.candidateHash,status:'queued'};state.submitDispatches++;writeFileSync(stateFile,JSON.stringify(state));}
  else if(JSON.stringify(ticket.submission)!==JSON.stringify(submission))throw Error('Remote same-key conflict');
  die('remoteSaved');armed=true;return ticket.result;
 }
 throw Error('Unexpected '+r.command);
},collect:async()=>{
 die('beforeCollection');const directory=path.join(root,'collected');mkdirSync(directory,{recursive:true});const task=c.getTask(state.taskId),d=state.packet.descriptor;
 const receipt={job_id:'remote',manifest_hash:d.manifestHash,status:'completed',mode:'fixture',deadline:Math.floor(task.deadline/1000),semantic_finalization_intent_at:(task.deadline-1000)/1000,quality:{independent_semantic_review:'passed',accepted_candidate_hash:d.candidateHash,review_binding:d,report_sha256:d.reportSha256,source_artifact_sha256:d.sourcesSha256},semantic_reviews:state.tickets};
 writeFileSync(path.join(directory,'receipt.json'),JSON.stringify(receipt));writeFileSync(path.join(directory,'claims.json'),state.packet.canonical.report);writeFileSync(path.join(directory,'sources.json'),state.packet.canonical.sources);die('afterCollectionBeforeCompletion');return {directory,job_id:'remote',status:'completed',checksums_verified:true};
}});
const complete=c.completeTask.bind(c);c.completeTask=(...args)=>{const result=complete(...args);die('afterCompletion');return result;};
const input={taskId:state.taskId,candidateHash:state.packet.descriptor.candidateHash,rubricHash:state.packet.descriptor.rubricSha256};
if(action==='reserve')await a.review({action:'reserve',...input},'reserve');
if(action==='submit')await a.review({action:'submit',...input,ticketId:'ticket-0',decision:'accept',findings:[],coverage:state.packet.descriptor.units},'submit');
if(action==='collect'){
 state.remote.status='completed';writeFileSync(stateFile,JSON.stringify(state));
 const task=c.getTask(state.taskId);
 if(task.status==='uncertain')await a.reconcile({taskId:task.id},'recover-collection');
 else if(task.status!=='accepted'){c.claimNext(owner);await a.step(c.getTask(task.id),owner);}
}
console.log(JSON.stringify({task:c.getTask(state.taskId),reviewers:c.store.all('reviewer'),remote:state,acceptedEvents:c.store.events(0,1000).filter(e=>e.type==='task.result'&&e.data.status==='accepted').length}));c.close();
