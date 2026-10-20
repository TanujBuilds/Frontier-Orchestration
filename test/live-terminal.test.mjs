import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const liveScript = fileURLToPath(new URL('../src/live.mjs', import.meta.url));
async function runFake(answer) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'frontier-live-test-'));
  try {
    const briefPath = path.join(dir, 'brief.md');
    await writeFile(briefPath, 'Design a small reading club plan.');
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [liveScript, '--brief', briefPath, '--fake'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(`${answer}\n`);
    });
    const match = output.stdout.match(/Job ID: ([\w-]+)/);
    assert.ok(match, output.stdout + output.stderr);
    const log = (await readFile(path.join(dir, '.data/jobs', `${match[1]}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    return { ...output, log };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('fake terminal run prints both answers and reviews', async () => {
  const run = await runFake('y');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /DeepSeek answer \(attempt 1/);
  assert.match(run.stdout, /Codex review \(attempt 2/);
  assert.match(run.stdout, /Final status: accepted/);
  assert.equal(run.log.at(-1).data.status, 'accepted');
});

test('fake terminal rejection creates a paused job', async () => {
  const run = await runFake('n');
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stdout, /Final status: paused/);
  assert.equal(run.log.at(-1).type, 'job.paused');
  assert.equal(run.log.some((event) => event.type === 'assignment.sent'), false);
});
