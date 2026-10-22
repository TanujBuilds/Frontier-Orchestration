import assert from 'node:assert/strict';
import { summarizeJob, describeEvent, eventKind } from '../src/dashboard.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const at = new Date().toISOString();
const event = (sequence, type, data = {}) => ({ jobId: id, sequence, at, type, data });

const planning = summarizeJob(id, [event(1, 'project.plan.requested', {
  input: { brief: 'Build the Night Shift dashboard' }, source: 'Codex CLI',
})]);
assert.equal(planning?.status, 'planning', 'The initial Codex planning request must appear before a plan exists');

const checkStart = event(2, 'operation.started', { key: 'v1/interactions/local-1/checks' });
assert.match(describeEvent(checkStart, 'live') ?? '', /check/i, 'A running Mac check needs a visible description');
assert.equal(eventKind(checkStart), 'check', 'A running Mac check must be classified as a check');

console.log('dashboard events: planning and running Mac checks are visible');
