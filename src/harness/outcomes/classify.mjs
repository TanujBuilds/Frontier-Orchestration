// Initialize the contracts module before its circular behavioral dependency.
import {digest, normalizeResearchPolicy} from '../contracts.mjs';
import {deriveBehavioralEvidence} from '../behavioral-validation.mjs';
import {isOvernightV2} from '../overnight.mjs';
import {verifyLocalAcceptance, verifyReviewVerdict, verifySubmitAck} from '../research-review.mjs';

// Match the coordinator's terminal set. Stopped and blocked tasks can resume.
const terminalStatuses = new Set(['accepted', 'failed', 'partial', 'cancelled']);
const queuedStatuses = new Set(['draft', 'queued', 'codex_ready']);
const knownStatuses = new Set([...terminalStatuses, ...queuedStatuses,
  'running', 'codex_active', 'blocked', 'stopped', 'paused', 'suspended', 'uncertain',
  'awaiting_review', 'awaiting_legacy_review', 'legacy_reviewing', 'ready_to_integrate',
  'awaiting_supervisor', 'awaiting_user']);
const startEvents = new Set(['task.claimed', 'task.native_started', 'attempt.started']);
const reviewEvents = new Set(['task.reviewed', 'task.legacy_reviewed', 'research.review_submitted']);
const modePolicies = new Map([
  ['collaborative@1', 'operator'], ['codex_only@1', 'operator'], ['deepseek_only@1', 'checks'],
  ['overnight_review@1', 'legacy'], ['overnight_review@2', 'legacy'],
]);
const versions = new Map([['coding', [1]], ['research', [1, 2, 3, 4, 5, 6]], ['consult', [1]], ['learning', [1]]]);
const approvedStatuses = new Set(['active', 'paused', 'stopped', 'completed', 'partial']);
const researchTicketId = /^[a-zA-Z0-9_-]{1,100}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const positiveTime = value => nonnegative(value) && value > 0;
const same = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);
const ref = entry => ({kind: 'event', id: entry.seq, type: entry.type});

function historicalGoal(evidence, goalId, version) {
  const id = `${goalId}-${version}`;
  const saved = evidence.find(row => row.kind === 'goal_history' && row.id === id)?.data;
  return saved?.id === id && saved.goalId === goalId && saved.version === version ? saved : null;
}

function approvedGoal(task, goal, evidence) {
  if (!goal || task.goalId !== goal.id || !Number.isSafeInteger(task.goalVersion) ||
      !Number.isSafeInteger(goal.version) || task.goalVersion < 1 || task.goalVersion > goal.version) return null;
  return task.goalVersion === goal.version ? goal : historicalGoal(evidence, goal.id, task.goalVersion);
}

function passingChecks(receipts, project, required, allowed = project.checks.map(check => check.id)) {
  if (!Array.isArray(receipts) || !receipts.length) return false;
  const byId = new Map(project.checks.map(check => [check.id, check]));
  const ids = new Set(receipts.map(receipt => receipt?.id));
  return ids.size === receipts.length && required.every(id => ids.has(id)) &&
    receipts.every(receipt => {
      const spec = byId.get(receipt?.id);
      return spec && allowed.includes(spec.id) && receipt.passed === true && receipt.code === 0 &&
        !receipt.stopped && (receipt.argv === undefined || same(receipt.argv, spec.argv)) &&
        (!spec.screenshots?.length || receipt.screenshots?.length === spec.screenshots.length);
    });
}

function mappedChecks(evidence, project, checks, checkIds, snapshot) {
  if (typeof evidence?.snapshotHash !== 'string' || !hashPattern.test(evidence.snapshotHash) ||
      typeof evidence.executableModesHash !== 'string' || !hashPattern.test(evidence.executableModesHash) ||
      (snapshot !== undefined && evidence.snapshotHash !== digest(snapshot))) return false;
  // The integration transaction persisted the verified commit binding. Recompute
  // the check coverage against the pinned map using the recorded receipt and IDs.
  const expected = deriveBehavioralEvidence(project, {checks, checkIds, snapshot: {}});
  return same(evidence.criteria, expected.criteria);
}

