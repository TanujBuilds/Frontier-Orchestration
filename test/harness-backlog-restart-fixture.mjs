import {writeSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';

const [root, clock, scenario] = process.argv.slice(2);
// The node:test discovery path must not start a coordinator or wait for input.
if (root && clock && scenario) {
  const {Backlog} = await import('../src/harness/backlog/service.mjs');
  const c = new Coordinator({root, now: () => Number(clock)});
  const owner = 'backlog-child';
  const calls = [];
  const worker = new Worker({
    c, owner, config: {environment: 'fixture'},
    provider: {async complete(messages) {
      calls.push(JSON.parse(messages.at(-1).content).task.objective);
      return {model: 'fixture', content: 'Durable fixture response'};
    }},
  });

  const send = value => writeSync(1, JSON.stringify(value) + '\n');
  if (scenario === 'crash') c.acquireWorker(owner);
  const input = createInterface({input: process.stdin});
  try {
    send({ready: true});
    for await (const line of input) {
      const {submission, commandKey} = JSON.parse(line);
      const backlog = new Backlog({c, worker});
      if (scenario === 'crash') {
        const group = await backlog.submit(submission, commandKey);
        const saveRequest = c.saveRequest.bind(c);
        c.saveRequest = (...args) => {
          const result = saveRequest(...args);
          // The real transaction committed. Hold the owned child before the
          // worker can finish the task or consider another group item.
          send({group, calls, requestId: args[0]});
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          throw Error('Crash barrier unexpectedly resumed');
        };
        await worker.tick();
        throw Error('Worker did not reach the durable response barrier');
      }

      let result;
      try {
        result = {group: await backlog.submit(submission, commandKey)};
      } catch (error) {
        result = {error: error.message};
      }
      try {
        c.acquireWorker(owner);
        c.releaseWorker(owner);
      } catch (error) {
        result.leaseError = error.message;
      }
      send(result);
      break;
    }
  } finally {
    input.close();
    c.close();
  }
}
