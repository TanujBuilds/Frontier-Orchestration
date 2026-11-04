import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openObserver,mergeOnboarding} from '../src/harness/personal.mjs';

async function fixture(t,value={url:'http://127.0.0.1:4332',token:'v'.repeat(64),role:'viewer'}){
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-personal-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'viewer-connection.json'),JSON.stringify(value));return root;
}
test('observer opener copies only the viewer key through stdin and opens the login-aware home',async t=>{
 const root=await fixture(t),calls=[];
 const result=await openObserver({root,run:async(...args)=>{calls.push(args);}});
 assert.deepEqual(calls,[['/usr/bin/pbcopy',[],'v'.repeat(64)],['/usr/bin/open',['http://127.0.0.1:4332/']]]);
 assert.equal(result.url,'http://127.0.0.1:4332/');assert.doesNotMatch(JSON.stringify(result),/vvvv/);
});
test('observer opener rejects operator keys, unsafe URLs and symlinked connection files before effects',async t=>{
 for(const value of [
  {url:'http://127.0.0.1:4332',role:'operator'},
  ...['https://example.com','http://localhost:4332','http://127.0.0.1:4332/private','http://127.0.0.1:4332/?key=x','http://user@127.0.0.1:4332','http://127.0.0.1:4332/#x'].map(url=>({url,role:'viewer'}))
 ]){const root=await fixture(t,{...value,token:'s'.repeat(64)});await assert.rejects(openObserver({root,run:()=>assert.fail('side effect')}),/viewer|loopback|connection/i);}
 const root=await fixture(t);await rm(path.join(root,'viewer-connection.json'));await symlink('operator.json',path.join(root,'viewer-connection.json'));await assert.rejects(openObserver({root,run:()=>assert.fail('side effect')}),/connection/i);
});
test('clipboard failure does not open browser or return sensitive subprocess output',async t=>{
 const root=await fixture(t),calls=[];
 await assert.rejects(openObserver({root,run:async(command)=>{calls.push(command);throw Error('secret subprocess output');}}),error=>!error.message.includes('secret'));
 assert.deepEqual(calls,['/usr/bin/pbcopy']);
});
const block='<!-- BEGIN FRONTIER-HARNESS ONBOARDING v1 -->\nNew onboarding\n<!-- END FRONTIER-HARNESS ONBOARDING v1 -->';
test('managed onboarding appends or replaces only its own complete block',()=>{
 assert.equal(mergeOnboarding('Personal instructions\n',block),'Personal instructions\n\n'+block+'\n');
 const old=block.replace('New onboarding','Old onboarding');
 assert.equal(mergeOnboarding('Before\n'+old+'\nAfter\n',block),'Before\n'+block+'\nAfter\n');
 assert.equal(mergeOnboarding(mergeOnboarding('Before\n',block),block),mergeOnboarding('Before\n',block));
});
test('duplicate, partial and reversed managed blocks fail without overwriting personal instructions',()=>{
 for(const old of [block+'\n'+block,block.split('\n')[0],block.split('\n')[2],block.split('\n').reverse().join('\n'),block.replaceAll('v1','v2')])assert.throws(()=>mergeOnboarding(old,block),/managed|block/i);
 assert.throws(()=>mergeOnboarding('Personal','not a managed template'),/template|block/i);
});
