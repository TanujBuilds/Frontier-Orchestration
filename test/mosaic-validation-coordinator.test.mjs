import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {digest} from '../src/harness/contracts.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {OvernightPreflight} from '../src/harness/overnight-preflight.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {Journal} from '../src/project/journal.mjs';

const criterion = {
  criterionId: 'filtered-download',
  description: 'Export includes the visible row and omits the hidden row',
  checkIds: ['build', 'download'],
};
const goodApp = [
  "import {quote} from './quote.mjs';",
  "const rows = [{name: 'Visible, Inc.', visible: true}, {name: 'Hidden', visible: false}];",
  "console.log('name\\n' + rows.filter(row => row.visible).map(row => quote(row.name)).join('\\n'));",
].join('\n') + '\n';
const badApp = goodApp.replace('.filter(row => row.visible)', '');

async function setup(t, {oversized = false} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mosaic-validation-coordinator-'));
  const c = new Coordinator({root: path.join(root, 'state')});
  t.after(() => {
    c.close();
    rmSync(root, {recursive: true, force: true});
  });
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, 'checks'), {recursive: true});
  mkdirSync(path.join(repo, 'src'));
  const checkFiles = {
    'starter.mjs': "import {quote} from '../src/quote.mjs'; if (typeof quote !== 'function') process.exit(1);",
    'unit.mjs': "import assert from 'node:assert/strict'; import {quote} from '../src/quote.mjs'; assert.equal(quote('x,y'), '\"x,y\"');",
    'download.mjs': [
      "import assert from 'node:assert/strict';",
      "import {execFileSync} from 'node:child_process';",
      "const downloaded = execFileSync(process.execPath, ['src/export.mjs'], {encoding: 'utf8'});",
      "assert.equal(downloaded, 'name\\n\"Visible, Inc.\"\\n');",
      "console.log('download contained the visible row');",
    ].join('\n'),
  };
  for (const [name, contents] of Object.entries(checkFiles)) {
    writeFileSync(path.join(repo, 'checks', name), contents + '\n');
  }
  writeFileSync(path.join(repo, 'src/quote.mjs'), 'export const quote = value => value.includes(",") ? `"${value}"` : value;\n');
  const git = (...args) => execFileSync('git', args, {cwd: repo, encoding: 'utf8'}).trim();
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '--quiet', '-m', 'Protected baseline');

  const checks = [
    {id: 'starter', argv: [process.execPath, 'checks/starter.mjs']},
    {id: 'unit', argv: [process.execPath, 'checks/unit.mjs']},
    {id: 'build', argv: [process.execPath, '--check', 'src/export.mjs']},
    {id: 'download', argv: [process.execPath, 'checks/download.mjs']},
  ];
  const readPaths = ['checks/', 'src/'], writePaths = ['src/export.mjs'];
  const project = {repo, baseCommit: git('rev-parse', 'HEAD'), readPaths, writePaths, checks, behavioralChecks: [criterion]};
  const goal = c.prepareGoal({
    submissionId: 'csv-export', objective: 'Export filtered rows', acceptance: [criterion.description],
    mode: 'overnight_review', environment: 'fixture', project,
    overnightPolicy: {preflightCheckIds: ['starter'], finalOnlyCheckIds: ['build', 'download'], launchCheckIds: ['download']},
  }, 'prepare');
  const preflight = await new OvernightPreflight({c}).run({goalId: goal.id, hash: goal.hash}, 'preflight');
  assert.equal(preflight.passed, true, JSON.stringify(preflight));
  c.activateGoal({goalId: goal.id, hash: goal.hash}, 'activate');

  const stages = [
    {key: 'unit-stage', kind: 'coding', role: 'implementation', objective: 'Verify CSV quoting',
      acceptance: ['CSV quoting works'], dependsOn: [], permissions: {readPaths, writePaths, checks: ['unit']}},
    {key: 'final-stage', kind: 'coding', role: 'final', objective: 'Verify download and combined result',
      acceptance: [criterion.description], dependsOn: ['unit-stage'],
      permissions: {readPaths, writePaths, checks: checks.map(check => check.id)}},
  ];
  const reviewPackets = [];
  let seenFailure;
  const provider = {complete: async messages => {
    const input = JSON.parse(messages.at(-1).content);
    const result = content => ({content: JSON.stringify(content), finishReason: 'stop'});
    if (input.goal) return result({tasks: stages});
    if (input.task.role === 'implementation' || input.exchange > 0) {
      return result({type: 'finish_stage', summary: 'Claims the export works'});
    }
    if (input.attempt === 2) seenFailure = input.repair?.failure;
    return result({
      type: 'apply_changes', summary: 'Implement the export',
      edits: [{
        path: 'src/export.mjs', action: 'write',
        baseHash: input.inventory.find(file => file.path === 'src/export.mjs')?.hash ?? null,
        content: oversized || input.attempt === 2 ? goodApp : badApp,
      }],
    });
  }};
  const reviewer = {reviewCode: async packet => {
    reviewPackets.push(packet);
    return {decision: 'accept', feedback: 'Fixture review complete', unverified: []};
  }};
  // Only the oversize case injects a larger-than-production output field.
  const checksFactory = oversized ? () => ({
    verify: async () => ({verified: true}),
    run: async declared => declared.map(({id}) => ({
      id, passed: true, code: 0, stdout: id === 'download' ? 'x'.repeat(1024 * 1024) : '',
    })),
  }) : undefined;
  const worker = new Worker({c, config: {environment: 'fixture'}, provider, reviewer, checksFactory});
  const tasks = () => c.getGoal(goal.id).tasks;
  const final = () => tasks().find(task => task.spec.role === 'final');
  const tickUntil = async predicate => {
    for (let n = 0; n < 36; n++) {
      if (predicate()) return;
      await worker.tick();
    }
    const state = c.getGoal(goal.id);
    assert.fail(JSON.stringify({
      planning: state.planning?.reason,
      tasks: tasks().map(({status, checkpoint, reason}) => ({status, checkpoint, reason})),
    }));
  };
  const journalOf = task => new Journal(path.join(root, 'state', 'coding'), task.id).load();
  return {final, reviewPackets, tickUntil, worker, journalOf, failureSeen: () => seenFailure, savedGoal: () => c.getGoal(goal.id)};
}