function codingAcceptance(task, goal, events) {
  const {project, mode, overnightPolicy} = goal.manifest;
  const integration = task.integration;
  if (!project || !Array.isArray(project.checks) || !integration || typeof integration.commit !== 'string' ||
      !commitPattern.test(integration.commit)) return {reason: 'integration_receipt_missing'};
  const directNative = integration.review === 'codex_native';
  const expectedReview = {checks: 'none', operator: 'codex_operator', legacy: 'codex_legacy'}[mode.review];
  if (directNative ? mode.review !== 'operator' || task.executionActor !== 'codex' || !task.native ||
      task.native.layout === 'candidate_v1' : integration.review !== expectedReview ||
      typeof integration.candidateCommit !== 'string' || !commitPattern.test(integration.candidateCommit)) {
    return {reason: 'integration_review_policy_mismatch'};
  }
  const integrationEvent = events.findLast(event =>
    event.type === (directNative ? 'task.native_finished' : 'task.integrated'));
  if (!same(integrationEvent?.data, integration)) return {reason: 'integration_event_missing_or_mismatched'};

  const projectIds = project.checks.map(check => check.id);
  const stageIds = task.spec.permissions?.checks;
  if (!Array.isArray(stageIds) || !stageIds.length || stageIds.some(id => !projectIds.includes(id))) {
    return {reason: 'invalid_approved_check_scope'};
  }
  const overnight = isOvernightV2(goal.manifest);
  const intermediate = overnight && task.spec.role !== 'final';
  const required = intermediate ? [...new Set([...overnightPolicy.preflightCheckIds, ...stageIds])] : projectIds;
  const allowed = intermediate ? projectIds.filter(id => !overnightPolicy.finalOnlyCheckIds.includes(id)) : projectIds;
  if (!passingChecks(integration.checks, project, required, allowed)) {
    return {reason: 'combined_checks_missing_or_failed'};
  }
  const combinedIds = integration.checks.map(check => check.id);
  if (project.behavioralChecks && !mappedChecks(integration.behavioralEvidence, project, integration.checks,
    combinedIds)) return {reason: 'combined_behavioral_binding_invalid'};

  const evidenceRefs = [ref(integrationEvent), {
    kind: 'integration', id: integration.commit, candidateCommit: integration.candidateCommit ?? null,
    review: integration.review, checkIds: combinedIds,
  }];
  if (directNative) return {reason: 'direct_native_checks_committed', evidenceRefs};

  const nativeCandidate = task.native?.layout === 'candidate_v1';
  const candidateEvent = events.findLast(event =>
    event.type === (nativeCandidate ? 'task.native_finished' : 'task.result'));
  const candidateChecks = task.result?.checks;
  // This event identifies the completed candidate. For a historical rebind,
  // the original candidate's check list may differ from integration's new check
  // list. The mapped integration receipt below binds the re-run to the candidate.
  if (!candidateEvent || candidateEvent.seq >= integrationEvent.seq ||
      !Array.isArray(candidateChecks) || !candidateChecks.length ||
      !candidateChecks.every(check => check?.passed === true && check.code === 0 && !check.stopped) ||
      (nativeCandidate
        ? task.native.writerActive || task.native.status !== 'integrated' ||
          task.native.commit !== integration.candidateCommit || candidateEvent.data?.commit !== integration.candidateCommit ||
          candidateEvent.data.status !== 'awaiting_review' || !same(task.native.checks, candidateChecks)
        : !same(candidateEvent.data?.result, task.result))) return {reason: 'candidate_checks_or_binding_missing'};
  evidenceRefs.push(ref(candidateEvent));

  // effectiveIntegrationChecks includes earlier accepted stages' check IDs.
  // The matched candidate result preserves that cumulative set even when the
  // report page does not include those earlier stages.
  const candidateIds = overnight ? candidateChecks.map(check => check.id) : stageIds;
  if (overnight && (!passingChecks(candidateChecks, project, required, allowed) ||
      candidateIds.some(id => !combinedIds.includes(id)))) return {reason: 'cumulative_overnight_checks_missing_or_invalid'};

  if (project.behavioralChecks) {
    const snapshot = nativeCandidate ? undefined : task.result?.snapshot;
    if ((!nativeCandidate && !snapshot) ||
        !mappedChecks(integration.candidateBehavioralEvidence, project, integration.checks, candidateIds, snapshot)) {
      return {reason: 'candidate_behavioral_binding_invalid'};
    }
  }

  if (mode.review !== 'checks') {
    const reviewType = mode.review === 'legacy' ? 'task.legacy_reviewed' : 'task.reviewed';
    const review = events.findLast(event => event.type === reviewType);
    if (review?.data?.decision !== 'accept' || review.seq <= candidateEvent.seq || review.seq >= integrationEvent.seq ||
        (mode.review === 'legacy' && task.legacyDecision?.decision !== 'accept')) {
      return {reason: 'candidate_review_missing_or_not_accepted'};
    }
    if (mode.review === 'legacy' && project.behavioralChecks) {
      const binding = task.legacyBehavioralReview;
      const candidate = integration.candidateBehavioralEvidence;
      if (binding?.approvalHash !== goal.hash || binding.taskHash !== task.hash ||
          binding.baseCommit !== task.result.baseCommit || binding.snapshotHash !== candidate.snapshotHash ||
          binding.executableModesHash !== candidate.executableModesHash) return {reason: 'legacy_review_binding_invalid'};
    }
    evidenceRefs.push(ref(review));
  }
  return {reason: 'checked_candidate_integrated', evidenceRefs};
}

