import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/harness/store.mjs';
import { digest } from '../src/harness/contracts.mjs';

const module = () => import('../src/harness/outcomes/snapshot.mjs');
const FROM = '2026-11-09T00:00:00.000Z';
const TO = '2026-11-10T00:00:00.000Z';
const created = Date.parse(FROM);

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'mosaic-outcomes-readonly-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function files(root) {
  return readdirSync(root).map(name => ({
    name,
    mode: statSync(path.join(root, name)).mode,
    bytes: readFileSync(path.join(root, name)),
  }));
}

function schemaAndCounts(root) {
  const url = pathToFileURL(path.join(root, 'harness.sqlite3'));
  url.searchParams.set('immutable', '1');
  const db = new DatabaseSync(url, { readOnly: true });
  try {
    return {
      schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
      counts: ['records', 'submissions', 'commands', 'events', 'requests'].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n),
    };
  } finally {
    db.close();
  }
}

function seed(store) {
  store.put('goal', { id: 'goal-a', version: 2, manifest: { project: { repo: '/fixture/a', baseCommit: 'a'.repeat(40) } } });
  store.put('goal', { id: 'goal-b', version: 1, manifest: { project: { repo: '/fixture/b', baseCommit: 'b'.repeat(40) } } });
  store.put('goal_history', { id: 'goal-a-1', goalId: 'goal-a', version: 1, manifest: { project: { repo: '/fixture/a' } } });
  store.put('reviewer', { id: 'review-a', taskId: 'task-a', goalId: 'goal-a' });
  for (const [id, goalId, goalVersion, createdAt] of [
    ['task-a', 'goal-a', 1, created],
    ['task-b', 'goal-a', 2, created + 1],
    ['task-c', 'goal-a', 2, Date.parse(TO)],
    ['task-d', 'goal-b', 1, created],
    ['task-e', 'goal-a', 2, created - 1],
  ]) {
    store.put('task', { id, goalId, goalVersion, createdAt, spec: { kind: 'research' },
      ...(id === 'task-a' ? { researchReviewAcceptance: { nativeReservationId: 'review-a' } } : {}) });
  }
  store.event('goal.activated', { goalId: 'goal-a', at: created });
  store.event('task.claimed', { goalId: 'goal-a', taskId: 'task-a', at: created });
  store.event('model.output', { goalId: 'goal-a', taskId: 'task-a', at: created, data: { text: 'irrelevant stream fragment' } });
  store.event('task.result', { goalId: 'goal-a', taskId: 'task-a', at: Date.parse(TO) + 1, data: { status: 'accepted', result: { receiptStatus: 'completed' } } });
  const addRequest = store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)');
  addRequest.run('request-a', 'task-a', 'attempt-1', 'model', 'completed', JSON.stringify({
    id: 'counterfeit-id', reservedAt: created, savedAt: created + 1,
    result: { text: 'private payload', model: 'fixture', usage: { prompt_tokens: 10, completion_tokens: 5 } },
  }));
  addRequest.run('planning-a', 'goal-a', 'plan-1', 'model', 'reserved', '{"reservedAt":1}');
}

test('standalone report reads a checkpointed WAL database without changing files, schema, or rows', async t => {
  const { readOutcomeSnapshot } = await module();
  const root = fixture(t);
  const store = new Store(root);
  seed(store);
  store.close();
  const before = files(root);
  const schema = schemaAndCounts(root);
  const report = readOutcomeSnapshot({ stateRoot: root, goalId: 'goal-a' });
  assert.equal(report.coverage.complete, true);
  assert.deepEqual(report.tasks.map(task => task.id), ['task-a', 'task-b', 'task-c', 'task-e']);
  assert.deepEqual(report.events.map(event => event.type), ['goal.activated', 'task.claimed', 'task.result']);
  assert.deepEqual(report.evidence.map(item => [item.kind, item.id]), [['goal_history', 'goal-a-1'], ['reviewer', 'review-a']]);
  assert.equal(report.requests.length, 2);
  const request = report.requests.find(row => row.id === 'request-a');
  assert.equal(request.task_id, 'task-a');
  assert.deepEqual(request.data.result, { model: 'fixture', usage: { prompt_tokens: 10, completion_tokens: 5 } });
  assert.deepEqual(schemaAndCounts(root), schema);
  assert.deepEqual(files(root), before);
});

