import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatTimelineEvent, watchJournal } from '../../src/project/timeline.mjs';

const event = (sequence, type, data = {}) => ({ jobId: 'test', sequence, at: '2026-10-21T00:00:00.000Z', type, data });

test('watch replays through an earlier pause and waits for a complete live event', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-timeline-'));
  const file = path.join(dir, 'job.jsonl');
  const old = [event(1, 'run.started'), event(2, 'run.finished', { status: 'paused' }), event(3, 'run.started')];
  await writeFile(file, old.map(item => JSON.stringify(item)).join('\n') + '\n');
  const final = JSON.stringify(event(4, 'run.finished', { status: 'accepted' }));
  const seen = [];
  const pending = (async () => { for await (const item of watchJournal(file, { intervalMs: 5 })) seen.push(item); })();
  try {
    await appendFile(file, final.slice(0, 17));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(seen.map(item => item.sequence), [1, 2, 3]);
    await appendFile(file, final.slice(17) + '\n');
    await pending;
    assert.deepEqual(seen.map(item => item.sequence), [1, 2, 3, 4]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('timeline labels fake work and displays persisted handoff and review', () => {
  const sent = formatTimelineEvent(event(5, 'operation.started', {
    key: 'v1/implementation/local-1/response-0', input: { assignment: { instructions: 'Add a button' } },
  }), { mode: 'fake' });
  const reviewed = formatTimelineEvent(event(6, 'operation.completed', {
    key: 'v1/implementation/local-1/review', value: { decision: 'revise', feedback: 'Button does not click' },
  }));
  assert.match(sent, /\[FAKE\].*Coordinator → DeepSeek.*Add a button/);
  assert.match(reviewed, /Codex review.*revise.*Button does not click/);
});
