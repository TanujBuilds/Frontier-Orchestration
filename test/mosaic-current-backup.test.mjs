import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/harness/store.mjs';
import {backupCurrentDatabase} from '../scripts/deployment-checkpoint.mjs';
import {runCase, representative, snapshot, inventory, physical, sha, MiB} from './fixtures/mosaic-current-backup/fixture.mjs';

// These assertions detect a main-file-only/stale copy, loss or rewriting of any
// authoritative row, replay/refund of spent requests, and artifact-bundle claims.
test('real Store committed WAL backup preserves exact approvals, accounting, holds and artifact references', {timeout: 20_000}, t => runCase(t, 'real-store', async f => {
  const r = await representative(f), output = path.join(f.root, 'backup');
  assert.ok((await fs.stat(f.source + '-wal')).size > 0);
  const stale = path.join(f.root, 'main-only.sqlite');
  await fs.copyFile(f.source, stale);
  const mainOnly = new DatabaseSync(stale, {readOnly: true});
  try { assert.equal(mainOnly.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0); }
  finally { mainOnly.close(); }
  f.details.physicalBefore = await physical(f.source, path.join(f.root, 'source-before'));
  await f.json('logical-before.json', r.logical);
  const receipt = await backupCurrentDatabase({source: f.source, output});
  const copyFile = path.join(output, 'current.sqlite'), copyBytes = await fs.readFile(copyFile);
  assert.ok(copyBytes.length <= 8 * MiB);
  assert.deepEqual(receipt, {schema: 1, scope: 'fixture_or_operator_backup', restorationSupported: false,
    complete: true, sha256: sha(copyBytes), userVersion: 1});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'backup-receipt.json'), 'utf8')), receipt);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o700);
  for (const name of ['current.sqlite', 'backup-receipt.json']) assert.equal((await fs.stat(path.join(output, name))).mode & 0o777, 0o600);
  const copy = new DatabaseSync(copyFile, {readOnly: true});
  let copied;
  try {
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 1);
    copied = snapshot(copy);
    assert.deepEqual(copied, r.logical);
    // Verify important invariants directly in the copy, in addition to full rows.
    const goal = JSON.parse(copy.prepare("SELECT data FROM records WHERE kind='goal' AND id=?").get(r.g.id).data);
    assert.deepEqual(goal, r.c.store.get('goal', r.g.id));
    const unknown = JSON.parse(copy.prepare("SELECT data FROM records WHERE kind='task' AND id=?").get(r.tasks[2].id).data);
    assert.equal(unknown.status, 'uncertain');
    assert.equal(unknown.owner, 'owned-offline-fixture');
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM requests WHERE task_id=?').get(unknown.id).n, 1);
    const artifact = JSON.parse(copy.prepare("SELECT data FROM records WHERE kind='artifact' AND id=?").get(r.catalog[0].id).data);
    assert.equal(artifact.file, r.reportFile);
    assert.equal(artifact.sha256, sha(r.reportBytes));
  } finally { copy.close(); }
  await f.json('logical-copy.json', copied);
  assert.deepEqual(snapshot(r.db), r.logical);
  assert.deepEqual(r.c.store.get('goal', r.g.id), r.g);
  assert.deepEqual(r.tasks.map(task => r.c.getTask(task.id)), r.tasks);
  assert.deepEqual(await fs.readFile(r.reportFile), r.reportBytes);
  assert.deepEqual((await r.artifacts.read(r.catalog[0].id)).data, r.reportBytes);
  // Read-only SQLite inspection can create its own WAL/SHM bookkeeping files.
  const outputNames = await fs.readdir(output);
  assert.ok(outputNames.includes('backup-receipt.json') && outputNames.includes('current.sqlite'));
  assert.ok(outputNames.every(name => ['backup-receipt.json', 'current.sqlite', 'current.sqlite-wal', 'current.sqlite-shm'].includes(name)));
  assert.ok(!outputNames.includes('report.md'));
  const beforeReuse = await inventory(output);
  await assert.rejects(backupCurrentDatabase({source: f.source, output}), /backup_exists_preserve_it/);
  assert.deepEqual(await inventory(output), beforeReuse);
  assert.deepEqual(snapshot(r.db), r.logical);
  await f.json('logical-after.json', snapshot(r.db));
  f.details.physicalAfter = await physical(f.source, path.join(f.root, 'source-after'));
  f.details.receipt = receipt;
  f.details.tableCounts = Object.fromEntries(Object.entries(r.logical).map(([name, rows]) => [name, rows.length]));
  f.details.logicalSha256 = sha(Buffer.from(JSON.stringify(r.logical)));
  f.details.externalArtifact = r.catalog[0];
}));

test('overlap and symlink refusal preserve owned state and sentinels', {timeout: 20_000}, t => runCase(t, 'refusals', async f => {
  const state = path.join(f.root, 'state'), store = new Store(state);
  f.closers.push(() => store.close());
  f.source = path.join(state, 'harness.sqlite3');
  store.db.exec('PRAGMA wal_autocheckpoint=0');
  store.tx(() => store.put('sentinel', {id: 'owned', value: 'PRESERVE'}));
  const before = snapshot(store.db), sentinel = path.join(state, 'sentinel.txt');
  await fs.writeFile(sentinel, 'OWNED_SENTINEL', {mode: 0o600});
  const sourceLink = path.join(f.root, 'source-link.sqlite'), parentLink = path.join(f.root, 'parent-link');
  await fs.symlink(f.source, sourceLink); await fs.symlink(f.root, parentLink);
  const attempts = [
    {source: f.source, output: path.join(state, 'overlap')},
    {source: sourceLink, output: path.join(f.root, 'source-link-output')},
    {source: f.source, output: path.join(parentLink, 'aliased-output')},
  ];
  for (const options of attempts) {
    await assert.rejects(backupCurrentDatabase(options), {message: /^(backup_overlaps_state|unsafe_or_missing_path)$/});
    await assert.rejects(fs.lstat(options.output), {code: 'ENOENT'});
    assert.deepEqual(snapshot(store.db), before);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'OWNED_SENTINEL');
  }
  assert.equal(await fs.readlink(sourceLink), f.source);
  assert.equal(await fs.readlink(parentLink), f.root);
  f.details.refusals = ['source-directory-overlap', 'source-symlink', 'output-parent-symlink'];
}));

test('small corrupt source retains partial output and returns a fixed private failure', {timeout: 20_000}, t => runCase(t, 'corrupt', async f => {
  const state = path.join(f.root, 'state'); await fs.mkdir(state, {mode: 0o700});
  f.source = path.join(state, 'SECRET_SENTINEL.sqlite');
  const bytes = Buffer.from('not a SQLite database: owned corruption specimen\n');
  await fs.writeFile(f.source, bytes, {mode: 0o600});
  const output = path.join(f.root, 'partial-backup');
  const error = await backupCurrentDatabase({source: f.source, output}).then(() => null, error => error);
  assert.ok(error, 'corrupt database must not produce a complete backup');
  assert.match(error.message, /^[a-z][a-z0-9_]{1,80}$/);
  assert.ok(!error.message.includes('SECRET_SENTINEL') && !error.message.includes(f.root));
  assert.deepEqual(await fs.readFile(f.source), bytes);
  await assert.rejects(fs.lstat(path.join(output, 'backup-receipt.json')), {code: 'ENOENT'});
  f.details.error = {message: error.message, stack: error.stack};
  f.details.partialOutput = await inventory(output);
  f.details.restorationAttempted = false;
}));
