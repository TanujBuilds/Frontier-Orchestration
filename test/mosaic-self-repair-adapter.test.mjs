import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Coordinator } from '../src/harness/coordinator.mjs';
import { Goals } from '../src/harness/goals.mjs';
import { Worker } from '../src/harness/worker.mjs';
import { Journal } from '../src/project/journal.mjs';
import { command, git } from '../src/project/process.mjs';

const source = 'src/answer.mjs';
const otherSource = 'src/offset.mjs';
const initialSource = 'export const answer = 0;\n';
const initialOffset = 'export const offset = 0;\n';
const assertion = /Repair assertion: the computed answer must equal 42/;
const hash = content => createHash('sha256').update(content).digest('hex');
const answerText = value => `export const answer = ${value};\n`;
const timeout = { timeout: 30000 };
const fakeModel = 'fixture-local';

function action(type, fields = {}) {
  return { content: JSON.stringify({ type, summary: 'Fixture reply', ...fields }), model: fakeModel, finishReason: 'stop' };
}

function edit(input, file, content) {
  const entry = input.files.find(candidate => candidate.path === file);
  assert.ok(entry?.hash, `Expected approved context for ${file}`);
  return { path: file, action: 'write', baseHash: entry.hash, content };
}

async function runCheck(definition, workspace) {
  const result = await command(definition.argv, { cwd: workspace.root, env: {} });
  return { ...result, id: definition.id, argv: definition.argv, passed: result.code === 0 && !result.stopped, screenshots: [] };
}

