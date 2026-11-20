import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pause, digest, secretPath } from '../contracts.mjs';
import { validateExecution } from './contracts.mjs';
import { compileDarwinSeatbeltPolicyV2, nativeDependencyInventory, nativeInputInventory } from './darwin-seatbelt-v2.mjs';
import { NATIVE_NODE_RELEASES } from './native-node-releases.mjs';
import { executeSupervised } from './native-supervisor.mjs';

const legacySources = Object.freeze([
  'native-supervisor.c', 'native-supervisor.mjs', 'darwin-seatbelt-v2.mjs',
  'darwin-seatbelt.mjs', 'contracts.mjs', '../sandbox.mjs',
]);
const currentSources = Object.freeze([
  ...legacySources, '../contracts.mjs', 'darwin-seatbelt-v2-node-24223.mjs',
  'native-runtime-dispatch.mjs', 'native-node-releases.mjs',
]);

export function nativeImplementationSources(nodeVersion) {
  if (nodeVersion === '24.22.0') return legacySources;
  if (nodeVersion === '24.22.3') return currentSources;
  throw isolation('Unsupported native check runtime version');
}

const isolation = message => new Pause(message, 'isolation');
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const sandbox = '/usr/bin/sandbox-exec';
const release = NATIVE_NODE_RELEASES['24.22.3'];
const manifestLimit = 128 * 1024;
const artifactFileLimit = 512 * 1024 * 1024;
const artifactModes = Object.freeze({ node: '100755', 'mosaic-check-supervisor': '100755', 'NODE-LICENSE': '100644' });
const implementationUrl = file => new URL(file, import.meta.url);
const hashSource = file => digest(readFileSync(implementationUrl(file)));

function exactFields(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

function canonicalEntry(file, directory = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file || /[\x00-\x1f\x7f\\]/.test(file))
    throw isolation('Native artifact requires canonical absolute paths');
  try {
    const info = lstatSync(file, { bigint: true });
    if (info.isSymbolicLink() || realpathSync(file) !== file || !(directory ? info.isDirectory() : info.isFile())) throw Error();
    return info;
  } catch {
    throw isolation('Native artifact path is missing, nonregular or aliased: ' + file);
  }
}

function validateArtifactParents(root, uid) {
  for (let current = root; ; current = path.dirname(current)) {
    const info = canonicalEntry(current, true);
    if ((info.uid !== uid && info.uid !== 0n) || (current === root && info.uid !== uid))
      throw isolation('Native artifact directory has an untrusted owner');
    const protectedStickyParent = current !== root && info.uid === 0n && (info.mode & 0o1000n) !== 0n;
    if ((info.mode & 0o022n) !== 0n && !protectedStickyParent)
      throw isolation('Native artifact directory or ancestor is group/world writable');
    if (current === path.dirname(current)) return;
  }
}

function sameEntry(left, right) {
  return ['dev', 'ino', 'uid', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
}

function readExactFile(file, expected, keepBytes = false) {
  const size = Number(expected.size);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, size + 1));
  const chunks = [];
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameEntry(fstatSync(fd, { bigint: true }), expected))
      throw isolation('Native artifact changed before reading: ' + file);
    let count = 0;
    while (true) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - count + 1), null);
      if (!read) break;
      count += read;
      if (count > size) throw isolation('Native artifact grew during reading: ' + file);
      const bytes = buffer.subarray(0, read);
      hash.update(bytes);
      if (keepBytes) chunks.push(Buffer.from(bytes));
    }
    if (count !== size || !sameEntry(fstatSync(fd, { bigint: true }), expected) ||
        !sameEntry(canonicalEntry(file), expected))
      throw isolation('Native artifact changed during reading: ' + file);
    return { sha256: hash.digest('hex'), ...(keepBytes ? { bytes: Buffer.concat(chunks, count) } : {}) };
  } finally {
    closeSync(fd);
  }
}

// Select only after reading and hashing the exact bounded, canonically owned manifest.
export function readNativeManifest(config, expectedFingerprint) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw isolation('Native revision 2 requires Darwin arm64');
  if (!exactFields(config, ['schema', 'artifactManifestPath', 'artifactManifestSha256']) || config.schema !== 1 ||
      !isDigest(config.artifactManifestSha256) ||
      (expectedFingerprint !== undefined && expectedFingerprint !== config.artifactManifestSha256))
    throw isolation('Native runtime configuration or approved runtime fingerprint differs');

  const manifestPath = config.artifactManifestPath;
  const info = canonicalEntry(manifestPath);
  const root = path.dirname(manifestPath);
  const uid = BigInt(process.getuid());
  validateArtifactParents(root, uid);
  if (path.basename(manifestPath) !== 'artifact-manifest.json' || root === '/' || secretPath(root) ||
      info.size > BigInt(manifestLimit) || (info.mode & 0o022n) !== 0n || info.uid !== uid)
    throw isolation('Native artifact manifest is not safely owned outside credential roots');

  const { bytes, sha256 } = readExactFile(manifestPath, info, true);
  if (sha256 !== config.artifactManifestSha256) throw isolation('Native artifact manifest bytes changed');
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { throw isolation('Native artifact manifest is not JSON'); }
  return { manifest, manifestPath, root };
}

