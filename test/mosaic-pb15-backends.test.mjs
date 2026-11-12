import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CheckRunner } from '../src/project/sandbox.mjs';
import { command } from '../src/project/process.mjs';

async function boundary() {
  const api = await import('../src/project/check-backends/contracts.mjs').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return {};
  });
  assert.equal(typeof api.createBackend, 'function', 'backend factory boundary must exist');
  assert.equal(typeof api.createPolicy, 'function', 'permission policy must be independent of backend syntax');
  return api;
}

async function fixture(t) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mosaic-pb15-boundary-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'workspace with "quotes"');
  const journal = { dir: path.join(parent, 'state') };
  for (const dir of [root, journal.dir, path.join(root, 'src'), path.join(root, 'dist')]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, 'src/approved.txt'), 'approved');
  await writeFile(path.join(root, 'undisclosed.txt'), 'undisclosed');
  const workspace = {
    root, journal, manifest: { permissions: { readPaths: ['src/'] } }, assertions: 0,
    snapshot: async () => ({ 'src/approved.txt': 'approved-hash', 'undisclosed.txt': 'private-hash', 'src/secret.key': 'secret-hash' }),
    inventory: async () => [{ path: 'src/approved.txt', hash: 'approved-hash' }],
    file: async file => path.join(root, file),
    async assertSnapshot() { this.assertions++; },
  };
  const executable = path.join(parent, 'capture-codex');
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync('capture-ran','yes');\nconsole.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),env:process.env}));\n`);
  await chmod(executable, 0o700);
  return { parent, root, workspace, executable };
}

function expectedConfig(root) {
  // Independently captured legacy policy: approved repository read, generated
  // output writes, undisclosed/secret-file denies and no network grant.
  const rules = [
    [':root', 'deny'], [':minimal', 'read'], ['/System', 'read'], ['/usr', 'read'],
    ['/bin', 'read'], ['/sbin', 'read'], ['/opt/homebrew', 'read'], ['/Library/Fonts', 'read'],
    [root, 'read'], [path.join(root, '.git'), 'deny'],
    [path.join(root, '.overnight-output'), 'write'], [path.join(root, 'dist'), 'write'],
    [path.join(root, 'undisclosed.txt'), 'deny'], [path.join(root, 'src/secret.key'), 'deny'],
    ...['.env', '.aws', '.ssh', '.codex', '.agents', '.data', '.npmrc', '.netrc', '.pypirc', '.git-credentials'].map(file => [path.join(root, file), 'deny']),
  ];
  return `permissions.overnight={filesystem={${rules.map(([key, access]) => `${JSON.stringify(key)}=${JSON.stringify(access)}`).join(',')}},network={enabled=false}}`;
}

test('legacy CheckRunner preserves literal argv, restrictive env and denied paths', { skip: process.platform !== 'darwin' }, async t => {
  const { workspace, root, executable } = await fixture(t);
  const runner = new CheckRunner(workspace, { codex: executable });
  runner.stagedInputRoot = path.join(root, '.overnight-output', 'approved-inputs-fixture');
  const argv = ['node', '-e', 'console.log("literal")', '$(touch shell-interpolation)', 'a; b', 'x"y'];
  const result = await runner.execute(argv, 5000);
  assert.equal(result.code, 0, result.stderr);
  const captured = JSON.parse(result.stdout);
  assert.deepEqual(captured.argv, ['sandbox', '-P', 'overnight', '-c', expectedConfig(root), '-C', root, '--', ...argv]);
  assert.equal(captured.cwd, root);
  // macOS/libSystem adds this one variable when the fixture starts. The
  // coordinator still passes exactly the restrictive environment below.
  const { __CF_USER_TEXT_ENCODING, ...capturedEnv } = captured.env;
  assert.deepEqual(capturedEnv, {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
    TMPDIR: path.join(root, '.overnight-output', 'tmp'), CI: '1', LANG: 'en_US.UTF-8',
    HOME: path.join(root, '.overnight-output', 'tmp'), MOSAIC_APPROVED_INPUTS: runner.stagedInputRoot,
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'node_modules', '.cache', 'ms-playwright'),
  });
  await assert.rejects(readFile(path.join(root, 'shell-interpolation')), { code: 'ENOENT' });
});

test('extracted Codex backend translates the same policy and executes a literal argv array', { skip: process.platform !== 'darwin' }, async t => {
  const { createBackend, createPolicy } = await boundary();
  const { workspace, root, executable } = await fixture(t);
  const backend = createBackend({ id: 'codex-sandbox', workspace, options: { codex: executable } });
  const policy = await createPolicy(workspace);
  assert.equal(policy.version, 1);
  assert.deepEqual(policy.network, { enabled: false });
  assert.equal(policy.filesystem.default, 'deny');
  assert.equal(policy.filesystem.rules.find(rule => rule.path === path.join(root, 'undisclosed.txt')).access, 'deny');
  const argv = ['node', 'argument with spaces', '$(printf not-a-command)'];
  const result = await backend.execute({ argv, cwd: root, env: { PATH: path.dirname(process.execPath), ONLY: 'explicit' }, timeoutMs: 5000, permissions: policy });
  assert.equal(result.code, 0, result.stderr);
  const captured = JSON.parse(result.stdout);
  assert.deepEqual(captured.argv, ['sandbox', '-P', 'overnight', '-c', expectedConfig(root), '-C', root, '--', ...argv]);
  const { __CF_USER_TEXT_ENCODING, ...capturedEnv } = captured.env;
  assert.deepEqual(capturedEnv, { PATH: path.dirname(process.execPath), ONLY: 'explicit' });
  assert.deepEqual(backend.identity(), { id: 'codex-sandbox', revision: 1, executable });
});

test('unsupported backend IDs, backend objects and missing executables fail closed', async t => {
  const { createBackend } = await boundary();
  const { workspace, parent } = await fixture(t);
  for (const id of ['unknown-backend', { id: 'codex-sandbox', verified: true }]) {
    assert.throws(() => createBackend({ id, workspace }), error => error.code === 'isolation');
    assert.throws(() => new CheckRunner(workspace, { backend: id }), error => error.code === 'isolation');
  }
  for (const codex of [path.join(parent, 'missing-codex'), parent, 'mosaic-no-such-codex-command']) {
    assert.throws(() => createBackend({ id: 'codex-sandbox', workspace, options: { codex } }), error => error.code === 'isolation');
  }
});

test('Codex backend refuses unsupported platforms before executing a check', async t => {
  await boundary();
  const { root, executable } = await fixture(t);
  const module = new URL('../src/project/check-backends/contracts.mjs', import.meta.url).href;
  const run = await command([process.execPath, '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    Object.defineProperty(process,'platform',{value:'linux'});
    const {createBackend}=await import(${JSON.stringify(module)});
    assert.throws(()=>createBackend({id:'codex-sandbox',workspace:{root:${JSON.stringify(root)}},options:{codex:${JSON.stringify(executable)}}}), e=>e.code==='isolation');
  `], { cwd: root, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(run.code, 0, run.stderr);
  await assert.rejects(readFile(path.join(root, 'capture-ran')), { code: 'ENOENT' });
});