async function setup(t, { mode = 'collaborative', limits = {}, overnightPolicy = {}, respond, check, noisy = false, readOnlyFile, taskReadPaths } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-self-repair-'));
  const repo = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  let c;
  t.after(async () => {
    c?.close();
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(path.join(repo, 'src'), { recursive: true });
  await mkdir(path.join(repo, 'checks'));
  await writeFile(path.join(repo, source), initialSource);
  await writeFile(path.join(repo, otherSource), initialOffset);
  await writeFile(path.join(repo, 'outside.txt'), 'private fixture input\n');
  if (readOnlyFile) await writeFile(path.join(repo, readOnlyFile), 'Read-only fixture reference\n');
  await copyFile(new URL('./fixtures/mosaic-self-repair/verify.mjs.txt', import.meta.url), path.join(repo, 'checks/verify.mjs'));
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.name', 'Repair Fixture');
  await git(repo, 'config', 'user.email', 'repair-fixture@example.invalid');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'fixture baseline');

  const v2 = mode === 'overnight_review';
  const checks = [
    ...(v2 ? [{ id: 'preflight', argv: [process.execPath, '--version'] }] : []),
    { id: 'verify-answer', argv: [process.execPath, 'checks/verify.mjs', ...(noisy ? ['--noisy'] : [])] },
  ];
  const project = {
    repo, baseCommit: await git(repo, 'rev-parse', 'HEAD'),
    readPaths: ['src/', 'checks/', ...(readOnlyFile ? [readOnlyFile] : [])], writePaths: ['src/'], checks,
  };
  let now = Date.now();
  c = new Coordinator({ root: stateRoot, now: () => now });
  const goal = c.prepareGoal({
    submissionId: 'repair-goal', objective: 'Compute the verified answer',
    acceptance: ['Protected fixture check passes'], mode, environment: 'fixture', project,
    ...(v2 ? { overnightPolicy: { preflightCheckIds: ['preflight'], finalOnlyCheckIds: [], ...overnightPolicy } } : {}),
  }, 'prepare');
  if (v2) {
    // This fixture starts at the coding boundary with a pinned, approved v2 goal.
    // Exact approval and the OS sandbox are exercised by the existing v2 suite.
    c.store.tx(() => {
      const saved = c.store.get('goal', goal.id);
      Object.assign(saved, { status: 'active', activatedAt: now, deadline: now + 3600000 });
      c.store.put('goal', saved);
    });
  } else {
    c.activateGoal({ goalId: goal.id, hash: goal.hash }, 'activate');
  }
  const task = c.submitTask({
    goalId: goal.id, submissionId: 'repair-task', kind: 'coding',
    ...(v2 ? { role: 'implementation' } : {}),
    objective: 'Compute 42 using approved source', acceptance: ['Check verify-answer passes'],
    permissions: { readPaths: taskReadPaths ?? project.readPaths, writePaths: project.writePaths, checks: ['verify-answer'] },
    limits,
  }, 'submit');

  const calls = [], runs = [], reviews = [];
  const provider = {
    complete: async messages => {
      const input = JSON.parse(messages.at(-1).content);
      calls.push(input);
      return respond(input, calls.length, messages[0].content);
    },
  };
  const reviewer = {
    reviewCode: async packet => {
      reviews.push(packet);
      return { decision: 'accept', feedback: 'Protected fixture passes', unverified: [] };
    },
  };
  const checksFactory = workspace => ({
    verify: async () => ({ fixture: true }),
    run: async (selected, label) => {
      const results = await Promise.all(selected.map(async definition => {
        if (check && definition.id === 'verify-answer') return check(definition, workspace, label);
        return runCheck(definition, workspace);
      }));
      runs.push({ label, results, workspace: workspace.root });
      return results;
    },
  });
  const owner = 'repair-fixture-worker';
  const makeWorker = () => new Worker({ c, provider, reviewer, checksFactory, owner, config: { environment: 'fixture' } });
  let worker = makeWorker();

  return {
    repo, stateRoot, goal, task, calls, runs, reviews,
    async journal() { return new Journal(path.join(stateRoot, 'coding'), task.id).load(); },
    requests() {
      return c.store.db.prepare('SELECT id, key, kind, status FROM requests WHERE task_id=? ORDER BY rowid').all(task.id)
        .map(({ id, key, kind, status }) => ({ id, key, kind, status }));
    },
    get c() { return c; },
    get saved() { return c.getTask(task.id); },
    get worker() { return worker; },
    setTime(value) { now = value; },
    restart() {
      c.close();
      c = new Coordinator({ root: stateRoot, now: () => now });
      worker = makeWorker();
    },
    async until(predicate, maxSteps = 40) {
      for (let step = 0; step < maxSteps; step++) {
        if (predicate(this.saved)) return this.saved;
        const result = await worker.tick();
        if (!result || result.waiting || ['blocked', 'uncertain', 'failed', 'accepted'].includes(this.saved.status)) break;
      }
      assert.ok(predicate(this.saved), JSON.stringify({
        status: this.saved.status, phase: this.saved.checkpoint.phase, reason: this.saved.reason,
        attempts: this.saved.attempts, calls: calls.length,
      }));
      return this.saved;
    },
  };
}

test('S1 legacy coding feeds the failed protected check to a local repair that passes', timeout, async t => {
  const f = await setup(t, {
    limits: { attempts: 2, modelCalls: 2 },
    respond: (input, n) => action('submit_changes', {
      paths: [], edits: [edit(input, source, answerText(n === 1 ? 41 : 42))],
    }),
  });

  const candidate = await f.until(task => task.status === 'awaiting_review');
  assert.equal(f.calls.length, 2);
  assert.equal(candidate.spent.model, 2);
  assert.equal(candidate.attempts, 2);
  assert.equal(f.reviews.length, 0);
  assert.ok(candidate.result.checks.every(check => check.passed));
  assert.equal(await readFile(path.join(f.repo, source), 'utf8'), initialSource);

  const repair = f.calls[1].repair;
  assert.equal(repair?.failure?.category, 'functional_check', 'The next local assignment should carry structured repair guidance');
  assert.equal(repair.failure.checks[0].id, 'verify-answer');
  assert.equal(repair.failure.checks[0].exitCode, 1);
  assert.match(repair.failure.checks[0].stderr, assertion);
  assert.ok(repair.contextPaths.includes(source));
  assert.deepEqual(repair.requiredCheckIds, ['verify-answer']);
  assert.ok(repair.allowedActions.includes('submit_changes'));
});

test('S1/S2 Overnight v2 reviews only after the local repair passes protected checks', timeout, async t => {
  const f = await setup(t, {
    mode: 'overnight_review',
    limits: { attempts: 2, modelCalls: 4, questions: 1 },
    overnightPolicy: { maxBatches: 2, maxExchanges: 4, maxCorrections: 1 },
    respond: (input, n) => n % 2 === 0
      ? action('finish_stage')
      : action('apply_changes', { edits: [edit(input, source, answerText(n === 1 ? 41 : 42))] }),
  });

  const afterFailure = await f.until(task => task.attempts === 1 && task.checkpoint.phase === 'attempt');
  assert.equal(afterFailure.spent.model, 2);
  assert.equal(f.reviews.length, 0);
  assert.equal(f.runs.find(run => run.label === 'attempt-1').results.find(check => check.id === 'verify-answer').passed, false);

  const candidate = await f.until(task => task.status === 'awaiting_legacy_review');
  assert.equal(candidate.attempts, 2);
  assert.deepEqual(f.requests().map(row => row.key), ['code-1-0', 'code-1-1', 'code-2-0', 'code-2-1']);
  assert.equal(f.calls.length, 4);
  assert.equal(f.reviews.length, 0);
  const repair = f.calls[2].repair;
  assert.equal(repair?.failure?.category, 'functional_check');
  assert.deepEqual(repair.failure.changedPaths, [source]);
  assert.ok(repair.contextPaths.includes(source));
  assert.ok(!repair.contextPaths.includes('outside.txt'));
  assert.deepEqual(repair.requiredCheckIds, ['preflight', 'verify-answer']);
  assert.ok(repair.allowedActions.includes('apply_changes'));
  assert.match(repair.instruction, /check/i);
  assert.deepEqual(repair.limits, {
    remainingAttempts: 0, remainingModelCalls: 2, remainingExchanges: 4,
    remainingBatches: 2, remainingCorrections: 1, remainingQuestions: 1,
  });

  await f.worker.tick();
  assert.equal(f.saved.status, 'ready_to_integrate');
  assert.equal(f.reviews.length, 1);
  assert.equal(f.saved.spent.codexReview, 1);
  assert.ok(f.reviews[0].evidence.checks.every(check => check.passed));
  assert.equal(f.calls.length, 4);
});

test('S3 identical candidate and failed check stop before a third gate after restart', timeout, async t => {
  const f = await setup(t, {
    mode: 'overnight_review',
    limits: { attempts: 4, modelCalls: 8 },
    respond: (input, n) => n === 1
      ? action('apply_changes', { edits: [edit(input, source, answerText(41))] })
      : action('finish_stage'),
    check: async (definition, workspace, label) => {
      const result = await runCheck(definition, workspace);
      const attempt = label === 'attempt-1' ? 1 : 2;
      return {
        ...result,
        stdout: [
          `2026-11-10T12:30:0${attempt}.000Z report /private/var/folders/zz/fixture/T/repair-${attempt}/result.json`,
          `ℹ duration_ms ${attempt === 1 ? '57.8401' : '61.1023'}`,
        ].join('\n'),
      };
    },
  });
  await f.until(task => task.attempts === 1 && task.checkpoint.phase === 'attempt');
  const before = f.saved;
  f.restart();
  const stopped = await f.until(task => task.status === 'blocked');

  assert.match(stopped.reason, /no.progress/i);
  assert.match(stopped.reason, /verify-answer/);
  assert.equal(stopped.attempts, 2);
  assert.equal(stopped.spent.model, 3);
  assert.equal(stopped.deadline, before.deadline);
  assert.equal(stopped.spent.codexReview ?? 0, 0);
  assert.equal(f.reviews.length, 0);
  assert.deepEqual(f.runs.filter(run => run.label.startsWith('attempt-')).map(run => run.label), ['attempt-1', 'attempt-2']);
  assert.deepEqual(f.requests().map(row => row.key), ['code-1-0', 'code-1-1', 'code-2-0']);

  const journal = await f.journal();
  const retained = stopped.feedback.find(record => record.repair?.category === 'no_progress');
  assert.ok(retained);
  assert.equal(retained.repair.evidenceKey, 'harness-attempt-2/checks');
  for (const attempt of [1, 2]) {
    const checks = journal.completed(`harness-attempt-${attempt}/checks`).value;
    const check = checks.find(result => result.id === 'verify-answer');
    assert.match(check.stderr, assertion);
    assert.ok(check.stdout.endsWith(attempt === 1 ? 'ℹ duration_ms 57.8401' : 'ℹ duration_ms 61.1023'));
  }
  assert.equal(await readFile(path.join(journal.last('workspace.created').root, source), 'utf8'), answerText(41));
  assert.equal(await readFile(path.join(f.repo, source), 'utf8'), initialSource);
});

test('S4 changed candidate can use its final original attempt with identical failure output', timeout, async t => {
  const f = await setup(t, {
    limits: { attempts: 3, modelCalls: 3 },
    respond: (input, n) => action('submit_changes', {
      paths: [],
      edits: [edit(input, source, n === 3 ? answerText(42) : `// candidate ${n}\n${answerText(41)}`)],
    }),
  });

  const saved = await f.until(task => task.status === 'awaiting_review');
  const failures = f.runs.filter(run => run.label.startsWith('attempt-')).slice(0, 2);
  assert.equal(failures[0].results[0].stderr, failures[1].results[0].stderr);
  assert.deepEqual(f.calls[2].repair?.failure?.changedPaths, [source]);
  assert.equal(f.calls[2].repair?.failure?.comparedToAttempt, 1);
  assert.equal(saved.attempts, 3);
  assert.equal(saved.spent.model, 3);
  assert.equal(f.calls.length, 3);
  assert.ok(saved.result.checks.every(check => check.passed));
});

for (const mode of ['collaborative', 'overnight_review']) {
  test(`S5 ${mode} leaves protected-check infrastructure failures out of repair`, timeout, async t => {
    const f = await setup(t, {
      mode,
      limits: { attempts: 3, modelCalls: 5 },
      respond: () => mode === 'overnight_review' ? action('finish_stage') : action('submit_changes', { paths: [], edits: [] }),
      check: definition => ({ id: definition.id, code: null, passed: false, stopped: true, stdout: '', stderr: 'spawn fixture ENOENT', screenshots: [] }),
    });

    const blocked = await f.until(task => task.status === 'blocked');
    assert.match(blocked.reason, /infrastructure/i);
    assert.equal(blocked.attempts, 1);
    assert.equal(blocked.spent.model, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.reviews.length, 0);
    assert.ok(!blocked.feedback.some(record => record.repair?.category === 'functional_check'));
    assert.equal((await f.journal()).completed('harness-attempt-1/checks').value.at(-1).code, null);
  });
}

test('S5 ambiguous local-provider repair remains spent and retains transport ownership after restart', timeout, async t => {
  const f = await setup(t, {
    mode: 'overnight_review',
    limits: { attempts: 3, modelCalls: 6 },
    respond: (_input, n) => {
      if (n === 1) return action('finish_stage');
      const error = new Error('fixture disconnected after request dispatch');
      error.requestOutcome = 'unknown';
      throw error;
    },
  });

  const uncertain = await f.until(task => task.status === 'uncertain');
  assert.equal(uncertain.attempts, 2);
  assert.equal(uncertain.spent.model, 2);
  assert.equal(f.reviews.length, 0);
  assert.equal(f.calls.length, 2);
  const requests = f.requests();
  assert.deepEqual(requests.map(({ key, status }) => [key, status]), [['code-1-0', 'completed'], ['code-2-0', 'failed']]);
  f.restart();
  await f.worker.tick();
  assert.deepEqual(f.requests(), requests);
  assert.equal(f.saved.status, 'uncertain');
  assert.equal(f.saved.deadline, uncertain.deadline);
  assert.equal(f.c.claimNext('another-fixture-worker'), null);
  assert.throws(() => f.c.control({ taskId: f.task.id, action: 'resume' }, 'ambiguous-resume'), /uncertain ownership/i);
  assert.equal(f.calls.length, 2);
});

test('S6 v2 correction counters and request IDs survive malformed, oversized and stale replies across restart', timeout, async t => {
  const f = await setup(t, {
    mode: 'overnight_review',
    limits: { attempts: 1, modelCalls: 8 },
    overnightPolicy: { maxExchanges: 8, maxCorrections: 2 },
    respond: (input, n) => {
      if (n === 1) return { content: '{"type":', model: fakeModel, finishReason: 'stop' };
      if (n === 2) return action('apply_changes', { edits: [edit(input, source, ' '.repeat(24577))] });
      return action('apply_changes', {
        edits: [{ ...edit(input, source, answerText(42)), baseHash: 'f'.repeat(64) }],
      });
    },
  });
  await f.until(task => task.checkpoint.corrections === 1);
  const deadline = f.saved.deadline;
  const first = f.requests()[0];
  f.restart();
  await f.until(task => task.checkpoint.corrections === 2);
  assert.equal(f.saved.checkpoint.exchange, 2);
  const second = f.requests()[1];
  f.restart();
  const blocked = await f.until(task => task.status === 'blocked');

  assert.match(blocked.reason, /attempt limit/i);
  assert.equal(blocked.attempts, 1);
  assert.equal(blocked.spent.model, 3);
  assert.equal(blocked.deadline, deadline);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.requests().slice(0, 2), [first, second]);
  assert.deepEqual(f.requests().map(row => row.key), ['code-1-0', 'code-1-1', 'code-1-2']);
  assert.deepEqual(blocked.feedback.map(record => record.repair?.category).filter(Boolean), ['protocol', 'protocol', 'stale_context']);
  assert.match(blocked.feedback[0].text, /JSON/i);
  assert.match(blocked.feedback[1].text, /bytes/i);
  assert.match(blocked.feedback[2].text, /stale/i);
  assert.equal(f.calls[1].repair?.limits.remainingCorrections, 1);
  assert.equal(f.calls[2].repair?.limits.remainingCorrections, 0);
  const journal = await f.journal();
  assert.equal(journal.events.filter(event => event.type === 'edits.applied').length, 0);
  assert.equal(await readFile(path.join(journal.last('workspace.created').root, source), 'utf8'), initialSource);
  assert.equal(f.reviews.length, 0);
});