function validateCurrentManifest(manifest) {
  if (!exactFields(manifest, ['schema', 'platform', 'arch', 'nodeVersion', 'supervisorProtocol', 'files', 'provenance']) ||
      manifest.schema !== 1 || manifest.platform !== 'darwin' || manifest.arch !== 'arm64' ||
      manifest.nodeVersion !== release.version || manifest.supervisorProtocol !== 1 ||
      !Array.isArray(manifest.files) || manifest.files.length !== 3)
    throw isolation('Unsupported native artifact manifest');
  const { provenance } = manifest;
  if (!exactFields(provenance, ['nodeSource', 'nodePatch', 'supervisorSourceSha256', 'build']) ||
      !exactFields(provenance.nodeSource, ['version', 'url', 'sha256']) ||
      provenance.nodeSource.version !== release.version || provenance.nodeSource.url !== release.sourceUrl ||
      provenance.nodeSource.sha256 !== release.sourceSha256 || !exactFields(provenance.nodePatch, ['sha256', 'description']) ||
      provenance.nodePatch.sha256 !== release.patchSha256 || typeof provenance.nodePatch.description !== 'string' ||
      !provenance.nodePatch.description || provenance.nodePatch.description.length > 2000 ||
      !exactFields(provenance.build, ['compiler', 'platform']) ||
      typeof provenance.build.compiler !== 'string' || !provenance.build.compiler || provenance.build.platform !== 'darwin-arm64')
    throw isolation('Native artifact provenance does not match the reviewed Node source and patch');
  if (provenance.supervisorSourceSha256 !== hashSource('native-supervisor.c'))
    throw isolation('Native supervisor source protocol changed; rebuild the explicitly approved artifact');
}

export function validateCurrentNativeCheckRuntime(config, expectedFingerprint) {
  const { manifest, manifestPath, root } = readNativeManifest(config, expectedFingerprint);
  validateCurrentManifest(manifest);
  const files = new Map();
  const uid = BigInt(process.getuid());
  for (const entry of manifest.files) {
    if (!exactFields(entry, ['path', 'sha256', 'bytes', 'mode']) || typeof entry.path !== 'string' ||
        !Object.hasOwn(artifactModes, entry.path) ||
        files.has(entry.path) || !isDigest(entry.sha256) || !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 1 || entry.bytes > artifactFileLimit || entry.mode !== artifactModes[entry.path])
      throw isolation('Invalid native artifact inventory');
    if (entry.path === 'NODE-LICENSE' && entry.sha256 !== release.licenseSha256)
      throw isolation('Native artifact license does not match the reviewed Node release');
    const file = path.join(root, entry.path);
    const info = canonicalEntry(file);
    const mode = entry.mode === '100755' ? 0o755n : 0o644n;
    if (info.uid !== uid || (info.mode & 0o7777n) !== mode || info.size !== BigInt(entry.bytes) ||
        readExactFile(file, info).sha256 !== entry.sha256)
      throw isolation('Native artifact bytes, size or executable mode changed: ' + entry.path);
    files.set(entry.path, { executable: file, sha256: entry.sha256 });
  }
  const implementationHash = digest(currentSources.map(file => ({ file, hash: hashSource(file) })));
  return freeze({
    fingerprint: config.artifactManifestSha256,
    manifestPath,
    root,
    runtime: files.get('node'),
    supervisor: { ...files.get('mosaic-check-supervisor'), protocol: 1 },
    sandbox: { executable: sandbox, sha256: readExactFile(sandbox, canonicalEntry(sandbox)).sha256 },
    implementationHash,
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: manifest.nodeVersion,
    manifest,
  });
}

async function canonicalRoot(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory)
    throw isolation('Native check root is aliased');
  return { path: directory, realPath: directory };
}

async function approvedStagedInputs(stages, inventory) {
  const stagedInputs = [];
  for (const stage of stages) {
    const root = await canonicalRoot(stage.root);
    const entries = [];
    for (const file of inventory) {
      const absolute = path.join(stage.root, file.path);
      const info = await lstat(absolute);
      const mode = file.mode === '100755' ? 0o755 : 0o644;
      if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute ||
          (info.mode & 0o7777) !== mode || digest(await readFile(absolute)) !== file.hash)
        throw isolation('Staged native input bytes, executable mode or path changed');
      entries.push({ ...file, realPath: absolute });
    }
    if (digest(entries.map(({ realPath, ...file }) => file)) !== stage.inventoryHash)
      throw isolation('Native staged input inventory changed');
    stagedInputs.push({ root, inventory: entries });
  }
  return stagedInputs;
}

