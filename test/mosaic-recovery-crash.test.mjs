import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile, stat, utimes} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from '../src/harness/contracts.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {Journal} from '../src/project/journal.mjs';
import {git} from '../src/project/process.mjs';
import {
  adapters, advance, calls, fileContents, files, fixture, fixtureEnvironment, hour, open, owner, stages, startTime,
} from './fixtures/mosaic-recovery/fixture.mjs';

const childScript = fileURLToPath(new URL('./fixtures/mosaic-recovery/child.mjs', import.meta.url));
const goalOf = (c, f) => c.getGoal(f.goal.id);
const journalOf = (f, id, kind = 'coding') => new Journal(path.join(f.stateRoot, kind), id).load();
const spending = (model, codexReview = 0) => ({model, search: 0, download: 0, codexReview});

function binding(c, f) {
  const goal = goalOf(c, f);
  assert.equal(goal.id, f.goal.id);
  assert.equal(goal.version, f.goal.version);
  assert.equal(goal.hash, f.goal.hash);
  assert.equal(goal.hash, digest(goal.manifest));
  assert.deepEqual(goal.manifest.project, f.goal.manifest.project);
  assert.equal(goal.deadline, f.goal.deadline);
  assert.equal(goal.deadline, startTime + 24 * hour);
  assert.equal(goal.planning.spent, 1);
  const plan = c.store.get('overnight_plan', goal.id);
  assert.equal(plan.approvalHash, goal.hash);
  assert.deepEqual(plan.tasks, f.goal.tasks.map(task => task.id));
  assert.deepEqual(plan.specHashes, f.goal.tasks.map(task => task.hash));
  assert.deepEqual(goal.tasks.map(({id, hash, goalId, goalVersion, spec}) =>
    ({id, hash, goalId, goalVersion, spec})), f.goal.tasks.map(({id, hash, goalId, goalVersion, spec}) =>
    ({id, hash, goalId, goalVersion, spec})));
  return goal;
}

async function crash(f, point, {index = 0, now = startTime, whileLive} = {}) {
  const taskId = f.goal.tasks[index].id;
  const token = 'fixture-crash-' + point;
  const child = spawn(process.execPath, [childScript, JSON.stringify({
    root: f.root, stateRoot: f.stateRoot, point, taskId, now, token,
  })], {
    cwd: f.root,
    env: fixtureEnvironment(f.root),
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'close');
  let timer;
  const marker = new Promise((resolve, reject) => {
    let output = '';
    child.stdio[3].setEncoding('utf8').on('data', chunk => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      try { resolve(JSON.parse(output.slice(0, newline))); }
      catch (error) { reject(error); }
    });
    exited.then(([code, signal]) => reject(Error(`Child exited before ${point} (${code}, ${signal}): ${stderr}`)), reject);
    timer = setTimeout(() => reject(Error(`Child stalled before ${point}: ${stderr}`)), 15000);
  });
  let value;
  try {
    value = await marker;
    assert.equal(value.name, point);
    assert.equal(value.pid, child.pid);
    await whileLive?.();
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const [code, signal] = await exited;
    if (value) assert.deepEqual([code, signal], [null, 'SIGKILL']);
  }
  return {taskId, token, ...value.data};
}

async function restart(f, now, action) {
  const c = open(f, now);
  try {
    c.acquireWorker(owner);
    const worker = new Worker({c, owner, ...adapters(f.root)});
    binding(c, f);
    await action(c, worker);
  } finally {
    if (c.store.maybe('lease', 'coordinator')?.token === owner) c.releaseWorker(owner);
    c.close();
  }
}

async function verifyCandidate(f, task, stage = 'schema') {
  assert.equal(task.spec.objective, stage);
  assert.ok(task.result.checks.length);
  assert.ok(task.result.checks.every(check => check.passed));
  assert.match(task.result.checks.find(check => check.id === stage).stdout, /protected check passed/);
  assert.equal(await readFile(path.join(task.result.worktree, files[stage]), 'utf8'), fileContents(stage));
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.baseCommit);
  assert.equal(await git(f.repo, 'status', '--porcelain'), '');
}

