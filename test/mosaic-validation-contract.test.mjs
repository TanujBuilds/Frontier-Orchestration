import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {digest, goalDispatchInputSchema, normalizeGoal, normalizeTask} from '../src/harness/contracts.mjs';
import * as validation from '../src/harness/behavioral-validation.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {git} from '../src/project/process.mjs';

const project = {
  repo: '/tmp/validation-project',
  baseCommit: 'a'.repeat(40),
  readPaths: ['src/', 'checks/'],
  writePaths: ['src/'],
  checks: [
    {id: 'unit', argv: ['node', 'checks/unit.mjs']},
    {id: 'export', argv: ['node', 'checks/export.mjs']},
  ],
};
const manifest = {
  submissionId: 'validation-goal',
  objective: 'Export the visible CSV rows',
  acceptance: ['CSV contains visible rows'],
  environment: 'fixture',
  project,
};
const criterion = {
  criterionId: 'visible-export',
  description: 'Clicking Export downloads CSV with the visible rows.',
  checkIds: ['export'],
};
const withMapping = behavioralChecks => ({...manifest, project: {...project, behavioralChecks}});
const snapshot = {'src/export.mjs': 'a'.repeat(64)};
const receipt = (id, code = 0) => ({id, code, stopped: false, passed: code === 0, stdout: 'trusted check output'});

test('legacy project hash is unchanged when behavioralChecks is omitted', () => {
  const goal = normalizeGoal(manifest);
  assert.equal(Object.hasOwn(goal.project, 'behavioralChecks'), false);
  assert.equal(digest(goal), '6fa9a161f7d0b63b8a3631c8f575c22f552fae0c117a159f82ddff623e6f5d88');
  assert.equal(validation.deriveBehavioralEvidence(goal.project, {checks: [], checkIds: [], snapshot}), undefined);
});

test('a closed discoverable behavioral mapping binds description and check IDs into exact approval', () => {
  const schema = goalDispatchInputSchema.properties.project.anyOf[1].properties.behavioralChecks;
  assert.equal(schema.items.additionalProperties, false);
  assert.equal(schema.minItems, 1);
  assert.deepEqual(schema.items.required, ['criterionId', 'description', 'checkIds']);
  const raw = withMapping([structuredClone(criterion)]);
  const goal = normalizeGoal(raw);
  raw.project.behavioralChecks[0].checkIds[0] = 'unit';
  assert.deepEqual(goal.project.behavioralChecks, [criterion]);
  assert.notEqual(digest(goal), digest(normalizeGoal(raw)));
  assert.notEqual(digest(goal), digest(normalizeGoal(withMapping([{...criterion, description: 'Other behavior'}]))));
});

test('mapping rejects unknown checks, duplicate criteria/IDs, extra fields, empty and excessive values', () => {
  const malformed = [
    null, undefined, [], {}, Array(33).fill(criterion), Array(1),
    [null], [criterion, criterion],
    [{...criterion, criterionId: ''}], [{...criterion, criterionId: 'not a stable ID'}],
    [{...criterion, criterionId: 'x'.repeat(121)}],
    [{...criterion, description: ' '}], [{...criterion, description: 'x'.repeat(513)}],
    [{...criterion, checkIds: []}], [{...criterion, checkIds: Array(17).fill('export')}],
    [{...criterion, checkIds: ['export', 'export']}],
    [{...criterion, checkIds: ['undeclared']}],
    [{...criterion, argv: ['node', 'unapproved.mjs']}],
    [{...criterion, env: {SECRET: 'invalid-field'}}],
    [{...criterion, path: 'checks/other.mjs'}],
  ];
  for (const behavioralChecks of malformed) {
    assert.throws(() => normalizeGoal(withMapping(behavioralChecks)), /behavioral|criterion|check/i);
  }
});

test('non-staged coding cannot narrow away an approval-bound behavior check', () => {
  const task = {
    submissionId: 'assignment',
    kind: 'coding',
    objective: 'Implement CSV export',
    acceptance: ['Visible rows download'],
    permissions: {readPaths: project.readPaths, writePaths: project.writePaths, checks: ['unit']},
  };
  assert.deepEqual(normalizeTask(task, normalizeGoal(manifest)).permissions.checks, ['unit']);
  const goal = normalizeGoal(withMapping([criterion]));
  assert.throws(() => normalizeTask(task, goal), /required behavioral check/i);
  assert.doesNotThrow(() => normalizeTask({...task, permissions: {...task.permissions, checks: ['unit', 'export']}}, goal));
});

