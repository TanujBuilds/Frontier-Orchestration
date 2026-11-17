import test from 'node:test';
import assert from 'node:assert/strict';
import {constants as bufferConstants} from 'node:buffer';
import {chmod,mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {fileBytes,jsonFile} from '../src/beta/files.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-m056-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,file:path.join(root,'input')};
}
const unsafe=/Unsafe file|File changed/;
const specimenPath=fileURLToPath(new URL('./fixtures/mosaic-m056-safe-files/read-specimen.mjs',import.meta.url));
async function specimen(t,scenario){
 const {root}=await fixture(t);
 const result=spawnSync(process.execPath,[specimenPath,scenario,root],{encoding:'utf8',timeout:10000,maxBuffer:65536});
 assert.equal(result.error,undefined,'owned specimen must finish before its finite deadline');
 assert.equal(result.status,0,result.stderr);
 return JSON.parse(result.stdout);
}
function closed(result){
 assert.equal(result.metrics.opened,1,'the checked file has one opened descriptor');
 assert.deepEqual(result.metrics.closed,[true],'descriptor is closed before settlement');
 assert.deepEqual(result.metrics.closedStatCodes,['EBADF']);
}

test('fileBytes preserves absent, binary, empty and exact byte limit results',async t=>{
 const {file}=await fixture(t);
 assert.equal(await fileBytes(file),null);
 assert.equal(await jsonFile(file),null);
 const binary=Buffer.from([0,255,128,10]);
 await writeFile(file,binary,{mode:0o600});
 assert.deepEqual(await fileBytes(file,{max:4}),binary);
 await assert.rejects(fileBytes(file,{max:3}),unsafe);
 await writeFile(file,'');
 assert.deepEqual(await fileBytes(file,{max:0}),Buffer.alloc(0));
 await writeFile(file,'x');
 await assert.rejects(fileBytes(file,{max:0}),unsafe);
});

test('fileBytes keeps its one MiB default and explicit finite supported limits',async t=>{
 const {file}=await fixture(t);
 await writeFile(file,Buffer.alloc(1024*1024));
 assert.equal((await fileBytes(file)).length,1024*1024);
 await writeFile(file,Buffer.alloc(1024*1024+1));
 await assert.rejects(fileBytes(file),unsafe);
 await writeFile(file,'x');
 assert.equal((await fileBytes(file,{max:bufferConstants.MAX_LENGTH-1})).toString(),'x');
 for(const max of [-1,0.5,NaN,Infinity,-Infinity,'8',null,8n,Number.MAX_SAFE_INTEGER,bufferConstants.MAX_LENGTH]){
  await assert.rejects(fileBytes(file,{max}),{name:'RangeError'});
 }
});

test('jsonFile preserves parsed scalars and content-free invalid JSON errors',async t=>{
 const {file}=await fixture(t);
 for(const [text,want] of [['{"ok":true}',{ok:true}],['false',false],['0',0],['null',null]]){
  await writeFile(file,text,{mode:0o600});
  assert.deepEqual(await jsonFile(file,{privateFile:true,max:32}),want);
 }
 for(const text of ['', 'fixture-secret-invalid-json']){
  await writeFile(file,text);
  await assert.rejects(jsonFile(file),error=>error.message==='Invalid JSON file at '+file&&!error.message.includes('fixture-secret'));
 }
 await writeFile(file,'{}');
 await assert.rejects(jsonFile(file,{max:1}),unsafe);
});

test('fileBytes applies private permissions only when requested',async t=>{
 const {file}=await fixture(t);
 await writeFile(file,'private');
 await chmod(file,0o600);
 assert.equal((await fileBytes(file,{privateFile:true})).toString(),'private');
 await chmod(file,0o640);
 assert.equal((await fileBytes(file)).toString(),'private');
 await assert.rejects(fileBytes(file,{privateFile:true}),unsafe);
});

test('fileBytes rejects directories and final symlinks including dangling links',async t=>{
 const {file,root}=await fixture(t),directory=path.join(root,'directory');
 await mkdir(directory);
 await assert.rejects(fileBytes(directory),unsafe);
 await symlink(directory,file);
 await assert.rejects(fileBytes(file),unsafe);
 await rm(file);
 await symlink(path.join(root,'missing-target'),file);
 await assert.rejects(fileBytes(file),unsafe);
});

for(const scenario of ['swap-symlink','swap-private','swap-fifo']){
 test('fileBytes rejects deterministic open-time '+scenario,{timeout:15000},async t=>{
  const result=await specimen(t,scenario);
  assert.equal(result.ok,false,'replacement must not disclose the newly substituted object');
  assert.match(result.error.message,unsafe);
  assert.doesNotMatch(result.error.message,/fixture-private-content/);
  if(scenario==='swap-symlink')assert.equal(result.metrics.opened,0);
  else closed(result);
 });
}

test('fileBytes reads the validated descriptor after its pathname is replaced',async t=>{
 const result=await specimen(t,'swap-regular');
 assert.equal(result.ok,true);
 assert.equal(result.sample,'original');
 closed(result);
});

for(const scenario of ['grow','grow-within-limit','shrink','chmod','rewrite','stamp']){
 test('fileBytes rejects observed '+scenario+' during descriptor reading',async t=>{
  const result=await specimen(t,scenario);
  assert.equal(result.ok,false,'observed mutation must reject before bytes are returned');
  assert.match(result.error.message,unsafe);
  assert.ok(result.metrics.readBytes<=9,'no more than max+1 bytes read');
  assert.ok(result.metrics.bufferLengths.every(size=>size<=9),'read allocation stays within max+1');
  closed(result);
 });
}

test('fileBytes handles short regular-file reads without truncating output',async t=>{
 const result=await specimen(t,'short-reads');
 assert.equal(result.ok,true);
 assert.equal(result.sample,'original');
 assert.ok(result.metrics.reads>=4);
 assert.equal(result.metrics.readBytes,8);
 closed(result);
});

for(const scenario of ['fifo','oversize','stat-error','read-error','final-stat-error']){
 test('fileBytes closes its descriptor on '+scenario,async t=>{
  const result=await specimen(t,scenario);
  assert.equal(result.ok,false);
  closed(result);
 });
}
