import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmod, mkdtemp, realpath, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {locations, privateDirectories, withLock} from '../src/beta/files.mjs';
import {assertStateCompatibility} from '../src/beta/install.mjs';
import {stopForMaintenance} from '../src/beta/service.mjs';

const holdDatabase = `
  import {DatabaseSync} from 'node:sqlite';
  const db = new DatabaseSync(process.argv[1]);
  db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
  process.send('locked');
  process.once('message', () => setTimeout(() => {
    db.close();
    process.disconnect();
  }, 325));
`;

async function withContendedDatabase(file, check) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', holdDatabase, file], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const closed = once(child, 'close');
  let releaseRequested = false;
  try {
    const [message] = await once(child, 'message', {signal: AbortSignal.timeout(3000)});
    assert.equal(message, 'locked');
    child.send('release');
    releaseRequested = true;
    return await check();
  } finally {
    if (!releaseRequested) child.kill();
    const [code] = await closed;
    if (releaseRequested) assert.equal(code, 0);
  }
}

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mosaic-beta-maintenance-')));
  t.after(() => rm(home, {recursive: true, force: true}));
  const paths = locations(home, true);
  await privateDirectories(paths);
  const file = path.join(paths.state, 'harness.sqlite3');
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE records(kind TEXT, id TEXT, data TEXT);
      PRAGMA user_version=1;
      INSERT INTO records VALUES ('lease', 'coordinator', '{}');`);
  } finally {
    db.close();
  }
  await chmod(file, 0o600);
  return {paths, file};
}

test('the install compatibility read waits for transient WAL contention', {timeout: 5000}, async t => {
  const {paths, file} = await fixture(t);
  await withContendedDatabase(file, () => assertStateCompatibility(paths, {}));
});

test('the offline maintenance read waits and still detects a retained lease', {timeout: 5000}, async t => {
  const {paths, file} = await fixture(t);
  await withContendedDatabase(file, () =>
    assert.rejects(stopForMaintenance(paths), /coordinator lease remains present/i));
});

test('the maintenance mutex reports its separate owner immediately', {timeout: 5000}, async t => {
  const {paths} = await fixture(t);
  await withLock(paths, () => {});
  const file = path.join(paths.configDir, 'maintenance.sqlite3');
  await withContendedDatabase(file, () =>
    assert.rejects(withLock(paths, () => assert.fail('Maintenance must reject contention')),
      /another Mosaic Beta maintenance command is running/i));
});