test('only fresh complete coordinator receipts for a snapshot establish a passing criterion', () => {
  const p = normalizeGoal(withMapping([{...criterion, checkIds: ['unit', 'export']}])).project;
  const derive = (checks, checkIds = ['unit', 'export'], checkedSnapshot = snapshot) =>
    validation.deriveBehavioralEvidence(p, {checks, checkIds, snapshot: checkedSnapshot});

  const passing = derive([receipt('unit'), receipt('export')]);
  assert.equal(passing.snapshotHash, digest(snapshot));
  assert.deepEqual(passing.criteria, [
    {...criterion, checkIds: ['unit', 'export'], status: 'passed', checks: [{id: 'unit', status: 'passed'}, {id: 'export', status: 'passed'}]},
  ]);
  assert.doesNotThrow(() => validation.assertBehavioralChecks(passing));

  const missing = derive([receipt('unit'), {summary: 'All checks passed', screenshots: ['screenshot.png']}]);
  assert.equal(missing.criteria[0].status, 'not_run');
  assert.throws(() => validation.assertBehavioralChecks(missing), /export/);

  const notDue = derive([receipt('unit'), receipt('export')], ['unit']);
  assert.equal(notDue.criteria[0].status, 'not_run');
  assert.deepEqual(notDue.criteria[0].checks[1], {id: 'export', status: 'not_run', reason: 'not_due'});
  assert.doesNotThrow(() => validation.assertBehavioralChecks(notDue));

  for (const untrustworthy of [
    [receipt('unit'), receipt('export', 1)],
    [receipt('unit'), receipt('export'), receipt('export', 1)],
    [receipt('unit'), {...receipt('export', 1), passed: true}],
    [receipt('unit'), {...receipt('export'), stopped: true}],
    [receipt('unit'), {id: 'export', passed: true, screenshots: ['screenshot.png']}],
  ]) {
    const failure = derive(untrustworthy);
    assert.equal(failure.criteria[0].status, 'failed');
    assert.throws(() => validation.assertBehavioralChecks(failure), /export/);
  }

  const unbound = derive([receipt('unit'), receipt('export')], ['unit', 'export'], null);
  assert.equal(unbound.snapshotHash, null);
  assert.equal(unbound.criteria[0].status, 'not_run');
  assert.throws(() => validation.assertBehavioralChecks(unbound), /unit/);
  assert.notEqual(passing.snapshotHash, derive([receipt('unit'), receipt('export')], ['unit', 'export'], {}).snapshotHash);
  const defaultScope = validation.deriveBehavioralEvidence(p, {snapshot});
  assert.throws(() => validation.assertBehavioralChecks(defaultScope), /unit/);
});

test('a declared artifact missing from the coordinator receipt cannot establish pass', () => {
  const p = {...project,
    checks: [project.checks[0], {...project.checks[1], screenshots: ['.overnight-output/export.png']}],
    behavioralChecks: [criterion],
  };
  const derive = checks => validation.deriveBehavioralEvidence(p, {checks, checkIds: ['export'], snapshot});
  assert.equal(derive([{...receipt('export'), screenshots: []}]).criteria[0].status, 'failed');
  assert.equal(derive([{...receipt('export', 1), screenshots: ['export.png']}]).criteria[0].status, 'failed');
  assert.equal(derive([{...receipt('export'), screenshots: ['export.png']}]).criteria[0].status, 'passed');
});

test('a completed legacy review can resume only for its bound behavioral snapshot', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-validation-reservation-'));
  const c = new Coordinator({root: path.join(root, 'state')});
  t.after(async () => {
    c.close();
    await rm(root, {recursive: true, force: true});
  });
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), {recursive: true});
  await writeFile(path.join(repo, 'src/export.mjs'), 'export const visible = true;\n');
  await git(repo, 'init');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-m', 'Baseline');
  const goal = c.prepareGoal({
    ...withMapping([criterion]),
    mode: 'overnight_review',
    modeVersion: 1,
    project: {...withMapping([criterion]).project, repo, baseCommit: await git(repo, 'rev-parse', 'HEAD')},
  }, 'prepare');
  c.activateGoal({goalId: goal.id, hash: goal.hash}, 'activate');
  const task = c.submitTask({
    goalId: goal.id, submissionId: 'candidate', kind: 'coding', objective: 'Review export',
    acceptance: ['CSV contains the visible rows'],
  }, 'submit');
  let calls = 0;
  const worker = new Worker({
    c,
    config: {environment: 'fixture'},
    provider: {complete: async () => ({
      content: JSON.stringify({type: 'submit_changes', paths: [], edits: [], summary: 'Candidate ready'}),
    })},
    reviewer: {reviewCode: async () => {
      calls++;
      return {decision: 'accept', feedback: 'Fixture verdict', unverified: []};
    }},
    checksFactory: () => ({
      verify: async () => ({verified: true}),
      run: async declared => declared.map(check => receipt(check.id)),
    }),
  });
  for (let n = 0; n < 8 && c.getTask(task.id).status !== 'awaiting_legacy_review'; n++) {
    await worker.tick();
  }
  assert.equal(c.getTask(task.id).status, 'awaiting_legacy_review');
  const accepted = await worker.legacyReview.tick();
  assert.equal(accepted.status, 'ready_to_integrate');
  const request = c.store.request(task.id, 'legacy-review-1');
  assert.equal(request.status, 'completed');
  assert.deepEqual(request.reviewBinding, accepted.legacyBehavioralReview);
  assert.equal(request.reviewBinding.snapshotHash, digest(accepted.result.snapshot));

  // Restore the crash boundary after the response was saved but before its verdict was applied.
  const restorePendingVerdict = () => {
    const pending = c.store.get('task', task.id);
    pending.status = 'legacy_reviewing';
    pending.checkpoint.legacyReviewKey = request.key;
    delete pending.legacyDecision;
    delete pending.legacyBehavioralReview;
    c.store.put('task', pending);
  };
  c.store.tx(restorePendingVerdict);
  assert.equal((await worker.legacyReview.tick()).status, 'ready_to_integrate');
  assert.equal(calls, 1, 'matching completed response is reused without spending another review');

  c.store.tx(() => {
    restorePendingVerdict();
    const saved = JSON.parse(request.data);
    saved.reviewBinding.snapshotHash = '0'.repeat(64);
    c.store.db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(saved), request.id);
  });
  const rejected = await worker.legacyReview.tick();
  assert.equal(rejected.status, 'blocked');
  assert.match(rejected.reason, /Saved review does not match/);
  assert.equal(rejected.legacyBehavioralReview, undefined);
  assert.equal(rejected.spent.codexReview, 1);
  assert.equal(calls, 1);
});