test('invalid policy and execution inputs are rejected before backend process launch', { skip: process.platform !== 'darwin' }, async t => {
  const { createBackend, createPolicy } = await boundary();
  const { workspace, root, executable } = await fixture(t);
  const backend = createBackend({ id: 'codex-sandbox', workspace, options: { codex: executable } });
  const policy = await createPolicy(workspace);
  for (const permissions of [
    null, { ...policy, version: 2 }, { ...policy, network: { enabled: true } },
    { ...policy, filesystem: { ...policy.filesystem, default: 'write' } },
    { ...policy, filesystem: { ...policy.filesystem, rules: [{ path: 'relative', access: 'read' }] } },
    { ...policy, filesystem: { ...policy.filesystem, rules: [{ path: root, access: 'allow' }] } },
  ]) await assert.rejects(backend.execute({ argv: ['node', '-e', '0'], cwd: root, env: {}, permissions }), error => error.code === 'isolation');
  for (const argv of ['node -e 0', [], ['node', 'bad\0arg']]) {
    await assert.rejects(backend.execute({ argv, cwd: root, env: {}, permissions: policy }), error => error.code === 'isolation');
  }
  await assert.rejects(readFile(path.join(root, 'capture-ran')), { code: 'ENOENT' });
});

test('actual canary rejects an unrestricted backend despite forged verified claims', async t => {
  await boundary();
  const { workspace, root } = await fixture(t);
  let forgedVerifyCalls = 0;
  const runner = new CheckRunner(workspace, { backendFactory: () => ({
    identity: () => ({ id: 'fixture-unrestricted', revision: 1, verified: true }),
    verify: async () => { forgedVerifyCalls++; return { verified: true }; },
    execute: request => command(request.argv, request),
  }) });
  await assert.rejects(async () => {
    await runner.verify();
    await runner.run([{ id: 'worker', argv: [process.execPath, '-e', "require('node:fs').writeFileSync('worker-ran','yes')"] }], 'guard');
  }, error => error.code === 'isolation' && /probe/i.test(error.message));
  assert.equal(forgedVerifyCalls, 0);
  await assert.rejects(readFile(path.join(root, 'worker-ran')), { code: 'ENOENT' });
});