test('S6 v2 stale hash requires a fresh scoped read before any edit can apply', timeout, async t => {
  const f = await setup(t, {
    mode: 'overnight_review',
    limits: { attempts: 1, modelCalls: 6 },
    overnightPolicy: { maxExchanges: 5, maxCorrections: 2 },
    respond: (input, n) => {
      if (n === 3) return action('read_files', { paths: [source] });
      if (n === 5) return action('finish_stage');
      const proposal = edit(input, source, answerText(42));
      if (n === 1) proposal.baseHash = 'f'.repeat(64);
      return action('apply_changes', { edits: [proposal] });
    },
  });

  await f.until(task => task.checkpoint.corrections === 1);
  const first = f.requests()[0];
  f.restart();
  const saved = await f.until(task => task.status === 'awaiting_legacy_review');
  assert.equal(saved.attempts, 1);
  assert.equal(saved.spent.model, 5);
  assert.deepEqual(f.requests()[0], first);
  assert.deepEqual(f.calls.map(input => input.exchange), [0, 1, 2, 3, 4]);
  assert.equal(f.calls[1].repair?.failure?.category, 'stale_context');
  assert.match(f.calls[1].repair.instruction, /read_files/);
  assert.match(f.calls[1].repair.instruction, /fresh|current/i);
  assert.deepEqual(f.calls[1].repair.failure.stalePaths, [source]);
  assert.equal(f.calls[3].previousAction.type, 'read_files');
  assert.equal(f.calls[3].previousAction.files[0].hash, hash(initialSource));
  assert.ok(saved.result.checks.every(check => check.passed));
  const journal = await f.journal();
  const intents = journal.events.filter(event => event.type === 'edits.intent');
  assert.equal(intents.length, 1);
  assert.equal(intents[0].data.changes[0].before, hash(initialSource));
  assert.equal(intents[0].data.changes[0].after, hash(answerText(42)));
});

