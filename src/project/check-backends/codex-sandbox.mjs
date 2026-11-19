import { accessSync, constants, statSync, realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { command } from '../process.mjs';
import { digest, matches, Pause, secretPath } from '../contracts.mjs';
import { Workspace } from '../workspace.mjs';
import { CHECK_BACKEND_REVISION, createPolicy, validateExecution } from './contracts.mjs';

const LEGACY_BYTES = 32768;
// Private transport and modeled regex bounds for compact policies.
const COMPACT_BYTES = 73_728;
const SBPL_LITERAL_BYTES = 900;
const FIXED_DENIES = ['.git', '.env', '.aws', '.ssh', '.codex', '.agents', '.data', '.npmrc', '.netrc', '.pypirc', '.git-credentials'];
const isolation = reason => new Pause(`Codex policy compaction unavailable: ${reason}; narrow the approved workspace or denied inventory`, 'isolation');
const component = value => /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
const rootComponent = value => value.length > 0 && !/[^A-Za-z0-9._ -]/.test(value) && value !== '.' && value !== '..';

// Only the admitted ASCII grammar reaches this model. Count dot, hyphen and
// root space as escaped, even when the regex translator emits them literally.
const regexBytes = literal => Buffer.byteLength(literal.replace(/[. -]/g, '\\$&'));
// Include the literal delimiters, absolute anchors and group syntax. The
// exact arm adds a pair of brackets around one already-counted character.
const exactChunkOverhead = Buffer.byteLength('#"^/()$"') + 2;
const subtreeChunkOverhead = Buffer.byteLength('#"^/()/.*$"');
const chunkFits = bytes => bytes + exactChunkOverhead <= SBPL_LITERAL_BYTES &&
  bytes + subtreeChunkOverhead <= SBPL_LITERAL_BYTES;

function configFor(permissions, rules = permissions.filesystem.rules) {
  const fs = { ':root': permissions.filesystem.default, ':minimal': permissions.filesystem.minimal };
  for (const rule of rules) fs[rule.path] = rule.access;
  const fields = Object.entries(fs).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',');
  return `permissions.overnight={filesystem={${fields}},network={enabled=false}}`;
}