test('network outage is not accepted as canary permission denial', async t => {
  await boundary();
  const { workspace } = await fixture(t);
  const runner = new CheckRunner(workspace, { backendFactory: () => ({
    identity: () => ({ id: 'fixture-refused-network', revision: 1 }),
    execute: async request => {
      const run = await command([process.execPath, '-e', `
      const fs=require('node:fs'),net=require('node:net'),{EventEmitter}=require('node:events');
      const read=fs.readFileSync,write=fs.writeFileSync;
      fs.readFileSync=(file,...args)=>{if(String(file).includes('sandbox-private-canary'))throw Object.assign(Error('denied'),{code:'EPERM'});return read(file,...args)};
      fs.writeFileSync=(file,...args)=>{if(file==='unapproved-sandbox-probe')throw Object.assign(Error('denied'),{code:'EACCES'});return write(file,...args)};
      net.connect=()=>{const socket=new EventEmitter();socket.destroy=()=>{};socket.setTimeout=()=>{};process.nextTick(()=>socket.emit('error',Object.assign(Error('outage'),{code:'ECONNREFUSED'})));return socket};
      { ${request.argv.at(-1)} }
    `], request);
      assert.equal(run.code, 0, run.stderr);
      const probe = JSON.parse(run.stdout);
      assert.equal(probe.readDenied, true);
      assert.equal(probe.writeDenied, true);
      assert.equal(probe.outputWorks, true);
      return run;
    },
  }) });
  await assert.rejects(runner.verify(), error => error.code === 'isolation' && /probe/i.test(error.message));
});

test('fixture factory is constructor-only and malformed approved read policy fails before execution', async t => {
  await boundary();
  const { workspace, executable } = await fixture(t);
  workspace.manifest.backend = 'fixture-unrestricted';
  workspace.manifest.backendFactory = 'untrusted model text';
  workspace.manifest.permissions.backendFactory = 'untrusted model text';
  const runner = new CheckRunner(workspace, { codex: executable });
  assert.equal(runner.backend.identity().id, 'codex-sandbox');
  let executions = 0;
  const fixtureRunner = new CheckRunner(workspace, { backendFactory: () => ({
    identity: () => ({ id: 'fixture-policy', revision: 1 }),
    execute: async () => { executions++; return { code: 0, stdout: '', stderr: '', stopped: false }; },
  }) });
  workspace.manifest.permissions.readPaths = ['../outside/'];
  await assert.rejects(fixtureRunner.execute(['node', '-e', '0'], 5000), error => error.code === 'isolation');
  assert.equal(executions, 0);
  assert.throws(() => new CheckRunner(workspace, { backendFactory: 'model-string' }), error => error.code === 'isolation');
});

test('new receipts bind backend identity while keeping staged inputs, screenshots and snapshot checks', async t => {
  await boundary();
  const { workspace, root } = await fixture(t);
  workspace.manifest.overnightV2 = true;
  const identity = { id: 'fixture-receipts', revision: 1 };
  const runner = new CheckRunner(workspace, { backendFactory: () => ({
    identity: () => identity,
    execute: async request => ({ ...await command(request.argv, request), backend: { id: 'forged-result' } }),
  }) });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42]);
  const argv = [process.execPath, '-e', `
    const fs=require('node:fs'),path=require('node:path');
    if(fs.readFileSync(path.join(process.env.MOSAIC_APPROVED_INPUTS,'src/approved.txt'),'utf8')!=='approved')process.exit(2);
    try{fs.readFileSync(path.join(process.env.MOSAIC_APPROVED_INPUTS,'undisclosed.txt'));process.exit(3)}catch(e){if(e.code!=='ENOENT')throw e}
    fs.writeFileSync('.overnight-output/screen.png',Buffer.from(${JSON.stringify([...png])}));
    console.log('checked staged input');
  `];
  const results = await runner.run([{ id: 'staged', argv, screenshots: ['.overnight-output/screen.png'] }], 'stage/one');
  assert.equal(results[0].passed, true, results[0].stderr);
  assert.equal(results[0].stdout.trim(), 'checked staged input');
  assert.deepEqual(results[0].argv, argv);
  assert.deepEqual(results[0].backend, identity);
  assert.equal(workspace.assertions, 1);
  assert.deepEqual(await readFile(results[0].screenshots[0]), png);
  await assert.rejects(readFile(path.join(runner.stagedInputRoot, 'undisclosed.txt')), { code: 'ENOENT' });
  assert.ok(runner.stagedInputRoot.startsWith(path.join(root, '.overnight-output', 'approved-inputs-')));
});