test('S6 original exchange ceiling prevents an extra request after restart', timeout, async t => {
  const f = await setup(t, {
    mode: 'overnight_review',
    limits: { attempts: 1, modelCalls: 8 },
    overnightPolicy: { maxExchanges: 2, maxCorrections: 2 },
    respond: (_input, n) => n === 1
      ? { content: '{', model: fakeModel, finishReason: 'stop' }
      : action('read_files', { paths: [source] }),
  });

  const boundary = await f.until(task => task.checkpoint.exchange === 2);
  const requests = f.requests();
  f.restart();
  const stopped = await f.until(task => task.status === 'blocked');
  assert.deepEqual(f.requests(), requests);
  assert.equal(f.calls.length, 2);
  assert.equal(stopped.attempts, 1);
  assert.equal(stopped.spent.model, 2);
  assert.equal(stopped.deadline, boundary.deadline);
  assert.match(stopped.feedback.at(-1).text, /exchange limit/i);
  assert.equal(f.reviews.length, 0);
});

async function interruptCheckpoint(f, shouldInterrupt) {
  const interruption = new Error('Fixture interruption before durable task checkpoint');
  const checkpoint = f.worker.checkpoint.bind(f.worker);
  f.worker.checkpoint = (task, next, owner, options) => {
    if (shouldInterrupt(next)) throw interruption;
    return checkpoint(task, next, owner, options);
  };
  // Skip Worker.executeTick's ordinary error handling to simulate a process exit.
  // The real adapter has already persisted the completed request or applied batch.
  await assert.rejects(f.worker.adapters.coding.step(f.saved, f.worker.owner), error => error === interruption);
}

