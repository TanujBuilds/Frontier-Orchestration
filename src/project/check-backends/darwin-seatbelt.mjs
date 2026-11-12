import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { digest, matches, Pause, relativePath, secretPath } from '../contracts.mjs';
import { validatePolicy } from './contracts.mjs';

export const DARWIN_SEATBELT_CONTAINMENT_BLOCKER = 'darwin-seatbelt revision 1 is unavailable: detached/reparented descendants can escape process-group cancellation; verified descendant containment is required';
const isolation = message => new Pause(message, 'isolation');
export function assertDarwinSeatbeltContainment() { throw isolation(DARWIN_SEATBELT_CONTAINMENT_BLOCKER); }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const quote = value => JSON.stringify(value);
const literal = value => `(literal ${quote(value)})`;
const subtree = value => `(subpath ${quote(value)})`;
const MAX_INPUTS = 10000;
// Installed dyld-support.sb/system.sb describe these system library, cryptex,
// locale and font paths. No /usr, home, /var, Homebrew or Mach-service grant.
const RUNTIME_READ_ROOTS = Object.freeze(['/System/Library', '/System/Cryptexes', '/System/Volumes/Preboot/Cryptexes', '/usr/lib', '/usr/share', '/Library/Fonts']);
const LEGACY_RUNTIME_SELECTORS = new Set(['/System', '/usr', '/bin', '/sbin', '/opt/homebrew', '/Library/Fonts']);

