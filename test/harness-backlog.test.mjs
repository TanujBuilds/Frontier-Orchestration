import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {digest} from '../src/harness/contracts.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {Worker} from '../src/harness/worker.mjs';

import {Backlog} from '../src/harness/backlog/service.mjs';

function fixture(t, fields = {}, {active = true} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mosaic-backlog-'));
  let now = 1_000_000;
  const c = new Coordinator({root, now: () => now});
  t.after(() => {
    c.close();
    rmSync(root, {recursive: true, force: true});
  });
  const raw = {
    submissionId: 'goal', objective: 'Check the approved project',
    acceptance: ['Save the results'], environment: 'fixture', ...fields,
  };
  const draft = c.prepareGoal(raw, 'prepare');
  const goal = active ? c.activateGoal({goalId: draft.id, hash: draft.hash}, 'activate') : draft;
  let providerCalls = 0;
  const worker = new Worker({c, config: {environment: 'fixture'}, provider: {
    async complete() { providerCalls++; throw Error('Unexpected provider dispatch'); },
  }});
  return {
    c, goal, raw, worker, backlog: new Backlog({c, worker}),
    advanceTo: time => { now = time; }, providerCalls: () => providerCalls,
  };
}

const project = {
  repo: '/tmp/backlog-fixture', baseCommit: 'a'.repeat(40),
  readPaths: ['src/'], writePaths: ['src/'],
  checks: [{id: 'unit', argv: ['node', 'checks/unit.mjs']}],
};
const consult = (key, dependsOnKeys = []) => ({
  key, task: {kind: 'consult', objective: `Explain ${key}`, acceptance: ['Record the answer']}, dependsOnKeys,
});
const coding = (key, permissions) => ({
  key, task: {kind: 'coding', objective: `Implement ${key}`, acceptance: ['Checks pass'], permissions},
  dependsOnKeys: [],
});
const input = (goal, items, submissionId = 'batch') => ({
  goalId: goal.id, expectedGoalHash: goal.hash, expectedGoalVersion: goal.version, submissionId, items,
});
const count = (c, table) => c.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const counts = c => ({
  tasks: c.store.all('task').length,
  groups: c.store.all('backlog_group').length,
  submissions: count(c, 'submissions'), commands: count(c, 'commands'),
  events: count(c, 'events'), requests: count(c, 'requests'),
});

function rejectsGroup(f, request, code, message) {
  const before = counts(f.c);
  const preview = f.backlog.preview(request);
  assert.equal(preview?.valid, false, 'invalid input should produce preview diagnostics');
  assert.ok(preview.errors.some(error => error.code === code && message.test(error.message)),
    JSON.stringify(preview.errors));
  assert.throws(() => f.backlog.submit(request, 'submit'), message);
  assert.deepEqual(counts(f.c), before);
  assert.equal(f.providerCalls(), 0);
  return preview;
}

test('preview resolves forward references and binds the approved goal without changing state', t => {
  const f = fixture(t);
  const request = input(f.goal, [consult('followup', ['first']), consult('first'), consult('independent')]);
  const before = counts(f.c);
  const preview = f.backlog.preview(request);
  assert.equal(preview?.valid, true);
  assert.deepEqual(preview.taskKeys, ['first', 'followup', 'independent']);
  assert.deepEqual(preview.edges, [{from: 'first', to: 'followup'}]);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.goalId, f.goal.id);
  assert.equal(preview.goalHash, f.goal.hash);
  assert.equal(preview.goalVersion, f.goal.version);
  assert.deepEqual(f.backlog.preview(request), preview);
  assert.deepEqual(counts(f.c), before);
  assert.equal(f.providerCalls(), 0);
});