test('S7 replay of fulfilled read and apply preserves exact cross-file hashes and avoids duplicate edits', timeout, async t => {
  const firstAnswer = answerText(10);
  const firstOffset = 'export const offset = 32;\n';
  const finalAnswer = answerText(11);
  const finalOffset = 'export const offset = 31;\n';
  const f = await setup(t, {
    mode: 'overnight_review',
    limits: { attempts: 1, modelCalls: 4 },
    respond: (input, n) => {
      if (n === 1) return action('read_files', { paths: [source, otherSource] });
      if (n === 2) return action('apply_changes', { edits: [edit(input, source, firstAnswer), edit(input, otherSource, firstOffset)] });
      if (n === 3) return action('apply_changes', { edits: [edit(input, source, finalAnswer), edit(input, otherSource, finalOffset)] });
      return action('finish_stage');
    },
  });

  await f.until(task => task.checkpoint.phase === 'model');
  await interruptCheckpoint(f, next => next.previousAction?.type === 'read_files');
  const originalRead = f.requests()[0];
  assert.equal(originalRead.status, 'completed');
  assert.equal(f.saved.checkpoint.exchange, 0);
  f.restart();
  await f.until(task => task.checkpoint.phase === 'apply');
  assert.deepEqual(f.requests()[0], originalRead);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].previousAction.fulfilled, true);
  assert.deepEqual(f.calls[1].previousAction.files, [
    { path: source, hash: hash(initialSource) },
    { path: otherSource, hash: hash(initialOffset) },
  ]);

  await interruptCheckpoint(f, next => next.previousAction?.type === 'apply_changes' && next.batch === 1);
  const firstBatch = f.requests()[1];
  assert.equal(f.saved.checkpoint.phase, 'apply');
  assert.equal((await f.journal()).events.filter(event => event.type === 'edits.applied').length, 1);
  f.restart();
  const candidate = await f.until(task => task.status === 'awaiting_legacy_review');
  assert.equal(f.calls.length, 4);
  assert.equal(candidate.spent.model, 4);
  assert.deepEqual(f.requests().slice(0, 2), [originalRead, firstBatch]);
  assert.deepEqual(f.requests().map(row => row.key), ['code-1-0', 'code-1-1', 'code-1-2', 'code-1-3']);
  assert.equal(f.calls[2].previousAction.type, 'apply_changes');
  assert.equal(f.calls[2].previousAction.fulfilled, true);
  assert.equal(f.calls[2].previousAction.batch, 0);
  assert.deepEqual(f.calls[2].previousAction.paths, [source, otherSource]);
  const firstBatchHashes = [{ path: source, hash: hash(firstAnswer) }, { path: otherSource, hash: hash(firstOffset) }];
  assert.deepEqual(f.calls[2].previousAction.files, firstBatchHashes);
  assert.deepEqual(f.calls[2].files.filter(file => [source, otherSource].includes(file.path)).map(({ path, hash }) => ({ path, hash })), firstBatchHashes);
  const journal = await f.journal();
  assert.equal(journal.events.filter(event => event.type === 'edits.applied').length, 2);
  const intents = journal.events.filter(event => event.type === 'edits.intent');
  assert.deepEqual(intents.map(event => event.data.changes.map(({ path, before, after }) => [path, before, after])), [
    [[source, hash(initialSource), hash(firstAnswer)], [otherSource, hash(initialOffset), hash(firstOffset)]],
    [[source, hash(firstAnswer), hash(finalAnswer)], [otherSource, hash(firstOffset), hash(finalOffset)]],
  ]);
  assert.equal(await readFile(path.join(candidate.result.worktree, source), 'utf8'), finalAnswer);
  assert.equal(await readFile(path.join(candidate.result.worktree, otherSource), 'utf8'), finalOffset);
  assert.equal(await readFile(path.join(candidate.result.worktree, 'outside.txt'), 'utf8'), 'private fixture input\n');
});

test('S7 a mixed cross-file batch cannot apply its approved edit if another edit is outside scope', timeout, async t => {
  const f = await setup(t, {
    mode: 'overnight_review',
    respond: input => action('apply_changes', {
      edits: [
        edit(input, source, answerText(42)),
        { path: 'outside.txt', action: 'write', baseHash: null, content: 'outside scope' },
      ],
    }),
  });

  const blocked = await f.until(task => task.status === 'blocked');
  assert.match(blocked.reason, /outside approved scope/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.reviews.length, 0);
  assert.ok(!f.calls[0].inventory.some(file => file.path === 'outside.txt'));
  const journal = await f.journal();
  assert.equal(journal.events.filter(event => event.type === 'edits.applied').length, 0);
  const root = journal.last('workspace.created').root;
  assert.equal(await readFile(path.join(root, source), 'utf8'), initialSource);
  assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), 'private fixture input\n');
});