test('active WAL is read through the existing connection and standalone cannot silently miss WAL writes', async t => {
  const { readOutcomeSnapshot, readOutcomeSnapshotFromDatabase } = await module();
  const root = fixture(t);
  const store = new Store(root);
  try {
    seed(store);
    const before = files(root);
    assert.throws(() => readOutcomeSnapshot({ stateRoot: root, goalId: 'goal-a' }), /WAL|sidecar|active/i);
    assert.deepEqual(files(root), before);
    const report = readOutcomeSnapshotFromDatabase(store.db, { goalId: 'goal-a' });
    assert.equal(report.tasks.length, 4);
    assert.equal(report.coverage.complete, true);
    // SQLite may advance a transient reader mark in the existing SHM file.
    // Main DB/WAL bytes and the complete file set/modes must be unchanged.
    const withoutReaderMarks = entries => entries.map(row => row.name.endsWith('-shm')
      ? { ...row, bytes: null } : row);
    assert.deepEqual(withoutReaderMarks(files(root)), withoutReaderMarks(before));
    assert.equal(store.db.isTransaction, false);
  } finally {
    store.close();
  }
});

test('scope filters creation time half open, keeps later lifecycle evidence, and paginates honestly', async t => {
  const { readOutcomeSnapshot } = await module();
  const root = fixture(t);
  const store = new Store(root);
  seed(store);
  store.close();
  const scope = { stateRoot: root, projectKey: digest('/fixture/a'), from: FROM, to: TO, limit: 1 };
  const first = readOutcomeSnapshot(scope);
  assert.equal(first.coverage.complete, false);
  assert.deepEqual(first.tasks.map(task => task.id), ['task-a']);
  assert.ok(first.events.some(event => event.type === 'task.result' && event.at > Date.parse(TO)));
  assert.ok(first.coverage.nextCursor);
  assert.ok(first.requests.every(row => row.task_id === 'task-a'));
  const last = readOutcomeSnapshot({ ...scope, cursor: first.coverage.nextCursor });
  assert.equal(last.coverage.complete, false);
  assert.equal(last.coverage.nextCursor, null);
  assert.deepEqual(last.tasks.map(task => task.id), ['task-b']);
  assert.throws(() => readOutcomeSnapshot({ ...scope, from: '2026-11-08T00:00:00Z', cursor: first.coverage.nextCursor }), /cursor/i);
  assert.throws(() => readOutcomeSnapshot({ ...scope, from: '2026-02-30T00:00:00Z' }), /UTC|date|from/i);
  assert.throws(() => readOutcomeSnapshot({ ...scope, limit: 501 }), /limit/i);
});

test('malformed rows give incomplete coverage while preserving unaffected task and request identities', async t => {
  const { readOutcomeSnapshot } = await module();
  const root = fixture(t);
  const store = new Store(root);
  seed(store);
  store.db.prepare("INSERT INTO records VALUES('task','bad-task',?)").run('{');
  store.db.prepare("INSERT INTO requests VALUES('bad-request','task-a','attempt-2','model','completed',?)").run('{');
  store.db.prepare("INSERT INTO events(at,goal_id,task_id,type,data) VALUES(?, 'goal-a', 'task-a', 'task.reviewed', ?)").run(created, '{');
  store.close();
  const before = files(root);
  const report = readOutcomeSnapshot({ stateRoot: root, goalId: 'goal-a' });
  assert.equal(report.coverage.complete, false);
  assert.ok(report.tasks.some(row => row.id === 'task-a'));
  assert.ok(report.requests.some(row => row.id === 'request-a'));
  assert.ok(report.requests.some(row => row.id === 'bad-request' && row.data === null));
  assert.ok(report.diagnostics.some(row => row.id === 'bad-task'));
  assert.ok(report.diagnostics.some(row => row.id === 'bad-request'));
  assert.ok(report.diagnostics.some(row => row.source === 'events'));
  assert.ok(report.events.some(row => row.type === 'task.reviewed' && row.data === null));
  assert.deepEqual(files(root), before);
});

test('missing and unsafe database selections fail without creating state', async t => {
  const { readOutcomeSnapshot } = await module();
  const root = fixture(t);
  assert.throws(() => readOutcomeSnapshot({ stateRoot: path.join(root, 'missing') }), /missing|not exist/i);
  assert.throws(() => readOutcomeSnapshot({ stateRoot: root }), /harness.sqlite3/i);
  assert.deepEqual(readdirSync(root), []);
  symlinkSync(path.join(root, 'target-does-not-exist'), path.join(root, 'harness.sqlite3'));
  assert.throws(() => readOutcomeSnapshot({ stateRoot: root }), /regular file|unsafe/i);
  assert.deepEqual(readdirSync(root), ['harness.sqlite3']);
});

test('a complete explicit goal scope preserves exact goal planner ownership evidence', async t => {
  const { readOutcomeSnapshot } = await module();
  const root = fixture(t);
  const store = new Store(root);
  seed(store);
  const planning = {id: 'goal-a', goalId: 'goal-a', status: 'uncertain', attempt: 1};
  store.put('planning', planning);
  store.close();
  const snapshot = readOutcomeSnapshot({stateRoot: root, goalId: 'goal-a'});
  assert.deepEqual(snapshot.evidence.find(row => row.kind === 'planning'),
    {kind: 'planning', id: 'goal-a', data: planning});
  assert.ok(!readOutcomeSnapshot({stateRoot: root}).evidence.some(row => row.kind === 'planning'));
});