async function compactPolicy(workspace, policy, original) {
  const root = workspace.root;
  const input = JSON.stringify(policy);
  const scopes = JSON.stringify(workspace.manifest?.permissions?.readPaths);
  if (workspace.snapshot !== Workspace.prototype.snapshot || workspace.file !== Workspace.prototype.file ||
      !Array.isArray(workspace.manifest?.permissions?.readPaths) ||
      !root.split('/').slice(1).every(rootComponent) || root === '/' || path.resolve(root) !== root) {
    throw isolation('large policies require a canonical Git-backed Workspace and literal paths');
  }
  const readPaths = [...workspace.manifest.permissions.readPaths];
  if (readPaths.some(scope => typeof scope !== 'string' || !scope.replace(/\/$/, '').split('/').every(component) || secretPath(scope))) {
    throw isolation('unsupported or secret read scope');
  }
  const fixed = new Set(FIXED_DENIES.map(file => path.join(root, file)));
  const generated = file => ['.git', '.overnight-output', 'dist', 'node_modules'].includes(file.split('/')[0]);

  // Bind actual Git inventory, contents and filesystem identities, not just a
  // caller-supplied permission object. Repeat this immediately before launch.
  async function state() {
    if (workspace.root !== root || workspace.snapshot !== Workspace.prototype.snapshot || workspace.file !== Workspace.prototype.file ||
        JSON.stringify(workspace.manifest.permissions.readPaths) !== scopes || JSON.stringify(policy) !== input) throw isolation('inputs changed');
    const snapshot = await workspace.snapshot();
    const files = Object.keys(snapshot);
    if (files.length > 4096 || files.some(file => !file.split('/').every(component) || generated(file))) throw isolation('unsupported snapshot paths or inventory bound');
    const identities = new Map();
    async function pin(file, regular) {
      if (identities.has(file)) return;
      const stat = await lstat(file, { bigint: true });
      if (stat.isSymbolicLink() || (regular ? !stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()) : !stat.isDirectory()) || await realpath(file) !== file) {
        throw isolation('aliased or nonregular inventory');
      }
      identities.set(file, [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, ...(regular ? [stat.size, stat.mtimeNs, stat.ctimeNs] : [])].map(String));
    }
    const parents = new Set();
    for (let dir = root; dir !== '/'; dir = path.dirname(dir)) parents.add(dir);
    for (const file of files) {
      const absolute = path.join(root, file);
      if (digest(await readFile(absolute)) !== snapshot[file]) throw isolation('snapshot content changed');
      await pin(absolute, true);
      for (let dir = path.dirname(absolute); dir !== root; dir = path.dirname(dir)) parents.add(dir);
    }
    for (const dir of [...parents].sort()) await pin(dir, false);
    return { snapshot, identity: digest([...identities].sort(([a], [b]) => a.localeCompare(b))) };
  }

  try {
    const before = await state();
    if (JSON.stringify(await createPolicy(workspace)) !== input) throw isolation('policy is not the fresh canonical coordinator policy');
    const groups = new Map();
    const selected = new Set();
    for (const [file] of Object.entries(before.snapshot)) {
      const absolute = path.join(root, file);
      if (fixed.has(absolute) || (!secretPath(file) && matches(file, readPaths))) continue;
      if (readPaths.some(scope => scope === file || scope.startsWith(`${file}/`))) throw isolation('denied file overlaps an approved scope');
      const parent = path.dirname(absolute);
      if (parent.split('/').filter(Boolean).length > 24) throw isolation('directory depth bound exceeded');
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(path.basename(file));
      selected.add(absolute);
    }
    if (groups.size > 128) throw isolation('denial directory bound exceeded');
    let globForms = 0;
    const replacements = new Map();
    const covered = new Set();
    for (const [parent, basenames] of groups) {
      if (basenames.length > 256) throw isolation('basename alternative bound exceeded');
      for (const name of basenames) {
        const file = path.join(parent, name);
        if (covered.has(file) || !selected.has(file)) throw isolation('incomplete denial membership');
        covered.add(file);
      }
      if (basenames.length === 1) continue;
      const prefixBytes = regexBytes(parent);
      let chunk = [];
      let bytes = prefixBytes;
      function emitChunk() {
        if (chunk.length < 2) return;
        globForms += 2;
        if (globForms > 256) throw isolation('denial glob form bound exceeded');
        const [first, ...rest] = chunk;
        // The pinned Codex frontend treats braces alone as a literal path.
        // A singleton class selects its glob parser without changing the
        // first alternative. Admitted ASCII includes no class escapes, and
        // a hyphen is literal as the sole member of a class.
        const exact = `${parent}/{[${first[0]}]${first.slice(1)},${rest.join(',')}}`;
        const subtree = `${parent}/{${chunk.join(',')}}/**`;
        replacements.set(path.join(parent, first), [{ path: exact, access: 'deny' }, { path: subtree, access: 'deny' }]);
        for (const name of chunk.slice(1)) replacements.set(path.join(parent, name), []);
      }
      for (const name of basenames) {
        const nameBytes = regexBytes(name);
        if (!chunkFits(prefixBytes + nameBytes)) throw isolation('basename exceeds the modeled regex literal bound');
        if (!chunkFits(bytes + nameBytes + Number(chunk.length > 0))) {
          emitChunk();
          chunk = [];
          bytes = prefixBytes;
        }
        bytes += nameBytes + Number(chunk.length > 0);
        chunk.push(name);
      }
      emitChunk();
    }
    if (covered.size !== selected.size) throw isolation('denial coverage bound exceeded');
    const rules = [];
    for (const rule of policy.filesystem.rules) {
      if (!selected.has(rule.path)) rules.push(rule);
      else {
        if (rule.access !== 'deny') throw isolation('unexpected snapshot read grant');
        if (replacements.has(rule.path)) rules.push(...replacements.get(rule.path));
        else rules.push(rule);
      }
    }
    const config = configFor(policy, rules);
    if (Buffer.byteLength(config) > COMPACT_BYTES || Buffer.byteLength(config) >= Buffer.byteLength(original)) throw isolation('compact transport does not fit its size bound');
    if (JSON.stringify(await createPolicy(workspace)) !== input) throw isolation('canonical policy changed');
    const after = await state();
    if (digest(after) !== digest(before) || JSON.stringify(policy) !== input ||
        workspace.root !== root || JSON.stringify(workspace.manifest.permissions.readPaths) !== scopes) throw isolation('workspace or policy changed before launch');
    return config;
  } catch (error) {
    if (error.code === 'isolation') throw error;
    throw isolation(`inventory admission failed (${error.code ?? 'invalid input'})`);
  }
}

function executable(commandName) {
  if (typeof commandName !== 'string' || !commandName || /[\0\r\n]/.test(commandName)) throw new Pause('Invalid Codex sandbox executable', 'isolation');
  const candidates = commandName.includes('/') ? [path.resolve(commandName)] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.resolve(dir, commandName));
  for (const file of candidates) {
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return realpathSync(file);
    } catch {}
  }
  throw new Pause('Codex CLI is not executable or not on PATH; sandbox unavailable', 'isolation');
}

export function createCodexSandboxBackend({ workspace, options = {} }) {
  if (process.platform !== 'darwin') throw new Pause('Unattended checks currently require the verified Mac sandbox', 'isolation');
  const codex = executable(options.codex ?? 'codex');
  const identity = Object.freeze({ id: 'codex-sandbox', revision: CHECK_BACKEND_REVISION, executable: codex });
  return {
    identity: () => identity,
    async execute(request) {
      validateExecution(request, workspace);
      const { argv, cwd, env, timeoutMs, signal, permissions } = request;
      const execution = JSON.stringify({ argv, cwd, env, timeoutMs });
      const original = configFor(permissions);
      const config = Buffer.byteLength(original) <= LEGACY_BYTES ? original : await compactPolicy(workspace, permissions, original);
      validateExecution(request, workspace);
      if (JSON.stringify({ argv, cwd, env, timeoutMs }) !== execution) throw isolation('execution inputs changed');
      return command([codex, 'sandbox', '-P', 'overnight', '-c', config, '-C', cwd, '--', ...argv], { cwd, env, timeoutMs, signal });
    },
  };
}
