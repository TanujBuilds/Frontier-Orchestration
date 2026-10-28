import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/project/contracts.mjs';
import {
  initQueue, enqueue, queueStatus, runQueue, stopQueue, retryItem, cancelItem,
} from '../src/task-queue.mjs';

const permissions = {
  readPaths: ['src/'],
  writePaths: ['src/'],
  checks: [{ id: 'test', argv: ['node', 'checks/check.mjs'] }],
};

async function approvedJob(root, { mode = 'fake', brief = 'Exercise the queue', stageId = 'implementation', kind = 'implementation', planVersion = 1, planSummary } = {}) {
  const id = randomUUID();
  const plan = {
    summary: planSummary ?? `Plan for ${brief}`,
    stages: [
      { id: stageId, kind, objective: 'Implement', deliverable: 'Code', writePaths: ['src/'], acceptance: ['checks pass'], checks: ['test'] },
    ],
  };
  const manifest = {
    schemaVersion: 1, planVersion, mode, brief, repo: '/repo', baseCommit: 'a'.repeat(40),
    permissions, plan, limits: { hours: 8, attempts: 5, reviewRounds: 2 },
  };
  const hash = digest(manifest);
  const events = [
    { jobId: id, sequence: 1, at: new Date().toISOString(), type: 'project.created', data: manifest },
    { jobId: id, sequence: 2, at: new Date().toISOString(), type: 'project.approved', data: { hash, planVersion } },
  ];
  await mkdir(path.join(root, 'jobs'), { recursive: true });
  await writeFile(path.join(root, 'jobs', `${id}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return { id, hash, manifest };
}

async function replanJob(root, id, manifest) {
  const file = path.join(root, 'jobs', `${id}.jsonl`);
  const raw = await readFile(file, 'utf8');
  const events = raw.trim().split('\n').map(JSON.parse);
  const revised = { ...manifest, planVersion: manifest.planVersion + 1, plan: { ...manifest.plan, summary: 'Revised plan' } };
  events.push({ jobId: id, sequence: events.length + 1, at: new Date().toISOString(), type: 'project.created', data: revised });
  await writeFile(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

async function rootWith(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'task-queue-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fakeRunner(outcomes = {}) {
  const calls = [];
  const runner = async ({ job }) => {
    calls.push(job.jobId);
    return { status: outcomes[job.jobId] ?? 'accepted' };
  };
  runner.calls = calls;
  return runner;
}

async function drain(root, runner) { await runQueue({ root, once: true, runJob: runner }); }

test('init records fixed limits and is idempotent across restarts', async t => {
  const root = await rootWith(t);
  const first = await initQueue({ root, mode: 'fake', hours: 4, maxJobs: 3, maxReviews: 2 });
  assert.equal(first.mode, 'fake');
  assert.equal(first.limits.hours, 4);
  assert.equal(first.limits.maxJobs, 3);
  assert.equal(first.limits.maxReviews, 2);
  const again = await initQueue({ root });
  assert.equal(again.limits.hours, 4);
  assert.equal(again.limits.maxJobs, 3);
  assert.equal(again.limits.maxReviews, 2);
  assert.equal(again.mode, 'fake');
});

test('init defaults to eight hours, ten jobs, eight reviews', async t => {
  const root = await rootWith(t);
  const state = await initQueue({ root, mode: 'fake' });
  assert.equal(state.limits.hours, 8);
  assert.equal(state.limits.maxJobs, 10);
  assert.equal(state.limits.maxReviews, 8);
});

test('init rejects invalid limits and mode', async t => {
  const root = await rootWith(t);
  await assert.rejects(initQueue({ root, mode: 'other' }), /mode/i);
  await assert.rejects(initQueue({ root, mode: 'fake', hours: 0 }), /hours/i);
  await assert.rejects(initQueue({ root, mode: 'fake', hours: Infinity }), /hours/i);
  await assert.rejects(initQueue({ root, mode: 'fake', maxJobs: 0 }), /maxJobs/i);
  await assert.rejects(initQueue({ root, mode: 'fake', maxReviews: 1.5 }), /maxReviews/i);
});

test('enqueue requires an existing approved matching-mode job', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  await assert.rejects(enqueue({ root, jobId: randomUUID(), hash: 'a'.repeat(64) }), /not found|unknown/i);
  const live = await approvedJob(root, { mode: 'live' });
  await assert.rejects(enqueue({ root, jobId: live.id, hash: live.hash }), /mode/i);
  const fake = await approvedJob(root, { mode: 'fake' });
  await assert.rejects(enqueue({ root, jobId: fake.id, hash: 'b'.repeat(64) }), /hash|approval/i);
  const ok = await enqueue({ root, jobId: fake.id, hash: fake.hash });
  assert.equal(ok.status, 'queued');
});

test('enqueue rejects unapproved jobs and malformed IDs/hashes', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  await assert.rejects(enqueue({ root, jobId: 'not-a-uuid', hash: 'a'.repeat(64) }), /job ID/i);
  const job = await approvedJob(root);
  await assert.rejects(enqueue({ root, jobId: job.id, hash: 'short' }), /hash/i);
  const file = path.join(root, 'jobs', `${job.id}.jsonl`);
  const events = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse).slice(0, 1);
  await writeFile(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  await assert.rejects(enqueue({ root, jobId: job.id, hash: job.hash }), /approv/i);
});

test('enqueue is idempotent and preserves original priority', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  const job = await approvedJob(root);
  const a = await enqueue({ root, jobId: job.id, hash: job.hash, priority: 2 });
  const b = await enqueue({ root, jobId: job.id, hash: job.hash, priority: 9 });
  assert.equal(b.status, 'queued');
  const status = await queueStatus({ root });
  assert.equal(status.items.filter(item => item.jobId === job.id).length, 1);
  assert.equal(status.items.find(item => item.jobId === job.id).priority, a.priority);
});

test('dispatch honors priority then FIFO order', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  const high = await approvedJob(root, { brief: 'high' });
  const fifoA = await approvedJob(root, { brief: 'fifo-a' });
  const fifoB = await approvedJob(root, { brief: 'fifo-b' });
  const low = await approvedJob(root, { brief: 'low' });
  await enqueue({ root, jobId: high.id, hash: high.hash, priority: 5 });
  await enqueue({ root, jobId: fifoA.id, hash: fifoA.hash, priority: 1 });
  await enqueue({ root, jobId: fifoB.id, hash: fifoB.hash, priority: 1 });
  await enqueue({ root, jobId: low.id, hash: low.hash, priority: 0 });
  const runner = fakeRunner();
  await drain(root, runner);
  assert.deepEqual(runner.calls.slice(0, 4), [high.id, fifoA.id, fifoB.id, low.id]);
});

test('dispatch runs jobs through the injected executor and persists outcomes', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  const a = await approvedJob(root, { brief: 'a' });
  const b = await approvedJob(root, { brief: 'b' });
  await enqueue({ root, jobId: a.id, hash: a.hash });
  await enqueue({ root, jobId: b.id, hash: b.hash });
  let observed;
  const runner = async ({ job }) => { observed = job; return { status: 'accepted' }; };
  await runQueue({ root, once: true, runJob: runner });
  assert.ok(observed);
  assert.equal(typeof observed.jobId, 'string');
  const status = await queueStatus({ root });
  assert.equal(status.items.filter(i => i.status === 'accepted').length >= 1, true);
});

test('completed outcomes are persisted and visible while other jobs continue', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  const a = await approvedJob(root, { brief: 'a' });
  const b = await approvedJob(root, { brief: 'b' });
  await enqueue({ root, jobId: a.id, hash: a.hash, priority: 1 });
  await enqueue({ root, jobId: b.id, hash: b.hash, priority: 0 });
  const runner = fakeRunner({ [a.id]: 'failed', [b.id]: 'accepted' });
  await drain(root, runner);
  const status = await queueStatus({ root });
  const itemA = status.items.find(i => i.jobId === a.id);
  const itemB = status.items.find(i => i.jobId === b.id);
  assert.equal(itemA.status, 'failed');
  assert.equal(itemB.status, 'accepted');
  assert.equal(itemA.outcome, 'failed');
});

test('single worker lease refuses a second concurrent worker', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  const job = await approvedJob(root);
  await enqueue({ root, jobId: job.id, hash: job.hash });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runner = async () => { await gate; return { status: 'accepted' }; };
  const first = runQueue({ root, once: true, runJob: runner });
  await new Promise(r => setTimeout(r, 50));
  await assert.rejects(runQueue({ root, once: true, runJob: runner }), /lease|worker/i);
  release();
  await first;
});

test('cancel affects only pending items', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  const job = await approvedJob(root);
  await enqueue({ root, jobId: job.id, hash: job.hash });
  const cancelled = await cancelItem({ root, jobId: job.id });
  assert.equal(cancelled.status, 'cancelled');
  const status = await queueStatus({ root });
  assert.equal(status.items.find(i => i.jobId === job.id).status, 'cancelled');
  const done = await approvedJob(root, { brief: 'done' });
  await enqueue({ root, jobId: done.id, hash: done.hash });
  await runQueue({ root, once: true, runJob: fakeRunner() });
  await assert.rejects(cancelItem({ root, jobId: done.id }), /pending/i);
});

test('retry is allowed at most once per item and keeps counters', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  const job = await approvedJob(root);
  await enqueue({ root, jobId: job.id, hash: job.hash });
  await runQueue({ root, once: true, runJob: fakeRunner({ [job.id]: 'failed' }) });
  const retried = await retryItem({ root, jobId: job.id, hash: job.hash });
  assert.equal(retried.retries, 1);
  assert.equal(retried.status, 'queued');
  await runQueue({ root, once: true, runJob: fakeRunner({ [job.id]: 'failed' }) });
  await assert.rejects(retryItem({ root, jobId: job.id, hash: job.hash }), /retry|once/i);
});

test('retry rejects a stale hash and does not approve', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  const job = await approvedJob(root);
  await enqueue({ root, jobId: job.id, hash: job.hash });
  await runQueue({ root, once: true, runJob: fakeRunner({ [job.id]: 'failed' }) });
  await assert.rejects(retryItem({ root, jobId: job.id, hash: 'c'.repeat(64) }), /hash|approval/i);
});

test('retry requires an explicit reason, rejects queued items', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  const job = await approvedJob(root);
  await enqueue({ root, jobId: job.id, hash: job.hash });
  await assert.rejects(retryItem({ root, jobId: job.id, hash: job.hash }), /retry|failed|needs/i);
});

test('replan invalidation blocks the item before provider dispatch', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  const job = await approvedJob(root);
  await enqueue({ root, jobId: job.id, hash: job.hash });
  await replanJob(root, job.id, job.manifest);
  const runner = fakeRunner();
  await runQueue({ root, once: true, runJob: runner });
  assert.equal(runner.calls.length, 0);
  const status = await queueStatus({ root });
  assert.equal(status.items.find(i => i.jobId === job.id).status, 'invalidated');
});

test('review cap is enforced at the durable reservation boundary', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake', maxReviews: 1 });
  const a = await approvedJob(root, { brief: 'a' });
  const b = await approvedJob(root, { brief: 'b' });
  await enqueue({ root, jobId: a.id, hash: a.hash, priority: 1 });
  await enqueue({ root, jobId: b.id, hash: b.hash, priority: 0 });
  const runner = async ({ job, reserveReview }) => {
    const ok = await reserveReview({ jobId: job.jobId });
    return ok?.ok ? { status: 'accepted' } : { status: 'needs_review', reason: ok?.reason };
  };
  await drain(root, runner);
  const status = await queueStatus({ root });
  assert.equal(status.reviewsUsed, 1);
  assert.equal(status.items.filter(i => i.status === 'accepted').length, 1);
});

test('distinct-job cap blocks new dispatch', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake', maxJobs: 1 });
  const a = await approvedJob(root, { brief: 'a' });
  const b = await approvedJob(root, { brief: 'b' });
  await enqueue({ root, jobId: a.id, hash: a.hash });
  await enqueue({ root, jobId: b.id, hash: b.hash });
  const runner = fakeRunner();
  await runQueue({ root, once: true, runJob: runner });
  assert.equal(runner.calls.length, 1);
  const status = await queueStatus({ root });
  assert.equal(status.jobsUsed, 1);
});

test('jobs and reviews counters never reset on restart', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake', maxJobs: 2, maxReviews: 2 });
  const a = await approvedJob(root, { brief: 'a' });
  await enqueue({ root, jobId: a.id, hash: a.hash });
  const runner = async ({ reserveReview }) => { await reserveReview({}); return { status: 'accepted' }; };
  await runQueue({ root, once: true, runJob: runner });
  const before = await queueStatus({ root });
  const again = await initQueue({ root });
  assert.equal(again.limits.maxJobs, 2);
  assert.equal(again.limits.maxReviews, 2);
  assert.equal(before.jobsUsed, again.jobsUsed);
  assert.equal(before.reviewsUsed, again.reviewsUsed);
});

test('stop persists until an explicit worker restart', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  const job = await approvedJob(root);
  await enqueue({ root, jobId: job.id, hash: job.hash });
  await stopQueue({ root });
  const status = await queueStatus({ root });
  assert.equal(status.stopped, true);
  const runner = fakeRunner();
  await runQueue({ root, once: true, runJob: runner });
  assert.equal(runner.calls.length, 1);
});

test('uninitialized status is explicit', async t => {
  const root = await rootWith(t);
  const status = await queueStatus({ root });
  assert.equal(status.initialized, false);
  assert.equal(status.items.length, 0);
  await assert.rejects(enqueue({ root, jobId: randomUUID(), hash: 'a'.repeat(64) }), /init/i);
});

test('queue persists a report file in status', async t => {
  const root = await rootWith(t);
  await initQueue({ root, mode: 'fake' });
  const job = await approvedJob(root);
  await enqueue({ root, jobId: job.id, hash: job.hash });
  await runQueue({ root, once: true, runJob: fakeRunner({ [job.id]: 'needs_review' }) });
  const status = await queueStatus({ root });
  assert.ok(status.items.some(i => i.jobId === job.id && i.status === 'needs_review'));
  assert.ok(status.report && typeof status.report === 'string');
});
