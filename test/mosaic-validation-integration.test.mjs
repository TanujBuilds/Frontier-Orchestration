import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Coordinator } from '../src/harness/coordinator.mjs';
import { Integration } from '../src/harness/integration.mjs';
import { digest } from '../src/harness/contracts.mjs';
import { Journal } from '../src/project/journal.mjs';
import { command, git } from '../src/project/process.mjs';

const originalMode = "export default 'normal';\n";
const compatibilityMode = "export default 'compatibility';\n";
const originalFormat = "export default 'plain';\n";
const compactFormat = "export default 'compact';\n";

async function fixture(t, { integrationFault } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-validation-integration-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await mkdir(path.join(repo, 'checks'));
  await writeFile(path.join(repo, 'src/mode.mjs'), originalMode);
  await writeFile(path.join(repo, 'src/format.mjs'), originalFormat);
  await writeFile(path.join(repo, 'checks/export.mjs'), `
    import assert from 'node:assert/strict';
    import mode from '../src/mode.mjs';
    import format from '../src/format.mjs';
    assert.notEqual(mode + ':' + format, 'compatibility:compact', 'Combined settings break export');
  `);
  for (const args of [
    ['init', '-q'], ['config', 'user.email', 'fixture@example.invalid'],
    ['config', 'user.name', 'Fixture'], ['add', '.'], ['commit', '-qm', 'base'],
  ]) await git(repo, ...args);

  const c = new Coordinator({ root: path.join(root, 'state') });
  t.after(async () => {
    c.close();
    await rm(root, { recursive: true, force: true });
  });
  const g = c.prepareGoal({
    submissionId: 'goal', objective: 'Export with both supported formats',
    acceptance: ['Combined settings preserve export'], mode: 'codex_only',
    environment: 'fixture',
    project: {
      repo, baseCommit: await git(repo, 'rev-parse', 'HEAD'),
      readPaths: ['src/', 'checks/'], writePaths: ['src/'],
      checks: [
        { id: 'build', argv: [process.execPath, '--check', 'src/format.mjs'] },
        { id: 'export', argv: [process.execPath, 'checks/export.mjs'] },
      ],
      behavioralChecks: [
        { criterionId: 'export', description: 'Combined settings preserve export', checkIds: ['export'] },
      ],
    },
  }, 'prepare');
  c.activateGoal({ goalId: g.id, hash: g.hash }, 'activate');
  // Execute the approved literal argv against actual disposable Git worktrees.
  // The test replaces the platform sandbox and uses an explicit minimal child env.
  const integration = new Integration({
    c,
    checksFactory: workspace => ({
      verify: async () => ({ fixture: true }),
      run: async (checks, key) => {
        const results = await Promise.all(checks.map(async check => {
          const result = await command(check.argv, {
            cwd: workspace.root, env: { PATH: '/usr/bin:/bin' },
          });
          return { ...result, id: check.id, argv: check.argv, passed: result.code === 0, screenshots: [] };
        }));
        return key.startsWith('integrate-') && integrationFault
          ? integrationFault(workspace, results)
          : results;
      },
    }),
  });
  return { c, g, integration };
}

async function prepareCandidate({ c, g, integration }, key, file, content) {
  const task = c.submitTask({
    goalId: g.id, submissionId: key, kind: 'coding', actor: 'codex',
    objective: 'Change one export setting', acceptance: ['Export remains valid'],
    permissions: {
      readPaths: ['src/', 'checks/'], writePaths: [file], checks: ['build', 'export'],
    },
  }, `submit-${key}`);
  const active = await integration.startNative({ taskId: task.id, layout: 'candidate_v1' }, `start-${key}`);
  await writeFile(path.join(active.native.worktree, file), content);
  const candidate = await integration.finishNative({ taskId: task.id, summary: 'Changed one setting' }, `finish-${key}`);
  assert.equal(candidate.status, 'awaiting_review');
  assert.deepEqual(candidate.result.checks.map(({ id, passed }) => ({ id, passed })), [
    { id: 'build', passed: true }, { id: 'export', passed: true },
  ]);
  return candidate;
}

function accept(f, task, key) {
  return f.integration.accept({ taskId: task.id, feedback: 'Reviewed actual candidate' }, key);
}

