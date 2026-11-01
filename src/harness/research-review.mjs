import {createHash} from 'node:crypto';
import {digest} from './contracts.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
export function verifyProposal(packet,task){
 const d=packet?.descriptor,{candidateHash,...base}=d??{};
 if(!d||candidateHash!==digest(base)||d.jobId!==task.checkpoint.remoteJobId||d.manifestHash!==task.checkpoint.remoteHash||d.rubricSha256!==task.spec.researchPolicy.review.rubricSha256)throw Error('Research proposal identity mismatch');
 for(const [key,hash]of [['report','reportSha256'],['sources','sourcesSha256'],['offers','offersSha256']])if(typeof packet.canonical?.[key]!=='string'||sha(packet.canonical[key])!==d[hash])throw Error('Research proposal checksum mismatch');
 if(Buffer.byteLength(JSON.stringify(packet))>32*1024*1024)throw Error('Research proposal exceeds bound');
 return packet;
}
export function verifyReviewedReceipt(receipt,task){
 const q=receipt?.quality,d=q?.review_binding;
 if(q?.independent_semantic_review!=='passed'||q.accepted_candidate_hash!==d?.candidateHash||d?.jobId!==task.checkpoint.remoteJobId||d?.manifestHash!==task.checkpoint.remoteHash||d?.rubricSha256!==task.spec.researchPolicy.review.rubricSha256)throw Error('Missing bound independent research acceptance');
 const {candidateHash,...base}=d;if(digest(base)!==candidateHash)throw Error('Review binding checksum mismatch');
 if(!Number.isFinite(receipt.semantic_finalization_intent_at)||receipt.semantic_finalization_intent_at>=receipt.deadline)throw Error('No timely research finalization intent');
 if(q.report_sha256!==d.reportSha256||q.source_artifact_sha256!==d.sourcesSha256)throw Error('Accepted report/source artifact binding mismatch');
 const tickets=receipt.semantic_reviews;
 if(!Array.isArray(tickets)||tickets.length>2||!tickets.some(t=>t.binding?.candidateHash===candidateHash&&t.submission?.decision==='accept'&&t.submission.rubricSha256===d.rubricSha256&&digest(t.submission.coverage?.slice().sort())===digest(d.units.slice().sort())&&!t.submission.findings.length))throw Error('Missing full replacement review coverage');
 return d;
}

export function verifyAcceptedArtifacts(descriptor,report,sources){
 if(sha(report)!==descriptor.reportSha256||sha(sources)!==descriptor.sourcesSha256)throw Error('Accepted report/source artifact content mismatch');
}