// Match the persisted part of release-authority.mjs. The report relies on the
// coordinator's recorded artifact verification and has no filesystem authority.
function researchDeadlineMatches(task, goal, evidence) {
  const {activatedAt, deadline} = goal;
  const hours = goal.manifest.limits?.hours;
  const seconds = task.spec.limits?.seconds;
  if (!approvedStatuses.has(goal.status) || !positiveTime(activatedAt) || !positiveTime(deadline) ||
      deadline <= activatedAt || !positiveTime(hours) || !positiveTime(seconds)) return false;

  let approvedDeadline = activatedAt + hours * 3_600_000;
  if (goal.version > 1) {
    const previous = historicalGoal(evidence, task.goalId, goal.version - 1);
    if (previous?.activatedAt !== activatedAt || !positiveTime(previous.deadline) ||
        previous.deadline <= activatedAt) return false;
    approvedDeadline = Math.min(previous.deadline, approvedDeadline);
  }
  return deadline === approvedDeadline && positiveTime(task.createdAt) && task.createdAt >= activatedAt &&
    positiveTime(task.startedAt) && task.startedAt >= task.createdAt && positiveTime(task.deadline) &&
    task.deadline === Math.min(deadline, task.startedAt + seconds * 1000);
}

function timelyResearchReviewer(reviewer, task, intent) {
  return positiveTime(reviewer?.at) && positiveTime(intent?.intentAt) &&
    reviewer.at >= task.startedAt && reviewer.at <= intent.intentAt;
}

function targetedReview(task, events, evidence, accepted, submitted) {
  const descriptor = accepted.descriptor;
  const baseHash = descriptor.assembly.baseCandidateHash;
  const proof = task.checkpoint.targetedProof;
  if (proof?.candidateHash !== descriptor.candidateHash || !hashPattern.test(proof.sha256)) return null;
  const prior = task.researchReviewTickets.find(ticket => ticket.candidateHash === baseHash &&
    ticket.submissionIntent?.input?.decision === 'revise');
  const intent = prior?.submissionIntent;
  if (intent?.state !== 'acknowledged' || intent.ticketId !== prior.id || intent.nativeReservationId !== prior.nativeReservationId ||
      intent.taskId !== task.id || intent.goalId !== task.goalId || intent.jobId !== accepted.jobId ||
      intent.manifestHash !== accepted.manifestHash || intent.input.ticketId !== prior.id ||
      intent.input.taskId !== task.id || intent.input.candidateHash !== baseHash ||
      intent.input.rubricHash !== descriptor.rubricSha256 || !same(intent.descriptor, prior.descriptor) ||
      !same(intent.acknowledgment, prior.submissionResult) || prior.submissionHash !== intent.inputHash ||
      intent.inputHash !== digest({input: intent.input, key: intent.submissionKey})) return null;
  verifyReviewVerdict(intent.input, intent.descriptor);
  verifySubmitAck(intent.acknowledgment, intent);
  const previousReviewer = evidence.find(row => row.kind === 'reviewer' && row.id === prior.nativeReservationId)?.data;
  if (previousReviewer?.id !== prior.nativeReservationId || previousReviewer.taskId !== task.id ||
      previousReviewer.goalId !== task.goalId || previousReviewer.status !== 'completed' ||
      !timelyResearchReviewer(previousReviewer, task, intent) ||
      !positiveTime(intent.acknowledgedAt) || intent.acknowledgedAt < intent.intentAt ||
      intent.acknowledgedAt > accepted.intentAt ||
      !same(previousReviewer.result, {ticketId: prior.id, decision: 'revise', candidateHash: baseHash,
        submissionHash: intent.inputHash})) return null;
  const revised = events.findLast(event => event.type === 'research.review_submitted' && event.seq < submitted.seq);
  if (revised?.data?.decision !== 'revise' || revised.data.ticketId !== prior.id ||
      revised.data.candidateHash !== baseHash) return null;
  return [ref(revised), {kind: 'reviewer', id: previousReviewer.id}];
}

