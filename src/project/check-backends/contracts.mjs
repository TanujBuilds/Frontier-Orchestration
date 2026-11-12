import path from 'node:path';
import { Pause, relativePath, secretPath, matches } from '../contracts.mjs';
import { createCodexSandboxBackend } from './codex-sandbox.mjs';

export const CHECK_BACKEND_REVISION = 1;

const isolation = message => new Pause(message, 'isolation');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safePath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value);

// This is coordinator-owned policy, independent of any sandbox's syntax. Keep
// its ordered rules equivalent to the existing Codex filesystem configuration.
export async function createPolicy(workspace) {
  const root = workspace.root;
  if (!safePath(root)) throw isolation('Sandbox workspace must be an absolute path');
  const rules = new Map([
    ['/System', 'read'], ['/usr', 'read'], ['/bin', 'read'], ['/sbin', 'read'],
    ['/opt/homebrew', 'read'], ['/Library/Fonts', 'read'],
    [root, 'read'], [path.join(root, '.git'), 'deny'],
    [path.join(root, '.overnight-output'), 'write'], [path.join(root, 'dist'), 'write'],
  ]);
  const permissions = workspace.manifest?.permissions;
  if (permissions) {
    if (!Array.isArray(permissions.readPaths) || !permissions.readPaths.length) throw isolation('Invalid sandbox read policy');
    try {
      for (const scope of permissions.readPaths) relativePath(typeof scope === 'string' && scope.endsWith('/') ? scope.slice(0, -1) : scope);
    } catch { throw isolation('Invalid sandbox read policy'); }
    for (const file of Object.keys(await workspace.snapshot())) {
      try { relativePath(file); } catch { throw isolation('Invalid sandbox snapshot path'); }
      if (secretPath(file) || !matches(file, permissions.readPaths)) rules.set(path.join(root, file), 'deny');
    }
  }
  for (const name of ['.env', '.aws', '.ssh', '.codex', '.agents', '.data', '.npmrc', '.netrc', '.pypirc', '.git-credentials']) rules.set(path.join(root, name), 'deny');
  return validatePolicy({
    version: 1,
    filesystem: { default: 'deny', minimal: 'read', rules: [...rules].map(([file, access]) => ({ path: file, access })) },
    network: { enabled: false },
  });
}

export function validatePolicy(policy) {
  const fs = policy?.filesystem;
  if (!record(policy) || policy.version !== 1 || !record(fs) || fs.default !== 'deny' || fs.minimal !== 'read' ||
      !record(policy.network) || policy.network.enabled !== false ||
      !Array.isArray(fs.rules) || !fs.rules.length || fs.rules.length > 100_000) throw isolation('Invalid sandbox permissions policy');
  const paths = new Set();
  for (const rule of fs.rules) {
    if (!record(rule) || !safePath(rule.path) || !['deny', 'read', 'write'].includes(rule.access) || paths.has(rule.path)) throw isolation('Invalid sandbox filesystem rule');
    paths.add(rule.path);
  }
  return policy;
}

export function validateExecution({ argv, cwd, env, timeoutMs = 60_000, signal, permissions } = {}, workspace) {
  validatePolicy(permissions);
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !argv[0]) throw isolation('Sandbox argv must be a nonempty literal string array');
  if (!safePath(cwd) || path.resolve(cwd) !== path.resolve(workspace.root)) throw isolation('Sandbox cwd must be the approved workspace');
  if (!record(env) || Object.entries(env).some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0'))) throw isolation('Invalid sandbox environment');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) throw isolation('Invalid sandbox timeout');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw isolation('Invalid sandbox cancellation signal');
}

export function validateBackend(backend) {
  if (!backend || typeof backend.execute !== 'function' || typeof backend.identity !== 'function') throw isolation('Invalid sandbox backend interface');
  const identity = backend.identity();
  if (!record(identity) || typeof identity.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(identity.id) ||
      !Number.isInteger(identity.revision) || identity.revision < 1) throw isolation('Invalid sandbox backend identity');
  return backend;
}

export function createBackend({ id = 'codex-sandbox', workspace, options = {} } = {}) {
  if (!workspace || !safePath(workspace.root) || !record(options)) throw isolation('Invalid sandbox backend configuration');
  // darwin-seatbelt is reserved for the independently verified native backend.
  // An unavailable selector must never fall through to an ordinary process.
  if (id !== 'codex-sandbox') throw isolation(`Unsupported check backend: ${typeof id === 'string' ? id : 'invalid selector'}`);
  return validateBackend(createCodexSandboxBackend({ workspace, options }));
}
