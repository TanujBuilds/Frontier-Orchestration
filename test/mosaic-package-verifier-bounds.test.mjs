import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,chmod,symlink,open} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {digest} from '../src/harness/contracts.mjs';
import {verifyPackage} from '../src/harness/package.mjs';

const exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const manifestLimit=8*1024*1024,dependencyLimit=2*1024*1024;
const moduleUrl=new URL('../src/harness/package.mjs',import.meta.url).href;
const probe=path.join(import.meta.dirname,'fixtures/mosaic-package-verifier-bounds/probe.mjs');
async function fixture(t,items=[['data','payload']]){
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-verifier-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const files=[];
 for(const [name,body,mode] of items){const bytes=Buffer.from(body);await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),bytes);if(mode)await chmod(path.join(root,name),parseInt(mode.slice(3),8));files.push({path:name,bytes:bytes.length,sha256:sha(bytes),...(mode?{mode}:{})});}
 await save(root,files);return {root,files};
}
async function save(root,files,extra={},length){
 const json=JSON.stringify({schema:1,dependenciesInstalled:false,files,contentHash:digest(files),...extra});
 await writeFile(path.join(root,'package-manifest.json'),length?json+' '.repeat(length-Buffer.byteLength(json)):json);
}
async function run(root,scenario,target){
 const {stdout}=await exec(process.execPath,[probe,moduleUrl,root,scenario,...(target?[target]:[])],{timeout:10000,maxBuffer:1024*1024});
 const result=JSON.parse(stdout.trim());assert.equal(result.openHandles,0);assert.equal(result.openDirectories,0);return result;
}

