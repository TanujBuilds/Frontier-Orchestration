import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const required=process.env.MOSAIC_REQUIRE_INSTALLED==='1';
const archive=process.env.MOSAIC_INSTALLED_ARCHIVE;
const updateArchive=process.env.MOSAIC_INSTALLED_UPDATE_ARCHIVE;
const demo=process.env.MOSAIC_INSTALLED_DEMO_ARCHIVE;
const retainedParent=process.env.MOSAIC_INSTALLED_ROOT_PARENT;
const available=Boolean(archive&&updateArchive&&demo);
const fixture=fileURLToPath(new URL('./fixtures/mosaic-pb16-installed/',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function command(argv,{env,cwd,timeoutMs=60000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(argv[0],argv.slice(1),{env,cwd,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',bytes=>{stdout+=bytes;});child.stderr.on('data',bytes=>{stderr+=bytes;});
  let escalation;const timer=setTimeout(()=>{child.kill('SIGTERM');escalation=setTimeout(()=>child.kill('SIGKILL'),45000);escalation.unref();},timeoutMs);timer.unref();child.once('error',reject);
  child.once('close',(code,signal)=>{clearTimeout(timer);clearTimeout(escalation);resolve({code,signal,stdout,stderr});});
 });
}
async function evidence(file,value){const dir=process.env.MOSAIC_INSTALLED_EVIDENCE_DIR;if(dir){await mkdir(dir,{recursive:true});await writeFile(path.join(dir,file),JSON.stringify(value,null,2)+'\n');}}

test('required installed native/browser proof has explicit release and offline project artifacts',()=>{
 if(required){assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');assert.ok(archive,'MOSAIC_INSTALLED_ARCHIVE must name the actual local release archive');assert.ok(updateArchive,'MOSAIC_INSTALLED_UPDATE_ARCHIVE must name a distinct compatible release version');assert.ok(demo,'MOSAIC_INSTALLED_DEMO_ARCHIVE must name the separately inventoried offline project artifact');assert.ok(retainedParent&&path.isAbsolute(retainedParent),'MOSAIC_INSTALLED_ROOT_PARENT must name an owned durable directory outside the checkout');}
});
for(const review of ['host','api'])test(`extracted Codex-free installed ${review} lifecycle uses native2 checks, routed repair, restart and integration`,{skip:!available&&!required,timeout:740000},async t=>{
 assert.equal(process.platform,'darwin','Installed acceptance requires actual Darwin');assert.equal(process.arch,'arm64');
 const parent=retainedParent??os.tmpdir();await mkdir(parent,{recursive:true,mode:0o700});
 const root=await realpath(await mkdtemp(path.join(parent,'Mosaic installed proof ')));
 const checkout=await realpath(fileURLToPath(new URL('../',import.meta.url)));assert.ok(root!==checkout&&!root.startsWith(checkout+path.sep),'Installed proof must execute outside the source checkout');
 let completed=false,unresolved=false;t.after(async()=>{if(completed&&!unresolved)await rm(root,{recursive:true,force:true});else await evidence(`installed-${review}-retained-root.json`,{root,completed,unresolved,reason:unresolved?'Actual installed native owner remains uncertain; preserve original approval paths, SQLite and receipts':'Failed or interrupted installed fixture retained for diagnosis; dummy fixture credentials only'});});
 const env={PATH:'/usr/bin:/bin',HOME:path.join(root,'empty home'),TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',CI:'1'};
 await mkdir(env.HOME,{mode:0o700});
 const extracted=await command(['/usr/bin/tar','-xzf',archive,'-C',root],{env});assert.equal(extracted.code,0,extracted.stderr);
 const list=await command(['/usr/bin/tar','-tzf',archive],{env});assert.equal(list.code,0,list.stderr);
 const stem=list.stdout.split('\n').find(Boolean).split('/')[0],bundle=path.join(root,stem);
 const next=await command(['/usr/bin/tar','-xzf',updateArchive,'-C',root],{env});assert.equal(next.code,0,next.stderr);
 const nextList=await command(['/usr/bin/tar','-tzf',updateArchive],{env});assert.equal(nextList.code,0,nextList.stderr);
 const nextStem=nextList.stdout.split('\n').find(Boolean).split('/')[0];assert.notEqual(nextStem,stem,'Update proof needs a distinct version');
 await mkdir(path.join(root,'offline project inputs'),{mode:0o700});
 const inputs=await command(['/usr/bin/tar','-xzf',demo,'-C',path.join(root,'offline project inputs')],{env,timeoutMs:90000});assert.equal(inputs.code,0,inputs.stderr);
 const driver=path.join(root,'installed driver');await cp(fixture,driver,{recursive:true});
 // The child has no source directory or developer environment. Only the test
 // harness is copied; its project and dependencies come from the separate tar.
 await rm(path.join(driver,'project'),{recursive:true,force:true});
 const result=await command([path.join(bundle,'payload/runtime/bin/node'),path.join(driver,'run.mjs'),bundle,path.join(root,'run'),path.join(root,'offline project inputs'),review,path.join(root,nextStem)],{env,cwd:root,timeoutMs:680000});
 await evidence(`installed-${review}-process.json`,{...result,archiveSha256:sha(await readFile(archive)),updateArchiveSha256:sha(await readFile(updateArchive)),demoSha256:sha(await readFile(demo))});
 for(const name of ['failure','interruption','cleanup']){try{await evidence(`installed-${review}-${name}.json`,JSON.parse(await readFile(path.join(root,'run/installed-'+name+'.json'),'utf8')));}catch{}}
 assert.equal(result.code,0,result.stderr+'\n'+result.stdout);
 const summary=JSON.parse(result.stdout.trim().split('\n').at(-1));
 assert.equal(summary.fixtureOnly,true);assert.equal(summary.liveCallsMade,false);assert.equal(summary.sourceImports,false);assert.equal(summary.codexAbsent,true);
 assert.equal(summary.usefulAccepted,2);assert.equal(summary.parallel.maxActive,2);assert.equal(summary.parallel.sharedCapacityBlocked,true);
 assert.deepEqual(summary.tasks.map(task=>task.providerId),['worker-a','worker-b']);
 assert.equal(summary.protectedChecks.failedBytes,44);assert.equal(summary.protectedChecks.correctedBytes,33);assert.equal(summary.protectedChecks.unchanged,true);assert.equal(summary.protectedChecks.repairedOnOriginalProvider,true);
 assert.deepEqual(summary.restartBoundaries,['saved-response','applied-edits','failed-check','stopped-pending-review','accepted-replay']);
 assert.ok(summary.native.passingChecks>0);assert.equal(summary.native.allFingerprintsBound,true);assert.equal(summary.replay.noExtraPost,true);assert.equal(summary.replay.exactlyOnce,true);
 assert.equal(summary.hostClosed.noFallback,true);assert.equal(summary.failureStatuses.unreachableWorker,true);assert.equal(summary.failureStatuses.malformedReview,true);
 assert.equal(summary.uncertain.heldAfterRestart,true);assert.equal(summary.uncertain.sameScopeBlocked,true);assert.equal(summary.uncertain.noDuplicateLaunch,true);
 assert.equal(summary.uncertain.owner.status,'uncertain');unresolved=true;
 assert.equal(summary.lifecycle.discovery,true);assert.equal(summary.lifecycle.uninstallOwnership,true);assert.equal(summary.lifecycle.update,true);assert.equal(summary.lifecycle.compatibleRollback,true);assert.equal(summary.lifecycle.offOnRetained,true);assert.equal(summary.failureStatuses.missingHost,true);
 assert.equal(summary.lifecycle.stoppedApprovalUpdate.passed,true);assert.notEqual(summary.lifecycle.stoppedApprovalUpdate.oldVersion,summary.lifecycle.stoppedApprovalUpdate.newVersion);assert.notEqual(summary.uncertain.deniedUpdate.code,0);
 await evidence(`installed-${review}-summary.json`,summary);
 if(process.env.MOSAIC_INSTALLED_EVIDENCE_DIR)await cp(path.join(root,'run/uncertainty-evidence'),path.join(process.env.MOSAIC_INSTALLED_EVIDENCE_DIR,`installed-${review}-uncertain-state`),{recursive:true});
 completed=true;
});
