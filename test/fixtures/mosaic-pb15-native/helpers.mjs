import assert from 'node:assert/strict';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { command } from '../../../src/project/process.mjs';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function nativeApi() {
  const api = await import('../../../src/project/check-backends/darwin-seatbelt.mjs').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return {};
  });
  assert.equal(typeof api.compileDarwinSeatbeltPolicy, 'function', 'native compiler must exist');
  return api;
}
export async function canonical(file) { return { path: file, realPath: await realpath(file) }; }
export async function input(root, file) {
  const absolute = path.join(root, file), stat = await lstat(absolute);
  return { path: file, realPath: await realpath(absolute), hash: hash(await readFile(absolute)), mode: stat.mode & 0o100 ? '100755' : '100644' };
}
export async function fixture(t) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mosaic-pb15-native-')));
  const ownedPids = new Set();
  t.after(async () => {
    for (const pid of ownedPids) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(parent, { recursive: true, force: true });
  });
  const root = path.join(parent, 'workspace "double" and \'single\'');
  for (const dir of ['src', 'checks', 'dist', '.overnight-output/tmp', '.git', 'nested', 'node_modules']) await mkdir(path.join(root, dir), { recursive: true });
  const files = { 'package.json': '{"type":"module","private":true}', 'src/source.txt': 'approved-source', 'checks/check.mjs': 'console.log("approved check")', '.env': 'dummy-env', '.git/config': 'dummy-git', 'undisclosed.txt': 'undisclosed', 'nested/.env.local': 'dummy-nested-env', 'nested/ignored.txt': 'ignored-secret' };
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
  const external = path.join(parent, 'dummy-home'); await mkdir(external); await writeFile(path.join(external, 'canary'), 'dummy-home-canary');
  const readPaths = ['package.json', 'src/', 'checks/'];
  const inventory = await Promise.all(['package.json', 'src/source.txt', 'checks/check.mjs'].map(file => input(root, file)));
  const permissions = { version: 1, filesystem: { default: 'deny', minimal: 'read', rules: [
    { path: root, access: 'read' }, { path: path.join(root, '.git'), access: 'deny' },
    { path: path.join(root, 'dist'), access: 'write' }, { path: path.join(root, '.overnight-output'), access: 'write' },
    { path: path.join(root, 'undisclosed.txt'), access: 'deny' },
  ] }, network: { enabled: false } };
  const spec = { workspace: await canonical(root), permissions, readPaths, inventory,
    dependencies: [await canonical(path.join(root, 'node_modules'))],
    outputs: await Promise.all(['dist', '.overnight-output'].map(file => canonical(path.join(root, file)))),
    executable: await canonical(process.execPath), stagedInputs: [], deniedPaths: [] };
  return { parent, root, external, spec, ownedPids };
}
export function environment(root) {
  return { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(root, '.overnight-output/tmp'), TMPDIR: path.join(root, '.overnight-output/tmp'), LANG: 'en_US.UTF-8', CI: '1', PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'node_modules/.cache/ms-playwright') };
}
// Diagnostic executor belongs to owned tests, never the production backend.
export async function executeProfile(compiled, root, argv, options = {}) {
  const dir = await mkdtemp(path.join(path.dirname(root), 'profile-'));
  const profile = path.join(dir, 'owned.sb');
  try {
    await writeFile(profile, compiled.profile, { mode: 0o600 });
    return await command(['/usr/bin/sandbox-exec', '-f', profile, ...argv], { cwd: root, env: environment(root), timeoutMs: 20000, ...options });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export async function copyBrowser(root) {
  const dependencies = new URL('../../../node_modules/', import.meta.url);
  for (const name of ['playwright', 'playwright-core', '.cache/ms-playwright']) await cp(new URL(name, dependencies), path.join(root, 'node_modules', name), { recursive: true });
}
export async function stage(spec, root) {
  const staged = path.join(root, '.overnight-output/approved-inputs-fixture');
  await mkdir(staged);
  for (const file of spec.inventory) {
    await mkdir(path.dirname(path.join(staged, file.path)), { recursive: true });
    await cp(path.join(root, file.path), path.join(staged, file.path));
    await chmod(path.join(staged, file.path), file.mode === '100755' ? 0o755 : 0o644);
  }
  spec.stagedInputs = [{ root: await canonical(staged), inventory: await Promise.all(spec.inventory.map(file => input(staged, file.path))) }];
  return staged;
}
export async function eventually(read, timeout = 3000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    try { return await read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Owned child did not become ready');
}
