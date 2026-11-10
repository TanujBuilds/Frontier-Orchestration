import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startApi} from '../src/harness/api.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {command} from '../src/project/process.mjs';

const cli = fileURLToPath(new URL('../scripts/mosaic-workflow-recipes.mjs', import.meta.url));
const run = (...args) => command([process.execPath, cli, ...args]);
function json(result) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-recipes-cli-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

test('recipe list and inspect read built-ins through the authenticated coordinator', async t => {
  const root = await temp(t);
  const c = new Coordinator({root});
  const config = {environment: 'fixture'};
  const worker = new Worker({c, config, provider: {
    complete() { throw Error('A read-only command must never call a provider'); }
  }});
  const dispatcher = new Dispatcher({c, worker, config});
  const token = 'fixture-token-'.repeat(4);
  const api = await startApi({dispatcher, token, headless: true});
  try {
    const connectionFile = path.join(root, 'connection.json');
    await writeFile(connectionFile, JSON.stringify({url: api.url, token}), {mode: 0o600});
    const recipes = json(await run('list', '--root', root));
    assert.deepEqual(recipes.map(recipe => recipe.id).sort(), ['bugfix', 'feature', 'research-comparison']);
    const inspect = json(await run('inspect', '--root', root, '--id', 'bugfix', '--version', '1'));
    assert.equal(inspect.definitionDigest, recipes.find(recipe => recipe.id === 'bugfix').definitionDigest);
    assert.deepEqual(inspect.definition.tasks.map(task => task.kind), ['coding']);
    await writeFile(connectionFile, JSON.stringify({url: api.url, token: 'wrong-token-'.repeat(4)}));
    const denied = await run('list', '--root', root);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /Authentication required/);
  } finally {
    await api.close();
    worker.overnight.close();
    c.close();
  }
});

test('recipe CLI rejects an existing demo directory and preserves its contents', async t => {
  const root = await temp(t);
  const output = path.join(root, 'existing');
  await mkdir(output);
  await writeFile(path.join(output, 'keep.txt'), 'owned by caller');
  const result = await run('demo', '--output', output);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already exists/);
  assert.equal(await readFile(path.join(output, 'keep.txt'), 'utf8'), 'owned by caller');
  assert.deepEqual(await readdir(output), ['keep.txt']);
});

test('recipe demo refuses Git environment overrides that can redirect fixture writes', async t => {
  const root = await temp(t);
  const result = await command([process.execPath, cli, 'demo', '--output', path.join(root, 'evidence')], {
    env: {...process.env, GIT_DIR: path.join(root, 'redirected.git')}
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Git repository override.*GIT_DIR/);
  assert.deepEqual(await readdir(root), []);
});

test('recipe CLI requires an explicit coordinator root and rejects ambiguous submission keys', async t => {
  const root = await temp(t);
  const input = path.join(root, 'input.json');
  await writeFile(input, JSON.stringify({idempotencyKey: 'from-file'}));
  const implicit = await run('list');
  assert.equal(implicit.code, 1);
  assert.match(implicit.stderr, /--root/);
  const ambiguous = await run('submit', '--root', root, '--input', input, '--idempotency-key', 'from-flag');
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /idempotency key.*--idempotency-key/i);
});

test('public recipe demo saves exact preview, checked integration, stale rejection and parked research', async t => {
  const root = await temp(t);
  const output = path.join(root, 'evidence');
  const result = json(await run('demo', '--output', output));
  assert.deepEqual(await readdir(output), ['demo.json']);
  const evidence = JSON.parse(await readFile(path.join(output, 'demo.json'), 'utf8'));
  assert.equal(result.evidence, path.join(output, 'demo.json'));
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.environment, 'fixture');
  assert.equal(evidence.coding.preview.launchable, true);
  assert.equal(evidence.coding.preview.previewDigest, evidence.coding.receipt.previewDigest);
  assert.equal(evidence.coding.preview.definitionDigest, evidence.coding.receipt.definitionDigest);
  assert.equal(evidence.coding.preview.parameterDigest, evidence.coding.receipt.parameterDigest);
  assert.deepEqual(evidence.coding.receipt.tasks, [evidence.coding.task.id]);
  assert.equal(evidence.coding.task.spec.objective, 'Return 42 from the answer module');
  assert.deepEqual(evidence.coding.task.spec.permissions, {
    readPaths: ['src/answer.mjs', 'checks/verify.mjs'],
    writePaths: ['src/answer.mjs'],
    checks: ['verify']
  });
  assert.equal(evidence.coding.task.status, 'accepted');
  assert.deepEqual(evidence.coding.task.checks, [{id: 'verify', passed: true}]);
  assert.deepEqual(evidence.coding.task.integratedChecks, [{id: 'verify', passed: true}]);
  assert.equal(evidence.coding.replayId, evidence.coding.receipt.id);
  assert.equal(evidence.stale.taskCountBefore, 0);
  assert.equal(evidence.stale.taskCountAfter, 0);
  assert.match(evidence.stale.error, /parameter|preview/i);
  assert.equal(evidence.research.validTemplate, true);
  assert.equal(evidence.research.launchable, false);
  assert.deepEqual(evidence.research.resolvedDefinition.tasks.map(task => task.kind), ['research']);
  assert.match(JSON.stringify(evidence.research.diagnostics), /parked|gate/i);
});
