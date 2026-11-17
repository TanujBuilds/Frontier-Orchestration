import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../src/harness/store.mjs';
import {Artifacts} from '../src/harness/artifacts.mjs';
const run=promisify(execFile),fixture=new URL('./fixtures/mosaic-artifact-read-boundaries/child.mjs',import.meta.url),MAX=32*1024*1024;
const unsafe=['over-limit','growth','name-swap','ancestor-swap','name-after-read','ancestor-after-read','same-size-change','symlink-swap','static-symlink','ancestor-symlink','directory','fifo','fifo-swap','read-error','missing'];
for(const operation of ['list','read'])for(const scenario of ['at-limit',...unsafe,...(operation==='read'?['tamper']:[])]){
 test(`${operation} ${scenario}: bounded opened-file validation preserves the catalog and safe siblings`,async()=>{
  const {stdout}=await run(process.execPath,[fixture.pathname,scenario,operation],{timeout:15000,maxBuffer:1024*1024});
  const observed=JSON.parse(stdout);
  assert.equal(observed.safeSibling,'safe sibling\n');
  assert.equal(observed.io.closed,true,'owned OS descriptors must be closed on every outcome');
  if(scenario==='at-limit'){
   assert.equal(observed.outcome,'accepted');
   const data=operation==='read'?observed.result:observed.result[0];
   assert.equal(data.bytes,MAX);assert.equal(data.name,'proposal.json');
  }else{
   assert.equal(observed.outcome,'rejected',`${scenario} served or registered unsafe/changed bytes: ${JSON.stringify(observed)}`);
   assert.equal(observed.catalogUnchanged,true,'rejected bytes cannot create or alter a verified record');
  }
  assert.ok(observed.io.readBytes<=MAX+1,'finite content reads must not exceed cap plus sentinel');
  if(['growth','name-swap','ancestor-swap','name-after-read','ancestor-after-read','same-size-change','symlink-swap','fifo-swap'].includes(scenario))assert.equal(observed.io.mutated,true,'the owned race must actually execute');
 });
}
test('saved catalog keeps exact bytes, checksum, type, names, public URL and duplicate identity',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-contract-')),store=new Store(root);
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const directory=path.join(root,'reports');await mkdir(directory);
 const screenshot=path.join(root,'screenshot.png'),bytes=Buffer.from([0,1,2,255]);
 await writeFile(screenshot,bytes);await writeFile(path.join(directory,'report.md'),'report\n');
 const task={result:{directory,checksumsVerified:true,checks:[{screenshots:[screenshot,screenshot]}]},integration:{checks:[{screenshots:[screenshot]}]}};
 const artifacts=new Artifacts({store,getTask:()=>task}),list=await artifacts.list('task');
 assert.equal(list.length,2);assert.equal(store.all('artifact').length,2);
 const image=list.find(x=>x.name==='screenshot.png');
 assert.equal(image.type,'image/png');assert.equal(image.bytes,4);assert.equal(image.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal(image.url,'/api/artifacts/'+image.id);assert.equal(image.file,undefined);
 assert.deepEqual((await artifacts.read(image.id)).data,bytes);
 assert.deepEqual(await artifacts.list('task'),list);
 await assert.rejects(artifacts.read('../arbitrary'),/Invalid|Unknown/);
 await assert.rejects(artifacts.list('task',{limit:1}),/limit/);
});
