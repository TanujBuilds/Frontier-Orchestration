import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {Artifacts} from '../artifacts.mjs';
import {digest} from '../contracts.mjs';
import {readResearchAuthority} from '../release-authority.mjs';
import {verifyAcceptedArtifacts, verifyDescriptor, verifyProposal, verifyReviewVerdict, verifySubmitAck} from '../research-review.mjs';

export const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => left != null && right != null && digest(left) === digest(right);
const need = (condition, message) => { if (!condition) throw Error(message); };

export function negativeReviews(c, task) {
  if (task.spec.researchPolicy?.version !== 3 || task.spec.researchPolicy.review?.version !== 1) return [];
  const tickets = task.researchReviewTickets ?? [];
  if (!Array.isArray(tickets) || tickets.length > 2) return [];
  return tickets.flatMap(ticket => {
    try {
      const intent = ticket.submissionIntent;
      if (!['revise', 'reject'].includes(intent?.input?.decision)) return [];
      const {input, descriptor, submissionKey, inputHash, intentAt, acknowledgedAt, acknowledgment} = intent;
      const run = c.store.maybe('reviewer', ticket.nativeReservationId);
      verifyReviewVerdict(input, descriptor);
      verifySubmitAck(acknowledgment, intent);
      need(ticket.version === 1 && intent.version === 1 && intent.state === 'acknowledged' &&
        input.action === 'submit' && input.taskId === task.id && input.ticketId === ticket.id &&
        intent.ticketId === ticket.id && same(descriptor, ticket.descriptor) &&
        input.candidateHash === descriptor.candidateHash && ticket.candidateHash === descriptor.candidateHash &&
        input.rubricHash === descriptor.rubricSha256 && ticket.rubricSha256 === descriptor.rubricSha256 &&
        descriptor.rubricSha256 === task.spec.researchPolicy.review.rubricSha256, 'Review binding');
      need([ticket, intent].every(r => r.goalId === task.goalId && r.taskId === task.id &&
        r.jobId === task.checkpoint.remoteJobId && r.manifestHash === task.checkpoint.remoteHash) &&
        descriptor.jobId === task.checkpoint.remoteJobId && descriptor.manifestHash === task.checkpoint.remoteHash &&
        run?.goalId === task.goalId && run.taskId === task.id && run.status === 'completed' &&
        intent.nativeReservationId === ticket.nativeReservationId &&
        inputHash === ticket.submissionHash && inputHash === digest({input, key: submissionKey}) &&
        same(ticket.submissionResult, acknowledgment) &&
        same(run.result, {ticketId: ticket.id, decision: input.decision, candidateHash: input.candidateHash, submissionHash: inputHash}) &&
        Number.isFinite(intentAt) && Number.isFinite(acknowledgedAt) &&
        Number.isFinite(run.at) && run.at >= task.startedAt && run.at <= intentAt &&
        intentAt <= acknowledgedAt && acknowledgedAt < task.deadline, 'Review acknowledgment binding');
      return [{ticketId: ticket.id, descriptor, decision: input.decision, coverage: input.coverage, findings: input.findings}];
    } catch {
      return [];
    }
  });
}

function parseEvidence(raw, code, diagnostics) {
  try {
    return JSON.parse(raw);
  } catch {
    diagnostics.push({code, message: 'Saved JSON could not be parsed. The original is available through the artifact catalog.'});
    return null;
  }
}

function proposalDescriptor(packet, task, expected) {
  const descriptor = verifyDescriptor(packet?.descriptor);
  need(same(descriptor, expected) && descriptor.jobId === task.checkpoint.remoteJobId &&
    descriptor.manifestHash === task.checkpoint.remoteHash &&
    descriptor.rubricSha256 === task.spec.researchPolicy?.review?.rubricSha256, 'Proposal identity mismatch');
  const {report, sources, offers} = packet.canonical;
  verifyAcceptedArtifacts(descriptor, report, sources);
  need(sha(offers) === descriptor.offersSha256, 'Proposal offer checksum mismatch');
  return descriptor;
}