test('combined result reruns mapped checks even though both separately reviewed candidates passed', async t => {
  const f = await fixture(t);
  const a = await prepareCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  const b = await prepareCandidate(f, 'format', 'src/format.mjs', compactFormat);
  const first = await accept(f, a, 'accept-mode');
  assert.equal(first.status, 'accepted');
  assert.equal(first.integration.candidateCommit, a.native.commit);
  assert.equal(first.integration.candidateBehavioralEvidence.criteria[0].status, 'passed');
  assert.equal(first.integration.behavioralEvidence.criteria[0].status, 'passed');
  assert.equal(first.integration.commit, await git(first.integration.worktree, 'rev-parse', 'HEAD'));

  await assert.rejects(accept(f, b, 'accept-format'), /Integrated checks failed/);
  const journal = await new Journal(path.join(f.c.store.root, 'integration'), f.g.id).load();
  const failed = journal.last('integration.checks');
  assert.equal(failed.checks.find(check => check.id === 'build').passed, true);
  assert.match(failed.checks.find(check => check.id === 'export').stderr, /Combined settings break export/);
  assert.equal(failed.behavioralEvidence.criteria[0].status, 'failed');
  assert.equal(failed.behavioralEvidence.snapshotHash, digest(failed.snapshot));
  assert.equal(f.c.getTask(b.id).integration, undefined);

  const repaired = await f.integration.repair({
    taskId: b.id, reason: 'Restore exactly the failed import before correcting the candidate',
  }, 'repair-format');
  assert.equal(repaired.status, 'codex_ready');
  assert.equal(await git(first.integration.worktree, 'rev-parse', 'HEAD'), first.integration.commit);
  assert.equal(await readFile(path.join(first.integration.worktree, 'src/mode.mjs'), 'utf8'), compatibilityMode);
  assert.equal(await readFile(path.join(first.integration.worktree, 'src/format.mjs'), 'utf8'), originalFormat);
  assert.equal(f.c.getGoal(f.g.id).integrationPending, null);
});

test('a journaled candidate mutation cannot reuse an older passing native checkpoint', async t => {
  const f = await fixture(t);
  const candidate = await prepareCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  const { journal, workspace } = await f.integration.candidate(candidate);
  const release = await journal.lock();
  try {
    const file = await workspace.content('src/mode.mjs');
    await workspace.apply('changed-after-checks', { writePaths: ['src/mode.mjs'] }, [
      { path: file.path, action: 'write', baseHash: file.hash, content: originalMode },
    ]);
  } finally {
    await release();
  }
  await assert.rejects(accept(f, candidate, 'accept-stale'), /changed|snapshot/i);
  const saved = f.c.getTask(candidate.id);
  assert.equal(saved.status, 'awaiting_review');
  assert.equal(saved.reviews, 0);
  assert.equal(saved.integration, undefined);
  assert.equal(f.c.getGoal(f.g.id).integrationPending, undefined);
});

test('a passing build cannot make a missing mapped receipt eligible for combined acceptance', async t => {
  const f = await fixture(t, {
    integrationFault: (_workspace, results) => results.filter(check => check.id !== 'export'),
  });
  const candidate = await prepareCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  await assert.rejects(accept(f, candidate, 'accept-missing'), /behavior|receipt|missing/i);
  const journal = await new Journal(path.join(f.c.store.root, 'integration'), f.g.id).load();
  const failed = journal.last('integration.checks');
  assert.deepEqual(failed.checks.map(({ id }) => id), ['build']);
  assert.equal(failed.behavioralEvidence.criteria[0].status, 'not_run');
  assert.equal(f.c.getTask(candidate.id).integration, undefined);
  assert.equal(f.c.getGoal(f.g.id).integrationPending.taskId, candidate.id);
});

test('a combined snapshot changed after a check cannot be checkpointed with its passing receipt', async t => {
  const f = await fixture(t, {
    integrationFault: async (workspace, results) => {
      await writeFile(path.join(workspace.root, 'src/mode.mjs'), originalMode);
      return results;
    },
  });
  const candidate = await prepareCandidate(f, 'mode', 'src/mode.mjs', compatibilityMode);
  await assert.rejects(accept(f, candidate, 'accept-changed'), /changed|snapshot/i);
  const goal = f.c.getGoal(f.g.id);
  assert.equal(await git(goal.integration.worktree, 'rev-parse', 'HEAD'), f.g.manifest.project.baseCommit);
  assert.equal(f.c.getTask(candidate.id).integration, undefined);
  assert.equal(goal.integrationPending.taskId, candidate.id);
});