test('SIGKILL before the first model reservation keeps scope and resumes without spending a phantom call', async t => {
  const f = await fixture(t);
  const interrupted = await crash(f, 'before-reserve', {whileLive: () => {
    const observer = open(f, startTime + 25 * hour);
    try { assert.throws(() => observer.acquireWorker('other-live-token'), /owns|ownership/); }
    finally { observer.close(); }
  }});
  assert.deepEqual(await calls(f.root, 'model'), []);
  await restart(f, startTime + 1000, async (c, worker) => {
    const saved = c.getTask(interrupted.taskId);
    assert.deepEqual(saved.spent, spending(0));
    assert.equal(saved.attempts, 1);
    assert.equal(saved.reviews, 0);
    assert.equal(saved.deadline, startTime + 2 * hour);
    assert.equal(saved.checkpoint.phase, 'model');
    if (saved.status === 'uncertain') c.recoverSaved(saved.id, owner);
    await worker.tick();
    const resumed = c.getTask(saved.id);
    assert.equal(resumed.checkpoint.phase, 'apply');
    assert.equal(resumed.checkpoint.executionBase, f.baseCommit);
    assert.equal(resumed.deadline, saved.deadline);
    assert.equal(resumed.attempts, saved.attempts);
    assert.deepEqual(resumed.spent, spending(1));
    assert.deepEqual(await calls(f.root, 'model'), [
      {kind: 'model', stage: 'schema', attempt: 1, exchange: 0},
    ]);
  });
});

for (const point of ['reserved', 'model-dispatched']) {
  test(`SIGKILL at ${point} keeps the request uncertain and spent without automatic resend`, async t => {
    const f = await fixture(t);
    const interrupted = await crash(f, point);
    const modelCount = point === 'reserved' ? 0 : 1;
    await restart(f, startTime + 1000, async (c, worker) => {
      const saved = c.getTask(interrupted.taskId);
      const request = c.store.request(saved.id, 'code-1-0');
      assert.equal(request.id, interrupted.id);
      assert.equal(request.owner, interrupted.token);
      assert.equal(request.status, 'reserved');
      assert.equal(saved.status, 'uncertain');
      assert.equal(saved.deadline, startTime + 2 * hour);
      assert.equal(saved.checkpoint.executionBase, f.baseCommit);
      assert.equal(saved.attempts, 1);
      assert.equal(saved.reviews, 0);
      assert.deepEqual(saved.spent, spending(1));
      assert.throws(() => c.recoverSaved(saved.id, owner), /ambiguous|pending|unknown/);
      const journal = await journalOf(f, saved.id);
      const worktree = journal.last('workspace.created').root;
      assert.equal(await git(worktree, 'rev-parse', 'HEAD'), f.baseCommit);
      await assert.rejects(readFile(path.join(worktree, files.schema)), {code: 'ENOENT'});
      await worker.drain();
      assert.equal(c.getTask(saved.id).status, 'uncertain');
      assert.equal(c.store.request(saved.id, request.key).id, request.id);
      assert.deepEqual(c.getTask(saved.id).spent, saved.spent);
      assert.equal(c.getTask(f.goal.tasks[1].id).status, 'queued');
      assert.equal((await calls(f.root, 'model')).length, modelCount);
      assert.deepEqual(await calls(f.root, 'review'), []);
    });
  });
}

test('SIGKILL after response persistence reuses the exact saved response and request id', async t => {
  const f = await fixture(t);
  const interrupted = await crash(f, 'response-saved');
  await restart(f, startTime + 1000, async (c, worker) => {
    const saved = c.getTask(interrupted.taskId);
    const request = c.store.request(saved.id, 'code-1-0');
    assert.equal(request.id, interrupted.id);
    assert.equal(request.status, 'completed');
    assert.equal(request.result.model, 'fixture-model');
    assert.equal(JSON.parse(request.result.content).edits[0].content, fileContents('schema'));
    assert.equal(saved.checkpoint.phase, 'model');
    if (saved.status === 'uncertain') c.recoverSaved(saved.id, owner);
    await worker.tick();
    const resumed = c.getTask(saved.id);
    assert.equal(resumed.checkpoint.phase, 'apply');
    assert.equal(resumed.checkpoint.requestId, request.id);
    assert.equal(resumed.checkpoint.reply.edits[0].content, fileContents('schema'));
    assert.equal(resumed.attempts, saved.attempts);
    assert.equal(resumed.deadline, saved.deadline);
    assert.deepEqual(resumed.spent, spending(1));
    assert.equal((await calls(f.root, 'model')).length, 1);
  });
});

