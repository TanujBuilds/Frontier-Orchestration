import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {OvernightPreflight} from '../../../src/harness/overnight-preflight.mjs';
import {Worker} from '../../../src/harness/worker.mjs';
import {command, git} from '../../../src/project/process.mjs';

export const startTime = Date.UTC(2026, 0, 10, 0, 0, 0);
export const hour = 60 * 60 * 1000;
export const config = {environment: 'fixture', codexPath: process.execPath};
export const owner = 'fixture-restart';
export const stages = ['schema', 'app', 'final'];
export const files = {schema: 'src/schema.mjs', app: 'src/app.mjs', final: 'src/final.mjs'};
export const fileContents = stage => `export const value = '${stage}';\n`;
export const fixtureEnvironment = root => ({
  PATH: process.env.PATH, HOME: root, TMPDIR: root,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C',
});

function record(root, item) {
  appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(item) + '\n', {flush: true});
}

export async function calls(root, kind) {
  const text = await readFile(path.join(root, 'calls.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(call => !kind || call.kind === kind);
}

export function adapters(root, hooks = {}) {
  return {
    config,
    provider: {
      async complete(messages) {
        const input = JSON.parse(messages.at(-1).content);
        if (input.goal) {
          record(root, {kind: 'planning'});
          const tasks = stages.map((stage, index) => ({
            key: stage,
            role: stage === 'final' ? 'final' : 'implementation',
            kind: 'coding',
            objective: stage,
            acceptance: ['Protected fixture check verifies contents'],
            dependsOn: stages.slice(Math.max(0, index - 1), index),
            permissions: {
              readPaths: ['src/', 'checks/'],
              writePaths: [files[stage]],
              checks: stage === 'final' ? ['preflight', ...stages] : [stage],
            },
          }));
          return {model: 'fixture-model', content: JSON.stringify({tasks})};
        }
        const stage = input.task.objective;
        record(root, {kind: 'model', stage, attempt: input.attempt, exchange: input.exchange});
        await hooks.dispatched?.();
        if (input.exchange === 0) {
          const file = files[stage];
          return {model: 'fixture-model', content: JSON.stringify({
            type: 'apply_changes', summary: 'Write fixture file',
            edits: [{path: file, action: 'write', baseHash: null, content: fileContents(stage)}],
          })};
        }
        assert.equal(input.previousAction.type, 'apply_changes');
        assert.equal(input.previousAction.fulfilled, true);
        return {model: 'fixture-model', content: JSON.stringify({
          type: 'finish_stage', summary: 'Candidate ready for protected checks',
        })};
      },
    },
    reviewer: {
      async reviewCode({stage, evidence}) {
        record(root, {kind: 'review', stage: stage.objective});
        assert.ok(evidence.checks.length);
        assert.ok(evidence.checks.every(check => check.passed));
        assert.equal(evidence.sourceFixture.unchanged, true);
        await hooks.reviewDispatched?.();
        return {decision: 'accept', feedback: 'Protected fixture contents verified', unverified: []};
      },
    },
    checksFactory: workspace => ({
      verify: async () => ({fixture: true}),
      async run(checks, label) {
        // The fixture owns the literal commands. No external sandbox or inference is launched.
        record(root, {kind: 'check', label, checkIds: checks.map(check => check.id)});
        await hooks.checkStarted?.(label);
        const results = [];
        for (const check of checks) {
          const result = await command(check.argv, {cwd: workspace.root, env: fixtureEnvironment(root)});
          results.push({...result, id: check.id, passed: result.code === 0, screenshots: []});
        }
        return results;
      },
    }),
  };
}

export async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mosaic-recovery-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), {recursive: true});
  await mkdir(path.join(repo, 'checks'));
  await writeFile(path.join(repo, 'src/base.mjs'), 'export const fixture = true;\n');
  await writeFile(path.join(repo, 'checks/preflight.mjs'), "import {fixture} from '../src/base.mjs'; if (!fixture) process.exit(1);\n");
  for (const [index, stage] of stages.entries()) {
    const needs = stages.slice(0, index + 1);
    await writeFile(path.join(repo, 'checks', stage + '.mjs'), `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
for (const [file, expected] of ${JSON.stringify(needs.map(name => [files[name], fileContents(name)]))}) {
  assert.equal(readFileSync(file, 'utf8'), expected);
}
console.log(${JSON.stringify(stage + ' protected check passed')});
`);
  }
  for (const args of [
    ['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'],
    ['add', '.'], ['commit', '-qm', 'fixture base'],
  ]) await git(repo, ...args);
  const baseCommit = await git(repo, 'rev-parse', 'HEAD');
  const stateRoot = path.join(root, 'state');
  const c = new Coordinator({root: stateRoot, now: () => startTime});
  const project = {
    repo, baseCommit,
    readPaths: ['src/', 'checks/'], writePaths: ['src/'],
    checks: ['preflight', ...stages].map(id => ({id, argv: [process.execPath, `checks/${id}.mjs`]})),
  };
  const fakes = adapters(root);
  try {
    const goal = c.prepareGoal({
      submissionId: 'recovery-fixture', objective: 'Verify three sequential recovery stages',
      acceptance: ['All literal protected checks pass'], environment: 'fixture',
      mode: 'overnight_review', project, limits: {hours: 24},
      overnightPolicy: {preflightCheckIds: ['preflight'], finalOnlyCheckIds: ['final']},
    }, 'prepare');
    const preflight = await new OvernightPreflight({c, ...fakes}).run({
      goalId: goal.id, hash: goal.hash,
    }, 'preflight');
    assert.equal(preflight.passed, true, JSON.stringify(preflight));
    c.activateGoal({goalId: goal.id, hash: goal.hash}, 'activate');
    c.acquireWorker('fixture-setup');
    await new Worker({c, owner: 'fixture-setup', ...fakes}).planner.tick();
    c.releaseWorker('fixture-setup');
    const saved = c.getGoal(goal.id);
    assert.equal(saved.planning.status, 'completed');
    assert.equal(saved.planning.spent, 1);
    assert.deepEqual(saved.tasks.map(task => task.spec.objective), stages);
    return {root, stateRoot, repo, baseCommit, goal: saved};
  } finally {
    c.close();
  }
}

export function open(fixture, now) {
  return new Coordinator({root: fixture.stateRoot, now: () => now});
}

export async function advance(worker, predicate) {
  for (let n = 0; n < 24; n++) {
    if (predicate()) return;
    await worker.tick();
  }
  assert.ok(predicate(), 'Fixture did not reach its expected durable state');
}
