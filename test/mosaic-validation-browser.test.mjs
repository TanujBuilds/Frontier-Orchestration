import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Journal } from '../src/project/journal.mjs';
import { git } from '../src/project/process.mjs';
import { CheckRunner } from '../src/project/sandbox.mjs';
import { Workspace } from '../src/project/workspace.mjs';

const fixture = fileURLToPath(new URL('./fixtures/mosaic-validation/', import.meta.url));
const dependencies = fileURLToPath(new URL('../node_modules/', import.meta.url));
const browserCache = '.cache/ms-playwright';
const downloadCheck = 'checks/download.mjs';
const workerFile = 'src/export.mjs';

function unavailable(t, reason) {
  if (process.env.MOSAIC_REQUIRE_BROWSER === '1') assert.fail(reason);
  t.skip(reason);
}

test('protected browser check detects wrong CSV rows despite passing build and unit checks', { timeout: 120000 }, async t => {
  if (process.platform !== 'darwin') return unavailable(t, 'The production CheckRunner sandbox requires macOS');
  if (!existsSync(path.join(dependencies, browserCache))) {
    return unavailable(t, 'Pinned Chromium cache missing; prepare node_modules/.cache/ms-playwright');
  }

  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mosaic-csv-validation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'source');
  await cp(fixture, repo, { recursive: true });
  await git(repo, 'init', '-q');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'user.name=Mosaic Test', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');

  const prepared = path.join(repo, 'node_modules');
  await mkdir(prepared);
  for (const dependency of ['playwright', 'playwright-core', browserCache]) {
    await cp(path.join(dependencies, dependency), path.join(prepared, dependency), { recursive: true });
  }
  const checks = [
    { id: 'build', argv: [process.execPath, 'checks/build.mjs'], timeoutMs: 10000 },
    { id: 'unit', argv: [process.execPath, 'checks/unit.mjs'], timeoutMs: 10000 },
    { id: 'download', argv: [process.execPath, downloadCheck], timeoutMs: 25000 },
  ];
  const permissions = { readPaths: ['src/', 'checks/'], writePaths: ['src/'], checks };
  const journal = await new Journal(path.join(root, 'state'), randomUUID()).load();
  const workspace = new Workspace({ repo, baseCommit: await git(repo, 'rev-parse', 'HEAD'), permissions }, journal);
  await workspace.initialize();
  let runner;
  try {
    runner = new CheckRunner(workspace);
  } catch (error) {
    if (error.code !== 'isolation') throw error;
    return unavailable(t, error.message);
  }
  const sandbox = await runner.verify();
  assert.equal(sandbox.networkDenied, true);

  const protectedCheck = await workspace.content(downloadCheck);
  await assert.rejects(workspace.apply('tamper', permissions, [
    { path: downloadCheck, action: 'write', baseHash: protectedCheck.hash, content: 'process.exit(0);' },
  ]), /outside approved scope/);

  const correct = await workspace.content(workerFile);
  const incorrect = correct.content.replace('tbody input:checked', 'tbody input');
  await workspace.apply('regression', permissions, [
    { path: workerFile, action: 'write', baseHash: correct.hash, content: incorrect },
  ]);
  const bad = await runner.run(checks, 'before-fix');
  const failedDownload = bad.find(check => check.id === 'download');
  if (/Executable doesn.t exist/.test(failedDownload.stderr)) {
    return unavailable(t, 'Pinned Chromium executable is missing from the prepared cache');
  }
  assert.deepEqual(bad.map(({ id, code, passed }) => ({ id, code, passed })), [
    { id: 'build', code: 0, passed: true },
    { id: 'unit', code: 0, passed: true },
    { id: 'download', code: 1, passed: false },
  ], failedDownload.stderr);
  assert.match(failedDownload.stderr, /downloads selected rows only/);
  t.diagnostic('Before fix: build=0, unit=0, download=1 (download includes unselected rows)');

  const broken = await workspace.content(workerFile);
  await workspace.apply('correction', permissions, [
    { path: workerFile, action: 'write', baseHash: broken.hash, content: correct.content },
  ]);
  const good = await runner.run(checks, 'after-fix');
  assert.deepEqual(good.map(({ id, code, passed }) => ({ id, code, passed })), [
    { id: 'build', code: 0, passed: true },
    { id: 'unit', code: 0, passed: true },
    { id: 'download', code: 0, passed: true },
  ], good.find(check => check.id === 'download').stderr);
  assert.equal((await workspace.content(downloadCheck)).hash, protectedCheck.hash);
  t.diagnostic(`After fix: build=0, unit=0, download=0. ${good.at(-1).stdout.trim()}`);
  t.diagnostic(`Unchanged protected download check sha256=${protectedCheck.hash}`);
});
