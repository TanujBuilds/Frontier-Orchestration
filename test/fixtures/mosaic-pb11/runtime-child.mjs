import {writeSync} from 'node:fs';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Worker} from '../../../src/harness/worker.mjs';
import {ProviderRegistry} from '../../../src/harness/providers/registry.mjs';

if (!process.argv[2]) process.exit(0);
const input = JSON.parse(process.argv[2]);
const credentials = {'credential-a': 'dummy-provider-a-secret', 'credential-b': 'dummy-provider-b-secret'};
const c = new Coordinator({root: input.root, now: () => input.now, beta: true,
  providerRegistry: ProviderRegistry({profiles: input.profiles, credentialResolver: ref => credentials[ref]})});
const owner = 'owned-child-worker'; c.acquireWorker(owner);
const marker = () => writeSync(3, JSON.stringify({pid: process.pid}) + '\n');
if (input.point === 'response-saved') {
  const save = c.saveRequest.bind(c);
  c.saveRequest = (...args) => {
    const result = save(...args); marker();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return result;
  };
} else marker();
await new Worker({c, owner, config: {environment: 'fixture'}}).tick();
throw Error('Owned runtime fixture passed its crash boundary');