test('submit queues an entire DAG under one goal and both replay keys reuse original task IDs', t => {
  const f = fixture(t);
  const request = input(f.goal, [consult('followup', ['first']), consult('first'), consult('independent')]);
  const group = f.backlog.submit(request, 'submit');
  assert.equal(group?.goalHash, f.goal.hash);
  assert.equal(group.goalVersion, f.goal.version);
  assert.equal(group.goalId, f.goal.id);
  assert.deepEqual(f.c.store.get('backlog_group', group.id), group);
  assert.deepEqual(group.items.map(item => item.key), ['first', 'followup', 'independent']);
  const [first, followup, independent] = group.items.map(item => f.c.getTask(item.taskId));
  assert.deepEqual(followup.spec.dependsOn, [first.id]);
  assert.deepEqual(independent.spec.dependsOn, []);
  assert.ok([first, followup, independent].every(task => task.goalVersion === f.goal.version && task.status === 'queued'));
  assert.equal(f.c.getGoal(f.goal.id).deadline, f.goal.deadline);
  assert.deepEqual(f.c.store.events().slice(-4).map(event => event.type),
    ['task.submitted', 'task.submitted', 'task.submitted', 'backlog.submitted']);
  const before = counts(f.c);
  const reorderedProperties = {items: request.items, submissionId: request.submissionId,
    expectedGoalHash: request.expectedGoalHash, expectedGoalVersion: request.expectedGoalVersion, goalId: request.goalId};
  assert.deepEqual(f.backlog.submit(reorderedProperties, 'submit'), group);
  assert.deepEqual(counts(f.c), before);
  f.advanceTo(f.goal.deadline);
  assert.deepEqual(f.backlog.submit(request, 'submit-retry'), group);
  assert.deepEqual(counts(f.c), {...before, commands: before.commands + 1});
  assert.equal(f.providerCalls(), 0);
});

test('idempotency and submission identities conflict on any changed task or dependency content', t => {
  const f = fixture(t);
  const request = input(f.goal, [consult('first'), consult('second')]);
  f.backlog.submit(request, 'submit');
  const before = counts(f.c);
  const changed = structuredClone(request);
  changed.items[1].task.context = 'Changed context';
  assert.throws(() => f.backlog.submit(changed, 'submit'), /idempotency key conflict/i);
  assert.throws(() => f.backlog.submit(changed, 'other-key'), /submission conflict/i);
  changed.items[1] = consult('second', ['first']);
  assert.throws(() => f.backlog.submit(changed, 'submit'), /idempotency key conflict/i);
  assert.throws(() => f.backlog.submit(changed, 'other-key'), /submission conflict/i);
  assert.deepEqual(counts(f.c), before);
});

test('an invalid last assignment leaves tasks, submissions, commands and events unchanged', t => {
  const f = fixture(t, {project});
  const request = input(f.goal, [consult('first'), coding('last', {
    readPaths: ['src/'], writePaths: ['outside/'], checks: ['unit'],
  })]);
  assert.equal(rejectsGroup(f, request, 'invalid_task', /scope/i).errors[0].key, 'last');
});

test('a file named placeholder cannot authorize submission of its containing directory', t => {
  const f = fixture(t, {project: {...project, readPaths: ['src/sub/placeholder'], writePaths: ['src/sub/placeholder']}});
  const request = input(f.goal, [coding('expanded', {readPaths: ['src/sub/'], writePaths: ['src/sub/'], checks: ['unit']})]);
  rejectsGroup(f, request, 'invalid_task', /scope/i);
});

test('duplicate keys, missing or duplicate dependencies and cycles reject the whole DAG', t => {
  const f = fixture(t);
  for (const [items, message] of [
    [[consult('a'), consult('a')], /duplicate.*key/i],
    [[consult('a', ['missing'])], /unknown.*dependenc/i],
    [[consult('a'), consult('b', ['a', 'a'])], /duplicate.*dependenc/i],
    [[consult('a', ['b']), consult('b', ['a'])], /cycle/i],
  ]) rejectsGroup(f, input(f.goal, items), 'invalid_input', message);
});

test('group, item and task identity fields are closed and group size is bounded', t => {
  const f = fixture(t);
  const request = input(f.goal, [consult('a')]);
  for (const [invalid, message] of [
    [{...request, unexpected: true}, /unknown field/i],
    [{...request, items: [{...consult('a'), extra: true}]}, /unknown field/i],
    [{...request, items: [{...consult('a'), task: {...consult('a').task, submissionId: 'override'}}]}, /unknown field/i],
    [{...request, items: [{...consult('a'), task: {...consult('a').task, dependsOn: ['outside']}}]}, /unknown field/i],
    [{...request, items: []}, /1.*20/],
    [{...request, items: Array.from({length: 21}, (_, i) => consult(`task-${i}`))}, /1.*20/],
  ]) rejectsGroup(f, invalid, 'invalid_input', message);
});

