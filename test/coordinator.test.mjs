import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runJob } from '../src/coordinator.mjs';

const plan = { summary: 'Design a useful system', steps: [{ id: 'step-1', objective: 'Design the storage layer', context: 'Single user', expectedResult: 'Schema and tradeoffs' }] };
function harness({ decisions = ['accept'], approve = true, localError, reviewError } = {}) {
  const events = [];
  const assignments = [];
  let localCalls = 0;
  const frontier = {
    identity: 'codex-test',
    plan: async () => plan,
    review: async () => {
      if (reviewError) throw new Error(reviewError);
      const decision = decisions.shift();
      return { decision, feedback: decision === 'revise' ? 'Address the missing tradeoff' : 'Clear result' };
    },
  };
  const local = {
    identity: 'deepseek-test',
    execute: async (assignment) => {
      localCalls += 1;
      assignments.push(assignment);
      if (localError) throw new Error(localError);
      return { status: 'completed', answer: `Answer ${localCalls}` };
    },
  };
  const store = { append: async (_id, event) => { events.push(event); } };
  return { frontier, local, store, events, assignments, approvePlan: async () => approve, get localCalls() { return localCalls; } };
}

test('accepted first answer is logged before display', async () => {
  const h = harness();
  const displayed = [];
  const outcome = await runJob({ goal: 'Design a system', ...h, onEvent: (event) => {
    assert.equal(h.events.at(-1), event);
    displayed.push(event.type);
  } });
  assert.equal(outcome.status, 'accepted');
  assert.equal(h.localCalls, 1);
  assert.deepEqual(displayed, h.events.map((event) => event.type));
  assert.equal(h.events.find((event) => event.type === 'plan.accepted').data.planVersion, 1);
});

test('rejection pauses without dispatch', async () => {
  const h = harness({ approve: false });
  const outcome = await runJob({ goal: 'Design a system', ...h });
  assert.equal(outcome.status, 'paused');
  assert.equal(h.localCalls, 0);
  assert.equal(h.events.at(-1).type, 'job.paused');
});

test('one revision carries the prior answer and feedback', async () => {
  const h = harness({ decisions: ['revise', 'accept'] });
  const outcome = await runJob({ goal: 'Design a system', ...h });
  assert.equal(outcome.status, 'accepted');
  assert.equal(h.localCalls, 2);
  assert.equal(h.assignments[1].priorResult.answer, 'Answer 1');
  assert.equal(h.assignments[1].feedback, 'Address the missing tradeoff');
  assert.equal(h.assignments[1].planVersion, 1);
});

test('second revision stops at needs_review with latest answer', async () => {
  const h = harness({ decisions: ['revise', 'revise'] });
  const outcome = await runJob({ goal: 'Design a system', ...h });
  assert.equal(outcome.status, 'needs_review');
  assert.equal(outcome.result.answer, 'Answer 2');
  assert.equal(h.localCalls, 2);
});

test('local failure preserves approval and assignment', async () => {
  const h = harness({ localError: 'Connection refused' });
  const outcome = await runJob({ goal: 'Design a system', ...h });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.stage, 'local');
  assert.deepEqual(h.events.slice(-3).map((event) => event.type), ['plan.accepted', 'assignment.sent', 'job.finished']);
});

test('review failure preserves the full local answer', async () => {
  const h = harness({ reviewError: 'Codex unavailable' });
  const outcome = await runJob({ goal: 'Design a system', ...h });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.result.answer, 'Answer 1');
  assert.equal(h.events.at(-2).type, 'local.result');
});

test('invalid plan and result fail clearly', async () => {
  const h = harness();
  h.frontier.plan = async () => ({ summary: 'Missing step', steps: [] });
  assert.equal((await runJob({ goal: 'Design', ...h })).status, 'failed');
  const h2 = harness();
  h2.local.execute = async () => ({ status: 'completed', answer: '' });
  const outcome = await runJob({ goal: 'Design', ...h2 });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.reason, /result.answer/);
});
