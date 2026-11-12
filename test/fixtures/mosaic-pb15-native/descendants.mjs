import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

const [mode, ready, late, detached = 'false'] = process.argv.slice(2);
if (mode === 'child') {
  process.on('SIGTERM', () => {});
  writeFileSync(ready, JSON.stringify({ pid: process.pid, ppid: process.ppid, readyAt: Date.now() }));
  setTimeout(() => writeFileSync(late, 'late-owned-write'), 3500);
  setTimeout(() => {}, 15000);
} else {
  const child = spawn(process.execPath, [process.argv[1], 'child', ready, late], { detached: detached === 'true', stdio: 'ignore' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  const timer = setInterval(() => { if (existsSync(ready)) { clearInterval(timer); console.log('owned-child-ready'); } }, 10);
  setInterval(() => {}, 1000);
}
