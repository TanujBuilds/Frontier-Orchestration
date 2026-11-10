import assert from 'node:assert/strict';
import {writeSync} from 'node:fs';
import {Worker} from '../../../src/harness/worker.mjs';
import {adapters, advance, open} from './fixture.mjs';

if (!process.argv[2]) process.exit(0); // This driver needs an owned IPC pipe and fixture.
const fixture = JSON.parse(process.argv[2]);
const {taskId, point, now, token} = fixture;
const c = open(fixture, now);
c.acquireWorker(token);

// The synchronous owned IPC pipe stops even an in-progress SQLite transaction
// at the exact boundary. The parent waits for the marker before killing us.
function barrier(name, data = {}) {
  if (point !== name) return;
  writeSync(3, JSON.stringify({name, pid: process.pid, data}) + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw Error('Barrier unexpectedly resumed');
}

const worker = new Worker({
  c, owner: token,
  ...adapters(fixture.root, {
    dispatched: () => barrier('model-dispatched', {id: c.store.request(taskId, 'code-1-0').id}),
    reviewDispatched: () => {
      const key = c.getTask(taskId).checkpoint.legacyReviewKey;
      barrier('review-dispatched', {id: c.store.request(taskId, key).id});
    },
    checkStarted: label => {
      if (label === 'attempt-1') barrier('checks-in-progress');
    },
  }),
});

const reserve = c.reserve.bind(c);
c.reserve = (...args) => {
  barrier('before-reserve');
  const request = reserve(...args);
  barrier('reserved', {id: request.id});
  return request;
};

const saveRequest = c.saveRequest.bind(c);
c.saveRequest = (...args) => {
  const saved = saveRequest(...args);
  barrier('response-saved', {id: args[0]});
  return saved;
};

const boundary = c.boundary.bind(c);
c.boundary = (id, checkpoint, ...args) => {
  if (checkpoint.previousAction?.type === 'apply_changes' && checkpoint.batch === 1) barrier('edit-applied');
  return boundary(id, checkpoint, ...args);
};

const completeTask = c.completeTask.bind(c);
c.completeTask = (...args) => {
  barrier('checks-saved');
  const result = completeTask(...args);
  // Coding commits feedback cleanup and completion in an outer transaction.
  barrier('review-before-commit');
  return result;
};

const tick = worker.tick.bind(worker);
worker.tick = async (...args) => {
  const result = await tick(...args);
  if (c.getTask(taskId).status === 'awaiting_legacy_review') barrier('waiting-review');
  return result;
};

const emit = c.emit.bind(c);
c.emit = (type, goalId, id, data) => {
  if (type === 'task.integrated') barrier('pending-integration', {commit: data.commit});
  return emit(type, goalId, id, data);
};

await advance(worker, () => c.getTask(taskId).status === 'accepted');
assert.fail('Task reached acceptance before crash boundary ' + point);