test('SIGKILL after durable edit application reuses the receipt without rewriting the candidate', async t => {
  const f = await fixture(t);
  const interrupted = await crash(f, 'edit-applied');
  await restart(f, startTime + 1000, async (c, worker) => {
    const saved = c.getTask(interrupted.taskId);
    assert.equal(saved.checkpoint.phase, 'apply');
    assert.equal(saved.checkpoint.batch, 0);
    const before = await journalOf(f, saved.id);
    const applied = before.events.filter(event => event.type === 'edits.applied');
    assert.equal(applied.length, 1);
    const file = path.join(before.last('workspace.created').root, files.schema);
    assert.equal(await readFile(file, 'utf8'), fileContents('schema'));
    await utimes(file, new Date(startTime), new Date(startTime));
    const metadata = await stat(file, {bigint: true});
    if (saved.status === 'uncertain') c.recoverSaved(saved.id, owner);
    await worker.tick();
    const resumed = c.getTask(saved.id);
    assert.equal(resumed.checkpoint.phase, 'model');
    assert.equal(resumed.checkpoint.batch, 1);
    assert.equal(resumed.checkpoint.previousAction.fulfilled, true);
    assert.equal(resumed.checkpoint.requestId, saved.checkpoint.requestId);
    assert.equal(resumed.attempts, saved.attempts);
    assert.equal(resumed.deadline, saved.deadline);
    assert.deepEqual(resumed.spent, saved.spent);
    assert.equal((await calls(f.root, 'model')).length, 1);
    assert.equal(await readFile(file, 'utf8'), fileContents('schema'));
    const after = await stat(file, {bigint: true});
    assert.deepEqual([after.ino, after.mtimeNs], [metadata.ino, metadata.mtimeNs]);
    assert.deepEqual((await journalOf(f, saved.id)).events.filter(event => event.type === 'edits.applied'), applied);
  });
});

for (const point of ['checks-in-progress', 'checks-saved']) {
  test(`SIGKILL at ${point} distinguishes unverified check quiescence from a saved gate`, async t => {
    const f = await fixture(t);
    const interrupted = await crash(f, point);
    await restart(f, startTime + 1000, async (c, worker) => {
      const saved = c.getTask(interrupted.taskId);
      assert.equal(saved.checkpoint.phase, 'checks');
      assert.equal(saved.result, null);
      assert.equal(saved.deadline, startTime + 2 * hour);
      assert.equal(saved.attempts, 1);
      assert.deepEqual(saved.spent, spending(2));
      const journal = await journalOf(f, saved.id);
      const key = 'harness-attempt-1/checks';
      assert.ok(journal.events.some(event => event.type === 'operation.started' && event.data.key === key));
      const checks = journal.completed(key)?.value;
      if (point === 'checks-in-progress') {
        assert.equal(checks, undefined);
        assert.throws(() => c.recoverSaved(saved.id, owner), /quiescence|check|receipt/i);
        await worker.tick();
        assert.equal(c.getTask(saved.id).status, 'uncertain');
      } else {
        assert.ok(checks.every(check => check.passed));
        if (saved.status === 'uncertain') c.recoverSaved(saved.id, owner);
        await advance(worker, () => c.getTask(saved.id).status === 'awaiting_legacy_review');
        const recovered = c.getTask(saved.id);
        assert.deepEqual(recovered.result.checks, checks);
        assert.equal(recovered.attempts, saved.attempts);
        assert.equal(recovered.deadline, saved.deadline);
        assert.deepEqual(recovered.spent, saved.spent);
        await verifyCandidate(f, recovered);
      }
      assert.equal((await calls(f.root, 'model')).length, 2);
      assert.equal((await calls(f.root, 'check')).filter(call => call.label === 'attempt-1').length, 1);
      assert.deepEqual(await calls(f.root, 'review'), []);
    });
  });
}

test('SIGKILL waiting for review retains checked candidate and requires a real verdict', async t => {
  const f = await fixture(t);
  const {taskId} = await crash(f, 'waiting-review');
  await restart(f, startTime + 1000, async (c, worker) => {
    const waiting = c.getTask(taskId);
    assert.equal(waiting.status, 'awaiting_legacy_review');
    assert.equal(waiting.reviews, 0);
    assert.deepEqual(waiting.spent, spending(2));
    assert.equal(waiting.deadline, startTime + 2 * hour);
    await verifyCandidate(f, waiting);
    assert.deepEqual(await calls(f.root, 'review'), []);
    assert.equal(goalOf(c, f).integrationPending ?? null, null);
    await worker.tick();
    const reviewed = c.getTask(taskId);
    assert.equal(reviewed.status, 'ready_to_integrate');
    assert.equal(reviewed.legacyDecision.decision, 'accept');
    assert.equal(reviewed.reviews, 1);
    assert.deepEqual(reviewed.spent, spending(2, 1));
    assert.deepEqual(reviewed.result, waiting.result);
    assert.equal(reviewed.deadline, waiting.deadline);
    assert.deepEqual(await calls(f.root, 'review'), [{kind: 'review', stage: 'schema'}]);
  });
});

