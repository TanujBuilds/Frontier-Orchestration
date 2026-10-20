import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FakeFrontier, FakeLocal } from './adapters/fake.mjs';
import { runJob } from './coordinator.mjs';
import { JsonlJobStore } from './store.mjs';

const goal = process.argv.slice(2).join(' ').trim() || 'Fix a small bug and explain the change';
const store = new JsonlJobStore(path.resolve('.data/jobs'));

console.log('FAKE MODEL DEMO — no model calls, file edits, or checks will run.');
const result = await runJob({
  goal,
  frontier: new FakeFrontier(),
  local: new FakeLocal(),
  store,
  approvePlan: async (plan) => {
    console.log(`Plan: ${plan.summary}`);
    console.log('Demo mode accepts this plan automatically.');
    return true;
  },
});

console.log(`Job ${result.jobId}: ${result.status}`);
const eventFile = path.resolve(`.data/jobs/${result.jobId}.jsonl`);
const events = (await readFile(eventFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
console.log(events.map((event) => event.type).join(' → '));
console.log(`Events: .data/jobs/${result.jobId}.jsonl`);
