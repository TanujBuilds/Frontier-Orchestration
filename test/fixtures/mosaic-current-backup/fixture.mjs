import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Artifacts} from '../../../src/harness/artifacts.mjs';
import {digest} from '../../../src/harness/contracts.mjs';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const MiB = 1024 * 1024;
export const tables = {
  records: 'kind,id', submissions: 'kind,scope,key', commands: 'key',
  events: 'seq', requests: 'id', sqlite_sequence: 'name',
};
export function snapshot(db) {
  return Object.fromEntries(Object.entries(tables).map(([table, order]) =>
    [table, JSON.parse(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()))]));
}
export async function inventory(root) {
  const files = [];
  async function walk(dir) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, name), st = await fs.lstat(file);
      if (st.isDirectory()) await walk(file);
      else if (st.isFile()) files.push({path: path.relative(root, file), bytes: st.size,
        mode: st.mode & 0o777, sha256: sha(await fs.readFile(file))});
      else if (st.isSymbolicLink()) files.push({path: path.relative(root, file), target: await fs.readlink(file)});
    }
  }
  await walk(root);
  return files;
}
export async function physical(source, destination) {
  await fs.mkdir(destination, {mode: 0o700});
  const files = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const file = source + suffix;
    try {
      const bytes = await fs.readFile(file);
      assert.ok(bytes.length <= 8 * MiB, 'bounded database/WAL/SHM');
      const name = 'harness.sqlite3' + suffix;
      await fs.writeFile(path.join(destination, name), bytes, {mode: 0o600, flag: 'wx'});
      files.push({name, bytes: bytes.length, sha256: sha(bytes)});
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files;
}
export async function runCase(t, label, fn) {
  // An optional lane-owned evidence directory retains all bytes. Ordinary runs
  // remove only successful fixtures; failures always retain their original state.
  const parent = process.env.MOSAIC_CURRENT_BACKUP_EVIDENCE_ROOT ?? os.tmpdir();
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'current-backup-' + label + '-')));
  const f = {root, closers: [], details: {}, json: async (name, value) =>
    fs.writeFile(path.join(root, name), JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'})};
  t.diagnostic('owned fixture: ' + root);
  let success = false;
  try {
    await fn(f);
    success = true;
  } catch (error) {
    await f.json('original-error.json', {message: error.message, stack: error.stack});
    throw error;
  } finally {
    // Preserve live main/WAL/SHM before connection close, even after assertions fail.
    try {
      if (f.source) f.details.beforeClose = await physical(f.source, path.join(root, 'before-close'));
      await f.json('case.json', {label, success, ...f.details});
      const files = await inventory(root);
      assert.ok(files.reduce((n, file) => n + (file.bytes ?? 0), 0) <= 64 * MiB, 'bounded retained fixture');
    } finally { for (const close of f.closers.reverse()) close(); }
    if (success && !process.env.MOSAIC_CURRENT_BACKUP_EVIDENCE_ROOT) await fs.rm(root, {recursive: true});
  }
}
export async function representative(f) {
  let clock = 1_700_000_000_000;
  const owner = 'owned-offline-fixture', state = path.join(f.root, 'state');
  const c = new Coordinator({root: state, now: () => clock});
  f.closers.push(() => c.close());
  const db = c.store.db;
  // Begin with an empty main database, then put every representative row in WAL.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0');
  f.source = path.join(state, 'harness.sqlite3');
  const prepared = c.prepareGoal({submissionId: 'current-backup-fixture', environment: 'fixture',
    mode: 'collaborative', objective: 'Qualify owned database backup without dispatch',
    acceptance: ['Exact durable identities and accounting'], project: null,
    limits: {hours: 1, maxTasks: 3}}, 'prepare-fixture');
  const g = c.activateGoal({goalId: prepared.id, hash: prepared.hash}, 'approve-fixture');
  const task = name => {
    clock += 10;
    const t = c.submitTask({goalId: g.id, expectedGoalHash: g.hash, expectedGoalVersion: 1,
      submissionId: name, kind: 'consult', objective: 'Offline state ' + name,
      acceptance: ['Preserve original request'], limits: {seconds: 120, modelCalls: 1}}, 'submit-' + name);
    const claimed = c.claimNext(owner);
    assert.equal(claimed.id, t.id);
    assert.equal(claimed.deadline, Math.min(g.deadline, clock + 120_000));
    return claimed;
  };
  const saved = task('saved');
  const savedRequest = c.reserve(saved.id, {key: 'saved-reservation', kind: 'model'}, owner);
  c.saveRequest(savedRequest.id, {content: 'Owned saved response; no inference occurred'}, owner);
  const directory = path.join(state, 'reports');
  await fs.mkdir(directory, {mode: 0o700});
  const reportFile = path.join(directory, 'report.md'), reportBytes = Buffer.from('Owned artifact outside SQLite backup.\n');
  assert.ok(reportBytes.length <= 64 * 1024);
  await fs.writeFile(reportFile, reportBytes, {mode: 0o600});
  c.completeTask(saved.id, {directory, checksumsVerified: true}, owner);
  const artifacts = new Artifacts(c), catalog = await artifacts.list(saved.id);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].url, '/api/artifacts/' + catalog[0].id);
  assert.equal(catalog[0].file, undefined);
  assert.equal(catalog[0].sha256, sha(reportBytes));
  assert.equal(catalog[0].bytes, reportBytes.length);
  assert.deepEqual((await artifacts.read(catalog[0].id)).data, reportBytes);
  const known = task('known-safe');
  const knownRequest = c.reserve(known.id, {key: 'not-dispatched', kind: 'model'}, owner);
  c.failModelRequest(knownRequest.id, owner, {reason: 'Owned fixture: not dispatched', outcome: 'not_dispatched', reconnect: false});
  const unknown = task('unknown');
  const unknownRequest = c.reserve(unknown.id, {key: 'unknown-spent', kind: 'model'}, owner);
  c.failModelRequest(unknownRequest.id, owner, {reason: 'Owned fixture: outcome unknown', outcome: 'unknown', reconnect: false});
  const marker = {identity: 'distinctive-committed-WAL-marker', request: unknownRequest.id};
  c.store.tx(() => c.store.event('fixture.current_backup_marker', {goalId: g.id, taskId: unknown.id, at: clock, data: marker}));
  const tasks = [saved, known, unknown].map(t => c.getTask(t.id));
  assert.deepEqual(tasks.map(t => t.status), ['accepted', 'blocked', 'uncertain']);
  assert.deepEqual(tasks.map(t => t.spent.model), [1, 1, 1]);
  assert.deepEqual(tasks.map(t => t.owner), [null, null, owner]);
  assert.equal(g.hash, digest(g.manifest));
  assert.equal(g.manifest.environment, 'fixture');
  assert.equal(g.manifest.mode.id, 'collaborative');
  assert.equal(g.version, 1);
  assert.equal(g.deadline, g.activatedAt + 3_600_000);
  assert.ok(tasks.every(t => t.hash === digest(t.spec) && t.goalVersion === 1 && t.spec.limits.modelCalls === 1));
  const logical = snapshot(db);
  assert.equal(logical.submissions.length, 4);
  assert.equal(logical.commands.length, 5);
  assert.equal(logical.requests.length, 3);
  assert.equal(logical.records.length, 11);
  assert.deepEqual(logical.events.map(e => e.type), [
    'goal.prepared', 'goal.activated',
    'task.submitted', 'memory.pinned', 'task.claimed', 'request.reserved', 'request.saved', 'task.result',
    'task.submitted', 'memory.pinned', 'task.claimed', 'request.reserved', 'task.blocked',
    'task.submitted', 'memory.pinned', 'task.claimed', 'request.reserved', 'task.uncertain',
    'fixture.current_backup_marker',
  ]);
  assert.deepEqual(logical.requests.map(r => r.status).sort(), ['completed', 'failed', 'failed']);
  assert.equal(logical.records.filter(r => r.kind === 'task').length, 3);
  assert.equal(logical.records.filter(r => r.kind === 'goal').length, 1);
  assert.equal(logical.records.filter(r => r.kind === 'artifact').length, 1);
  assert.deepEqual(logical.events.map(e => e.seq), Array.from({length: logical.events.length}, (_, i) => i + 1));
  assert.deepEqual(logical.sqlite_sequence, [{name: 'events', seq: logical.events.at(-1).seq}]);
  assert.equal(logical.events.at(-1).type, 'fixture.current_backup_marker');
  assert.deepEqual(JSON.parse(logical.events.at(-1).data), marker);
  assert.equal(JSON.parse(logical.requests.find(r => r.id === knownRequest.id).data).requestOutcome, 'not_dispatched');
  assert.equal(JSON.parse(logical.requests.find(r => r.id === unknownRequest.id).data).requestOutcome, 'unknown');
  assert.deepEqual(JSON.parse(logical.requests.find(r => r.id === savedRequest.id).data).result,
    {content: 'Owned saved response; no inference occurred'});
  return {c, db, g, tasks, logical, artifacts, catalog, reportFile, reportBytes, marker};
}