test('inactive, expired and revised goal authority cannot be used to enqueue new tasks', t => {
  const f = fixture(t, {}, {active: false});
  const request = input(f.goal, [consult('a')]);
  rejectsGroup(f, request, 'goal_inactive', /active/i);
  const active = f.c.activateGoal({goalId: f.goal.id, hash: f.goal.hash}, 'activate');
  rejectsGroup(f, {...request, expectedGoalHash: 'a'.repeat(64)}, 'goal_hash_mismatch', /hash/i);
  const goals = new Goals(f.c);
  const revision = goals.prepareRevision({goalId: active.id, expectedHash: active.hash,
    manifest: {...f.raw, objective: 'Revised fixture'}}, 'prepare-revision');
  const approved = goals.activateRevision({revisionId: revision.id, hash: revision.hash}, 'approve-revision');
  rejectsGroup(f, request, 'goal_hash_mismatch', /hash/i);
  const updated = input(approved, [consult('a')]);
  assert.equal(f.backlog.preview(updated).goalVersion, 2);
  f.advanceTo(active.deadline);
  rejectsGroup(f, updated, 'goal_expired', /deadline/i);
});

test('same-hash approval revisions reject an uncommitted backlog preview but preserve committed replay', t => {
  const f = fixture(t);
  const request = {...input(f.goal, [consult('a')]), expectedGoalVersion: f.goal.version};
  assert.equal(f.backlog.preview(request).valid, true);
  const committed = f.backlog.submit({...request, submissionId: 'committed'}, 'committed');
  const goals = new Goals(f.c);
  const revision = goals.prepareRevision({goalId: f.goal.id, expectedHash: f.goal.hash,
    manifest: f.raw}, 'same-hash-revision');
  const approved = goals.activateRevision({revisionId: revision.id, hash: revision.hash}, 'activate-same-hash');
  assert.equal(approved.hash, f.goal.hash);
  assert.equal(approved.version, f.goal.version + 1);
  rejectsGroup(f, request, 'goal_version_mismatch', /version/i);
  assert.deepEqual(f.backlog.submit({...request, submissionId: 'committed'}, 'replay-committed'), committed);
  assert.equal(f.backlog.preview({...request, expectedGoalVersion: approved.version}).valid, true);
});

test('incompatible modes and the parked beta research route cannot enqueue assignments', t => {
  const f = fixture(t, {mode: 'codex_only'});
  const wrongActor = consult('a');
  wrongActor.task.actor = 'deepseek';
  rejectsGroup(f, input(f.goal, [wrongActor]), 'invalid_task', /prohibits actor/i);
  // Exercise a legacy approved core record opened by a beta service.
  const beta = new Coordinator({root: f.c.store.root, beta: true, now: f.c.now});
  t.after(() => beta.close());
  const research = {key: 'research', task: {...consult('a').task, kind: 'research'}, dependsOnKeys: []};
  rejectsGroup({...f, c: beta, backlog: new Backlog({c: beta})}, input(f.goal, [research]), 'research_parked', /research.*parked/i);
});

test('overnight v2 remains restricted to its validated planner graph', t => {
  const f = fixture(t, {mode: 'overnight_review', modeVersion: 2, project: {...project, checks: [
    ...project.checks, {id: 'preflight', argv: ['node', 'checks/preflight.mjs']},
  ]}, overnightPolicy: {preflightCheckIds: ['preflight'], finalOnlyCheckIds: ['unit']}}, {active: false});
  // The fixture models the durable state after exact preflight and activation.
  const goal = {...f.goal, status: 'active', activatedAt: f.c.now(), deadline: f.c.now() + 1000};
  f.c.store.put('goal', goal);
  rejectsGroup(f, input(goal, [consult('a')]), 'overnight_planner_required', /overnight.*planner graph/i);
});

test('the active goal task cap includes ordinary existing tasks and all pending group items', t => {
  const f = fixture(t, {limits: {maxTasks: 2}});
  f.c.submitTask({goalId: f.goal.id, submissionId: 'existing', ...consult('ordinary').task}, 'ordinary');
  rejectsGroup(f, input(f.goal, [consult('a'), consult('b')]), 'goal_task_cap', /task cap/i);
});

test('an existing ordinary task cannot be adopted through a reserved submission identity', t => {
  const f = fixture(t);
  const request = input(f.goal, [consult('a')]);
  const reserved = `backlog-${digest({goalId: f.goal.id, submissionId: request.submissionId, key: 'a'})}`;
  f.c.submitTask({goalId: f.goal.id, submissionId: reserved, ...consult('a').task}, 'seed');
  rejectsGroup(f, request, 'task_submission_conflict', /task submission.*conflict/i);
});

