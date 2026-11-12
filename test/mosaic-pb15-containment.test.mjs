import assert from 'node:assert/strict';
import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { command } from '../src/project/process.mjs';
import { executeProfile, eventually, fixture, input, nativeApi } from './fixtures/mosaic-pb15-native/helpers.mjs';

async function ownedChild(t) {
  const f = await fixture(t), script = path.join(f.root, 'src/descendants.mjs');
  await cp(new URL('./fixtures/mosaic-pb15-native/descendants.mjs', import.meta.url), script);
  f.spec.inventory.push(await input(f.root, 'src/descendants.mjs'));
  const ready = path.join(f.root, '.overnight-output/ready.json'), late = path.join(f.root, '.overnight-output/late');
  return { ...f, script, ready, late };
}
for (const cancellation of [false, true]) test(`stopped command waits for SIGKILL of same-group ignored-stdio child (${cancellation ? 'cancellation' : 'timeout'})`, { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const { root, script, ready, late, ownedPids } = await ownedChild(t), controller = new AbortController();
  const pending = command([process.execPath, script, 'parent', ready, late, 'false'], { cwd: root, timeoutMs: cancellation ? 10000 : 1000, signal: controller.signal });
  const child = await eventually(async () => JSON.parse(await readFile(ready, 'utf8')));
  ownedPids.add(child.pid);
  if (cancellation) controller.abort();
  const result = await pending; assert.equal(result.stopped, true);
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH', 'owned same-group child must be dead when command resolves');
  await new Promise(resolve => setTimeout(resolve, Math.max(0, child.readyAt + 3800 - Date.now())));
  await assert.rejects(readFile(late), { code: 'ENOENT' }, 'owned child must not write after stopped command returns');
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH', 'owned same-group child must no longer be alive');
});

test('actual native detached/reparented escape remains a release blocker, with exact owned PID cleanup', { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 15000 }, async t => {
  const { compileDarwinSeatbeltPolicy: compile } = await nativeApi();
  const { spec, root, script, ready, late, ownedPids } = await ownedChild(t);
  const pending = executeProfile(compile(spec), root, [process.execPath, script, 'parent', ready, late, 'true'], { timeoutMs: 1000 });
  const child = await eventually(async () => JSON.parse(await readFile(ready, 'utf8'))); ownedPids.add(child.pid);
  const result = await pending; assert.equal(result.stopped, true);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, child.readyAt + 3800 - Date.now())));
  assert.equal(await readFile(late, 'utf8'), 'late-owned-write', 'diagnostic reproduction must continue to expose unsupported descendant containment');
  t.diagnostic(`Native production unavailable: owned detached child ${child.pid} escaped group termination; finally cleanup targets this PID only`);
});
