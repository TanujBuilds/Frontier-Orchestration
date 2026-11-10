import test from 'node:test';
import assert from 'node:assert/strict';
import {digest, normalizeGoal, normalizeTask} from '../src/harness/contracts.mjs';
import {deriveBehavioralEvidence} from '../src/harness/behavioral-validation.mjs';
import {fixture as reviewedResearchFixture, policy as researchPolicy} from '../test-support/research-review-binding.mjs';
import {classifyTaskOutcome} from '../src/harness/outcomes/classify.mjs';

const commit = 'a'.repeat(40);
const candidateCommit = 'b'.repeat(40);
const codeChecks = [{id: 'behavior', code: 0, passed: true, screenshots: []}];
const time = Date.UTC(2026, 10, 10);
function event(type, seq, data, taskId = 'task', goalId = 'goal') {
  return {seq, at: time + seq, goal_id: goalId, task_id: taskId, type, data};
}
function coding({mode = 'collaborative', mapped = false, native = false, overnight = false} = {}) {
  const manifest = normalizeGoal({
    submissionId: 'example', objective: 'Produce checked code', acceptance: ['Pass'],
    mode, environment: 'fixture',
    ...(overnight ? {modeVersion: 2, overnightPolicy: {preflightCheckIds: ['behavior'], finalOnlyCheckIds: ['launch']}} : {}),
    project: {
      repo: '/fixture', baseCommit: commit, readPaths: ['src/', 'checks/'], writePaths: ['src/'],
      checks: [{id: 'behavior', argv: ['node', 'checks/behavior.mjs']},
        ...(overnight ? [{id: 'launch', argv: ['node', 'checks/launch.mjs']}] : [])],
      ...(mapped ? {behavioralChecks: [{criterionId: 'behavior', description: 'Check behavior', checkIds: ['behavior']}]} : {}),
    },
  });
  const goal = {id: 'goal', manifest, hash: digest(manifest), version: 1, status: 'active', activatedAt: time, deadline: time + 1000};
  const spec = normalizeTask({submissionId: 'code', kind: 'coding', objective: 'Code', acceptance: ['Pass'],
    ...(overnight ? {role: 'implementation', permissions: {readPaths: ['src/', 'checks/'], writePaths: ['src/'], checks: ['behavior']}} : {}),
  }, manifest);
  const result = {baseCommit: commit, snapshot: {'src/file.mjs': 'f'.repeat(64)}, checks: structuredClone(codeChecks)};
  const integration = {
    commit, ...(native ? {} : {candidateCommit}),
    worktree: '/fixture/integration', checks: structuredClone(codeChecks),
    review: native ? 'codex_native' : mode === 'deepseek_only' ? 'none' : overnight ? 'codex_legacy' : 'codex_operator',
  };
  if (mapped) {
    const modes = 'a'.repeat(64);
    const bound = snapshot => deriveBehavioralEvidence(manifest.project, {checks: codeChecks, snapshot, executableModesHash: modes});
    integration.behavioralEvidence = bound({'src/file.mjs': 'e'.repeat(64)});
    if (!native) integration.candidateBehavioralEvidence = bound(result.snapshot);
  }
  const reviewed = !native && mode !== 'deepseek_only';
  const task = {
    id: 'task', goalId: goal.id, goalVersion: 1, spec, hash: digest(spec), createdAt: time,
    startedAt: time + 1, deadline: time + 500, attempts: native ? 0 : 1, owner: null,
    status: 'accepted', result, integration, reviews: reviewed ? 1 : 0, reviewed,
    feedback: reviewed ? [{decision: 'accept', at: time + 3}] : [],
    ...(native ? {native: {worktree: integration.worktree}, executionActor: 'codex'} : {}),
    ...(overnight ? {legacyDecision: {decision: 'accept'}, legacyBehavioralReview: {
      approvalHash: goal.hash, taskHash: digest(spec), baseCommit: commit,
      snapshotHash: digest(result.snapshot), executableModesHash: 'a'.repeat(64),
    }} : {}),
  };
  const events = [
    native ? event('task.native_started', 1, {}) : event('attempt.started', 1, {attempt: 1}),
    ...native ? [] : [event('task.result', 2, {status: reviewed ? 'awaiting_review' : 'ready_to_integrate', result: structuredClone(result)})],
    ...reviewed ? [event(overnight ? 'task.legacy_reviewed' : 'task.reviewed', 3, {decision: 'accept'})] : [],
    event(native ? 'task.native_finished' : 'task.integrated', 4, structuredClone(integration)),
  ];
  return {task, goal, events, requests: [], evidence: []};
}