test('S8 bounded repair feedback keeps the early assertion and retains full journal output', timeout, async t => {
  const f = await setup(t, {
    noisy: true,
    limits: { attempts: 2, modelCalls: 2 },
    respond: (input, n) => action('submit_changes', {
      paths: [], edits: [edit(input, source, answerText(n === 1 ? 41 : 42))],
    }),
  });

  await f.until(task => task.status === 'awaiting_review');
  const repair = f.calls[1].repair;
  const summary = repair?.failure?.checks[0];
  assert.equal(summary?.id, 'verify-answer');
  assert.match(summary.stderr, assertion);
  assert.equal(summary.truncated, true);
  assert.match(summary.stdout, /truncated/i);
  assert.match(summary.stderr, /truncated/i);
  assert.ok(Buffer.byteLength(JSON.stringify({ repair, feedback: f.calls[1].feedback })) < 16000);

  const evidence = (await f.journal()).completed(repair.failure.evidenceKey).value[0];
  assert.match(evidence.stderr, assertion);
  assert.match(evidence.stdout, /Saved stdout tail marker/);
  assert.match(evidence.stderr, /Saved stderr tail marker/);
  assert.ok(evidence.stdout.length > 90000);
  assert.ok(evidence.stderr.length > 80000);
  assert.deepEqual(evidence, f.runs.find(run => run.label === 'attempt-1').results[0]);
});

test('S9 v2 repair cannot refresh the original model-request allowance after restart and resume', timeout, async t => {
  const f = await setup(t, {
    mode: 'overnight_review',
    limits: { attempts: 3, modelCalls: 1 },
    overnightPolicy: { maxExchanges: 8, maxCorrections: 2 },
    respond: () => ({ content: '{', model: fakeModel, finishReason: 'stop' }),
  });

  const boundary = await f.until(task => task.checkpoint.corrections === 1);
  const requests = f.requests();
  f.c.control({ taskId: f.task.id, action: 'stop' }, 'stop-budget-fixture');
  await f.until(task => task.status === 'stopped');
  f.restart();
  f.c.control({ taskId: f.task.id, action: 'resume' }, 'resume-budget-fixture');
  const blocked = await f.until(task => task.status === 'blocked');

  assert.match(blocked.reason, /request budget/i);
  assert.equal(blocked.deadline, boundary.deadline);
  assert.equal(blocked.attempts, boundary.attempts);
  assert.equal(blocked.spent.model, 1);
  assert.equal(blocked.checkpoint.corrections, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.reviews.length, 0);
  assert.deepEqual(f.requests(), requests);
});

test('S9 a new functional repair record cannot extend the original task deadline on resume', timeout, async t => {
  const f = await setup(t, {
    limits: { attempts: 3, modelCalls: 3, seconds: 20 },
    respond: (input, n) => action('submit_changes', {
      paths: [], edits: [edit(input, source, answerText(n === 1 ? 41 : 42))],
    }),
  });

  const boundary = await f.until(task => task.attempts === 1 && task.checkpoint.phase === 'attempt');
  assert.ok(boundary.feedback.some(record => record.repair?.category === 'functional_check'));
  const requests = f.requests();
  f.c.control({ taskId: f.task.id, action: 'stop' }, 'stop-deadline-fixture');
  await f.until(task => task.status === 'stopped');
  f.restart();
  f.setTime(boundary.deadline + 1);
  f.c.control({ taskId: f.task.id, action: 'resume' }, 'resume-deadline-fixture');
  const expired = await f.until(task => task.status === 'partial');

  assert.match(expired.reason, /original deadline/i);
  assert.equal(expired.deadline, boundary.deadline);
  assert.equal(expired.attempts, 1);
  assert.equal(expired.spent.model, 1);
  assert.deepEqual(expired.feedback, boundary.feedback);
  assert.deepEqual(f.requests(), requests);
  assert.equal(f.calls.length, 1);
  assert.equal(f.reviews.length, 0);
});

test('S9 legacy checkpoint and check feedback from before repair metadata can resume', timeout, async t => {
  const f = await setup(t, {
    limits: { attempts: 2, modelCalls: 2 },
    respond: (input, n) => action('submit_changes', {
      paths: [], edits: [edit(input, source, answerText(n === 1 ? 41 : 42))],
    }),
  });

  const saved = await f.until(task => task.attempts === 1 && task.checkpoint.phase === 'attempt');
  const evidence = (await f.journal()).completed('harness-attempt-1/checks').value;
  f.c.store.tx(() => {
    const old = f.c.store.get('task', f.task.id);
    // Keep only fields serialized by the original coding adapter.
    const { phase, attempt, exchange, reply, requestId, executionBase, workingSet } = old.checkpoint;
    old.checkpoint = { phase, attempt, exchange, reply, requestId, executionBase, workingSet };
    old.feedback = [{ text: JSON.stringify(evidence), at: f.c.now(), kind: 'check' }];
    f.c.store.put('task', old);
  });
  f.restart();
  const passed = await f.until(task => task.status === 'awaiting_review');

  assert.match(f.calls[1].feedback[0].text, assertion);
  assert.equal(passed.deadline, saved.deadline);
  assert.equal(passed.attempts, 2);
  assert.equal(passed.spent.model, 2);
  assert.deepEqual(f.requests().map(row => row.key), ['code-1-0', 'code-2-0']);
  assert.ok(passed.result.checks.every(check => check.passed));
});