test('project mismatch excludes goal-owned planning requests from the selected cohort', async t => {
  const { readOutcomeSnapshot } = await module();
  const root = fixture(t);
  const store = new Store(root);
  seed(store);
  store.close();
  const report = readOutcomeSnapshot({ stateRoot: root, goalId: 'goal-a', projectKey: digest('/fixture/b') });
  assert.deepEqual(report.tasks, []);
  assert.deepEqual(report.requests, []);
  assert.deepEqual(report.goals, []);
  assert.equal(report.scope.planningRequestsIncluded, false);
});

test('a report identifies a common source revision only when selected goal bindings agree', async t => {
  const { readOutcomeSnapshot } = await module();
  const root = fixture(t);
  const store = new Store(root);
  seed(store);
  store.put('goal_history', { id: 'goal-a-1', goalId: 'goal-a', version: 1,
    manifest: { project: { repo: '/fixture/a', baseCommit: 'c'.repeat(40) } } });
  store.close();
  const mixed = readOutcomeSnapshot({ stateRoot: root, goalId: 'goal-a' });
  assert.equal(mixed.sourceRevision, null);
  const one = readOutcomeSnapshot({ stateRoot: root, goalId: 'goal-b' });
  assert.equal(one.sourceRevision, 'b'.repeat(40));
});

test('an oversized event cannot disappear from an otherwise complete report', async t => {
  const { readOutcomeSnapshot } = await module();
  const root = fixture(t);
  const store = new Store(root);
  seed(store);
  store.event('task.result', { goalId: 'goal-a', taskId: 'task-a', data: { text: 'x'.repeat(2 * 1024 * 1024) } });
  store.close();
  const report = readOutcomeSnapshot({ stateRoot: root, goalId: 'goal-a' });
  assert.equal(report.coverage.complete, false);
  assert.ok(report.diagnostics.some(row => row.code === 'row_size_limit' && row.source === 'events'));
  assert.equal(report.tasks.length, 4);
});

test('a capped task history retains its newest authority event', async t => {
  const { readOutcomeSnapshot } = await module();
  const root = fixture(t);
  const store = new Store(root);
  seed(store);
  store.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
    INSERT INTO events(at,goal_id,task_id,type,data)
    SELECT ?, 'goal-a', 'task-a', 'fixture.activity', '{}' FROM n`).run(created);
  const latest = store.event('task.integrated', {goalId: 'goal-a', taskId: 'task-a', at: created, data: {}});
  store.close();
  const report = readOutcomeSnapshot({stateRoot: root, goalId: 'goal-a'});
  assert.equal(report.coverage.complete, false);
  assert.equal(report.events.length, 10000);
  assert.equal(report.events.at(-1).seq, latest);
});

test('small historical v1 snapshots work but large unindexed scans fail without writes', async t => {
  const { readOutcomeSnapshot } = await module();
  const root = fixture(t);
  let store = new Store(root);
  seed(store);
  store.db.exec('DROP INDEX events_task_activity; DROP INDEX records_kind');
  store.close();
  assert.equal(readOutcomeSnapshot({stateRoot: root, goalId: 'goal-a'}).tasks.length, 4);

  store = new Store(root);
  store.db.exec('DROP INDEX events_task_activity');
  store.db.prepare("INSERT INTO events(seq,at,goal_id,task_id,type,data) VALUES(10001,?,'goal-a','task-a','fixture.activity','{}')")
    .run(created);
  store.close();
  const before = files(root);
  assert.throws(() => readOutcomeSnapshot({stateRoot: root, goalId: 'goal-a'}), /events_task_activity/);
  assert.deepEqual(files(root), before);

  store = new Store(root);
  store.db.exec("DROP INDEX records_kind; INSERT INTO records(rowid,kind,id,data) VALUES(10001,'fixture','old-record','{}')");
  store.close();
  const recordsBefore = files(root);
  assert.throws(() => readOutcomeSnapshot({stateRoot: root, goalId: 'goal-a'}), /records_kind/);
  assert.deepEqual(files(root), recordsBefore);
});

test('schema mismatch and existing transaction produce explicit errors without altering state', async t => {
  const { readOutcomeSnapshot, readOutcomeSnapshotFromDatabase } = await module();
  const root = fixture(t);
  const store = new Store(root);
  try {
    store.db.exec('BEGIN IMMEDIATE');
    assert.throws(() => readOutcomeSnapshotFromDatabase(store.db), /busy|transaction/i);
    assert.equal(store.db.isTransaction, true);
    store.db.exec('ROLLBACK');
    store.db.exec('PRAGMA user_version=99');
  } finally {
    store.close();
  }
  const before = files(root);
  assert.throws(() => readOutcomeSnapshot({ stateRoot: root }), /unsupported.*schema/i);
  assert.deepEqual(files(root), before);
});