test('manifest exact byte limit accepts and one byte over rejects',async t=>{
 const {root,files}=await fixture(t);
 await save(root,files,{},manifestLimit);assert.equal(await verifyPackage(root),true);
 await save(root,files,{},manifestLimit+1);await assert.rejects(verifyPackage(root),/manifest.*limit|metadata.*limit/i);
});
test('manifest and payload symlink swaps at open reject',async t=>{
 for(const target of ['package-manifest.json','data']){
  const {root}=await fixture(t),result=await run(root,'symlink',target);
  assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.triggered,true);assert.equal(result.openHandles,0);
 }
});
test('replacement of an opened manifest or payload rejects and closes descriptors',async t=>{
 for(const target of ['package-manifest.json','data']){
  const {root}=await fixture(t),result=await run(root,'replace',target);
  assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.triggered,true);assert.equal(result.openHandles,0);
 }
});
test('observed growth and same-size rewrite reject without leaking descriptors',async t=>{
 for(const scenario of ['grow','rewrite']){
  const {root}=await fixture(t,[['data','a'.repeat(150000)]]),result=await run(root,scenario);
  assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.triggered,true);assert.equal(result.openHandles,0);
 }
});
test('FIFO and directory manifests or payloads fail promptly',async t=>{
 for(const target of ['package-manifest.json','data'])for(const type of ['fifo','directory']){
  const {root}=await fixture(t);await rm(path.join(root,target));
  if(type==='fifo')await exec('mkfifo',[path.join(root,target)],{timeout:2000});else await mkdir(path.join(root,target));
  const result=await run(root,'plain',target);assert.equal(result.ok,false);assert.equal(result.openHandles,0);
 }
});
test('128 MiB sparse payload streams in fixed memory and rejects wrong length or checksum',{timeout:20000},async t=>{
 const {root}=await fixture(t),size=128*1024*1024,handle=await open(path.join(root,'data'),'w');
 try{await handle.truncate(size);}finally{await handle.close();}
 const zeros=Buffer.alloc(65536),hash=createHash('sha256');for(let n=0;n<size;n+=zeros.length)hash.update(zeros);
 const files=[{path:'data',bytes:size,sha256:hash.digest('hex')}];await save(root,files);
 const result=await run(root,'stream');assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.maxRead<=65536);assert.ok(result.maxBuffer<=65536);assert.equal(result.openHandles,0);
 await save(root,[{...files[0],bytes:size-1}]);assert.equal((await run(root,'stream')).ok,false);
 await save(root,[{...files[0],sha256:'0'.repeat(64)}]);assert.equal((await run(root,'stream')).ok,false);
});
test('dependency JSON exact limit accepts and one byte over rejects',async t=>{
 const lock='runtime/package-lock.json',sdk='runtime/node_modules/@modelcontextprotocol/sdk/package.json';
 const lockJson=JSON.stringify({packages:{'node_modules/@modelcontextprotocol/sdk':{version:'1.32.2'}}});
 for(const size of [dependencyLimit,dependencyLimit+1]){
  const {root,files}=await fixture(t,[[lock,lockJson+' '.repeat(size-Buffer.byteLength(lockJson))],[sdk,JSON.stringify({version:'1.32.2'})]]);
  await save(root,files,{dependenciesInstalled:true});
  if(size===dependencyLimit)assert.equal(await verifyPackage(root),true);else await assert.rejects(verifyPackage(root),/metadata.*limit|dependency.*limit/i);
 }
});
test('dependency version comparison uses the verified bytes without pathname rereads',async t=>{
 const sdk='runtime/node_modules/@modelcontextprotocol/sdk/package.json';
 const {root,files}=await fixture(t,[['runtime/package-lock.json',JSON.stringify({packages:{'node_modules/@modelcontextprotocol/sdk':{version:'1.32.2'}}})],[sdk,JSON.stringify({version:'1.32.2'})]]);
 await save(root,files,{dependenciesInstalled:true});const result=await run(root,'plain');
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.readFileCalls,0);assert.equal(result.openHandles,0);
});
test('inventory work limits reject before opening nonexistent listed payloads',async t=>{
 const {root}=await fixture(t),empty=sha('');
 const cases=[
  Array.from({length:32769},(_,n)=>({path:'f'+n,bytes:0,sha256:empty})),
  Array.from({length:16385},(_,n)=>({path:'d'+n+'/sub/data',bytes:0,sha256:empty})),
  [{path:'f',bytes:2*1024**3+1,sha256:empty}],
  Array.from({length:5},(_,n)=>({path:'f'+n,bytes:2*1024**3,sha256:empty})),
  [{path:'x'.repeat(4097),bytes:0,sha256:empty}],
  [{path:Array(65).fill('d').join('/'),bytes:0,sha256:empty}]
 ];
 for(const files of cases){await save(root,files);await assert.rejects(verifyPackage(root),/limit/i);}
});
test('extra entry detection iterates at most allowed entries plus one',async t=>{
 const {root}=await fixture(t);for(let n=0;n<100;n++)await writeFile(path.join(root,'extra'+n),'');
 const result=await run(root,'plain');assert.equal(result.ok,false);assert.match(result.message,/Unlisted/);assert.ok(result.dirEntries<=3,JSON.stringify(result));assert.equal(result.openHandles,0);
});
test('normal empty and nonempty payloads retain optional and explicit public modes',async t=>{
 const {root}=await fixture(t,[['empty',''],['plain','public','100644'],['tool','executable','100755'],['private','private','100600']]);
 assert.equal(await verifyPackage(root),true);
});
test('malformed manifests and invalid inventory contracts remain rejected',async t=>{
 const {root,files}=await fixture(t),original=files[0];
 for(const body of ['{','null','[]',JSON.stringify({schema:1,dependenciesInstalled:false,files:[]})]){
  await writeFile(path.join(root,'package-manifest.json'),body);await assert.rejects(verifyPackage(root));
 }
 for(const entry of [null,{...original,path:'/absolute'},{...original,path:'a\\b'},{...original,path:'a/../b'},{...original,path:'a/./b'},{...original,path:'a//b'},{...original,path:'a\0b'},{...original,bytes:-1},{...original,bytes:0.5},{...original,bytes:Number.MAX_SAFE_INTEGER+1},{...original,sha256:'A'.repeat(64)},{...original,mode:'100777'}]){
  await save(root,[entry]);await assert.rejects(verifyPackage(root),/Invalid package/);
 }
 await save(root,[original,original]);await assert.rejects(verifyPackage(root),/Duplicate/);
 await save(root,files,{contentHash:'0'.repeat(64)});await assert.rejects(verifyPackage(root),/manifest checksum/);
});
test('missing files, wrong mode, length, hash and symlink parents remain rejected',async t=>{
 const {root,files}=await fixture(t,[['dir/data','content','100644']]),entry=files[0];
 for(const changed of [{...entry,path:'missing'},{...entry,mode:'100755'},{...entry,bytes:0},{...entry,sha256:'0'.repeat(64)}]){
  await save(root,[changed]);await assert.rejects(verifyPackage(root));
 }
 await save(root,files);await rm(path.join(root,'dir'),{recursive:true});await symlink(os.tmpdir(),path.join(root,'dir'));await assert.rejects(verifyPackage(root),/regular directory|symlink/);
});
test('checksum and injected I/O failures close opened descriptors',async t=>{
 const {root,files}=await fixture(t);assert.equal((await run(root,'read-error')).ok,false);
 await save(root,[{...files[0],sha256:'0'.repeat(64)}]);assert.equal((await run(root,'plain')).ok,false);
});
test('growing maximum-size manifest consumes at most one overrun byte',async t=>{
 const {root,files}=await fixture(t);await save(root,files,{},manifestLimit);
 const result=await run(root,'grow','package-manifest.json');assert.equal(result.ok,false);assert.equal(result.triggered,true);assert.equal(result.readBytes,manifestLimit+1);
});
test('dependency mismatch, missing metadata and malformed JSON remain rejected',async t=>{
 const lock='runtime/package-lock.json',sdk='runtime/node_modules/@modelcontextprotocol/sdk/package.json';
 const {root,files}=await fixture(t,[[lock,JSON.stringify({packages:{'node_modules/@modelcontextprotocol/sdk':{version:'1.32.2'}}})],[sdk,JSON.stringify({version:'0.0.0'})]]);
 await save(root,files,{dependenciesInstalled:true});await assert.rejects(verifyPackage(root),/Pinned runtime dependency mismatch/);
 await save(root,files.slice(0,1),{dependenciesInstalled:true});await rm(path.join(root,'runtime/node_modules'),{recursive:true});await assert.rejects(verifyPackage(root),/ENOENT/);
 await writeFile(path.join(root,lock),'{');await save(root,[{path:lock,bytes:1,sha256:sha('{')},{path:sdk,bytes:1,sha256:sha('{')}],{dependenciesInstalled:true});await mkdir(path.dirname(path.join(root,sdk)),{recursive:true});await writeFile(path.join(root,sdk),'{');await assert.rejects(verifyPackage(root),SyntaxError);
});
test('oversized declared dependency metadata rejects before unrelated payload I/O',async t=>{
 const {root}=await fixture(t),files=[{path:'missing',bytes:0,sha256:sha('')},{path:'runtime/package-lock.json',bytes:dependencyLimit+1,sha256:sha('')}];
 await save(root,files,{dependenciesInstalled:true});await assert.rejects(verifyPackage(root),/metadata.*limit/i);
});
test('malformed JSON diagnostics omit manifest and dependency contents',async t=>{
 const {root}=await fixture(t);await writeFile(path.join(root,'package-manifest.json'),'SECRET_MANIFEST_CONTENT');
 await assert.rejects(verifyPackage(root),error=>error instanceof SyntaxError&&!/SECRET/.test(error.message)&&error.cause===undefined);
 const lock='runtime/package-lock.json',sdk='runtime/node_modules/@modelcontextprotocol/sdk/package.json';
 for(const malformed of [lock,sdk]){
  const items=[[lock,JSON.stringify({packages:{'node_modules/@modelcontextprotocol/sdk':{version:'1.32.2'}}})],[sdk,JSON.stringify({version:'1.32.2'})]].map(([name,body])=>[name,name===malformed?'SECRET_DEPENDENCY_CONTENT':body]);
  const specimen=await fixture(t,items);await save(specimen.root,specimen.files,{dependenciesInstalled:true});
  await assert.rejects(verifyPackage(specimen.root),error=>error instanceof SyntaxError&&!/SECRET/.test(error.message)&&error.cause===undefined);
 }
});
