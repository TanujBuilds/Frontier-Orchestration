import { spawn } from 'node:child_process';

export function command(argv, { cwd, env = process.env, timeoutMs = 60_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Interrupted'));
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped = false, forceTimer, closed = false, exitCode, escalated = false;
    const kill = signalName => {
      try { process.kill(-child.pid, signalName); } catch { child.kill(signalName); }
    };
    const finish = () => {
      if (!closed || stopped && !escalated) return;
      clean(); resolve({ code: exitCode, stdout, stderr, stopped });
    };
    const stop = () => {
      if (stopped) return;
      stopped = true; kill('SIGTERM');
      // A parent may exit while ignored-stdio descendants still own the group.
      // Retain escalation through parent close and wait for it before returning.
      // Descendants which create another session remain outside this guarantee.
      forceTimer = setTimeout(() => {
        kill('SIGKILL');
        const deadline = Date.now() + 2000;
        const groupExited = () => {
          if (process.platform !== 'win32') {
            try { process.kill(-child.pid, 0); }
            catch (error) {
              if (error.code === 'ESRCH') { escalated = true; finish(); return; }
              // Darwin can report EPERM while a dying group's membership is
              // being removed. It is not proof of exit: retry, then fail closed.
              if (!['EPERM', 'EACCES'].includes(error.code)) { clean(); reject(error); return; }
            }
            if (Date.now() >= deadline) { clean(); reject(new Error('Stopped command process group did not exit after SIGKILL')); return; }
            forceTimer = setTimeout(groupExited, 10); return;
          }
          escalated = true; finish();
        };
        groupExited();
      }, 2000);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    const collect = field => chunk => {
      if (field === 'stdout') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 4 * 1024 * 1024) stop();
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    const clean = () => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', stop); };
    child.once('error', error => { clean(); reject(error); });
    child.once('close', code => { closed = true; exitCode = code; finish(); });
  });
}
export async function git(cwd, ...args) {
  const result = await command(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}