test('operator integration requires its exact checked and reviewed candidate receipt', () => {
  const raw = coding({mapped: true});
  const row = classifyTaskOutcome(raw);
  assert.equal(row.usefulAccepted, true);
  assert.equal(row.attempted, true);
  assert.equal(row.disposition, 'useful_accepted');
  assert.ok(row.evidenceRefs.some(ref => ref.kind === 'event' && ref.id === 4));

  for (const corrupt of [
    input => { input.task.integration.candidateCommit = 'c'.repeat(40); },
    input => { input.events[2].data.decision = 'revise'; },
    input => { delete input.task.integration.behavioralEvidence.executableModesHash; delete input.events[3].data.behavioralEvidence.executableModesHash; },
    input => { input.task.integration.candidateBehavioralEvidence.snapshotHash = 'c'.repeat(64); input.events[3].data.candidateBehavioralEvidence.snapshotHash = 'c'.repeat(64); },
    input => { input.task.integration.checks[0].code = 1; input.events[3].data.checks[0].code = 1; },
  ]) {
    const broken = structuredClone(raw);
    corrupt(broken);
    assert.equal(classifyTaskOutcome(broken).usefulAccepted, null);
  }
});

test('DeepSeek-only checks-only integration qualifies without any Codex review', () => {
  const raw = coding({mode: 'deepseek_only'});
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, true);
  raw.task.integration.review = raw.events.at(-1).data.review = 'codex_operator';
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, null);
});

test('historical direct native acceptance and candidate-only finish are distinct', () => {
  const raw = coding({mode: 'codex_only', native: true});
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, true);
  raw.task.status = 'awaiting_review';
  delete raw.task.integration;
  raw.events.at(-1).data = {status: 'awaiting_review', commit};
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, false);
});

test('overnight intermediate checks honor final-only gates and the exact legacy review binding', () => {
  const raw = coding({mode: 'overnight_review', overnight: true, mapped: true});
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, true);
  raw.task.legacyBehavioralReview.executableModesHash = 'c'.repeat(64);
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, null);
});

test('the latest native candidate completion must identify the integrated commit', () => {
  const raw = coding({mode: 'codex_only', mapped: true});
  raw.task.native = {layout: 'candidate_v1', status: 'integrated', writerActive: false, commit: candidateCommit,
    checks: raw.task.result.checks};
  raw.task.executionActor = 'codex';
  raw.events[1] = event('task.native_finished', 2, {status: 'awaiting_review', commit: candidateCommit});
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, true);
  raw.events[1].data.commit = 'd'.repeat(40);
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, null);
});

test('a conflicting newer integration receipt prevents use of stale authority', () => {
  const raw = coding();
  raw.events.push(event('task.integrated', 5, {...raw.task.integration, commit: 'f'.repeat(40)}));
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, null);
});

test('older accepted work uses its saved approval version', () => {
  const raw = coding();
  raw.evidence.push({kind: 'goal_history', id: 'goal-1', data: {...structuredClone(raw.goal), id: 'goal-1', goalId: 'goal'}});
  raw.goal.version = 2;
  raw.goal.manifest.mode.version = 99;
  raw.goal.hash = digest(raw.goal.manifest);
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, true);
  raw.evidence = [];
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, null);
});

