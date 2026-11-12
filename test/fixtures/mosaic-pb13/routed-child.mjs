import {writeSync} from 'node:fs';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Worker} from '../../../src/harness/worker.mjs';
import {ProviderRegistry} from '../../../src/harness/providers/registry.mjs';

const input=JSON.parse(process.argv[2]);
const c=new Coordinator({root:input.root,now:()=>input.now,selectedHost:'codex',providerRegistry:ProviderRegistry({profiles:input.profiles,credentialResolver:()=> 'dummy-bearer'})});
const owner='owned-route-worker';c.acquireWorker(owner);
if(input.point==='response-saved'){
 const save=c.saveRequest.bind(c);c.saveRequest=(...args)=>{const result=save(...args);writeSync(3,'saved\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return result;};
}else writeSync(3,'started\n');
await new Worker({c,owner,config:{environment:'fixture'}}).tick();
throw Error('Owned route child passed its crash boundary');
