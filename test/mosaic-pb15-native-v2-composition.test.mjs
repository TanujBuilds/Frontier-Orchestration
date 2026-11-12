import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {command} from '../src/project/process.mjs';
const supported=process.platform==='darwin'&&process.arch==='arm64';
const required=process.env.MOSAIC_REQUIRE_NATIVE==='1';
const available=supported&&Boolean(process.env.MOSAIC_NATIVE_TEST_NODE);
const fixture=fileURLToPath(new URL('./fixtures/mosaic-pb15-v2-composition/run.mjs',import.meta.url));
function environment(){return {PATH:'/usr/bin:/bin',TMPDIR:os.tmpdir(),MOSAIC_NATIVE_TEST_NODE:process.env.MOSAIC_NATIVE_TEST_NODE,...(process.env.MOSAIC_NATIVE_TEST_LICENSE?{MOSAIC_NATIVE_TEST_LICENSE:process.env.MOSAIC_NATIVE_TEST_LICENSE}:{})};}
async function rootFor(t){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'mosaic-pb15-native-composition-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function evidence(name,result){if(process.env.MOSAIC_NATIVE_EVIDENCE_DIR){await mkdir(process.env.MOSAIC_NATIVE_EVIDENCE_DIR,{recursive:true});await writeFile(path.join(process.env.MOSAIC_NATIVE_EVIDENCE_DIR,name),JSON.stringify(result,null,2)+'\n');}}

test('required native composition has an explicit supported built runtime',()=>{if(required)assert.ok(available,'MOSAIC_REQUIRE_NATIVE=1 needs Darwin arm64 and explicit MOSAIC_NATIVE_TEST_NODE');});
for(const review of ['host','api'])test(`actual native2 Codex-free ${review} review composes routed repair, Chromium, restart and serialized integration`,{skip:!available&&!required,timeout:300000},async t=>{
 const root=await rootFor(t),result=await command([process.execPath,fixture,path.join(root,'run'),review],{env:environment(),timeoutMs:285000});
 await evidence('native-v2-'+review+'-process.json',result);
 assert.equal(result.code,0,result.stderr+'\n'+result.stdout);
 const summary=JSON.parse(result.stdout.trim().split('\n').at(-1));
 assert.equal(summary.usefulAccepted,2);assert.equal(summary.native.codexAbsent,true);assert.equal(summary.native.realFactory,true);assert.ok(summary.native.quiescentExecutions>0);
 assert.equal(summary.native.protectedCheckHash,'c4d9bac20d9fe9653505d4c60d3d5e417a2ab38950a56a21497e2dfce814fd72');
 assert.deepEqual(summary.tasks.map(task=>task.worker.providerId),['worker-a','worker-b']);
 assert.equal(summary.protectedChecks.failedFirst,true);assert.equal(summary.replay.noExtraPost,true);assert.equal(summary.liveCallsMade,false);
 assert.deepEqual(summary.native.restartBoundaries,['saved-response','applied-edits','failed-check','stopped-pending-review','accepted-replay']);
 assert.ok(summary.tasks.every(task=>/^[a-f0-9]{40}$/.test(task.commit)));
 await evidence('native-v2-'+review+'-summary.json',summary);
});

for(const variant of ['missing-manifest','changed-node','wrong-fingerprint','stock-node'])test(`native2 prerequisite ${variant} blocks actual activation with zero worker/planner/reviewer POST`,{skip:!available&&!required,timeout:90000},async t=>{
 const root=await rootFor(t),script=fileURLToPath(new URL('./fixtures/mosaic-pb15-v2-composition/prerequisite.mjs',import.meta.url));
 const result=await command([process.execPath,script,path.join(root,'run'),variant],{env:environment(),timeoutMs:80000});
 await evidence('native-v2-'+variant+'-process.json',result);assert.equal(result.code,0,result.stderr+'\n'+result.stdout);
 const summary=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(summary.blocked,true);assert.equal(summary.posts,0);
 if(variant==='stock-node')assert.match(summary.reason,/probe|spawn|isolat|runtime|supervisor|quiescen|permission/i);
 await evidence('native-v2-'+variant+'-summary.json',summary);
});

test('actual supervisor loss preserves uncertain owner, pins, spending and capacity across restart', {skip:!available&&!required,timeout:90000},async t=>{
 const root=await rootFor(t),script=fileURLToPath(new URL('./fixtures/mosaic-pb15-v2-composition/uncertain.mjs',import.meta.url));
 const result=await command([process.execPath,script,path.join(root,'run')],{env:environment(),timeoutMs:80000});
 await evidence('native-v2-uncertain-process.json',result);assert.equal(result.code,0,result.stderr+'\n'+result.stdout);
 const summary=JSON.parse(result.stdout.trim().split('\n').at(-1));
 assert.equal(summary.actualFactory,true);assert.equal(summary.heldAfterRestart,true);assert.equal(summary.noDuplicateLaunch,true);assert.equal(summary.changedHelperRejected,true);
 await evidence('native-v2-uncertain-summary.json',summary);
});