function researchAcceptance(task, goal, events, evidence, version) {
  const policy = task.spec.researchPolicy;
  if (version < 4 || policy?.version !== 3 || goal.manifest.mode.id !== 'collaborative') {
    return {reason: 'research_without_full_review_contract'};
  }
  if (!same(policy, goal.manifest.researchPolicy) || !same(policy, normalizeResearchPolicy(policy)) ||
      version !== (policy.correctionStrategy === 'targeted_v1' ? 6 : policy.repairContextVersion === 1 ? 5 : 4) ||
      task.spec.actor !== 'deepseek' || !goal.manifest.mode.actors?.includes('codex')) {
    return {reason: 'research_policy_or_approval_mismatch'};
  }
  if (!researchDeadlineMatches(task, goal, evidence)) return {reason: 'research_approval_deadline_mismatch'};
  const environment = goal.manifest.environment;
  if (!['live', 'fixture'].includes(environment) || task.checkpoint?.manifest?.mode !== environment ||
      task.checkpoint.manifest.not_after !== Math.floor(task.deadline / 1000)) {
    return {reason: 'research_environment_or_remote_deadline_mismatch'};
  }
  if (task.owner !== null || task.pauseRequested || task.stopRequested || task.yieldRequested ||
      task.checkpoint.remotePaused || task.executionActor && task.executionActor !== 'deepseek') {
    return {reason: 'research_acceptance_ownership_or_control_unverified'};
  }
  const {result} = task;
  if (result?.receiptStatus !== 'completed' || result.checksumsVerified !== true ||
      result.independentReview !== 'accepted' || result.remoteJobId !== task.checkpoint?.remoteJobId) {
    return {reason: 'research_verified_completion_missing'};
  }
  const accepted = task.researchReviewAcceptance;
  if (typeof accepted?.ticketId !== 'string' || !researchTicketId.test(accepted.ticketId)) {
    return {reason: 'research_local_review_binding_invalid'};
  }
  const reviewer = evidence.find(row => row.kind === 'reviewer' && row.id === accepted.nativeReservationId)?.data;
  if (!timelyResearchReviewer(reviewer, task, accepted)) return {reason: 'research_reviewer_timing_unverified'};
  try {
    verifyLocalAcceptance(task, id => reviewer?.id === id ? reviewer : null);
  } catch {
    return {reason: 'research_local_review_binding_invalid'};
  }
  const descriptor = accepted.descriptor;
  if (!same(descriptor, result.reviewBinding) || !same(descriptor, task.checkpoint.reviewCandidate)) {
    return {reason: 'research_candidate_binding_mismatch'};
  }
  const completion = events.findLast(event => event.type === 'task.result');
  const submitted = events.findLast(event => event.type === 'research.review_submitted');
  if (completion?.data?.status !== 'accepted' || !same(completion.data.result, result) ||
      submitted?.data?.decision !== 'accept' || submitted.seq >= completion.seq ||
      submitted.data.ticketId !== accepted.ticketId ||
      submitted.data.candidateHash !== descriptor.candidateHash) return {reason: 'research_completion_event_unverified'};
  const priorReview = descriptor.version === 2 ? targetedReview(task, events, evidence, accepted, submitted) : [];
  if (!priorReview) return {reason: 'research_targeted_prior_review_unverified'};
  // ResearchAdapter verifies the collected remote receipt and exact report/source
  // bytes before persisting this result. The report does not reopen artifact paths.
  return {reason: 'reviewed_research_completed', evidenceRefs: [
    ref(completion), ref(submitted), {kind: 'reviewer', id: reviewer.id}, ...priorReview, {
      kind: 'research_review', id: accepted.ticketId, candidateHash: descriptor.candidateHash,
      remoteJobId: result.remoteJobId, reportSha256: descriptor.reportSha256, sourcesSha256: descriptor.sourcesSha256,
    },
  ]};
}