function rebindScope(f, stopped, permissions) {
  const goals = new Goals(f.c);
  const manifest = f.goal.manifest;
  const revisedProject = { ...manifest.project, ...permissions };
  const revision = goals.prepareRevision({
    goalId: f.goal.id, expectedHash: f.goal.hash,
    manifest: {
      submissionId: manifest.submissionId, objective: manifest.objective, acceptance: manifest.acceptance,
      mode: manifest.mode.id, environment: manifest.environment, project: revisedProject,
    },
  }, 'prepare-narrower-fixture');
  goals.activateRevision({ revisionId: revision.id, hash: revision.hash }, 'approve-narrower-fixture');
  const rebound = goals.rebind({
    taskId: f.task.id,
    spec: { ...stopped.spec, permissions: { ...stopped.spec.permissions, ...permissions } },
  }, 'rebind-narrower-fixture');
  assert.equal(rebound.goalVersion, 2);
  assert.equal(rebound.attempts, stopped.attempts);
  assert.deepEqual(rebound.spent, stopped.spent);
  assert.equal(rebound.deadline, stopped.deadline);
}

test('approved legacy scope rebind retains owner feedback and withholds prior repair evidence from the next assignment', timeout, async t => {
  const withdrawn = 'zz-withdrawn-reference.txt';
  const oldDiagnostic = `Withdrawn fixture diagnostic for ${withdrawn}`;
  const ownerFeedback = 'Keep the verified result as the acceptance criterion.';
  const f = await setup(t, {
    readOnlyFile: withdrawn,
    limits: { attempts: 3, modelCalls: 3 },
    respond: (input, n) => action('submit_changes', {
      paths: [], edits: [edit(input, source, answerText(n === 2 ? 41 : 42))],
    }),
    check: async (definition, workspace) => {
      const result = await runCheck(definition, workspace);
      return result.passed ? result : { ...result, stderr: oldDiagnostic + '\n' + result.stderr };
    },
  });

  await f.until(task => task.status === 'awaiting_review');
  f.c.review({ taskId: f.task.id, decision: 'revise', feedback: ownerFeedback }, 'fixture-owner-review');
  await f.until(task => task.attempts === 2 && task.checkpoint.phase === 'attempt');
  f.c.control({ taskId: f.task.id, action: 'stop' }, 'stop-for-scope-revision');
  const stopped = await f.until(task => task.status === 'stopped');
  assert.ok(stopped.feedback.some(entry => entry.repair?.checks?.some(check => check.stderr.includes(oldDiagnostic))));

  rebindScope(f, stopped, { readPaths: ['src/', 'checks/'] });
  f.restart();

  const candidate = await f.until(task => task.status === 'awaiting_review');
  assert.equal(candidate.spent.model, 3);
  assert.equal(candidate.attempts, 3);
  assert.equal(candidate.deadline, stopped.deadline);
  assert.equal(f.calls.length, 3);
  const input = f.calls[2];
  assert.equal(input.repair, undefined);
  assert.ok(input.feedback.some(entry => entry.text === ownerFeedback));
  assert.ok(!input.feedback.some(entry => entry.kind === 'check' || entry.kind === 'protocol'));
  assert.ok(!JSON.stringify(input).includes(withdrawn));
  assert.match((await f.journal()).completed('harness-attempt-2/checks').value[0].stderr, /Withdrawn fixture diagnostic/);
});

test('a saved failed gate replays after an interrupted repair transition without rerunning checks or spending an attempt', timeout, async t => {
  const f = await setup(t, {
    limits: { attempts: 2, modelCalls: 2 },
    respond: (input, n) => action('submit_changes', {
      paths: [], edits: [edit(input, source, answerText(n === 1 ? 41 : 42))],
    }),
  });

  const before = await f.until(task => task.checkpoint.phase === 'checks');
  await interruptCheckpoint(f, next => next.phase === 'attempt');
  const evidenceKey = 'harness-attempt-1/checks';
  assert.match((await f.journal()).completed(evidenceKey).value[0].stderr, assertion);
  assert.equal(f.saved.checkpoint.phase, 'checks');
  assert.equal(f.saved.attempts, before.attempts);
  assert.deepEqual(f.saved.spent, before.spent);
  assert.deepEqual(f.saved.feedback, before.feedback);
  const requests = f.requests();

  f.restart();
  const repaired = await f.until(task => task.checkpoint.phase === 'attempt');
  assert.equal(repaired.attempts, 1);
  assert.equal(repaired.deadline, before.deadline);
  assert.deepEqual(f.requests(), requests);
  assert.equal(f.runs.filter(run => run.label === 'attempt-1').length, 1);
  assert.equal((await f.journal()).events.filter(event => event.type === 'operation.completed' && event.data.key === evidenceKey).length, 1);
  const recorded = repaired.feedback.filter(entry => entry.repair?.evidenceKey === evidenceKey);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].repair.category, 'functional_check');

  const candidate = await f.until(task => task.status === 'awaiting_review');
  assert.equal(candidate.attempts, 2);
  assert.equal(candidate.spent.model, 2);
  assert.equal(f.calls.length, 2);
  assert.ok(candidate.result.checks.every(check => check.passed));
});