test('SIGKILL in a dispatched review holds acceptance and preserves the original review spend', async t => {
  const f = await fixture(t);
  const {taskId, id} = await crash(f, 'review-dispatched');
  await restart(f, startTime + 1000, async (c, worker) => {
    const waiting = c.getTask(taskId);
    const request = c.store.request(taskId, waiting.checkpoint.legacyReviewKey);
    assert.equal(waiting.status, 'legacy_reviewing');
    assert.equal(waiting.reviews, 1);
    assert.equal(waiting.deadline, startTime + 2 * hour);
    assert.deepEqual(waiting.spent, spending(2, 1));
    assert.equal(request.id, id);
    assert.equal(request.status, 'reserved');
    await verifyCandidate(f, waiting);
    await worker.drain();
    const held = c.getTask(taskId);
    assert.equal(held.status, 'blocked');
    assert.match(held.reason, /reconciliation|uncertain|interrupted/i);
    assert.equal(held.legacyDecision ?? null, null);
    assert.deepEqual(held.spent, waiting.spent);
    assert.equal(held.deadline, waiting.deadline);
    assert.equal(held.reviews, waiting.reviews);
    assert.deepEqual(held.result, waiting.result);
    assert.equal(c.store.request(taskId, request.key).id, request.id);
    assert.equal(c.store.request(taskId, request.key).status, 'reserved');
    assert.equal(goalOf(c, f).integrationPending ?? null, null);
    assert.equal((await calls(f.root, 'model')).length, 2);
    assert.deepEqual(await calls(f.root, 'review'), [{kind: 'review', stage: 'schema'}]);
  });
});

test('SIGKILL during pending integration reuses the exact reviewed Git checkpoint', async t => {
  const f = await fixture(t);
  const {taskId, commit} = await crash(f, 'pending-integration');
  await restart(f, startTime + 1000, async (c, worker) => {
    const goal = goalOf(c, f);
    const saved = c.getTask(taskId);
    const pending = goal.integrationPending;
    assert.equal(saved.status, 'ready_to_integrate');
    assert.equal(saved.integration ?? null, null);
    assert.equal(saved.legacyDecision.decision, 'accept');
    assert.equal(saved.reviews, 1);
    assert.equal(saved.deadline, startTime + 2 * hour);
    assert.deepEqual(saved.spent, spending(2, 1));
    assert.equal(pending.taskId, taskId);
    assert.equal(await git(goal.integration.worktree, 'rev-parse', 'HEAD'), commit);
    assert.equal(await git(goal.integration.worktree, 'status', '--porcelain'), '');
    const journal = await journalOf(f, goal.id, 'integration');
    assert.equal(journal.last('integration.import.intent').key, pending.importKey);
    assert.equal(journal.last('stage.accepted').commit, commit);
    assert.ok(journal.last('integration.checks').checks.every(check => check.passed));
    await verifyCandidate(f, saved);
    await worker.tick();
    const done = c.getTask(taskId);
    assert.equal(done.status, 'accepted');
    assert.equal(done.integration.commit, commit);
    assert.equal(done.integration.candidateCommit, pending.candidateCommit);
    assert.equal(done.integration.review, 'codex_legacy');
    assert.equal(done.integration.worktree, goal.integration.worktree);
    assert.deepEqual(done.result, saved.result);
    assert.equal(done.reviews, saved.reviews);
    assert.equal(done.deadline, saved.deadline);
    assert.deepEqual(done.spent, saved.spent);
    assert.equal(goalOf(c, f).integrationPending, null);
    assert.equal((await calls(f.root, 'model')).length, 2);
    assert.deepEqual(await calls(f.root, 'review'), [{kind: 'review', stage: 'schema'}]);
    const replay = await journalOf(f, goal.id, 'integration');
    assert.equal(replay.events.filter(event => event.type === 'stage.accepted').length, 1);
    assert.equal(replay.events.filter(event => event.type === 'edits.applied').length, 1);
  });
});