export function classifyTaskOutcome({task, goal, events = [], requests = [], evidence = []}) {
  const history = events.filter(event => event?.task_id === task.id && event.goal_id === task.goalId &&
    nonnegative(event.seq)).sort((a, b) => a.seq - b.seq);
  const started = history.find(event => startEvents.has(event.type));
  const observedAttempt = history.reduce((max, event) => event.type === 'attempt.started' &&
    nonnegative(event.data?.attempt) ? Math.max(max, event.data.attempt) : max, 0);
  const attemptCount = nonnegative(task.attempts) ? Math.max(task.attempts, observedAttempt) : observedAttempt || null;
  const completedRequest = requests.find(request => request?.task_id === task.id && request.status === 'completed');
  // Native candidate allocation saves startedAt before initializing a writer.
  const pendingNativeStart = ['starting', 'generation_blocked'].includes(task.native?.status);
  const attempted = Boolean(started || attemptCount > 0 || completedRequest ||
    nonnegative(task.startedAt) && !pendingNativeStart);
  const sourceStatus = typeof task.status === 'string' ? task.status : null;
  const queued = !attempted && queuedStatuses.has(sourceStatus);
  const terminal = terminalStatuses.has(sourceStatus);
  const approval = approvedGoal(task, goal, evidence);
  const mode = approval?.manifest?.mode;
  const capability = typeof task.spec?.kind === 'string' ? task.spec.kind : null;
  const pinned = Array.isArray(approval?.manifest?.capabilities) ?
    approval.manifest.capabilities.filter(item => item?.id === capability) : [];
  const capabilityVersion = pinned.length === 1 && Number.isInteger(pinned[0].version) ? pinned[0].version : null;
  const row = {
    id: task.id, goalId: task.goalId, capability, capabilityVersion, mode: mode?.id ?? null,
    sourceStatus, attempted, queued, terminal, attemptCount,
    disposition: knownStatuses.has(sourceStatus) ? sourceStatus : 'unknown',
    usefulAccepted: false, reason: queued ? 'awaiting_first_execution' : 'task_not_accepted',
    evidenceRefs: started ? [ref(started)] : completedRequest ? [{kind: 'request', id: completedRequest.id}] : [],
  };
  const latestReview = history.findLast(event => reviewEvents.has(event.type));
  if (sourceStatus === 'partial' && history.some(event => event.type === 'task.expired')) row.disposition = 'expired';
  if (queuedStatuses.has(sourceStatus) && latestReview?.data?.decision === 'revise') {
    const subsequentWork = history.some(event => event.seq > latestReview.seq && startEvents.has(event.type));
    if (!subsequentWork) {
      row.disposition = 'revision_requested';
      row.evidenceRefs.push(ref(latestReview));
    }
  }
  if (sourceStatus !== 'accepted') {
    if (!knownStatuses.has(sourceStatus) || !versions.get(capability)?.includes(capabilityVersion)) {
      row.usefulAccepted = null;
      row.reason = knownStatuses.has(sourceStatus) ? 'capability_version_unverified' : 'task_status_unknown';
    }
    return row;
  }

  let result;
  try {
    if (!approval || approval.manifest?.schema !== 1 || !nonnegative(approval.activatedAt) ||
        !same(approval.hash, digest(approval.manifest)) || !same(task.hash, digest(task.spec))) {
      result = {reason: 'approval_or_task_binding_unverified'};
    } else if (!versions.get(capability)?.includes(capabilityVersion) || !modePolicies.has(`${mode?.id}@${mode?.version}`) ||
        modePolicies.get(`${mode.id}@${mode.version}`) !== mode.review ||
        !mode.capabilities?.includes(capability) || !mode.actors?.includes(task.spec.actor) ||
        !pinned[0].actors?.includes(task.spec.actor)) {
      result = {reason: 'unsupported_capability_or_mode'};
    } else if (task.owner || task.native?.writerActive) {
      result = {reason: 'acceptance_ownership_uncertain'};
    } else if (capability === 'coding') {
      result = codingAcceptance(task, approval, history);
    } else if (capability === 'research') {
      result = researchAcceptance(task, approval, history, evidence, capabilityVersion);
    } else {
      result = {reason: 'capability_outside_useful_result_contract'};
    }
  } catch {
    result = {reason: 'malformed_acceptance_evidence'};
  }
  row.usefulAccepted = result.evidenceRefs ? true : null;
  row.disposition = row.usefulAccepted ? 'useful_accepted' : 'acceptance_unverified';
  row.reason = result.reason;
  if (row.usefulAccepted) {
    row.attempted = true;
    row.evidenceRefs.push(...result.evidenceRefs, {
      kind: 'approval', id: task.goalId, version: approval.version, goalHash: approval.hash, taskHash: task.hash,
    });
  }
  return row;
}
