import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { command, git } from '../src/project/process.mjs';
const repo = await mkdtemp(path.resolve('.data/detached-smoke-'));
await mkdir(path.join(repo, 'src')); await mkdir(path.join(repo, 'checks'));
await writeFile(path.join(repo, 'src/start.txt'), 'start');
await writeFile(path.join(repo, '.gitignore'), '.overnight-output/\ndist/\n');
await writeFile(path.join(repo, 'checks/check.mjs'), "await new Promise(resolve=>setTimeout(resolve,2000));console.log('passed');\n");
await git(repo, 'init', '-q');
await git(repo, 'config', 'user.name', 'Detached Test'); await git(repo, 'config', 'user.email', 'test@example.invalid');
await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'baseline');
const requestDir = await mkdtemp(path.resolve('.data/detached-request-'));
await writeFile(path.join(requestDir, 'brief.md'), 'Fake detached runner smoke test');
await writeFile(path.join(requestDir, 'permissions.json'), JSON.stringify({ readPaths: ['src/', 'checks/'], writePaths: ['src/'], checks: [{ id: 'test', argv: ['node', 'checks/check.mjs'] }] }));
async function cli(...args) {
  const result = await command([process.execPath, 'src/project-cli.mjs', ...args, '--json']);
  if (![0, 2].includes(result.code)) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
const plan = await cli('plan', '--repo', repo, '--brief', path.join(requestDir, 'brief.md'), '--permissions', path.join(requestDir, 'permissions.json'), '--fake');
await cli('approve', '--job', plan.jobId, '--hash', plan.planHash);
const started = await cli('run', '--job', plan.jobId, '--background');
assert.equal(started.status, 'running');
await cli('stop', '--job', plan.jobId);
async function waitDone() {
  for (let n = 0; n < 100; n++) {
    const status = await cli('status', '--job', plan.jobId);
    if (status.status !== 'running') return status;
    await delay(200);
  }
  throw new Error('Detached runner did not finish in 20 seconds');
}
assert.equal((await waitDone()).status, 'paused');
await cli('resume', '--job', plan.jobId, '--background');
const result = await waitDone();
assert.equal(result.status, 'accepted');
console.log(JSON.stringify({ jobId: plan.jobId, mode: 'fake', status: result.status, stages: result.stages.map(s => ({ id: s.id, status: s.status, localAttempts: s.localAttempts })), verified: ['detached startup', 'status', 'stop', 'resume', 'real Mac sandbox checks'] }, null, 2));