test('a saved but unapplied edit from an earlier scope cannot replay after an approved legacy rebind', timeout, async t => {
  const withdrawn = 'zz-withdrawn-reference.txt';
  const staleReply = `// Derived under the earlier approval\n${answerText(42)}`;
  const f = await setup(t, {
    readOnlyFile: withdrawn,
    limits: { attempts: 2, modelCalls: 2 },
    respond: (input, n) => action('submit_changes', {
      paths: [], edits: [edit(input, source, n === 1 ? staleReply : answerText(42))],
    }),
  });

  await f.until(task => task.checkpoint.phase === 'apply');
  const requests = f.requests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, 'completed');
  assert.ok(f.calls[0].inventory.some(entry => entry.path === withdrawn));
  f.c.control({ taskId: f.task.id, action: 'stop' }, 'stop-pending-scope-edit');
  const stopped = await f.until(task => task.status === 'stopped');
  assert.equal(stopped.checkpoint.phase, 'apply');
  assert.equal((await f.journal()).events.filter(event => event.type === 'edits.applied').length, 0);
  rebindScope(f, stopped, { readPaths: ['src/', 'checks/'] });
  f.restart();

  const candidate = await f.until(task => task.status === 'awaiting_review');
  assert.equal(f.calls.length, 2, 'The prior completed response cannot supply an action under changed approval');
  assert.equal(candidate.attempts, 2);
  assert.equal(candidate.spent.model, 2);
  assert.equal(candidate.deadline, stopped.deadline);
  assert.deepEqual(f.requests().map(row => row.key), ['code-1-0', 'code-2-0']);
  assert.deepEqual(f.requests()[0], requests[0]);
  assert.equal(f.calls[1].files.find(file => file.path === source).hash, hash(initialSource));
  assert.ok(!f.calls[1].inventory.some(entry => entry.path === withdrawn));
  assert.deepEqual(f.runs.map(run => run.label), ['attempt-2']);
  const journal = await f.journal();
  assert.deepEqual(journal.events.filter(event => event.type === 'edits.applied').map(event => event.data.key), ['harness-attempt-2']);
  assert.equal(await readFile(path.join(candidate.result.worktree, source), 'utf8'), answerText(42));
});

test('S4 a changed candidate includes approved write-only edits without exposing their paths in repair context', timeout, async t => {
  const writeOnly = 'src/write-only.mjs';
  const newContent = 'export const candidateRevision = 2;\n';
  const f = await setup(t, {
    limits: { attempts: 3, modelCalls: 3 },
    taskReadPaths: [source, otherSource, 'checks/'],
    respond: (input, n) => {
      const edits = n === 1 ? [] : n === 2
        ? [{ path: writeOnly, action: 'write', baseHash: null, content: newContent }]
        : [edit(input, source, answerText(42))];
      return action('submit_changes', { paths: [], edits });
    },
  });

  const next = await f.until(task => task.attempts === 3 && task.checkpoint.phase === 'apply');
  assert.equal(next.spent.model, 3);
  assert.equal(f.calls.length, 3);
  assert.equal(f.runs[0].results[0].stderr, f.runs[1].results[0].stderr);
  assert.equal(f.calls[2].repair.failure.category, 'functional_check');
  assert.equal(f.calls[2].repair.failure.comparedToAttempt, 1);
  assert.ok(!JSON.stringify(f.calls[2].repair).includes(writeOnly));
  assert.ok(!f.calls[2].inventory.some(entry => entry.path === writeOnly));
  assert.equal(await readFile(path.join(f.runs[1].workspace, writeOnly), 'utf8'), newContent);
});

test('an interrupted edit intent cannot recover a path whose write permission was revoked by rebind', timeout, async t => {
  const f = await setup(t, {
    limits: { attempts: 2, modelCalls: 2 },
    respond: input => action('submit_changes', { paths: [], edits: [edit(input, source, answerText(42))] }),
  });
  await f.until(task => task.checkpoint.phase === 'apply');

  const interruption = new Error('Fixture interruption after durable edit intent');
  const adapter = f.worker.adapters.coding;
  const open = adapter.open.bind(adapter);
  adapter.open = async task => {
    const opened = await open(task);
    opened.workspace.applyIntent = async () => { throw interruption; };
    return opened;
  };
  await assert.rejects(adapter.step(f.saved, f.worker.owner), error => error === interruption);
  const journal = await f.journal();
  const intent = journal.last('edits.intent');
  assert.equal(intent.changes[0].path, source);
  const worktree = journal.last('workspace.created').root;
  assert.equal(await readFile(path.join(worktree, source), 'utf8'), initialSource);
  assert.equal(journal.last('edits.applied'), undefined);

  const requests = f.requests();
  f.c.control({ taskId: f.task.id, action: 'stop' }, 'stop-interrupted-intent');
  const stopped = await f.until(task => task.status === 'stopped');
  rebindScope(f, stopped, { writePaths: [otherSource] });
  f.restart();
  await f.worker.tick();

  assert.equal(await readFile(path.join(worktree, source), 'utf8'), initialSource, 'Recovery must stop before writing the revoked path');
  assert.equal(f.saved.status, 'blocked');
  assert.match(f.saved.reason, /edit intent|edit transaction/i);
  assert.match(f.saved.reason, /scope|permission|approval/i);
  assert.equal(f.saved.attempts, 1);
  assert.equal(f.saved.deadline, stopped.deadline);
  assert.deepEqual(f.requests(), requests);
  assert.equal(f.calls.length, 1);
  assert.deepEqual((await f.journal()).last('edits.intent'), intent);
  assert.equal((await f.journal()).last('edits.applied'), undefined);
});