test('unknown capability versions cannot count as accepted', () => {
  const raw = coding();
  raw.goal.manifest.capabilities.find(capability => capability.id === 'coding').version = 99;
  raw.goal.hash = digest(raw.goal.manifest);
  const row = classifyTaskOutcome(raw);
  assert.equal(row.usefulAccepted, null);
  assert.equal(row.capabilityVersion, 99);
});

test('review revision, queued-only work, and paused or terminal execution remain distinct', () => {
  const raw = coding();
  raw.task.status = 'queued';
  raw.task.attempts = 3;
  raw.events = [
    event('attempt.started', 1, {attempt: 1}), event('attempt.started', 2, {attempt: 2}),
    event('attempt.started', 3, {attempt: 3}), event('attempt.started', 3, {attempt: 3}),
    event('task.reviewed', 4, {decision: 'revise'}),
  ];
  const revised = classifyTaskOutcome(raw);
  assert.equal(revised.attemptCount, 3);
  assert.equal(revised.attempted, true);
  assert.equal(revised.queued, false);
  assert.equal(revised.disposition, 'revision_requested');
  for (const [status, terminal, disposition] of [
    ['stopped', false, 'stopped'], ['blocked', false, 'blocked'], ['failed', true, 'failed'],
    ['paused', false, 'paused'], ['uncertain', false, 'uncertain'], ['partial', true, 'expired'],
  ]) {
    raw.task.status = status;
    raw.events.push(event('task.expired', 5, {}));
    const row = classifyTaskOutcome(raw);
    assert.equal(row.disposition, disposition);
    assert.equal(row.terminal, terminal);
    assert.equal(row.attempted, true);
    assert.equal(row.usefulAccepted, false);
  }
  raw.task.status = 'queued';
  raw.task.startedAt = null;
  raw.task.attempts = 0;
  raw.events = [event('task.submitted', 1, {}), event('attempt.started', 2, {attempt: 3}, 'other')];
  raw.requests = [{id: 'reservation', task_id: 'task', status: 'failed', data: {requestOutcome: 'not_dispatched'}}];
  const queued = classifyTaskOutcome(raw);
  assert.equal(queued.attempted, false);
  assert.equal(queued.queued, true);
});

test('verified research result requires full current local review and exact completion binding', async t => {
  const f = await reviewedResearchFixture(t, {environment: 'fixture'});
  await f.accept();
  const accepted = await f.collect();
  assert.equal(accepted.status, 'accepted');
  const raw = {
    task: f.c.store.get('task', f.task.id), goal: f.c.store.get('goal', f.g.id),
    events: f.c.store.events(0, 100), requests: [],
    evidence: f.c.store.all('reviewer').map(data => ({kind: 'reviewer', id: data.id, data})),
  };
  const row = classifyTaskOutcome(raw);
  assert.equal(row.usefulAccepted, true);
  assert.ok(row.evidenceRefs.some(ref => ref.kind === 'reviewer'));

  for (const corrupt of [
    input => { input.task.checkpoint.reviewCandidate = {...input.task.checkpoint.reviewCandidate, candidateHash: 'e'.repeat(64)}; },
    input => { input.task.result.reviewBinding.sourcesSha256 = 'e'.repeat(64); },
    input => { input.task.researchReviewAcceptance.input.coverage = ['title']; },
    input => { input.events = input.events.filter(entry => entry.type !== 'task.result'); },
    input => { input.evidence = []; },
  ]) {
    const broken = structuredClone(raw);
    corrupt(broken);
    assert.equal(classifyTaskOutcome(broken).usefulAccepted, null);
  }
});

test('legacy accepted research and a plausible unverified report stay unknown', () => {
  const raw = coding();
  raw.task.spec.kind = 'research';
  raw.task.hash = digest(raw.task.spec);
  raw.task.result = {receiptStatus: 'completed', checksumsVerified: true, independentReview: 'accepted'};
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, null);
});

