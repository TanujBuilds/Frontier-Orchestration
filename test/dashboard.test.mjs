import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readJob } from '../src/dashboard.mjs';

test('browser timeline reads only complete persisted events', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'frontier-dashboard-'));
  const id = '11111111-1111-4111-8111-111111111111';
  try {
    await mkdir(path.join(root, 'jobs'));
    const first = { jobId: id, sequence: 1, at: '2026-10-21T00:00:00.000Z',
      type: 'job.created', data: { goal: 'Design a repair cafe intake' } };
    const second = { jobId: id, sequence: 2, at: '2026-10-21T00:00:01.000Z',
      type: 'plan.proposed', data: { planVersion: 1, plan: {
        summary: 'Paper intake plan', steps: [{ objective: 'Write intake flow' }],
      } } };
    await writeFile(path.join(root, 'jobs', id + '.jsonl'),
      JSON.stringify(first) + '\n' + JSON.stringify(second).slice(0, 40));
    const unfinished = await readJob(root, id);
    assert.equal(unfinished.job.status, 'planning');
    assert.equal(unfinished.events.length, 1);

    await writeFile(path.join(root, 'jobs', id + '.jsonl'),
      JSON.stringify(first) + '\n' + JSON.stringify(second) + '\n');
    const finished = await readJob(root, id);
    assert.equal(finished.job.status, 'awaiting_approval');
    assert.equal(finished.events.length, 2);
    assert.equal(finished.events[1].label, 'Codex → Mac: focused plan proposed');
    assert.equal(await readJob(root, '../../private'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
