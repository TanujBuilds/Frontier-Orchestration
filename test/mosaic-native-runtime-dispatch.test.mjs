import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { approvedChecks, nativeRuntime } from '../src/harness/execution.mjs';
import { Coordinator } from '../src/harness/coordinator.mjs';
import { Journal } from '../src/project/journal.mjs';
import { git } from '../src/project/process.mjs';
import { Workspace } from '../src/project/workspace.mjs';
import { readBundledNativeCheckRuntime } from '../src/beta/package-contract.mjs';
import { artifact } from './fixtures/mosaic-pb15-v2-backend/artifact.mjs';

const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const ordinaryLicense = process.env.MOSAIC_NATIVE_TEST_LICENSE ?? (process.env.MOSAIC_NATIVE_TEST_NODE
  ? path.resolve(process.env.MOSAIC_NATIVE_TEST_NODE, '../../../LICENSE') : undefined);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const legacyImplementation = '53e0ee50362b30b690168457766aa49b59e689cebf97e309861ee238aa7a8eca';
const currentSource = {
  version: '24.22.3',
  url: 'https://nodejs.org/dist/v24.22.3/node-v24.22.3.tar.xz',
  sha256: '48ca3aa8a9b02133356922ef4fc80200e00598c80a4ef446f7c39a459222593d',
};
const currentPatch = '840109e32a582faf92ed07f75987c6eb03c9b5659cf74b2f5231ac1e72594741';
const currentNode = process.env.MOSAIC_CURRENT_NATIVE_TEST_NODE;

async function fixture(t) {
  const result = await artifact();
  t.after(() => rm(result.root, { recursive: true, force: true }));
  return result;
}

async function writeManifest(file, manifest) {
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
  await writeFile(file, bytes);
  return { schema: 1, artifactManifestPath: file, artifactManifestSha256: hash(bytes) };
}

async function currentManifest(root, legacyManifest) {
  const license = await readFile(ordinaryLicense);
  await writeFile(path.join(root, 'NODE-LICENSE'), license);
  const files = legacyManifest.files.map(entry => entry.path === 'NODE-LICENSE'
    ? { ...entry, sha256: hash(license), bytes: license.length } : entry);
  const manifest = {
    ...legacyManifest,
    files,
    nodeVersion: '24.22.3',
    provenance: {
      ...legacyManifest.provenance,
      nodeSource: currentSource,
      nodePatch: { ...legacyManifest.provenance.nodePatch, sha256: currentPatch },
    },
  };
  return { manifest, license };
}

test('legacy native configuration retains the archived implementation and literal Node path', { skip: !darwin }, async t => {
  const { config, root } = await fixture(t);
  const runtime = nativeRuntime({ nativeCheckRuntime: config }, config.artifactManifestSha256);
  assert.equal(runtime.nodeVersion, '24.22.0');
  assert.equal(runtime.implementationHash, legacyImplementation);
  assert.equal(runtime.runtime.executable, path.join(root, 'node'));
  assert.equal(runtime.fingerprint, config.artifactManifestSha256);
});

test('bundled native selection binds the reviewed current Node provenance and exact approval', { skip: !darwin || !ordinaryLicense }, async t => {
  const prior = await fixture(t);
  const bundle = await mkdtemp('/private/tmp/mosaic-current-runtime-');
  t.after(() => rm(bundle, { recursive: true, force: true }));
  const root = path.join(bundle, 'check-artifact');
  await cp(prior.root, root, { recursive: true });
  const file = path.join(root, 'artifact-manifest.json');
  const { manifest, license } = await currentManifest(root, prior.manifest);
  const files = manifest.files;
  const config = await writeManifest(file, manifest);
  assert.deepEqual(await readBundledNativeCheckRuntime(bundle), config);
  const runtime = nativeRuntime({ nativeCheckRuntime: config }, config.artifactManifestSha256);
  assert.equal(runtime.nodeVersion, currentSource.version);
  assert.equal(runtime.runtime.executable, path.join(root, 'node'));
  assert.match(runtime.implementationHash, /^[a-f0-9]{64}$/);
  assert.notEqual(runtime.implementationHash, legacyImplementation);
  const { nativeCheckArgv } = await import('../src/project/check-backends/native-runtime-dispatch.mjs');
  assert.deepEqual(nativeCheckArgv(config, 'checks/value.mjs', ['a b']), [runtime.runtime.executable, 'checks/value.mjs', 'a b']);
  assert.throws(() => nativeCheckArgv(config, '../value.mjs'), /approved relative path/);
  assert.throws(() => nativeCheckArgv(config, 'checks/value.mjs', ['\0']), /literal strings/);
  assert.throws(() => nativeRuntime({ nativeCheckRuntime: config }, prior.config.artifactManifestSha256), /fingerprint/i);

  const bad = await writeManifest(file, {
    ...manifest,
    provenance: { ...manifest.provenance, nodeSource: { ...currentSource, sha256: 'a'.repeat(64) } },
  });
  assert.throws(() => nativeRuntime({ nativeCheckRuntime: bad }), /provenance/i);
  const badLicense = Buffer.from('substituted release license');
  await writeFile(path.join(root, 'NODE-LICENSE'), badLicense);
  const substituted = await writeManifest(file, {
    ...manifest,
    files: files.map(entry => entry.path === 'NODE-LICENSE'
      ? { ...entry, sha256: hash(badLicense), bytes: badLicense.length } : entry),
  });
  assert.throws(() => nativeRuntime({ nativeCheckRuntime: substituted }), /license/i);
  await writeFile(path.join(root, 'NODE-LICENSE'), license);
  await writeManifest(file, manifest);
  const node = path.join(root, 'node');
  await chmod(node, 0o644);
  assert.throws(() => nativeRuntime({ nativeCheckRuntime: config }), /mode/i);
  assert.equal(hash(await readFile(file)), config.artifactManifestSha256);
});

