import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile), cli = fileURLToPath(new URL('../src/task-queue-cli.mjs', import.meta.url));
async function command(root, ...args) {
  try { const result = await exec(process.execPath, [cli, ...args, '--data-dir', root, '--json']); return { ...result, code: 0, value: JSON.parse(result.stdout) }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'queue-cli-'));
  t.after(async () => { await command(root, 'stop'); for(let n=0;n<30;n++){ const s=await command(root,'status'); if(!s.value?.worker)break;await delay(100); } await rm(root,{recursive:true,force:true}); });
  assert.equal((await command(root, 'init', '--fake', '--hours', '0.01')).code, 0); return root;
}
test('CLI rejects known flags on the wrong action before executing anything', async t => {
  const root = await setup(t);
  for (const args of [['run','--fake'],['init','--once'],['status','--background'],['stop','--hours','1'],['run','--unknown']]) {
    const result = await command(root,...args); assert.notEqual(result.code,0,args.join(' ')); assert.match(result.stderr,/option|flag/i);
  }
});
test('background startup is tied to its own durable token and duplicate workers are refused', async t => {
  const root = await setup(t), started = await command(root,'run','--background');
  assert.equal(started.code,0,started.stderr); assert.ok(started.value.worker?.token); assert.equal(started.value.pid,started.value.worker.pid);
  const again = await command(root,'run','--background'); assert.notEqual(again.code,0); assert.match(again.stderr,/worker|lease/i);
  await command(root,'stop');
});
test('background once preserves drain mode and confirms a short-lived worker from its own history', async t => {
  const root = await setup(t), started = await command(root,'run','--once','--background');
  assert.equal(started.code,0,started.stderr);
  let status; for(let n=0;n<40;n++){status=await command(root,'status');if(!status.value.worker)break;await delay(50);}
  assert.equal(status.value.worker,null); assert.equal(status.value.status,'drained');
  const again=await command(root,'run','--once','--background'); assert.equal(again.code,0,again.stderr);
  assert.notEqual(again.value.lastWorker.token,started.value.lastWorker.token);
});
