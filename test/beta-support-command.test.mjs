import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,realpath,mkdir,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const exec=promisify(execFile);
const cli=new URL('../src/beta/cli.mjs',import.meta.url).pathname;
const run=(...args)=>exec(process.execPath,[cli,...args],{timeout:15000,maxBuffer:300000});

async function fixture(t){
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'mosaic-support-command-')));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const root=path.join(home,'Library','Application Support','Mosaic Beta');
 const config=path.join(root,'config'),output=path.join(root,'output');
 await mkdir(config,{recursive:true,mode:0o700});
 await mkdir(output,{mode:0o700});
 await writeFile(path.join(config,'settings.json'),JSON.stringify({schema:2,host:{id:'codex',target:'PRIVATE_COMMAND_SENTINEL'}}),{mode:0o600});
 return {home,root,output};
}

test('support command requires an explicit home before reading configuration',async()=>{
 await assert.rejects(run('support-bundle'),error=>{
  assert.equal(error.code,2);assert.equal(error.stdout,'');
  assert.match(error.stderr,/USAGE: --home ABS/);
  return true;
 });
});

test('support command exposes the sanitized offline preview through the product CLI',async t=>{
 const {home,root}=await fixture(t);
 const before=await readFile(path.join(root,'config/settings.json'));
 const {stdout}=await run('support-bundle','--home',home);
 const bundle=JSON.parse(stdout);
 assert.equal(bundle.kind,'mosaic-redacted-support');
 assert.equal(bundle.local.settings.host,'codex');
 assert.equal(bundle.collection.status,'unavailable');
 assert.ok(bundle.diagnostics.includes('VIEWER_ABSENT'));
 assert.doesNotMatch(stdout,/PRIVATE_COMMAND_SENTINEL/);
 assert.ok(!stdout.includes(home));
 assert.deepEqual(await readFile(path.join(root,'config/settings.json')),before);
 await assert.rejects(lstat(path.join(root,'state')),error=>error.code==='ENOENT');
});

test('explicit global home writes the preview once and preserves existing output',async t=>{
 const {home,output}=await fixture(t),file=path.join(output,'bundle.json');
 const {stdout}=await run('--home',home,'support-bundle','--output',file);
 assert.equal(await readFile(file,'utf8'),stdout);
 assert.equal((await lstat(file)).mode&0o777,0o600);
 await assert.rejects(run('--home',home,'support-bundle','--output',file),error=>{
  assert.equal(error.code,2);assert.match(error.stderr,/OUTPUT_EXISTS/);
  assert.equal(error.stdout,stdout);return true;
 });
 assert.equal(await readFile(file,'utf8'),stdout);
});
