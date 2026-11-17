import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const runner = fileURLToPath(new URL('../scripts/test-source.mjs', import.meta.url));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(MOSAIC_(REQUIRE_|NATIVE_|INSTALLED_|FEASIBILITY_|THREE_WORKER_)|PLAYWRIGHT_BROWSERS_PATH)/.test(key)));
async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'source runner with spaces '));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), {recursive: true});
    await writeFile(path.join(root, name), bytes);
  }
  return root;
}
function start(cwd, args = [], env = cleanEnv()) {
  const child = spawn(process.execPath, [runner, ...args], {cwd, env, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => {stdout += chunk;});
  child.stderr.on('data', chunk => {stderr += chunk;});
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal, stdout, stderr}));
  });
  return {child, done};
}
const run = (cwd, args = [], env) => start(cwd, args, env).done;
const passing = "import test from 'node:test'; test('two words',()=>{});\n";

test('listing includes both intended roots and new spaced entries, excluding nested fixtures and helpers', {timeout: 15000}, async t => {
  const root = await fixture(t, {
    'test/z.test.mjs': passing,
    'test/project/a space.test.mjs': passing,
    'test/fixtures/trap.test.mjs': 'throw Error("fixture driver selected");',
    'test/project/fixtures/trap.test.mjs': 'throw Error("project fixture selected");',
    'test/helper.mjs': 'throw Error("helper selected");',
    'test/root-driver.mjs': 'throw Error("root driver selected");',
    'test/beta-setup.test.mjs': 'throw Error("Darwin test selected");',
    'test/mosaic-validation-browser.test.mjs': 'throw Error("browser selected");',
    'test/mosaic-m027-installed.test.mjs': 'throw Error("installed selected");',
    'test/mosaic-pb13-composition.test.mjs': 'throw Error("indirect real sandbox selected");'
  });
  await symlink(path.join(root, 'test/z.test.mjs'), path.join(root, 'test/link.test.mjs'));
  const listed = await run(root, ['portable', '--list']);
  assert.equal(listed.code, 0, listed.stderr);
  const selection = JSON.parse(listed.stdout);
  assert.deepEqual(selection.selected, ['test/project/a space.test.mjs', 'test/z.test.mjs']);
  assert.equal(selection.excluded.length, 4);
  for (const item of selection.excluded) assert.ok(item.reason.length > 10);
  const executed = await run(root, ['portable']);
  assert.equal(executed.code, 0, executed.stderr + executed.stdout);
  assert.match(executed.stdout, /# tests 2\b/);
  const required = JSON.parse((await run(root, ['darwin-required', '--list'])).stdout);
  assert.equal(required.selected.length, 6);
  assert.deepEqual(required.excluded, []);
});

test('inherited Node options cannot silently filter either profile', {timeout: 15000}, async t => {
  const root = await fixture(t, {'test/fail.test.mjs': "import test from 'node:test';test('must execute',()=>{throw Error('sentinel');});"});
  for (const profile of ['portable', 'darwin-required']) {
    for (const options of ['--test-name-pattern=^no-such-test$', '--test-skip-pattern=.', '--test-only']) {
      const result = await run(root, [profile], {...cleanEnv(), NODE_OPTIONS: options});
      assert.equal(result.code, 2, JSON.stringify({profile, options, ...result}));
      assert.match(result.stderr, /NODE_OPTIONS/);
      assert.doesNotMatch(result.stdout, /# pass/);
    }
  }
});

test('symlinked test roots cannot turn fixture drivers into entries', {timeout: 15000}, async t => {
  for (const [link, target] of [['test', 'drivers'], ['test/project', 'fixtures']]) {
    const file = link === 'test' ? 'drivers/trap.test.mjs' : 'test/fixtures/trap.test.mjs';
    const root = await fixture(t, {[file]: "import {writeFileSync} from 'node:fs';writeFileSync('executed','bad');"});
    await symlink(target, path.join(root, link));
    for (const args of [['portable', '--list'], ['portable']]) {
      const result = await run(root, args);
      assert.equal(result.code, 2, JSON.stringify({link, ...result}));
      assert.match(result.stderr, /real directory/);
    }
    await assert.rejects(readFile(path.join(root, 'executed')), {code: 'ENOENT'});
  }
});

test('literal spaced pattern reaches the child as one argument', {timeout: 15000}, async t => {
  const root = await fixture(t, {'test/a space.test.mjs': passing + "test('must not run',()=>{throw Error('pattern lost');});\n"});
  const result = await run(root, ['portable', '--test-name-pattern', 'two words']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /pattern lost/);
  assert.match(result.stdout, /two words/);
});

test('invalid profiles, options, missing values and qualification filters fail before executing a test', {timeout: 15000}, async t => {
  const root = await fixture(t, {'test/marker.test.mjs': "import {writeFileSync} from 'node:fs';writeFileSync('executed','bad');"});
  for (const args of [['unknown'], ['portable', '--wat'], ['portable', '--test-name-pattern'],
    ['portable', '--list', '--list'], ['portable', 'test/fixtures/trap.mjs'],
    ['darwin-required', '--test-name-pattern', 'omit gates'], ['portable', '--test-name-pattern', '[']]) {
    const result = await run(root, args);
    assert.equal(result.code, 2, JSON.stringify({args, ...result}));
    assert.match(result.stderr, /source-checks:/);
  }
  await assert.rejects(readFile(path.join(root, 'executed')), {code: 'ENOENT'});
});

test('a failing child fails the command rather than reporting source success', {timeout: 15000}, async t => {
  const root = await fixture(t, {'test/fail.test.mjs': "import test from 'node:test';test('failure is retained',()=>{throw Error('original child failure');});"});
  const result = await run(root, ['portable']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /original child failure/);
  assert.match(result.stdout, /# fail 1\b/);
});

test('empty profiles fail instead of launching Node broad discovery', {timeout: 15000}, async t => {
  const root = await fixture(t, {'test/fixtures/trap.test.mjs': "throw Error('broad discovery');"});
  const result = await run(root, ['portable']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /No test entries/);
  assert.doesNotMatch(result.stdout, /broad discovery/);
});

test('portable rejects inherited qualification inputs before any test can activate them', {timeout: 15000}, async t => {
  const root = await fixture(t, {'test/good.test.mjs': passing});
  for (const key of ['MOSAIC_REQUIRE_NATIVE', 'MOSAIC_REQUIRE_BROWSER', 'MOSAIC_REQUIRE_INSTALLED',
    'MOSAIC_NATIVE_TEST_NODE', 'MOSAIC_INSTALLED_ARCHIVE', 'MOSAIC_THREE_WORKER_NATIVE_MANIFEST']) {
    const result = await run(root, ['portable'], {...cleanEnv(), [key]: key.includes('REQUIRE') ? '1' : '/absent'});
    assert.equal(result.code, 2, key + result.stderr);
    assert.match(result.stderr, new RegExp(key));
  }
});

test('required profile fails closed with native, browser, installed and N1/W1 prerequisites missing', {timeout: 15000}, async t => {
  const root = await fixture(t, {'test/good.test.mjs': passing});
  const result = await run(root, ['darwin-required'], {...cleanEnv(), PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'absent browsers')});
  assert.equal(result.code, 2, result.stdout + result.stderr);
  for (const label of ['MOSAIC_NATIVE_TEST_NODE', 'Chromium', 'MOSAIC_INSTALLED_ARCHIVE',
    'MOSAIC_INSTALLED_UPDATE_ARCHIVE', 'MOSAIC_INSTALLED_DEMO_ARCHIVE',
    'MOSAIC_NATIVE_ARTIFACT_MANIFEST', 'MOSAIC_NATIVE_ARTIFACT_SHA256',
    'MOSAIC_FEASIBILITY_TEST_PARENT', 'MOSAIC_THREE_WORKER_NATIVE_MANIFEST',
    'MOSAIC_THREE_WORKER_NATIVE_SHA256', 'MOSAIC_THREE_WORKER_TEST_PARENT']) assert.ok(result.stderr.includes(label), label);
  assert.doesNotMatch(result.stdout, /# pass/);
  assert.equal((await run(root, ['darwin-required', '--list'])).code, 0);
});

test('SIGTERM cancellation remains a signal and stops the test subprocess', {timeout: 15000}, async t => {
  const root = await fixture(t, {'test/wait.test.mjs': "import test from 'node:test';import {writeFileSync} from 'node:fs';test('wait',async()=>{writeFileSync('started',String(process.pid));await new Promise(()=>{});});"});
  // Keep an active handle so the pending test does not cancel itself.
  await writeFile(path.join(root, 'test/wait.test.mjs'), (await readFile(path.join(root, 'test/wait.test.mjs'), 'utf8')) + 'setInterval(()=>{},1000);');
  const {child, done} = start(root, ['portable']);
  t.after(() => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');});
  let pid;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {pid = Number(await readFile(path.join(root, 'started'), 'utf8')); break;} catch {await delay(30);}
  }
  assert.ok(pid, 'test subprocess started');
  t.after(() => {try {process.kill(pid, 'SIGKILL');} catch {}});
  child.kill('SIGTERM');
  const result = await done;
  assert.equal(result.code, null, result.stderr);
  assert.equal(result.signal, 'SIGTERM');
  let alive = true;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {process.kill(pid, 0); await delay(20);} catch {alive = false; break;}
  }
  assert.equal(alive, false, 'cancelled test subprocess must stop');
});