test('worker fixes a real failing download gate before review, with final evidence and combined checks', async t => {
  const f = await setup(t);
  await f.tickUntil(() => f.final()?.feedback.some(entry => entry.kind === 'check'));
  assert.equal(f.final().spent.codexReview, 0);
  assert.equal(f.reviewPackets.length, 1);
  const early = f.reviewPackets[0].evidence;
  assert.deepEqual(early.checks.map(receipt => receipt.id), ['starter', 'unit']);
  assert.equal(early.behavioralEvidence.criteria[0].status, 'not_run');
  assert.deepEqual(early.behavioralEvidence.criteria[0].checks.map(check => check.reason), ['not_due', 'not_due']);
  const failedTask = f.final();
  const repair = failedTask.checkpoint.repairFailure;
  assert.equal(repair.category, 'functional_check');
  assert.deepEqual(repair.checks.map(check => check.id), ['download']);
  assert.match(repair.checks[0].stderr, /Hidden/);
  const fail = (await f.journalOf(failedTask)).completed(failedTask.checkpoint.repairEvidence.key).value;
  assert.deepEqual(fail.map(({id, passed}) => [id, passed]), [
    ['starter', true], ['unit', true], ['build', true], ['download', false],
  ]);
  assert.match(fail.at(-1).stderr, /Hidden/);

  await f.tickUntil(() => f.final()?.status === 'accepted');
  assert.ok(f.failureSeen(), 'the local worker received the gate failure for repair');
  assert.deepEqual(f.failureSeen(), repair);
  assert.equal(f.final().attempts, 2);
  assert.equal(f.final().spent.codexReview, 1);
  const final = f.reviewPackets.at(-1).evidence;
  const matrix = final.behavioralEvidence;
  assert.equal(matrix.snapshotHash, digest(final.snapshot));
  assert.match(matrix.executableModesHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(matrix.criteria.map(({criterionId, description, checkIds, status}) => (
    {criterionId, description, checkIds, status}
  )), [{...criterion, status: 'passed'}]);
  assert.match(final.checks.find(check => check.id === 'download').stdout, /download contained the visible row/);
  const {integration} = f.final();
  assert.equal(integration.behavioralEvidence.criteria[0].status, 'passed');
  assert.equal(integration.candidateBehavioralEvidence.executableModesHash, matrix.executableModesHash);
  assert.match(integration.behavioralEvidence.executableModesHash, /^[a-f0-9]{64}$/);
  assert.equal(f.savedGoal().status, 'completed');
  assert.deepEqual(f.savedGoal().receipt.tasks.find(task => task.id === f.final().id).integration, integration);
  assert.equal(readFileSync(path.join(f.final().integration.worktree, 'src/export.mjs'), 'utf8'), goodApp);
});

test('a post-review edit cannot reuse the passing download evidence', async t => {
  const f = await setup(t);
  await f.tickUntil(() => f.final()?.status === 'ready_to_integrate');
  assert.equal(f.final().spent.codexReview, 1);
  const candidate = path.join(f.final().result.worktree, 'src/export.mjs');
  writeFileSync(candidate, goodApp + '// Edited after review; behavior still passes\n');
  await f.worker.tick();
  assert.equal(f.final().status, 'blocked');
  assert.match(f.final().reason, /candidate|snapshot|changed|edit/i);
  assert.equal(f.final().integration, undefined);
  assert.equal(f.reviewPackets.length, 2);
});

test('a post-review executable-bit edit cannot reuse the passing candidate verdict', async t => {
  const f = await setup(t);
  await f.tickUntil(() => f.final()?.status === 'ready_to_integrate');
  const candidate = path.join(f.final().result.worktree, 'src/export.mjs');
  chmodSync(candidate, 0o755);
  assert.equal(readFileSync(candidate, 'utf8'), goodApp);

  await f.worker.tick();
  assert.equal(f.final().status, 'blocked');
  assert.match(f.final().reason, /executable|snapshot/i);
  assert.equal(f.final().integration, undefined);
  assert.equal(f.final().spent.codexReview, 1);
  assert.equal(f.reviewPackets.length, 2);
});

test('oversized final behavioral review packet is rejected before a frontier reservation', async t => {
  const f = await setup(t, {oversized: true});
  await f.tickUntil(() => f.final()?.status === 'blocked');
  assert.match(f.final().reason, /review evidence exceeds 1 MiB/i);
  assert.equal(f.final().spent.codexReview, 0);
  assert.equal(f.reviewPackets.length, 1);
  assert.equal(f.reviewPackets[0].stage.role, 'implementation');
});