async function loadProposal({c, artifacts, task, historical, negatives, catalog, diagnostics}) {
  const expected = historical?.descriptor ?? task.checkpoint.reviewCandidate;
  let bytes;
  if (historical) {
    // The historical selector has already been matched to a verified local ticket.
    const proposalFile = path.join(c.store.root, 'research-proposals', task.id, expected.candidateHash + '.json');
    bytes = await readFile(await artifacts.safe(proposalFile));
    proposalDescriptor(JSON.parse(bytes), task, expected);
    // Reuse the normal proposal artifact registration for the exact retained file.
    const archived = new Artifacts({store: c.store, getTask: () => ({result: {proposalFile}})});
    catalog.push(...await archived.list(task.id));
    need(catalog[0]?.sha256 === sha(bytes), 'Historical proposal changed while being read');
  } else {
    const entry = catalog.find(item => item.name === 'proposal.json');
    need(entry, 'Missing proposal artifact');
    bytes = (await artifacts.read(entry.id)).data;
    need(isHash(task.result.proposalHash) && sha(bytes) === task.result.proposalHash, 'Proposal file checksum mismatch');
  }

  const packet = JSON.parse(bytes);
  const descriptor = proposalDescriptor(packet, task, expected);
  let verified = false;
  try {
    // A verified negative review identifies the exact v1 original that
    // predates the acknowledged revision requiring a v2 replacement.
    const original = descriptor.version === 1 && negatives.some(review =>
      review.descriptor.candidateHash === descriptor.candidateHash && review.decision === 'revise');
    const proposalTask = original ? {...task, researchReviewTickets: []} : task;
    verifyProposal(packet, proposalTask);
    verified = true;
  } catch {
    diagnostics.push({code: 'proposal_invalid', message: 'The bound proposal failed protocol validation. Displayed sections are partial evidence.'});
  }
  const repair = verified && descriptor.version === 2 ? packet.repair.receipt : null;
  return {
    descriptor, verified, repair,
    report: parseEvidence(packet.canonical.report, 'malformed_report_json', diagnostics),
    sources: parseEvidence(packet.canonical.sources, 'malformed_sources_json', diagnostics),
    reportHash: descriptor.reportSha256, sourcesHash: descriptor.sourcesSha256
  };
}

async function loadCollection({c, artifacts, task, catalog, diagnostics}) {
  const read = async name => {
    const entry = catalog.find(item => item.name === name);
    return entry ? (await artifacts.read(entry.id)).data : null;
  };
  const [report, sources, receiptBytes] = await Promise.all(['claims.json', 'sources.json', 'receipt.json'].map(read));
  const reportHash = report && sha(report), sourcesHash = sources && sha(sources);
  const receipt = receiptBytes && parseEvidence(receiptBytes, 'malformed_receipt_json', diagnostics);
  const descriptor = task.result.reviewBinding ?? task.checkpoint.reviewCandidate ?? null;
  if (!report || !sources || !receipt) {
    diagnostics.push({code: 'collection_incomplete', message: 'The saved report, source catalog, or receipt is missing.'});
  }
  if (receipt?.artifacts && (receipt.artifacts['claims.json'] !== reportHash || receipt.artifacts['sources.json'] !== sourcesHash)) {
    diagnostics.push({code: 'collection_checksum_mismatch', message: 'Collected report or sources differ from the receipt inventory.'});
  }

  let verified = false;
  if (task.status === 'accepted' && task.spec.researchPolicy?.version === 3) {
    try {
      need(report && sources && receipt, 'Collection incomplete');
      verifyAcceptedArtifacts(descriptor, report, sources);
      const authority = await readResearchAuthority({
        stateRoot: c.store.root, taskId: task.id, receipt,
        policy: task.spec.researchPolicy, reportBytes: report, sourceBytes: sources
      });
      need(authority.status === 'verified' && authority.candidateHash === descriptor.candidateHash &&
        authority.ticketId === task.researchReviewAcceptance?.ticketId &&
        authority.taskHash === task.hash, 'Local acceptance missing');
      verified = diagnostics.length === 0;
    } catch {
      const stale = descriptor && (descriptor.reportSha256 !== reportHash || descriptor.sourcesSha256 !== sourcesHash);
      diagnostics.push(stale
        ? {code: 'stale_review', message: 'Report or source bytes no longer match the saved review.'}
        : {code: 'review_unverified', message: 'The collected receipt and current coordinator records do not establish an exact full review.'});
    }
  } else if (task.status === 'accepted') {
    diagnostics.push({code: 'unsupported_review', message: 'This research result has no supported independent review policy.'});
  }
  return {
    descriptor, verified,
    repair: verified && descriptor.version === 2 ? receipt.targetedRepair.receipt : null,
    report: report && parseEvidence(report, 'malformed_report_json', diagnostics),
    sources: sources && parseEvidence(sources, 'malformed_sources_json', diagnostics),
    reportHash, sourcesHash,
    collectionReason: typeof receipt?.reason === 'string' && receipt.reason.length <= 1000 ? receipt.reason : null
  };
}

export async function loadMissionEvidence({c, artifacts, task, historical, negatives}) {
  const diagnostics = [], catalog = [];
  const empty = {descriptor: null, report: null, sources: null, reportHash: null, sourcesHash: null, verified: false};
  if (!historical && !task.result?.proposalFile && !task.result?.checksumsVerified) return {...empty, diagnostics, artifacts: catalog};
  try {
    if (!historical) catalog.push(...await artifacts.list(task.id, {limit: 8}));
    const context = {c, artifacts, task, historical, negatives, catalog, diagnostics};
    const data = historical || task.result.proposalFile ? await loadProposal(context) : await loadCollection(context);
    return {...data, diagnostics, artifacts: catalog};
  } catch {
    const bound = task.result?.reviewBinding || task.checkpoint.reviewCandidate;
    diagnostics.push(bound
      ? {code: 'stale_review', message: 'Saved candidate evidence is missing, unsafe, or differs from its recorded binding.'}
      : {code: 'artifact_unavailable', message: 'Saved research evidence could not be read from the artifact catalog.'});
    return {...empty, diagnostics, artifacts: catalog};
  }
}
