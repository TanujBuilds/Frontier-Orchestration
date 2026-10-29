import test from 'node:test';
import assert from 'node:assert/strict';
import { selectContext } from '../src/harness/context.mjs';
import { Workspace } from '../src/project/workspace.mjs';
import { mkdtemp,mkdir,writeFile,symlink,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'working-set-'));t.after(()=>rm(root,{recursive:true,force:true}));const w=new Workspace({permissions:{readPaths:['src/'],writePaths:[]}}, {dir:root,id:'fixture'});await mkdir(path.join(w.root,'src'),{recursive:true});return w;}
test('context retains newest requested paths, evicts oldest deterministically, and bounds checkpoint metadata',async t=>{
 const w=await fixture(t);for(const p of ['a','b','c','d','e'])await writeFile(path.join(w.root,'src',p),'x'.repeat(128*1024));
 let cp={executionBase:'base',paths:['src/a','src/b']};let a=await selectContext(w,cp,[]);cp.workingSet=a.workingSet;
 a=await selectContext(w,cp,[],['src/c']);cp.workingSet=a.workingSet;
 a=await selectContext(w,cp,[],['src/d']);assert.deepEqual(a.files.map(f=>f.path),['src/d','src/c','src/a']);assert.deepEqual(a.evicted,['src/b']);
 assert.ok(Buffer.byteLength(JSON.stringify(a.files))<=512*1024);assert.ok(a.workingSet.entries.every(e=>Object.keys(e).sort().join(',')==='hash,path'));
 await assert.rejects(selectContext(w,cp,[],['src/a','src/b','src/c','src/d']),/512 KiB/);
});
test('current content hashes refresh, missing/deleted files remain explicit, new base clears old selection',async t=>{
 const w=await fixture(t);await writeFile(path.join(w.root,'src/a'),'before');let cp={executionBase:'base',paths:['src/a']};let a=await selectContext(w,cp,[]);cp.workingSet=a.workingSet;const old=a.files[0].hash;
 await writeFile(path.join(w.root,'src/a'),'after');a=await selectContext(w,cp,[],['src/new']);assert.equal(a.files[0].content,null);assert.equal(a.files[0].hash,null);assert.notEqual(a.files[1].hash,old);assert.equal(a.files[1].content,'after');
 a=await selectContext(w,{...cp,executionBase:'new',paths:undefined},[{path:'src/new'}]);assert.deepEqual(a.files.map(f=>f.path),['src/new']);
});
test('explicit requests preserve existing scope, directory, secret, binary, symlink and per-file bounds',async t=>{
 const w=await fixture(t);await writeFile(path.join(w.root,'src/binary'),Buffer.from([0]));await writeFile(path.join(w.root,'src/big'),'x'.repeat(128*1024+1));await symlink('big',path.join(w.root,'src/link'));await writeFile(path.join(w.root,'src/.env'),'secret');
 for(const p of ['outside','src/','src','src/.env','src/binary','src/big','src/link'])await assert.rejects(selectContext(w,{executionBase:'base'},[],[p]),undefined,p);
});
test('scope revision prunes only previously retained unreadable paths, never explicit requests',async t=>{
 const w=await fixture(t);await writeFile(path.join(w.root,'src/a'),'allowed');const cp={executionBase:'base',workingSet:{version:1,executionBase:'base',entries:[{path:'old/a',hash:'old'},{path:'src/a',hash:'old'}]}};
 const selected=await selectContext(w,cp,[]);assert.deepEqual(selected.files.map(f=>f.path),['src/a']);assert.deepEqual(selected.evicted,['old/a']);await assert.rejects(selectContext(w,cp,[],['old/a']),/outside approved/);
});