test('a failure after nested task commands rolls back worker yield, task events and identity records', t => {
  const f = fixture(t);
  const running = f.c.submitTask({goalId: f.goal.id, submissionId: 'existing', ...consult('ordinary').task}, 'ordinary');
  f.c.claimNext('owner');
  const urgent = consult('urgent');
  urgent.task.priority = 'blocking';
  const request = input(f.goal, [urgent, consult('later', ['urgent'])]);
  const before = counts(f.c);
  f.c.store.db.exec(`CREATE TRIGGER fixture_rollback BEFORE INSERT ON records
    WHEN NEW.kind='backlog_group' BEGIN SELECT RAISE(ABORT, 'fixture group write failure'); END;`);
  assert.throws(() => f.backlog.submit(request, 'submit'), /fixture group write failure/i);
  assert.deepEqual(counts(f.c), before);
  assert.equal(f.c.getTask(running.id).yieldRequested, false);
  f.c.store.db.exec('DROP TRIGGER fixture_rollback');
  assert.equal(f.backlog.submit(request, 'submit').items.length, 2);
  assert.equal(f.c.getTask(running.id).yieldRequested, true);
});

test('backlog control delegates supported task actions without granting goal-wide control', t => {
  const f = fixture(t);
  const group = f.backlog.submit(input(f.goal, [consult('a')]), 'submit');
  assert.ok(group?.items[0]);
  const [{taskId}] = group.items;
  assert.throws(() => f.backlog.control({taskId, action: 'pause', goalId: f.goal.id}, 'bad'), /unknown field/i);
  assert.throws(() => f.backlog.control({taskId, action: 'cancel'}, 'bad'), /invalid.*control/i);
  const stopped = f.backlog.control({taskId, action: 'stop'}, 'stop');
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(f.backlog.control({taskId, action: 'stop'}, 'stop'), stopped);
  assert.equal(f.backlog.control({taskId, action: 'resume'}, 'resume').status, 'queued');
  assert.equal(f.c.getGoal(f.goal.id).deadline, f.goal.deadline);
  assert.equal(f.c.getGoal(f.goal.id).status, 'active');
});

test('a goal identity supplied through the prototype cannot be omitted from the command digest', t => {
  const f = fixture(t);
  const request = input(f.goal, [consult('a'), consult('b')]);
  const inheritedGoal = Object.assign(Object.create({goalId: f.goal.id}), request);
  delete inheritedGoal.goalId;
  rejectsGroup(f, inheritedGoal, 'invalid_input', /goalId/i);
});

test('inherited goal fields cannot widen task-only controls', t => {
  const f = fixture(t);
  const request = input(f.goal, [consult('a'), consult('b')]);
  const group = f.backlog.submit(request, 'submit');
  const [first, second] = group.items;
  const control = Object.assign(Object.create({goalId: f.goal.id}), {taskId: first.taskId, action: 'stop'});
  assert.equal(f.backlog.control(control, 'task-stop').status, 'stopped');
  assert.equal(f.c.getGoal(f.goal.id).status, 'active');
  assert.equal(f.c.getTask(second.taskId).status, 'queued');
});


test('pause or stop before activation cannot confer approval or create a task deadline', t => {
  for (const action of ['pause', 'stop']) {
    const f = fixture(t, {}, {active: false});
    f.c.control({goalId: f.goal.id, action}, 'control-before-approval');
    const request = input(f.goal, [consult('a')]);
    rejectsGroup(f, request, 'goal_inactive', /active/i);
    assert.equal(f.c.getGoal(f.goal.id).activatedAt, null);
    assert.equal(f.c.getGoal(f.goal.id).deadline, null);
  }
});

test('backlog coding assignments retain behavior-mapped checks from the exact approved project', t => {
  const f = fixture(t, {project: {
    ...project,
    checks: [...project.checks, {id: 'behavior', argv: ['node', 'checks/behavior.mjs']}],
    behavioralChecks: [{criterionId: 'observable', description: 'Verify the observable behavior', checkIds: ['behavior']}],
  }});
  const scope = {readPaths: ['src/'], writePaths: ['src/'], checks: ['unit']};
  rejectsGroup(f, input(f.goal, [coding('a', scope)]), 'invalid_task', /required behavioral check behavior/i);
  const group = f.backlog.submit(input(f.goal, [coding('a', {...scope, checks: ['unit', 'behavior']})]), 'submit');
  assert.deepEqual(f.c.getTask(group.items[0].taskId).spec.permissions.checks, ['unit', 'behavior']);
});
