// Run explicitly with node. This is a failing integration reproduction outside
// the lane's bounded test suite, since planning.mjs belongs to another lane.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Coordinator } from '../../../src/harness/coordinator.mjs';
import { OvernightPreflight } from '../../../src/harness/overnight-preflight.mjs';
import { Worker } from '../../../src/harness/worker.mjs';

if (!process.argv[2]) process.exit(0); // Discovery alone does not run the repro.
const boundary = process.argv[2];
assert.ok(['pause', 'expiry', 'result-pause'].includes(boundary));
const root = mkdtempSync(path.join(os.tmpdir(), 'mosaic-planner-pause-'));
const repo = path.join(root, 'repo');
let now = Date.UTC(2026, 0, 1);
const c = new Coordinator({ root: path.join(root, 'state'), now: () => now });
try {
  mkdirSync(repo);
  writeFileSync(path.join(repo, 'gate.mjs'), 'process.exit(0);\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', 'gate.mjs');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');

  const config = { environment: 'fixture', codexPath: process.execPath };
  const checksFactory = () => ({
    verify: async () => ({ fixture: true }),
    run: async checks => checks.map(check => ({ id: check.id, passed: true })),
  });
  const goal = c.prepareGoal({
    submissionId: 'pause-planner', objective: 'Fixture planner reconnect',
    acceptance: ['Keep the original reconnect wait while paused'], environment: 'fixture',
    mode: 'overnight_review', overnightPolicy: { preflightCheckIds: ['gate'], finalOnlyCheckIds: [] },
    project: { repo, baseCommit: git('rev-parse', 'HEAD'), readPaths: ['gate.mjs', 'src/'],
      writePaths: ['src/'], checks: [{ id: 'gate', argv: [process.execPath, 'gate.mjs'] }] },
  }, 'prepare');
  const receipt = await new OvernightPreflight({ c, config, checksFactory })
    .run({ goalId: goal.id, hash: goal.hash }, 'preflight');
  assert.equal(receipt.passed, true, JSON.stringify(receipt));
  c.activateGoal({ goalId: goal.id, hash: goal.hash }, 'activate');

  async function pauseBeforeMaterialization() {
    const owner = 'fixture-planner';
    c.acquireWorker(owner);
    const started = Promise.withResolvers();
    const response = Promise.withResolvers();
    let calls = 0;
    const worker = new Worker({ c, config, checksFactory, owner, provider: {
      complete: async () => {
        calls++;
        started.resolve();
        return response.promise;
      },
    } });
    const pending = worker.executeTick();
    await started.promise;
    c.control({ goalId: goal.id, action: 'pause' }, 'pause');
    response.resolve({ content: JSON.stringify({ tasks: [{
      key: 'final', kind: 'coding', role: 'final', objective: 'Verify final',
      acceptance: ['Gate passes'], dependsOn: [],
      permissions: { readPaths: ['gate.mjs', 'src/'], writePaths: ['src/'], checks: ['gate'] },
    }] }) });
    await pending;
    const saved = c.store.request(goal.id, 'plan-1');
    assert.equal(saved.status, 'completed');
    assert.equal(c.getGoal(goal.id).tasks.length, 0);
    c.control({ goalId: goal.id, action: 'resume' }, 'resume');
    await worker.executeTick();
    const after = c.getGoal(goal.id);
    assert.equal(calls, 1, 'resume must reuse the saved planner result');
    assert.equal(after.planning.spent, 1);
    assert.equal(after.tasks.length, 1);
    assert.equal(after.tasks[0].spec.role, 'final');
    assert.equal(after.hash, goal.hash);
    assert.equal(c.store.request(goal.id, 'plan-1').id, saved.id);
  }

  if (boundary === 'result-pause') {
    await pauseBeforeMaterialization();
  } else {
    const probeStarted = Promise.withResolvers();
    const finishProbe = Promise.withResolvers();
    let calls = 0;
    const worker = new Worker({ c, config, checksFactory, provider: {
      complete: async () => {
        calls++;
        throw Object.assign(Error('Provider unavailable'), { requestOutcome: 'not_dispatched' });
      },
      availability: async () => {
        probeStarted.resolve();
        return finishProbe.promise;
      },
    } });
    await worker.executeTick();
    const before = c.getGoal(goal.id);
    assert.equal(before.planning.status, 'queued');
    assert.equal(before.planning.spent, 1);
    assert.equal(calls, 1);
    now = before.planning.providerWait.retryAt;

    const pendingTick = worker.executeTick().then(
      () => null,
      error => error.message,
    );
    await probeStarted.promise;
    if (boundary === 'pause') c.control({ goalId: goal.id, action: 'pause' }, 'pause');
    else now = before.planning.providerWait.until;
    finishProbe.resolve(true);
    const error = await pendingTick;
    const paused = c.getGoal(goal.id);
    assert.equal(calls, 1);
    assert.equal(paused.status, boundary === 'pause' ? 'paused' : 'active');
    assert.equal(paused.hash, before.hash);
    assert.equal(paused.deadline, before.deadline);
    assert.equal(paused.planning.spent, 1);
    assert.deepEqual({
      error, state: paused.planning.status, attempt: paused.planning.attempt,
      wait: paused.planning.providerWait,
    }, {
      error: null, state: boundary === 'pause' ? before.planning.status : 'blocked',
      attempt: before.planning.attempt,
      wait: before.planning.providerWait,
    });
  }
} finally {
  c.close();
  rmSync(root, { recursive: true, force: true });
}