test('accelerated 23-hour run preserves three stages, acceptance evidence and accounting across restarts', async t => {
  const measuredAt = performance.now();
  const f = await fixture(t);
  const times = [6, 13, 23].map(hours => startTime + hours * hour);
  const points = ['response-saved', 'edit-applied', 'waiting-review'];
  const commits = [];
  for (const [index, now] of times.entries()) {
    const {taskId} = await crash(f, points[index], {index, now});
    await restart(f, now + 1000, async (c, worker) => {
      const waiting = c.getTask(taskId);
      assert.deepEqual(waiting.spec.dependsOn, index ? [f.goal.tasks[index - 1].id] : []);
      assert.equal(waiting.startedAt, now);
      assert.equal(waiting.deadline, Math.min(now + 2 * hour, f.goal.deadline));
      for (const [previous, commit] of commits.entries()) {
        assert.equal(c.getTask(f.goal.tasks[previous].id).integration.commit, commit);
        assert.equal(c.getTask(f.goal.tasks[previous].id).status, 'accepted');
      }
      if (waiting.status === 'uncertain') c.recoverSaved(waiting.id, owner);
      await advance(worker, () => c.getTask(taskId).status === 'accepted');
      const done = c.getTask(taskId);
      assert.equal(done.attempts, 1);
      assert.equal(done.reviews, 1);
      assert.equal(done.deadline, waiting.deadline);
      assert.deepEqual(done.spent, spending(2, 1));
      assert.equal(done.checkpoint.executionBase, commits.at(-1) ?? f.baseCommit);
      assert.equal(await git(done.integration.worktree, 'rev-parse', 'HEAD'), done.integration.commit);
      await verifyCandidate(f, done, stages[index]);
      commits.push(done.integration.commit);
    });
  }
  await restart(f, f.goal.deadline + 1, async (c, worker) => {
    await worker.drain();
    const goal = binding(c, f);
    assert.equal(goal.status, 'completed');
    assert.ok(goal.receiptHash);
    assert.deepEqual(goal.tasks.map(task => task.integration.commit), commits);
    assert.deepEqual(goal.tasks.at(-1).integration.checks.map(check => check.id), ['preflight', ...stages]);
    for (const stage of stages) {
      assert.equal(await readFile(path.join(goal.integration.worktree, files[stage]), 'utf8'), fileContents(stage));
    }
    const report = JSON.parse(await readFile(goal.overnightRun.reportPath, 'utf8'));
    assert.equal(report.goalId, goal.id);
    assert.equal(report.result, 'completed');
    assert.equal(report.approvalHash, goal.hash);
    assert.equal(report.receiptHash, goal.receiptHash);
    assert.deepEqual(report.tasks.map(task => task.id), f.goal.tasks.map(task => task.id));
    assert.deepEqual(await calls(f.root, 'planning'), [{kind: 'planning'}]);
    assert.deepEqual(await calls(f.root, 'model'), stages.flatMap(stage =>
      [0, 1].map(exchange => ({kind: 'model', stage, attempt: 1, exchange}))));
    assert.deepEqual(await calls(f.root, 'review'), stages.map(stage => ({kind: 'review', stage})));
  });
  t.diagnostic(`23 simulated hours and three owned process interruptions in ${Math.round(performance.now() - measuredAt)} ms`);
});

test('restart at the original one-day deadline retains partial files without resuming a saved reply', async t => {
  const f = await fixture(t);
  const now = f.goal.deadline - 1000;
  const {taskId, id} = await crash(f, 'response-saved', {now});
  await restart(f, f.goal.deadline, async (c, worker) => {
    const saved = c.getTask(taskId);
    const request = c.store.request(taskId, 'code-1-0');
    assert.equal(saved.deadline, f.goal.deadline);
    assert.equal(saved.startedAt, now);
    assert.equal(request.id, id);
    assert.equal(request.status, 'completed');
    const journal = await journalOf(f, taskId);
    const worktree = journal.last('workspace.created').root;
    assert.equal(await git(worktree, 'rev-parse', 'HEAD'), f.baseCommit);
    if (saved.status === 'uncertain') c.recoverSaved(taskId, owner);
    await worker.drain();
    const expired = c.getTask(taskId);
    assert.equal(expired.status, 'partial');
    assert.equal(expired.deadline, saved.deadline);
    assert.equal(expired.attempts, saved.attempts);
    assert.equal(expired.reviews, 0);
    assert.deepEqual(expired.spent, spending(1));
    assert.equal(c.store.request(taskId, request.key).id, id);
    assert.deepEqual(c.store.request(taskId, request.key).result, request.result);
    assert.equal(await readFile(path.join(worktree, 'src/base.mjs'), 'utf8'), 'export const fixture = true;\n');
    await assert.rejects(readFile(path.join(worktree, files.schema)), {code: 'ENOENT'});
    assert.ok(goalOf(c, f).tasks.slice(1).every(task => task.status === 'partial' && task.spent.model === 0));
    assert.equal((await calls(f.root, 'model')).length, 1);
    assert.deepEqual(await calls(f.root, 'review'), []);
  });
});
