import { spawn } from 'node:child_process';

export function command(argv, { cwd, env = process.env, timeoutMs = 60_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Interrupted'));
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped = false, forceTimer;
    const kill = signalName => {
      try { process.kill(-child.pid, signalName); } catch { child.kill(signalName); }
    };
    const stop = () => { stopped = true; kill('SIGTERM'); forceTimer ??= setTimeout(() => kill('SIGKILL'), 2000); };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    const collect = field => chunk => {
      if (field === 'stdout') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 4 * 1024 * 1024) stop();
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    const clean = () => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', stop); };
    child.once('error', error => { clean(); reject(error); });
    child.once('close', code => { clean(); resolve({ code, stdout, stderr, stopped }); });
  });
}
export async function git(cwd, ...args) {
  const result = await command(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}
