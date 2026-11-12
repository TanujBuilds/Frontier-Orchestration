import { accessSync, constants, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { command } from '../process.mjs';
import { Pause } from '../contracts.mjs';
import { CHECK_BACKEND_REVISION, validateExecution } from './contracts.mjs';

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
      const fs = { ':root': permissions.filesystem.default, ':minimal': permissions.filesystem.minimal };
      for (const rule of permissions.filesystem.rules) fs[rule.path] = rule.access;
      const fields = Object.entries(fs).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',');
      const config = `permissions.overnight={filesystem={${fields}},network={enabled=false}}`;
      return command([codex, 'sandbox', '-P', 'overnight', '-c', config, '-C', cwd, '--', ...argv], { cwd, env, timeoutMs, signal });
    },
  };
}
