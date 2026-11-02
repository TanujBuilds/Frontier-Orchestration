import {createHash} from 'node:crypto';
import {digest} from './contracts.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const hashPattern=/^[a-f0-9]{64}$/;
const closed=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(k=>Object.hasOwn(value,k));
export function verifyDescriptor(d){
 if(!closed(d,['version','jobId','manifestHash','rubricSha256','reportSha256','sourcesSha256','offersSha256','request','units','candidateHash'])||d.version!==1||typeof d.jobId!=='string'||!d.jobId.length||d.jobId.length>200||['manifestHash','rubricSha256','reportSha256','sourcesSha256','offersSha256','candidateHash'].some(k=>typeof d[k]!=='string'||!hashPattern.test(d[k]))||!closed(d.request,['operationId','requestSha256','resultSha256','offersSha256'])||typeof d.request.operationId!=='string'||!d.request.operationId.length||d.request.operationId.length>200||['requestSha256','resultSha256','offersSha256'].some(k=>typeof d.request[k]!=='string'||!hashPattern.test(d.request[k]))||d.request.offersSha256!==d.offersSha256||!Array.isArray(d.units)||!d.units.length||d.units.length>1000||d.units.some(u=>typeof u!=='string'||!u.length||u.length>200)||new Set(d.units).size!==d.units.length)throw Error('Invalid complete research descriptor/request lineage');
 const {candidateHash,...base}=d;if(candidateHash!==digest(base))throw Error('Research descriptor checksum mismatch');
 return d;
}
function reportUnits(raw){
 const report=JSON.parse(raw);
 if(!report||!Array.isArray(report.claims)||report.claims.length>100||report.claims.some(c=>!c||typeof c.id!=='string'||!/^C[0-9]{1,4}$/.test(c.id)))throw Error('Invalid candidate report units');
 const units=['title',...report.claims.map(c=>'claims:'+c.id)];
 for(const field of ['summary','comparisons','recommendations','contradictions','unanswered']){if(!Array.isArray(report[field])||units.length+report[field].length>1000)throw Error('Invalid candidate report units');for(let i=0;i<report[field].length;i++)units.push(field+':'+i);}
 if(new Set(units).size!==units.length)throw Error('Duplicate candidate report units');
 return units;
}
export function verifyProposal(packet,task){
 if(Buffer.byteLength(JSON.stringify(packet))>32*1024*1024)throw Error('Research proposal exceeds bound');
 const d=verifyDescriptor(packet?.descriptor);
 if(d.jobId!==task.checkpoint.remoteJobId||d.manifestHash!==task.checkpoint.remoteHash||d.rubricSha256!==task.spec.researchPolicy.review.rubricSha256)throw Error('Research proposal identity mismatch');
 for(const [key,hash]of [['report','reportSha256'],['sources','sourcesSha256'],['offers','offersSha256']])if(typeof packet.canonical?.[key]!=='string'||sha(packet.canonical[key])!==d[hash])throw Error('Research proposal checksum mismatch');
 if(digest(reportUnits(packet.canonical.report))!==digest(d.units))throw Error('Research descriptor does not cover exact canonical report units');
 return packet;
}
// Local coordinator records are authority; exported receipts only corroborate them.
const equal=(a,b)=>a!==undefined&&b!==undefined&&digest(a)===digest(b);
export function verifyReviewVerdict(input,descriptor){
 verifyDescriptor(descriptor);
 if(Buffer.byteLength(JSON.stringify(input))>32768)throw Error('Research review input exceeds bound');
 const {decision,findings,coverage}=input,units=descriptor?.units;
 if(!Array.isArray(units)||!units.length||new Set(units).size!==units.length||!Array.isArray(coverage)||coverage.some(u=>typeof u!=='string'||!units.includes(u))||new Set(coverage).size!==coverage.length||!Array.isArray(findings)||findings.length>50||!['accept','revise','reject'].includes(decision))throw Error('Invalid local research review verdict');
 if(decision==='accept'&&(findings.length||!equal([...coverage].sort(),[...units].sort())))throw Error('Local acceptance requires full unique coverage and no findings');
 if(decision!=='accept'&&!findings.length)throw Error('Negative local review requires findings');
}
export function verifyReserveAck(result,descriptor){
 if(!closed(result,['id','candidateHash','rubricSha256','dispatchRequired'])||typeof result.id!=='string'||!result.id.length||result.id.length>200||typeof result.dispatchRequired!=='boolean'||result.candidateHash!==descriptor.candidateHash||result.rubricSha256!==descriptor.rubricSha256)throw Error('Research reserve acknowledgment mismatch');
}
export function verifySubmitAck(result,intent){
 const i=intent.input;
 if(!equal(result,{jobId:intent.jobId,ticketId:intent.ticketId,decision:i.decision,candidateHash:i.candidateHash,status:'queued'}))throw Error('Research submit acknowledgment mismatch');
}
export function verifyLocalAcceptance(task,getReviewer){
 const a=task.researchReviewAcceptance,ticket=task.researchReviewTickets?.find(t=>t.id===a?.ticketId),intent=ticket?.submissionIntent,d=a?.descriptor;
 if(!a||a.version!==1||a.state!=='accepted'||a.goalId!==task.goalId||a.taskId!==task.id||a.jobId!==task.checkpoint.remoteJobId||a.manifestHash!==task.checkpoint.remoteHash||d?.jobId!==a.jobId||d?.manifestHash!==a.manifestHash||d?.rubricSha256!==task.spec.researchPolicy.review.rubricSha256||a.input?.decision!=='accept'||a.input.action!=='submit'||a.input.taskId!==task.id||a.input.ticketId!==a.ticketId||a.input.candidateHash!==d?.candidateHash||a.input.rubricHash!==d?.rubricSha256||!ticket||!intent||intent.state!=='acknowledged')throw Error('Missing authoritative local research acceptance');
 verifyDescriptor(d);
 const {candidateHash,...base}=d;if(candidateHash!==digest(base)||!equal(a.descriptor,intent.descriptor)||!equal(a.input,intent.input)||a.inputHash!==digest({input:a.input,key:a.submissionKey})||a.inputHash!==intent.inputHash||a.nativeReservationId!==ticket.nativeReservationId||a.nativeReservationId!==intent.nativeReservationId||a.ticketId!==intent.ticketId||a.submissionKey!==intent.submissionKey||a.intentAt!==intent.intentAt||a.goalId!==intent.goalId||a.taskId!==intent.taskId||a.jobId!==intent.jobId||a.manifestHash!==intent.manifestHash||ticket.candidateHash!==candidateHash||ticket.rubricSha256!==d.rubricSha256||ticket.submissionHash!==a.inputHash||!equal(ticket.descriptor,d)||!Number.isFinite(a.intentAt)||!Number.isFinite(a.acknowledgedAt)||a.intentAt>=task.deadline||a.acknowledgedAt>=task.deadline||a.acknowledgedAt<a.intentAt)throw Error('Local research acceptance binding mismatch');
 verifyReviewVerdict(a.input,d);verifySubmitAck(a.acknowledgment,a);
 if(!equal(a.acknowledgment,ticket.submissionResult)||!equal(a.acknowledgment,intent.acknowledgment))throw Error('Local research acknowledgment mismatch');
 const run=getReviewer?.(a.nativeReservationId);
 if(!run||run.goalId!==task.goalId||run.taskId!==task.id||run.status!=='completed'||!equal(run.result,{ticketId:a.ticketId,decision:'accept',candidateHash,submissionHash:a.inputHash}))throw Error('Local research reviewer reservation mismatch');
 return a;
}
// Remote evidence integrity alone never grants coordinator acceptance.
export function verifyRemoteReviewEvidence(receipt,task){
 const q=receipt?.quality,d=q?.review_binding;
 if(q?.independent_semantic_review!=='passed'||q.accepted_candidate_hash!==d?.candidateHash||d?.jobId!==task.checkpoint.remoteJobId||d?.manifestHash!==task.checkpoint.remoteHash||d?.rubricSha256!==task.spec.researchPolicy.review.rubricSha256)throw Error('Missing bound independent research acceptance');
 const {candidateHash,...base}=d;if(digest(base)!==candidateHash)throw Error('Review binding checksum mismatch');
 if(!Number.isFinite(receipt.semantic_finalization_intent_at)||receipt.semantic_finalization_intent_at>=receipt.deadline)throw Error('No timely research finalization intent');
 if(q.report_sha256!==d.reportSha256||q.source_artifact_sha256!==d.sourcesSha256)throw Error('Accepted report/source artifact binding mismatch');
 verifyDescriptor(d);
 const tickets=receipt.semantic_reviews;
 if(!Array.isArray(tickets)||tickets.length>2||!tickets.some(t=>t.binding?.candidateHash===candidateHash&&t.submission?.decision==='accept'&&t.submission.rubricSha256===d.rubricSha256&&digest(t.submission.coverage?.slice().sort())===digest(d.units.slice().sort())&&!t.submission.findings.length))throw Error('Missing full replacement review coverage');
 return d;
}
export function verifyReviewedReceipt(receipt,task,getReviewer){
 const d=verifyRemoteReviewEvidence(receipt,task),tickets=receipt.semantic_reviews;
 const a=verifyLocalAcceptance(task,getReviewer);
 const deadline=Math.floor(task.deadline/1000);
 if(receipt.job_id!==a.jobId||receipt.manifest_hash!==a.manifestHash||receipt.status!=='completed'||!['live','fixture'].includes(task.checkpoint.manifest?.mode)||receipt.mode!==task.checkpoint.manifest.mode||receipt.deadline!==deadline||task.checkpoint.manifest.not_after!==deadline||receipt.semantic_finalization_intent_at>=deadline)throw Error('Research receipt envelope identity/original deadline mismatch');
 if(!equal(d,a.descriptor))throw Error('Returned candidate differs from authoritative local acceptance');
 const ticket=tickets.find(t=>t.id===a.ticketId),i=a.input;
 const expected={ticketId:a.ticketId,candidateHash:i.candidateHash,rubricSha256:i.rubricHash,decision:i.decision,findings:i.findings,coverage:i.coverage,key:a.submissionKey};
 if(!ticket||ticket.key!==task.researchReviewTickets.find(t=>t.id===a.ticketId).reservationKey||!equal(ticket.binding,{candidateHash:d.candidateHash,rubricSha256:d.rubricSha256})||!equal(ticket.submission,expected)||!equal(ticket.result,a.acknowledgment))throw Error('Remote research ticket/submission differs from local acceptance');
 return a.descriptor;
}

export function verifyAcceptedArtifacts(descriptor,report,sources){
 if(sha(report)!==descriptor.reportSha256||sha(sources)!==descriptor.sourcesSha256)throw Error('Accepted report/source artifact content mismatch');
}
