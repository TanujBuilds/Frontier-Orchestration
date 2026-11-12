import {writeSync} from 'node:fs';
import {open} from './runtime.mjs';
if(!process.argv[2])process.exit(0);
const input=JSON.parse(process.argv[2]),{c,worker}=open(input.root,input.profiles,{owner:'owned-parallel-child'});
if(input.point==='response-saved'){
 const save=c.saveRequest.bind(c);c.saveRequest=(...args)=>{const result=save(...args);writeSync(3,JSON.stringify({point:input.point,requestId:args[0],pid:process.pid})+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return result;};
}
writeSync(3,JSON.stringify({point:'started',pid:process.pid})+'\n');
for(let n=0;n<20;n++)await worker.tick();
throw Error('Owned parallel child passed crash boundary');
