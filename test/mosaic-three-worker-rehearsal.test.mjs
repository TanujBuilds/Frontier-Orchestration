import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp, readFile, readdir, writeFile, realpath, symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const cli = path.resolve('scripts/demo-three-worker-rehearsal.mjs');
const run = (args, env = process.env, timeout=180000) => spawnSync(process.execPath, [cli, ...args], {env, encoding:'utf8', timeout, maxBuffer:1024*1024});

test('CLI refuses missing/duplicate arguments and Git overrides before writing', async () => {
  assert.ok((await readFile(cli, 'utf8')).includes('root'), 'runnable CLI exists');
  const parent = await mkdtemp(path.join(os.tmpdir(), 'three-worker-refusal-'));
  for (const args of [[], ['--root'], ['--root', path.join(parent,'new'), '--root', 'duplicate'], ['--unknown']]) {
    assert.notEqual(run(args).status, 0);
  }
  for (const name of ['GIT_DIR','GIT_WORK_TREE','GIT_CONFIG','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY']) {
    const result = run(['--root', path.join(parent,'new')], {...process.env, [name]:'/untrusted/override'});
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Git.*override/i);
  }
  assert.deepEqual(await readdir(parent), []);
  await writeFile(path.join(parent,'sentinel'), 'preserve');
  assert.notEqual(run(['--root', parent]).status, 0);
  assert.equal(await readFile(path.join(parent,'sentinel'),'utf8'), 'preserve');
});

test('inspect validates bounded evidence without creating or changing files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'three-worker-inspect-'));
  const file = path.join(root, 'rehearsal-result.json');
  await writeFile(file, JSON.stringify({schemaVersion:999,fixtureOnly:true}));
  assert.notEqual(run(['--root',root,'--inspect']).status,0);
  assert.deepEqual(await readdir(root), ['rehearsal-result.json']);
  const before = await readFile(file); run(['--root',root,'--inspect']);
  assert.deepEqual(await readFile(file),before);
});

test('inspect rejects FIFOs and symlinks without blocking or following them', async () => {
  const parent=await mkdtemp(path.join(os.tmpdir(),'three-worker-special-'));
  const fifoRoot=path.join(parent,'fifo'),linkRoot=path.join(parent,'link');
  const {mkdir}=await import('node:fs/promises');await mkdir(fifoRoot);await mkdir(linkRoot);
  assert.equal(spawnSync('/usr/bin/mkfifo',[path.join(fifoRoot,'rehearsal-result.json')]).status,0);
  const fifo=run(['--root',fifoRoot,'--inspect'],process.env,2000);
  assert.equal(fifo.status,1,'FIFO must be refused immediately, not killed by timeout');assert.match(fifo.stderr,/regular file/i);
  await writeFile(path.join(parent,'target'),'private fixture bytes');
  await symlink(path.join(parent,'target'),path.join(linkRoot,'rehearsal-result.json'));
  const link=run(['--root',linkRoot,'--inspect']);assert.equal(link.status,1);assert.match(link.stderr,/ELOOP|symbolic|symlink/i);
  assert.equal(await readFile(path.join(parent,'target'),'utf8'),'private fixture bytes');
});

test('three real coding endpoints overlap, integrate and retain blocked scenario identities', {timeout:180000}, async () => {
  // Native runtime is deliberately mandatory. Missing inputs must fail, never skip.
  const parent = await realpath(process.env.MOSAIC_THREE_WORKER_TEST_PARENT ?? await mkdtemp(path.join(os.tmpdir(),'three-worker-run-')));
  const root = path.join(parent, 'run-'+crypto.randomUUID());
  const result = run(['--root',root]);
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  const r = JSON.parse(result.stdout);
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.ok(r.source.files.some(file=>file.path==='src/harness/worker.mjs'));
  for (const file of r.source.files) assert.equal(file.sha256,sha256(await readFile(file.path)),file.path+' raw-byte identity');
  assert.equal(r.main.protectedChecks.sha256,sha256(await readFile(path.join(root,'main/repo/checks/invitation.mjs'))));
  assert.equal(r.main.evidenceHash,sha256(await readFile(path.join(root,'main/observations.json'))));
  assert.equal(r.schemaVersion,1); assert.equal(r.fixtureOnly,true); assert.equal(r.liveCallsMade,false);
  assert.equal(r.main.endpoints.length,3);
  assert.equal(new Set(r.main.endpoints.map(p=>new URL(p.baseUrl).host)).size,3);
  assert.ok(r.main.overlap.observedMaximum>=2);
  assert.equal(r.main.overlap.configured.service,3);
  assert.equal(r.main.tasks.length,3); assert.ok(r.main.tasks.every(t=>t.status==='accepted'));
  assert.equal(new Set(r.main.tasks.map(t=>t.integration.worktree)).size,1);
  assert.equal(r.main.protectedChecks.rejectedWrongCandidate,true);
  assert.equal(r.main.protectedChecks.combinedPassed,true);
  for (const t of r.main.tasks) {
    assert.equal(t.providerBinding.revision,'r1'); assert.ok(t.providerBinding.policyHash);
    assert.ok(t.integration.checks.every(c=>c.passed&&c.backend.revision===2));
  }
  assert.equal(r.busy.beforeRelease.spend,0); assert.equal(r.busy.beforeRelease.posts,0);
  assert.equal(r.offline.beforeDispatch.spend,0); assert.equal(r.offline.attempted.spend,1);
  assert.equal(r.offline.attempted.request.requestOutcome,'unknown');
  assert.equal(r.ambiguous.alias.spend,0); assert.equal(r.ambiguous.alias.posts,0);
  assert.equal(r.ambiguous.original.request.requestOutcome,'unknown');
  assert.equal(r.ambiguous.replay.noDuplicatePost,true); assert.equal(r.ambiguous.replay.sameBindings,true);
  assert.equal(r.quiescence.localWorkersClosed,true);
  const saved = await readFile(path.join(root,'rehearsal-result.json'));
  assert.ok(saved.length<256*1024); assert.doesNotMatch(saved.toString(),/dummy-bearer|fixture-key|Bearer /);
  const inspect=run(['--root',root,'--inspect']); assert.equal(inspect.status,0,inspect.stderr);
  assert.deepEqual(JSON.parse(inspect.stdout),r);
  assert.deepEqual(await readFile(path.join(root,'rehearsal-result.json')),saved);
  assert.notEqual(run(['--root',root]).status,0);
});