test('targeted completion also binds the prior completed revise reviewer', async t => {
  const f = await reviewedResearchFixture(t, {environment: 'fixture', researchPolicy: {
    ...researchPolicy, repairContextVersion: 1, correctionStrategy: 'targeted_v1',
  }});
  await f.accept();
  await f.collect();
  const task = f.c.store.get('task', f.task.id);
  const accepted = task.researchReviewAcceptance;
  const finalTicket = task.researchReviewTickets[0];
  const reviewer = f.c.store.all('reviewer')[0];
  const previous = accepted.descriptor;
  const assembly = {version: 1, baseCandidateHash: previous.candidateHash, planSha256: 'a'.repeat(64),
    patchSha256: 'b'.repeat(64), receiptSha256: 'c'.repeat(64), bundleSha256: 'd'.repeat(64)};
  const descriptor = {...previous, version: 2, assembly};
  delete descriptor.candidateHash;
  descriptor.candidateHash = digest(descriptor);
  const input = {...accepted.input, candidateHash: descriptor.candidateHash};
  const inputHash = digest({input, key: accepted.submissionKey});
  const acknowledgment = {...accepted.acknowledgment, candidateHash: descriptor.candidateHash};
  Object.assign(accepted, {descriptor, input, inputHash, acknowledgment});
  Object.assign(finalTicket, {descriptor, candidateHash: descriptor.candidateHash, submissionHash: inputHash,
    submissionResult: acknowledgment, submissionIntent: {...accepted, state: 'acknowledged'}});
  reviewer.result = {...reviewer.result, candidateHash: descriptor.candidateHash, submissionHash: inputHash};
  task.result.reviewBinding = descriptor;
  task.checkpoint.reviewCandidate = descriptor;
  task.checkpoint.targetedProof = {candidateHash: descriptor.candidateHash, sha256: 'e'.repeat(64)};
  const priorId = 'prior-reviewer';
  const priorTicketId = 'prior-ticket';
  const revise = {...input, decision: 'revise', ticketId: priorTicketId, candidateHash: previous.candidateHash,
    coverage: [], findings: [{unit: 'title'}]};
  const submissionKey = 'revise';
  const reviseHash = digest({input: revise, key: submissionKey});
  const reviseAck = {jobId: previous.jobId, ticketId: priorTicketId, candidateHash: previous.candidateHash,
    decision: 'revise', status: 'queued'};
  const priorIntent = {...accepted, ticketId: priorTicketId, nativeReservationId: priorId, state: 'acknowledged',
    descriptor: previous, input: revise, inputHash: reviseHash, submissionKey, acknowledgment: reviseAck,
    intentAt: task.startedAt, acknowledgedAt: task.startedAt};
  task.researchReviewTickets.unshift({...finalTicket, id: priorTicketId, nativeReservationId: priorId,
    descriptor: previous, candidateHash: previous.candidateHash, submissionHash: reviseHash,
    submissionResult: reviseAck, submissionIntent: priorIntent});
  const priorReviewer = {...reviewer, id: priorId, at: task.startedAt,
    result: {ticketId: priorTicketId, decision: 'revise', candidateHash: previous.candidateHash, submissionHash: reviseHash}};
  const events = f.c.store.events(0, 100);
  const submit = events.find(entry => entry.type === 'research.review_submitted');
  const result = events.findLast(entry => entry.type === 'task.result');
  submit.data.candidateHash = descriptor.candidateHash;
  result.data.result = task.result;
  const before = submit.seq;
  for (const entry of events) if (entry.seq >= before) entry.seq++;
  events.push({...submit, seq: before, data: {
    decision: 'revise', ticketId: priorTicketId, candidateHash: previous.candidateHash,
  }});
  const raw = {
    task, goal: f.c.store.get('goal', f.g.id), events, requests: [],
    evidence: [reviewer, priorReviewer].map(data => ({kind: 'reviewer', id: data.id, data})),
  };
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, true);
  raw.evidence.pop();
  assert.equal(classifyTaskOutcome(raw).usefulAccepted, null);
});