export function createCurrentNativeBackend({ workspace, options }) {
  const { nativeCheckRuntime, expectedRuntimeFingerprint, expectedDependencyHash, ownership } = options;
  const runtime = validateCurrentNativeCheckRuntime(nativeCheckRuntime, expectedRuntimeFingerprint);
  const identity = freeze({ id: 'darwin-seatbelt', revision: 2, executable: sandbox, runtime });
  const runtimeHash = digest(runtime);

  async function compile(request) {
    if (digest(validateCurrentNativeCheckRuntime(nativeCheckRuntime, expectedRuntimeFingerprint)) !== runtimeHash)
      throw isolation('Pinned native runtime identity changed');
    const root = await canonicalRoot(workspace.root);
    if (within(root.path, runtime.root) || within(runtime.root, root.path))
      throw isolation('Native artifact overlaps the check workspace');
    const inventory = await nativeInputInventory(workspace);
    const outputs = [];
    for (const name of ['dist', '.overnight-output']) {
      const directory = path.join(root.path, name);
      await mkdir(directory, { recursive: true });
      outputs.push(await canonicalRoot(directory));
    }
    const dependencyRoot = path.join(root.path, 'node_modules');
    const dependencies = nativeDependencyInventory(dependencyRoot);
    if (expectedDependencyHash !== undefined && (!isDigest(expectedDependencyHash) || dependencies.hash !== expectedDependencyHash))
      throw isolation('Native copied dependencies differ from the approved source bytes or executable modes');

    const deniedPaths = [];
    for (const rule of request.permissions.filesystem.rules.filter(rule => rule.access === 'deny')) {
      let resolved = rule.path;
      try { resolved = await realpath(rule.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      deniedPaths.push({ path: rule.path, realPath: resolved });
    }
    const compiled = compileDarwinSeatbeltPolicyV2({
      workspace: root,
      permissions: request.permissions,
      readPaths: workspace.manifest.permissions.readPaths,
      inventory,
      dependencies: dependencies.present ? [await canonicalRoot(dependencyRoot)] : [],
      outputs,
      executable: { path: runtime.runtime.executable, realPath: runtime.runtime.executable },
      stagedInputs: await approvedStagedInputs(request.stagedInputs ?? [], inventory),
      deniedPaths,
    }, runtime);
    return { ...compiled, evidence: { ...compiled.evidence, dependencyInventoryHash: dependencies.hash } };
  }

  async function execute(request) {
    validateExecution(request, workspace);
    if (request.argv[0] !== runtime.runtime.executable)
      throw isolation('Native revision 2 requires the explicitly approved literal pinned runtime launcher; prepare new exact check argv');

    const compiled = await compile(request);
    const profileDir = path.join(workspace.journal.dir, 'native-check-profiles');
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const info = await lstat(profileDir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid() ||
        await realpath(profileDir) !== profileDir || within(workspace.root, profileDir))
      throw isolation('Native profile storage must be private outside the check workspace');
    const profilePath = path.join(profileDir, randomUUID() + '.sb');
    await writeFile(profilePath, compiled.profile, { mode: 0o600, flag: 'wx' });
    const fields = {
      schema: 1,
      backend: { id: identity.id, revision: identity.revision },
      argv: [...request.argv],
      cwd: request.cwd,
      profileHash: compiled.evidence.profileHash,
      inputInventoryHash: compiled.evidence.inventoryHash,
      dependencyInventoryHash: compiled.evidence.dependencyInventoryHash,
      runtimeFingerprint: runtime.fingerprint,
      runtimeHash: runtime.runtime.sha256,
      supervisorHash: runtime.supervisor.sha256,
    };
    const binding = { ...fields, bindingHash: digest(fields) };
    const revalidate = async () => {
      const current = await compile(request);
      if (digest(current) !== digest(compiled) || digest(await readFile(profilePath)) !== compiled.evidence.profileHash)
        throw isolation('Native profile, inputs or runtime changed across an authority boundary');
    };
    try {
      const outcome = await executeSupervised({ ...request, profilePath, identity, ownership, binding, revalidate });
      await rm(profilePath, { force: true });
      return {
        ...outcome,
        provenance: {
          ...compiled.evidence, argv: [...request.argv], resolvedExecutable: runtime.runtime.executable,
          requestId: outcome.quiescence.requestId, bindingHash: binding.bindingHash,
        },
      };
    } catch (error) {
      if (error.executionOutcome !== 'unknown') await rm(profilePath, { force: true });
      throw error;
    }
  }

  return { identity: () => identity, execute };
}