test('current patched Node runs an approved protected check through the normal coordinator', {
  skip: !darwin || !currentNode || !ordinaryLicense, timeout: 35000,
}, async t => {
  const root = await mkdtemp('/private/tmp/mosaic-current-preflight-');
  const runtime = await artifact(currentNode);
  let coordinator;
  t.after(async () => {
    const held = coordinator?.executionOwnership.holds() ?? [];
    coordinator?.close();
    if (held.length) t.diagnostic('Retained unresolved native fixture roots: ' + root + ', ' + runtime.root);
    else await Promise.all([root, runtime.root].map(dir => rm(dir, { recursive: true, force: true })));
  });

  const { manifest } = await currentManifest(runtime.root, runtime.manifest);
  const nativeCheckRuntime = await writeManifest(runtime.config.artifactManifestPath, manifest);
  const executionPolicy = {
    version: 1, backend: 'darwin-seatbelt', backendRevision: 2,
    runtimeFingerprint: nativeCheckRuntime.artifactManifestSha256,
  };
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'checks'), { recursive: true });
  await mkdir(path.join(repo, 'src'));
  await writeFile(path.join(repo, 'checks/identity.mjs'), 'process.stdout.write(process.versions.node);\n');
  await writeFile(path.join(repo, 'src/value.mjs'), 'export const value = 42;\n');
  await git(repo, 'init', '-q');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Protected Node identity');

  const baseCommit = await git(repo, 'rev-parse', 'HEAD');
  const approvedArgv = [path.join(runtime.root, 'node'), 'checks/identity.mjs'];
  const project = {
    repo, baseCommit, readPaths: ['checks/', 'src/'], writePaths: ['src/'],
    checks: [{ id: 'identity', argv: approvedArgv, timeoutMs: 5000 }],
  };
  coordinator = new Coordinator({ root: path.join(root, 'state'), selectedHost: 'cursor', nativeCheckRuntime, executionPolicy });
  const goal = coordinator.preparePortableGoal({
    submissionId: 'current-protected-runtime', mode: 'codex_only', environment: 'fixture',
    objective: 'Verify the current protected check runtime',
    acceptance: ['Run only the exact approved Node executable'], project, executionPolicy,
  }, 'prepare-current');
  const proof = await coordinator.preflightExecution({ goalId: goal.id, hash: goal.hash });
  assert.equal(proof.passed, true);
  assert.equal(proof.sandbox.childProcessWorks, true);
  assert.equal(proof.sandbox.quiescence.groupESRCH, true);
  assert.equal(proof.sandbox.provenance.resolvedExecutable, approvedArgv[0]);
  coordinator.activateGoal({ goalId: goal.id, hash: goal.hash }, 'activate-current');

  const journal = await new Journal(root, randomUUID()).load();
  const workspace = new Workspace({ repo, baseCommit, executionPolicy, permissions: project, overnightV2: true }, journal);
  await workspace.initialize();
  const runner = approvedChecks(workspace, {
    config: coordinator.executionConfig,
    context: { c: coordinator, goalId: goal.id, operationKey: 'assert-current-runtime' },
  });
  await assert.rejects(runner.execute([process.execPath, approvedArgv[1]], 5000), /literal pinned runtime launcher/);
  const [result] = await runner.run(project.checks, 'current');
  assert.equal(result.stdout, '24.22.3');
  assert.equal(result.passed, true);
  assert.equal(result.quiescence.groupESRCH, true);
  assert.deepEqual(result.provenance.argv, approvedArgv);
  assert.equal(result.provenance.runtimeFingerprint, executionPolicy.runtimeFingerprint);
  assert.ok(coordinator.store.all('execution_owner').every(owner => owner.status === 'quiescent'));
});
