import assert from 'node:assert/strict';
import { chmod, link, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { capture, fixture, legacyConfig } from './fixtures/mosaic-codex-policy-compaction/child.mjs';
import { createPolicy } from '../src/project/check-backends/contracts.mjs';

async function owned(t, options) {
  const f = await fixture(options);
  t.after(() => rm(f.parent, { recursive: true, force: true }));
  return f;
}

// This models the pinned permission frontend separately from brace translation.
function frontendGlob(key) {
  return [...key].some(char => '*?[]'.includes(char));
}

function grouped(key) {
  const [, parent, alternatives, suffix] = /^(.*)\/\{([^{}]+)\}(\/\*\*)?$/.exec(key);
  const encoded = alternatives.split(',');
  const names = encoded.map(name => name.replace(/^\[([A-Za-z0-9._-])\]/, '$1'));
  assert.ok(names.length >= 2 && names.every(name => /^[A-Za-z0-9._-]+$/.test(name)));
  return { parent, names, encoded, subtree: Boolean(suffix) };
}

// Literal rules include descendants; grouped rules require both tagged forms.
function denied(entries, file) {
  return entries.some(([key, access]) => {
    if (access !== 'deny') return false;
    if (!frontendGlob(key)) return file === key || file.startsWith(`${key}/`);
    const { parent, names, subtree } = grouped(key);
    return names.some(name => subtree ? file.startsWith(`${parent}/${name}/`) : file === `${parent}/${name}`);
  });
}

// Construct the conservative regex string independently from emitted globs.
function modeledLiteralBytes(glob) {
  const { parent, encoded, subtree } = grouped(glob);
  const quote = literal => literal.replace(/[. -]/g, '\\$&');
  const alternatives = encoded.map(arm => arm.startsWith('[') ? arm.slice(0, 3) + quote(arm.slice(3)) : quote(arm));
  return Buffer.byteLength(`#"^${quote(parent)}/(${alternatives.join('|')})${subtree ? '/.*' : ''}$"`);
}

async function rejectsBeforeSpawn(f, permissions) {
  await assert.rejects(capture(f, permissions), error => error.code === 'isolation' && /compaction/.test(error.message));
  await assert.rejects(readFile(path.join(f.parent, 'capture-ran')), { code: 'ENOENT' });
}

test('large canonical snapshot uses bounded same-directory exact and subtree basename groups', async t => {
  const f = await fixture();
  t.after(() => rm(f.parent, { recursive: true, force: true }));
  const captured = await capture(f);
  const original = legacyConfig(captured.policy);
  assert.ok(Buffer.byteLength(original) > 32768);
  assert.ok(Buffer.byteLength(captured.config) < Buffer.byteLength(original));
  assert.ok(Buffer.byteLength(captured.config) <= 73728);
  assert.equal(new Map(captured.entries).get(f.root), 'read');
  const groups = captured.entries.filter(([key]) => key.includes('{'));
  assert.ok(groups.length > 0);
  assert.ok(groups.filter(([key]) => key.startsWith(path.join(f.root, 'denied/group-0/{')) && !key.endsWith('/**')).length > 1);
  for (const [key, access] of groups) {
    assert.equal(access, 'deny');
    const { parent, names, encoded, subtree } = grouped(key);
    assert.ok(frontendGlob(key), key);
    assert.ok(modeledLiteralBytes(key) <= 900, key);
    if (subtree) {
      assert.deepEqual(encoded, names);
    } else {
      assert.match(encoded[0], /^\[[A-Za-z0-9._-]\][A-Za-z0-9._-]*$/);
      assert.deepEqual(encoded.slice(1), names.slice(1));
      assert.equal(new Map(captured.entries).get(`${parent}/{${names.join(',')}}/**`), 'deny');
    }
  }
  assert.equal(captured.argv[6], f.root);
  assert.deepEqual(captured.argv.slice(8), captured.request.argv);
  assert.equal(captured.cwd, f.root);
  assert.equal(captured.env.ONLY, 'literal');
  assert.equal(new Map(captured.entries).get(path.join(f.root, '.git')), 'deny');
});

test('chunks include the 900-byte boundary and retain the last singleton literally', async t => {
  const f = await owned(t);
  const parent = path.join(f.root, 'boundary');
  await mkdir(parent);
  const prefix = Buffer.byteLength(parent.replace(/[. -]/g, '\\$&'));
  const lastLength = 900 - prefix - 11 - 2 - 500;
  const names = [`a${'x'.repeat(249)}`, `b${'x'.repeat(249)}`,
    `c${'x'.repeat(lastLength - 1)}`, 'd'];
  for (const name of names) await writeFile(path.join(parent, name), 'synthetic');
  const { entries } = await capture(f);
  const subtree = `${parent}/{${names.slice(0, 3).join(',')}}/**`;
  const sameGroup = entries.filter(([key]) => key.startsWith(`${parent}/{`));
  const exact = sameGroup.find(([key]) => !key.endsWith('/**'))[0];
  const rules = new Map(entries);
  assert.equal(modeledLiteralBytes(subtree), 900);
  assert.equal(modeledLiteralBytes(exact), 899);
  assert.deepEqual(grouped(exact).names, names.slice(0, 3));
  assert.equal(rules.get(exact), 'deny');
  assert.equal(rules.get(subtree), 'deny');
  assert.equal(rules.get(path.join(parent, names.at(-1))), 'deny');
});

test('pinned Codex frontend classifies identity-marked exact arms and preserves punctuation membership', async t => {
  const f = await owned(t);
  const parent = path.join(f.root, 'punctuation');
  await mkdir(parent);
  const names = ['--', '.dot-only', '_under'];
  for (const name of names) await writeFile(path.join(parent, name), 'synthetic');
  const { entries } = await capture(f);
  const exact = entries.find(([key]) => key.startsWith(`${parent}/{`) && !key.endsWith('/**'))[0];
  const descendant = entries.find(([key]) => key.startsWith(`${parent}/{`) && key.endsWith('/**'))[0];
  const decoded = grouped(exact);
  assert.equal(frontendGlob(`${parent}/{${names.join(',')}}`), false);
  assert.equal(frontendGlob(exact), true, 'exact grouped denial must reach the pinned Codex glob compiler');
  assert.equal(frontendGlob(descendant), true);
  assert.deepEqual(decoded.names, names);
  assert.match(decoded.encoded[0], /^\[-\]-$/);
  for (const name of names) {
    assert.equal(denied(entries, path.join(parent, name)), true);
    assert.equal(denied(entries, path.join(parent, name, 'child')), true);
  }
  for (const name of ['-', '.dot', 'x-', '--suffix', 'nested/--', 'a_under']) {
    assert.equal(denied(entries, path.join(parent, name)), false);
  }
});

test('literal ASCII space is admitted only in canonical workspace root components', async t => {
  const f = await owned(t);
  const root = path.join(f.parent, 'space root');
  await rename(f.root, root);
  f.root = f.workspace.root = root;
  const { entries } = await capture(f);
  assert.equal(new Map(entries).get(root), 'read');
  assert.ok(entries.some(([key, access]) => key.startsWith(`${root}/denied/group-0/{`) && access === 'deny'));
  assert.ok(entries.filter(([key]) => key.includes('{')).every(([key]) => modeledLiteralBytes(key) <= 900));

  f.workspace.manifest.permissions.readPaths.push('approved/space name.txt');
  await rejectsBeforeSpawn(f);
  f.workspace.manifest.permissions.readPaths.pop();
  await writeFile(path.join(root, 'space name.txt'), 'synthetic');
  await rejectsBeforeSpawn(f);
});

for (const name of ['tab\troot', 'no-break\u00a0space', 'line\u2028separator', 'glob[root]']) {
  test(`unsupported root component ${JSON.stringify(name)} fails before spawn`, async t => {
    const f = await owned(t);
    const root = path.join(f.parent, name);
    await rename(f.root, root);
    f.root = f.workspace.root = root;
    await rejectsBeforeSpawn(f);
  });
}

test('a normalized alias of the same workspace fails before spawn', async t => {
  const f = await owned(t);
  f.root = f.workspace.root = `${f.root}/.`;
  await rejectsBeforeSpawn(f);
});

test('finite grouped membership preserves every original denial, subtree and near neighbor', async t => {
  const f = await owned(t);
  await writeFile(path.join(f.root, 'ignored-after-snapshot.txt'), 'synthetic ignored');
  const result = await capture(f);
  const original = [[':root', 'deny'], [':minimal', 'read'], ...result.policy.filesystem.rules.map(rule => [rule.path, rule.access])];
  const known = [...f.tracked, 'untracked-private.txt', 'ignored-after-snapshot.txt', 'absent-after-snapshot.txt'];
  for (const relative of known) {
    const file = path.join(f.root, relative);
    for (const candidate of [file, `${file}/child`, `${file}/child/deeper`, `${file}-nearby`]) {
      assert.equal(denied(result.entries, candidate), denied(original, candidate), candidate);
    }
  }
  const expanded = result.entries.filter(([key]) => key.includes('{') && !key.endsWith('/**'))
    .flatMap(([key]) => {
      const { parent, names } = grouped(key);
      return names.map(name => `${parent}/${name}`);
    });
  assert.equal(new Set(expanded).size, expanded.length);
  for (const [file, access] of original) if (access === 'deny') assert.equal(denied(result.entries, file), true, file);
  for (const [file, access] of result.entries.filter(([key]) => !key.includes('{'))) {
    assert.ok(original.some(([old, oldAccess]) => file === old && access === oldAccess), file);
  }
  assert.equal(denied(result.entries, path.join(f.root, 'untracked-private.txt')), true);
  assert.equal(denied(result.entries, path.join(f.root, 'ignored-after-snapshot.txt')), false);
  assert.equal(denied(result.entries, path.join(f.root, 'absent-after-snapshot.txt')), false);
});

test('small configurations through exactly 32768 bytes remain byte identical', async t => {
  const f = await owned(t, { count: 30 });
  const policy = await createPolicy(f.workspace);
  assert.ok(Buffer.byteLength(legacyConfig(policy)) < 32768);
  assert.equal((await capture(f, policy)).config, legacyConfig(policy));
  const boundary = structuredClone(policy);
  boundary.filesystem.rules.push({ path: '/pad', access: 'deny' });
  const padding = 32768 - Buffer.byteLength(legacyConfig(boundary));
  boundary.filesystem.rules.at(-1).path += 'x'.repeat(padding);
  assert.equal(Buffer.byteLength(legacyConfig(boundary)), 32768);
  assert.equal((await capture(f, boundary)).config, legacyConfig(boundary));
  boundary.filesystem.rules.at(-1).path += 'x';
  await rejectsBeforeSpawn(f, boundary);
});

test('canonical permissions are immutable and arbitrary large policy changes fail closed', async t => {
  const f = await owned(t);
  const policy = await createPolicy(f.workspace);
  const before = JSON.stringify(policy);
  await capture(f, policy);
  assert.equal(JSON.stringify(policy), before);
  for (const change of [
    p => p.filesystem.rules.push({ path: '/private', access: 'read' }),
    p => p.filesystem.rules.splice(10, 1),
    p => p.filesystem.rules.reverse(),
    p => p.filesystem.rules.find(rule => rule.path === f.root).access = 'deny',
    p => p.filesystem.rules.find(rule => rule.path.endsWith('/denied/token.key')).access = 'read',
  ]) {
    const changed = structuredClone(policy); change(changed);
    await rejectsBeforeSpawn(f, changed);
  }
});

test('stale snapshot content and incomplete workspace implementations fail before spawn', async t => {
  const f = await owned(t);
  const policy = await createPolicy(f.workspace);
  await writeFile(path.join(f.root, 'new-untracked.txt'), 'new');
  await rejectsBeforeSpawn(f, policy);
  const snapshot = f.workspace.snapshot;
  f.workspace.snapshot = async () => ({});
  await rejectsBeforeSpawn(f, policy);
  f.workspace.snapshot = snapshot;
  const fresh = await createPolicy(f.workspace);
  // Force a content change after the first admission snapshot has been read.
  const originalRead = fs.readFile;
  let changed = false;
  fs.readFile = async function(file, ...args) {
    const bytes = await originalRead(file, ...args);
    if (!changed && file === path.join(f.root, 'denied/neighbor.txt')) {
      changed = true;
      await writeFile(file, 'changed during admission');
    }
    return bytes;
  };
  syncBuiltinESMExports();
  try { await rejectsBeforeSpawn(f, fresh); }
  finally { fs.readFile = originalRead; syncBuiltinESMExports(); }
  assert.equal(changed, true);
});

for (const shape of ['root-symlink', 'file-symlink', 'parent-symlink', 'hardlink', 'glob-name', 'comma-name', 'space-name']) {
  test(`unsupported ${shape} inventory fails before spawn`, async t => {
    const f = await owned(t);
    const policy = await createPolicy(f.workspace);
    if (shape === 'root-symlink') {
      const alias = path.join(f.parent, 'alias'); await symlink(f.root, alias); f.root = f.workspace.root = alias;
    } else if (shape === 'file-symlink') {
      const file = path.join(f.root, 'denied/neighbor.txt'); await rm(file); await symlink('neighbor.txt-extra', file);
    } else if (shape === 'parent-symlink') {
      await rename(path.join(f.root, 'denied'), path.join(f.parent, 'moved')); await symlink(path.join(f.parent, 'moved'), path.join(f.root, 'denied'));
    } else if (shape === 'hardlink') {
      await link(path.join(f.root, 'denied/neighbor.txt'), path.join(f.parent, 'hardlink'));
    } else {
      const name = shape === 'glob-name' ? '[glob].txt' : shape === 'comma-name' ? 'one,two.txt' : 'space name.txt';
      await writeFile(path.join(f.root, name), 'unsupported');
    }
    await rejectsBeforeSpawn(f, policy);
  });
}

test('fixed secret denies remain literal while snapshot secret filenames can be grouped', async t => {
  const f = await owned(t);
  await writeFile(path.join(f.root, 'denied/second.key'), 'synthetic secret');
  await writeFile(path.join(f.root, '.env'), 'synthetic fixed secret');
  const result = await capture(f);
  const entries = new Map(result.entries);
  for (const name of ['.git', '.env', '.aws', '.ssh', '.codex', '.agents', '.data', '.npmrc', '.netrc', '.pypirc', '.git-credentials']) {
    assert.equal(entries.get(path.join(f.root, name)), 'deny');
  }
  for (const file of ['denied/second.key', 'denied/token.key']) assert.equal(denied(result.entries, path.join(f.root, file)), true);
});

test('snapshot secret read scopes fail closed', async t => {
  const f = await owned(t);
  f.workspace.manifest.permissions.readPaths.push('denied/token.key');
  await rejectsBeforeSpawn(f);
});

test('mode mutation in the last canonical snapshot cannot pass admission', async t => {
  const f = await owned(t);
  const originalRead = fs.readFile;
  let reads = 0;
  fs.readFile = async function(file, ...args) {
    const bytes = await originalRead(file, ...args);
    if (file === path.join(f.root, 'denied/neighbor.txt') && ++reads === 7) await chmod(file, 0o700);
    return bytes;
  };
  syncBuiltinESMExports();
  try { await rejectsBeforeSpawn(f); }
  finally { fs.readFile = originalRead; syncBuiltinESMExports(); }
  assert.equal(reads, 7);
});

test('denial group alternatives are bounded at 256', async t => {
  const f = await owned(t);
  for (let i = 0; i < 257; i++) await writeFile(path.join(f.root, `many-${i}.txt`), 'synthetic');
  await rejectsBeforeSpawn(f);
});

test('extra chunks still count toward the total glob form bound', async t => {
  const f = await owned(t);
  for (let i = 0; i < 65; i++) {
    const directory = path.join(f.root, `chunks-${i}`);
    await mkdir(directory);
    for (let j = 0; j < 5; j++) await writeFile(path.join(directory, `${j}${'x'.repeat(247)}`), 'synthetic');
  }
  await assert.rejects(capture(f), error => error.code === 'isolation' && /glob form bound/.test(error.message));
  await assert.rejects(readFile(path.join(f.parent, 'capture-ran')), { code: 'ENOENT' });
});

test('denial directories and canonical parent depth have finite bounds', async t => {
  const f = await owned(t);
  for (let i = 0; i < 129; i++) {
    const dir = path.join(f.root, `extra-${i}`); await mkdir(dir); await writeFile(path.join(dir, 'private.txt'), 'synthetic');
  }
  await rejectsBeforeSpawn(f);
  for (let i = 0; i < 129; i++) await rm(path.join(f.root, `extra-${i}`), { recursive: true });
  const deep = path.join(f.root, ...Array(25).fill('d'));
  await mkdir(deep, { recursive: true }); await writeFile(path.join(deep, 'private.txt'), 'synthetic');
  await rejectsBeforeSpawn(f);
});

test('file identity and mode changes during final admission fail closed', async t => {
  const f = await owned(t);
  const originalRead = fs.readFile;
  let reads = 0;
  fs.readFile = async function(file, ...args) {
    const bytes = await originalRead(file, ...args);
    if (file === path.join(f.root, 'denied/neighbor.txt') && ++reads === 4) await chmod(file, 0o700);
    return bytes;
  };
  syncBuiltinESMExports();
  try { await rejectsBeforeSpawn(f); }
  finally { fs.readFile = originalRead; syncBuiltinESMExports(); }
  assert.ok(reads >= 4);
});
