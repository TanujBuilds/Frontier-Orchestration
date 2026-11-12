import assert from 'node:assert/strict';
import { chmod, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { CheckRunner } from '../src/project/sandbox.mjs';
import { createBackend } from '../src/project/check-backends/contracts.mjs';
import { canonical, copyBrowser, executeProfile, fixture, hash, input, nativeApi, stage } from './fixtures/mosaic-pb15-native/helpers.mjs';

const darwin = process.platform === 'darwin' && process.arch === 'arm64';

test('native compiler requires coordinator bounds and refuses unsafe aliases and input evidence', async t => {
  const { compileDarwinSeatbeltPolicy: compile } = await nativeApi();
  const { spec, root, external } = await fixture(t);
  const compiled = compile(spec);
  assert.equal(typeof compiled.profile, 'string');
  assert.equal(compiled.evidence.inputs.length, 3);
  for (const mutate of [
    s => { s.permissions.network.enabled = true; },
    s => { s.permissions.filesystem.rules = s.permissions.filesystem.rules.filter(rule => rule.path !== root); },
    s => { s.permissions.filesystem.rules = s.permissions.filesystem.rules.filter(rule => rule.path !== path.join(root, 'dist')); },
    s => { s.workspace.path += '\n(allow default)'; },
    s => { s.workspace.realPath = external; },
    s => { s.readPaths = ['../']; },
    s => { s.inventory[0].path = '../outside'; },
    s => { s.inventory[0].realPath = path.join(external, 'canary'); },
    s => { s.inventory[0].hash = 'unbound'; },
    s => { s.inventory[0].mode = '100777'; },
    s => { s.inventory.push({ ...s.inventory[0] }); },
    s => { s.inventory[0].path = 'undisclosed.txt'; s.inventory[0].realPath = path.join(root, 'undisclosed.txt'); },
    s => { s.inventory[0].path = '.env'; s.inventory[0].realPath = path.join(root, '.env'); s.readPaths.push('.env'); },
    s => { s.outputs[0] = { path: external, realPath: external }; },
    s => { s.dependencies[0] = { path: root, realPath: root }; },
    s => { s.dependencies[0].realPath = external; },
    s => { s.executable.path = '/usr/local/bin/../bin/node'; },
    s => { s.executable = { path: '/Users/dummy/.ssh/node', realPath: '/Users/dummy/.ssh/node' }; },
    s => { s.stagedInputs = [{ root: s.outputs[0], inventory: s.inventory }]; },
    s => { s.inventory = Array(10001).fill(s.inventory[0]); },
  ]) {
    const invalid = structuredClone(spec); mutate(invalid);
    assert.throws(() => compile(invalid), error => error.code === 'isolation');
  }
  const deniedAlias = structuredClone(spec);
  deniedAlias.deniedPaths = [{ path: path.join(root, 'nested/.env'), realPath: path.join(root, 'src/source.txt') }];
  assert.throws(() => compile(deniedAlias), error => error.code === 'isolation');
});

test('native backend is recognized but no option, identity or argv enables production checks', { skip: !darwin }, async t => {
  const api = await nativeApi();
  const { spec, root, parent } = await fixture(t);
  const workspace = { root, journal: { dir: parent }, manifest: { permissions: { readPaths: spec.readPaths } }, snapshot: async () => Object.fromEntries(spec.inventory.map(file => [file.path, file.hash])) };
  const marker = path.join(root, 'dist/must-not-run');
  const argv = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`];
  for (const options of [{}, { verified: true, allowUnsafe: true, containment: true, executable: process.execPath }]) {
    const backend = createBackend({ id: 'darwin-seatbelt', workspace, options });
    assert.equal(backend.identity().id, 'darwin-seatbelt');
    await assert.rejects(backend.execute({ argv, cwd: root, env: {}, permissions: spec.permissions }), error => error.code === 'isolation' && error.message === api.DARWIN_SEATBELT_CONTAINMENT_BLOCKER);
    const runner = new CheckRunner(workspace, { backend: 'darwin-seatbelt', backendOptions: options });
    for (const operation of [() => runner.execute(argv, 1000), () => runner.verify(), () => runner.run([{ id: 'blocked', argv }], 'blocked')]) await assert.rejects(operation(), error => error.code === 'isolation' && /descendant/i.test(error.message));
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('actual compiled diagnostic profile denies undisclosed, ignored secrets, aliases, writes and live network', { skip: !darwin, timeout: 30000 }, async t => {
  const { compileDarwinSeatbeltPolicy: compile } = await nativeApi();
  const { spec, root, external } = await fixture(t);
  for (const [alias, target] of [['external', path.join(external, 'canary')], ['env', path.join(root, '.env')], ['private', path.join(root, 'undisclosed.txt')]]) await symlink(target, path.join(root, 'src', alias));
  const staged = await stage(spec, root);
  await writeFile(path.join(staged, 'undisclosed-copy.txt'), 'staged-undisclosed');
  const server = createServer(socket => { socket.on('error', () => {}); socket.end('known-live'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => server.close());
  await new Promise((resolve, reject) => { const socket = connect(server.address().port, '127.0.0.1'); socket.on('error', reject); socket.once('data', data => { assert.equal(data.toString(), 'known-live'); socket.destroy(); resolve(); }); });
  const denied = ['.env', '.git/config', 'undisclosed.txt', 'nested/.env.local', 'nested/ignored.txt', 'src/external', 'src/env', 'src/private', path.join(staged, 'undisclosed-copy.txt'), path.join(external, 'canary'), '/System/Volumes/Data' + path.join(external, 'canary')];
  const probe = `const fs=require('node:fs'),net=require('node:net');const r={};
    function attempt(k,f){try{r[k]={ok:true,value:f()}}catch(e){r[k]={ok:false,code:e.code}}}
    for(const p of ${JSON.stringify(denied)})attempt('read:'+p,()=>fs.readFileSync(p,'utf8'));
    for(const p of ${JSON.stringify(['unapproved', 'src/source.txt', '.git/config', path.join(external, 'outside'), path.join(staged, 'src/source.txt')])})attempt('write:'+p,()=>fs.writeFileSync(p,'bad'));
    attempt('source',()=>fs.readFileSync('src/source.txt','utf8'));attempt('staged',()=>fs.readFileSync(${JSON.stringify(path.join(staged, 'src/source.txt'))},'utf8'));
    attempt('output',()=>fs.writeFileSync('dist/allowed','ok'));attempt('temp',()=>fs.writeFileSync('.overnight-output/tmp/allowed','ok'));
    async function netProbe(k,host,port){r[k]=await new Promise(resolve=>{const s=net.connect(port,host);s.on('connect',()=>{s.destroy();resolve({connected:true})});s.on('error',e=>resolve({code:e.code,syscall:e.syscall}));s.setTimeout(1500,()=>{s.destroy();resolve({timeout:true})})})}
    (async()=>{await netProbe('loopback','127.0.0.1',${server.address().port});await netProbe('external','198.51.100.1',443);console.log(JSON.stringify(r))})()`;
  const result = await executeProfile(compile(spec), root, [process.execPath, '-e', probe]);
  assert.equal(result.code, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  for (const [key, value] of Object.entries(actual)) if (/^(read|write):/.test(key)) assert.ok(!value.ok && ['EPERM', 'EACCES'].includes(value.code), `${key}: ${JSON.stringify(value)}`);
  assert.equal(actual.source.value, 'approved-source'); assert.equal(actual.staged.value, 'approved-source');
  assert.equal(actual.output.ok, true); assert.equal(actual.temp.ok, true);
  for (const key of ['loopback', 'external']) assert.ok(['EPERM', 'EACCES'].includes(actual[key].code) && actual[key].syscall === 'connect', JSON.stringify(actual[key]));
  assert.equal(await readFile(path.join(root, 'src/source.txt'), 'utf8'), 'approved-source');
});

test('diagnostic input evidence binds file bytes and executable mode, including staged copies', async t => {
  const { compileDarwinSeatbeltPolicy: compile } = await nativeApi();
  const { spec, root } = await fixture(t);
  await stage(spec, root);
  const first = compile(spec);
  const source = spec.inventory.find(file => file.path === 'src/source.txt');
  assert.equal(first.evidence.inputs.find(file => file.path === source.path).hash, hash(Buffer.from('approved-source')));
  await chmod(path.join(root, source.path), 0o755); source.mode = '100755';
  assert.throws(() => compile(spec), error => error.code === 'isolation', 'staged mode mismatch must fail');
  await chmod(path.join(spec.stagedInputs[0].root.path, source.path), 0o755);
  spec.stagedInputs[0].inventory = await Promise.all(spec.inventory.map(file => input(spec.stagedInputs[0].root.path, file.path)));
  const second = compile(spec);
  assert.notEqual(second.evidence.inventoryHash, first.evidence.inventoryHash);
  assert.equal(second.evidence.inputs.find(file => file.path === source.path).mode, '100755');
});

test('actual Chromium diagnoses wrong CSV then accepts correction under unchanged compiled policy and checks', { skip: !darwin, timeout: 120000 }, async t => {
  const { compileDarwinSeatbeltPolicy: compile } = await nativeApi();
  const { spec, root } = await fixture(t);
  await cp(new URL('./fixtures/mosaic-validation/', import.meta.url), root, { recursive: true });
  await copyBrowser(root);
  spec.readPaths = ['package.json', 'src/', 'checks/'];
  const files = ['package.json', 'src/index.html', 'src/csv.mjs', 'src/export.mjs', 'checks/build.mjs', 'checks/unit.mjs', 'checks/download.mjs'];
  spec.inventory = await Promise.all(files.map(file => input(root, file)));
  const download = await readFile(path.join(root, 'checks/download.mjs'));
  const original = await readFile(path.join(root, 'src/export.mjs'), 'utf8');
  await writeFile(path.join(root, 'src/export.mjs'), original.replace('tbody input:checked', 'tbody input'));
  spec.inventory = await Promise.all(files.map(file => input(root, file)));
  const incorrect = compile(spec);
  for (const check of ['build', 'unit']) { const result = await executeProfile(incorrect, root, [process.execPath, `checks/${check}.mjs`]); assert.equal(result.code, 0, result.stderr); }
  const bad = await executeProfile(incorrect, root, [process.execPath, 'checks/download.mjs']);
  assert.equal(bad.code, 1, bad.stderr); assert.match(bad.stderr, /downloads selected rows only/);
  await writeFile(path.join(root, 'src/export.mjs'), original);
  spec.inventory = await Promise.all(files.map(file => input(root, file)));
  const corrected = compile(spec);
  assert.equal(incorrect.profile, corrected.profile, 'same permissions and file paths retain the same native access policy');
  assert.notEqual(incorrect.evidence.inventoryHash, corrected.evidence.inventoryHash, 'evidence must bind the actual checked source revision');
  const good = await executeProfile(corrected, root, [process.execPath, 'checks/download.mjs']);
  assert.equal(good.code, 0, good.stderr); assert.match(good.stdout, /Downloaded sales.csv \(33 bytes, sha256=d476f038d8e8c000c50341d68cb44856e7d16109fcc28222b6d3604d9e9afb28\)/);
  assert.equal(hash(await readFile(path.join(root, 'checks/download.mjs'))), hash(download));
  if (process.env.MOSAIC_NATIVE_DIAGNOSTIC_DIR) {
    const dir = process.env.MOSAIC_NATIVE_DIAGNOSTIC_DIR; await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'task-2-compiled-policy.sb'), corrected.profile);
    await writeFile(path.join(dir, 'task-2-compiled-evidence.json'), JSON.stringify({ diagnosticOnly: true, spec, evidence: corrected.evidence, bad, good, protectedCheckHash: hash(download) }, null, 2));
  }
});