function absolute(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || path.normalize(value) !== value || /[\x00-\x1f\x7f\\]/.test(value)) throw isolation('Native policy requires normalized absolute paths without control characters');
  return value;
}
function canonical(value) {
  if (!record(value) || absolute(value.path) !== absolute(value.realPath)) throw isolation('Native policy rejects noncanonical roots and symlink aliases');
  return value.path;
}
function list(value, name, maximum = MAX_INPUTS) {
  if (!Array.isArray(value) || value.length > maximum) throw isolation(`Invalid bounded native ${name}`);
  return value;
}
function inputInventory(entries, root, readPaths, denies) {
  const seen = new Set();
  return list(entries, 'input inventory').map(entry => {
    if (!record(entry)) throw isolation('Invalid native input evidence');
    try { relativePath(entry.path); } catch { throw isolation('Invalid native input path'); }
    const file = path.join(root, entry.path);
    if (seen.has(entry.path) || secretPath(entry.path) || !matches(entry.path, readPaths) ||
        absolute(entry.realPath) !== file || !/^[a-f0-9]{64}$/.test(entry.hash) || !['100644', '100755'].includes(entry.mode) ||
        denies.some(denied => within(denied, file))) throw isolation('Native inventory is duplicated, secret, undisclosed, aliased or unbound');
    seen.add(entry.path);
    return { path: entry.path, realPath: file, hash: entry.hash, mode: entry.mode };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function ancestors(file) {
  const result = [];
  for (let parent = path.dirname(file);; parent = path.dirname(parent)) {
    result.push(parent);
    if (parent === path.dirname(parent)) return result;
  }
}
function insensitive(text) { return [...text].map(char => /[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : char === '.' ? '[.]' : char).join(''); }

// Pure diagnostic compiler. All bindings are coordinator-owned, freshly
// canonicalized inventory, not model-written SBPL or authorization. This does
// not execute anything and does not make the blocked native backend available.
export function compileDarwinSeatbeltPolicy(spec) {
  if (!record(spec)) throw isolation('Invalid native policy compilation request');
  try { if (Buffer.byteLength(JSON.stringify(spec)) > 2 * 1024 * 1024) throw Error('too large'); }
  catch { throw isolation('Native compilation data must be bounded serializable coordinator data'); }
  validatePolicy(spec.permissions);
  const root = canonical(spec.workspace);
  if (root === '/' || RUNTIME_READ_ROOTS.some(runtime => within(runtime, root) || within(root, runtime))) throw isolation('Workspace overlaps a native runtime root');
  const readPaths = list(spec.readPaths, 'read scopes');
  if (!readPaths.length) throw isolation('Native policy requires approved read scopes');
  try { for (const scope of readPaths) relativePath(scope.endsWith('/') ? scope.slice(0, -1) : scope); } catch { throw isolation('Invalid native read scope'); }
  const outputs = list(spec.outputs, 'output roots', 2).map(canonical);
  if (outputs.length !== 2 || new Set(outputs).size !== 2 || outputs.some(file => ![path.join(root, 'dist'), path.join(root, '.overnight-output')].includes(file))) throw isolation('Native writes require the two coordinator output roots');
  const dependencies = list(spec.dependencies, 'dependency roots', 1).map(canonical);
  if (dependencies.some(file => file !== path.join(root, 'node_modules'))) throw isolation('Native dependencies must be prepared inside node_modules');
  const executable = canonical(spec.executable);
  if (within(root, executable) || executable === '/' || secretPath(executable) || RUNTIME_READ_ROOTS.some(file => within(executable, file))) throw isolation('Native runtime executable overlaps workspace, secrets or system roots');
  const denies = new Set();
  for (const rule of spec.permissions.filesystem.rules) {
    absolute(rule.path);
    if (rule.access === 'write' && !outputs.includes(rule.path)) throw isolation('Native policy rejects writes beyond explicit output roots');
    if (rule.access === 'read' && !within(root, rule.path) && !LEGACY_RUNTIME_SELECTORS.has(rule.path)) throw isolation('Native policy rejects unapproved external read roots');
    if (rule.access === 'deny') denies.add(rule.path);
  }
  if (!spec.permissions.filesystem.rules.some(rule => rule.path === root && rule.access === 'read') ||
      outputs.some(output => !spec.permissions.filesystem.rules.some(rule => rule.path === output && rule.access === 'write'))) throw isolation('Native inventory and output roots require matching coordinator permissions');
  for (const binding of list(spec.deniedPaths, 'denied canonical bindings')) {
    if (!record(binding)) throw isolation('Invalid native denied path binding');
    denies.add(absolute(binding.path)); denies.add(absolute(binding.realPath));
  }
  const denied = [...denies];
  if ([root, executable, ...dependencies, ...outputs, ...RUNTIME_READ_ROOTS].some(file => denied.some(item => within(item, file) || within(file, item) && !within(root, item)))) throw isolation('Native deny overlaps a required runtime or writable root');
  const inputs = inputInventory(spec.inventory, root, readPaths, denied);
  if (!inputs.length) throw isolation('Native policy requires an exact approved input inventory');
  // Workspace.inventory excludes generated output roots. Do not accept a
  // contradictory immutable input that the profile grants output writes to.
  if (inputs.some(file => outputs.some(output => within(output, file.realPath)))) throw isolation('Native original input inventory must exclude generated output roots');
  const staged = list(spec.stagedInputs, 'staged input roots', 10).map(stage => {
    if (!record(stage)) throw isolation('Invalid native staged inputs');
    const stagedRoot = canonical(stage.root);
    const relative = path.relative(path.join(root, '.overnight-output'), stagedRoot);
    if (!/^approved-inputs-[a-zA-Z0-9-]{1,80}$/.test(relative)) throw isolation('Invalid native staged input root');
    const files = inputInventory(stage.inventory, stagedRoot, readPaths, denied);
    if (digest(files.map(({ realPath, ...file }) => file)) !== digest(inputs.map(({ realPath, ...file }) => file))) throw isolation('Staged input bytes or executable modes differ from approved inventory');
    return { root: stagedRoot, inputs: files };
  });
  if (new Set(staged.map(stage => stage.root)).size !== staged.length) throw isolation('Duplicate native staged input root');
  const reads = [...inputs.map(file => file.realPath), ...staged.flatMap(stage => stage.inputs.map(file => file.realPath))];
  const metadata = [...new Set([root, ...ancestors(root), ...reads.flatMap(ancestors), ...outputs, ...dependencies])];
  const executions = [executable, ...inputs.filter(file => file.mode === '100755').map(file => file.realPath), ...staged.flatMap(stage => stage.inputs.filter(file => file.mode === '100755').map(file => file.realPath))];
  const lines = ['(version 1)', '(deny default)', '(deny network*)', '(allow process-fork)', '(allow sysctl-read)',
    '(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid))',
    `(allow process-exec ${executions.map(literal).join(' ')} ${dependencies.map(subtree).join(' ')})`,
    `(allow file-read* ${['/', root, executable, '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', ...reads].map(literal).join(' ')} ${[...RUNTIME_READ_ROOTS, ...dependencies, ...outputs].map(subtree).join(' ')})`,
    `(allow file-map-executable ${executions.map(literal).join(' ')} ${[...RUNTIME_READ_ROOTS, ...dependencies].map(subtree).join(' ')})`,
    `(allow file-read-metadata ${metadata.map(literal).join(' ')})`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero"))',
    `(allow file-write* ${outputs.map(subtree).join(' ')})`,
    ...staged.map(stage => `(deny file-read* file-write* ${subtree(stage.root)})`),
    ...staged.map(stage => `(allow file-read* ${stage.inputs.map(file => literal(file.realPath)).join(' ')})`),
    ...staged.map(stage => `(allow file-read-metadata ${[...new Set(stage.inputs.flatMap(file => ancestors(file.realPath)).filter(file => within(stage.root, file)))].map(literal).join(' ')})`),
    ...denied.map(file => `(deny file-read* file-write* ${subtree(file)})`)];
  // Protect ignored/untracked nested secret basenames even inside output and
  // dependency runtime trees. Scope regex to the workspace, not its ancestors.
  const names = ['.git', '.agents', '.codex', '.aws', '.ssh', '.data', '.npmrc', '.netrc', '.pypirc', '.git-credentials', 'credentials.json', 'auth.json', 'PROJECT_MEMORY.md'].map(insensitive).join('|');
  // SBPL's #"..." reader does not share ordinary string escaping for quotes.
  // Keep that pattern quote/backslash-free. The exact subpath conjunct binds
  // the prefix; wildcard punctuation in this redundant prefix cannot widen it.
  const regexRoot = [...root].map(char => '.[]{}()*+?^$|"'.includes(char) ? '.' : char).join('');
  const pattern = `^${regexRoot}/(.*/)?(${names}|[.][eE][nN][vV]([.][^/]*)?|[^/]*[.]([pP][eE][mM]|[kK][eE][yY]|[pP]12|[pP][fF][xX]))(/.*)?$`;
  lines.push(`(deny file-read* file-write* (require-all ${subtree(root)} (regex #${quote(pattern)})))`);
  const profile = lines.join('\n') + '\n';
  if (Buffer.byteLength(profile) > 4 * 1024 * 1024) throw isolation('Native profile exceeds its compilation bound');
  const evidenceInputs = inputs.map(({ realPath, ...file }) => file);
  return { profile, evidence: { backend: { id: 'darwin-seatbelt', revision: 1 }, diagnosticOnly: true, inputs: evidenceInputs, inventoryHash: digest(evidenceInputs), profileHash: digest(profile), stagedInputRoots: staged.map(stage => stage.root) } };
}

export function createDarwinSeatbeltBackend() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw isolation('Native checks initially require Darwin arm64');
  const executable = '/usr/bin/sandbox-exec';
  try { accessSync(executable, constants.X_OK); if (!statSync(executable).isFile() || realpathSync(executable) !== executable) throw Error('Unexpected native executable'); }
  catch { throw isolation('Native sandbox-exec is unavailable'); }
  const identity = Object.freeze({ id: 'darwin-seatbelt', revision: 1, executable });
  return {
    identity: () => identity,
    async execute() {
      // No runtime option, environment flag, caller claim or compiler result can
      // override the confirmed detached/reparented descendant containment gap.
      assertDarwinSeatbeltContainment();
    },
  };
}
