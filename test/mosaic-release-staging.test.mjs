import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm,copyFile,chmod,readdir,symlink,open} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {fixture,sha,digest,gates} from './fixtures/portable-release-evidence/fixture.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
const modulePath=new URL('../scripts/release/build-reviewed-candidate.mjs',import.meta.url);
const load=async()=>{const api=await import(modulePath).catch(()=>({}));assert.equal(typeof api.stageReviewedCandidate,'function','staging API must exist');return api;};
async function setup(t){
 const f=await fixture();t.after(async()=>{if(f.options){const owner=await readFile(path.join(f.options.output,'OWNER.json'),'utf8').then(JSON.parse).catch(()=>null);if(owner?.temporaryRoot)await rm(owner.temporaryRoot,{recursive:true,force:true});}await rm(f.root,{recursive:true,force:true});});
 for(const p of ['THIRD_PARTY_NOTICES.md','docs/DISTRIBUTION_PROVENANCE.md','scripts/release/verify-portable-candidate.mjs','distribution/archive/install.sh']){
  await mkdir(path.dirname(path.join(f.source,p)),{recursive:true});await copyFile(path.join(repo,p),path.join(f.source,p));
 }
 const artifact=path.join(f.root,'native artifact'),cache=path.join(f.root,'owned npm cache');await mkdir(artifact);await mkdir(cache,{mode:0o700});
 const nativeBytes=Buffer.from('{"fixture":"inert manifest"}\n');await writeFile(path.join(artifact,'artifact-manifest.json'),nativeBytes);
 await writeFile(path.join(artifact,'node'),'inert native check runtime\n');
 const node=path.join(f.root,"ordinary node's input"),license=path.join(f.root,'node license');
 await writeFile(node,'inert coordinator input\n');await writeFile(license,'inert license\n');
 f.git('add','.');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','staging fixture inputs');
 const commit=f.git('rev-parse','HEAD'),tree=f.git('rev-parse','HEAD^{tree}');f.c.source.commit=commit;f.c.source.tree=tree;
 f.c.fixture=false;f.manifest.fixture=false;f.manifest.layout='terminal-beta-v2';
 f.c.versions.checkNode='24.22.0';f.manifest.nativeCheckArtifact={fingerprint:sha(nativeBytes),backend:{id:'darwin-seatbelt',revision:2}};
 f.c.verification.nativePreflight={backend:{id:'darwin-seatbelt',revision:2},runtimeFingerprint:sha(nativeBytes),childProcessWorks:true,quiescent:true,kernelContainment:true};
 for(const [p,b,mode] of [['runtime/bin/node',await readFile(node),'100755'],['runtime/NODE-LICENSE',await readFile(license),'100644'],['runtime/check-artifact/artifact-manifest.json',nativeBytes,'100600'],['runtime/THIRD_PARTY_NOTICES.md',await readFile(path.join(f.source,'THIRD_PARTY_NOTICES.md')),'100644'],['runtime/docs/DISTRIBUTION_PROVENANCE.md',await readFile(path.join(f.source,'docs/DISTRIBUTION_PROVENANCE.md')),'100644']]){
  f.payload.set(p,b);const r={path:p,sha256:sha(b),bytes:b.length,mode};const i=f.manifest.files.findIndex(v=>v.path===p);if(i<0)f.manifest.files.push(r);else f.manifest.files[i]=r;
 }
 f.manifest.files.sort((a,b)=>a.path<b.path?-1:1);f.manifest.contentHash=digest(f.manifest.files);
 f.c.build.runtimeInputs=f.manifest.files.filter(r=>['runtime/bin/node','runtime/NODE-LICENSE','runtime/check-artifact/artifact-manifest.json'].includes(r.path));
 await f.saveArchive();
 f.recordsFile=path.join(f.evidenceRoot,'records.json');await writeFile(f.recordsFile,JSON.stringify({records:f.index.records}));
 f.options={source:f.source,expectedCommit:commit,expectedTree:tree,version:f.c.version,node,nodeSha256:sha(await readFile(node)),nodeLicense:license,nodeLicenseSha256:sha(await readFile(license)),checkArtifact:artifact,nativeManifestSha256:sha(nativeBytes),evidenceRoot:f.evidenceRoot,evidenceRecords:f.recordsFile,evidenceRecordsSha256:sha(await readFile(f.recordsFile)),npmCache:cache,output:path.join(f.root,"new stage's $(touch NEVER) `literal`" )};
 f.calls=[];f.run=async request=>{
  f.calls.push(request);
  if(request.phase==='build'){
   const out=request.args[request.args.indexOf('--output')+1];await copyFile(f.archive,path.join(out,path.basename(f.archive)));await copyFile(f.candidate,path.join(out,f.stem+'.candidate.json'));await writeFile(path.join(out,path.basename(f.archive)+'.sha256'),f.c.archive.sha256+'  '+path.basename(f.archive)+'\n');return;
  }
  const {runStagingChild}=await load();return runStagingChild(request);
 };
 return f;
}
const absent=async p=>assert.rejects(readFile(p),{code:'ENOENT'});
test('composition binds exact source/runtime/evidence and preserves immutable pending gates',async t=>{
 const f=await setup(t),{stageReviewedCandidate}=await load(),before=await readFile(f.candidate);
 const result=await stageReviewedCandidate(f.options,{run:f.run});
 assert.equal(result.status,'integrity-verified-readiness-pending');assert.equal(result.releaseAuthority,false);
 const sidecar=JSON.parse(await readFile(path.join(f.options.output,'reports/portable-evidence.json')));
 assert.equal(sidecar.integrity.status,'verified');assert.deepEqual(sidecar.candidate.originalUnpassedGates,gates);assert.ok(sidecar.externalGates.every(g=>g.status==='pending'));
 assert.deepEqual(await readFile(f.candidate),before);assert.deepEqual(await readFile(path.join(f.options.output,'build',f.stem+'.candidate.json')),before);
 assert.equal(f.calls[0].phase,'build');assert.ok(f.calls[0].args.includes('--offline'));assert.ok(!f.calls[0].args.includes('--fixture'));assert.equal(f.calls[1].phase,'verify');
 const index=JSON.parse(await readFile(path.join(f.options.output,'evidence-index.json')));assert.equal(index.binding.candidateSha256,sha(before));assert.deepEqual(index.records,f.index.records);
 assert.equal(result.nextStep.argv[0],path.join(f.source,'distribution/archive/install.sh'));assert.ok(result.nextStep.argv.includes(f.c.archive.sha256));assert.ok(result.nextStep.requiresIndependentlyTrustedDigest);
 assert.ok(!JSON.stringify(result).includes('PRIVATE-TRANSCRIPT'));assert.equal(f.git('status','--porcelain'),'');
});
test('builder environment resolves installed npm offline without reading personal configuration',async t=>{
 const f=await setup(t),{stageReviewedCandidate}=await load();await stageReviewedCandidate(f.options,{run:f.run});
 const env=f.calls[0].env;const r=spawnSync('npm',['--version'],{env,encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/^\d+\.\d+\.\d+/);
 assert.equal(env.npm_config_offline,'true');assert.notEqual(env.npm_config_userconfig,env.npm_config_globalconfig);assert.equal(await readFile(env.npm_config_userconfig,'utf8'),'');assert.equal(await readFile(env.npm_config_globalconfig,'utf8'),'');assert.equal(env.TMPDIR,JSON.parse(await readFile(path.join(f.options.output,'OWNER.json'))).temporaryRoot);
});
test('missing notices and evidence fail before builder and do not claim output ownership',async t=>{
 for(const p of ['THIRD_PARTY_NOTICES.md','docs/DISTRIBUTION_PROVENANCE.md','evidence']){
  const f=await setup(t),{stageReviewedCandidate}=await load();await rm(p==='evidence'?f.recordsFile:path.join(f.source,p));
  await assert.rejects(stageReviewedCandidate(f.options,{run:f.run}));assert.equal(f.calls.length,0);await absent(path.join(f.options.output,'STATUS.json'));
 }
});
test('stale source, runtime, native and evidence pins fail before expensive operations',async t=>{
 for(const field of ['expectedCommit','expectedTree','nodeSha256','nodeLicenseSha256','nativeManifestSha256','evidenceRecordsSha256']){
  const f=await setup(t),{stageReviewedCandidate}=await load();f.options[field]='0'.repeat(field.startsWith('expected')?40:64);
  await assert.rejects(stageReviewedCandidate(f.options,{run:f.run}));assert.equal(f.calls.length,0);
 }
});
test('Git assume-unchanged cannot hide altered builder code before execution',async t=>{
 const f=await setup(t),{stageReviewedCandidate}=await load();f.git('update-index','--assume-unchanged','scripts/package-beta.mjs');await writeFile(path.join(f.source,'scripts/package-beta.mjs'),'// altered executable source\n');assert.equal(f.git('status','--porcelain'),'');
 await assert.rejects(stageReviewedCandidate(f.options,{run:f.run}));assert.equal(f.calls.length,0,'raw source pins must be checked before the builder can execute');
});
test('pre-existing outputs, overlapping source and symlink roots preserve unrelated bytes',async t=>{
 for(const kind of ['exists','overlap','symlink']){
  const f=await setup(t),{stageReviewedCandidate}=await load();const keep=path.join(f.root,'keep');await writeFile(keep,'unchanged');
  if(kind==='exists'){await mkdir(f.options.output);await writeFile(path.join(f.options.output,'keep'),'existing');}
  if(kind==='overlap')f.options.output=path.join(f.source,'new-output');
  if(kind==='symlink'){const alias=path.join(f.root,'linked');await symlink(f.evidenceRoot,alias);f.options.evidenceRoot=alias;}
  await assert.rejects(stageReviewedCandidate(f.options,{run:f.run}));assert.equal(f.calls.length,0);assert.equal(await readFile(keep,'utf8'),'unchanged');
  if(kind==='exists')assert.equal(await readFile(path.join(f.options.output,'keep'),'utf8'),'existing');
 }
});
test('builder and verifier failure retain owned artifacts and never publish a successful recipe',async t=>{
 for(const phase of ['build','verify']){
  const f=await setup(t),{stageReviewedCandidate}=await load();const run=async req=>{if(req.phase===phase){await writeFile(path.join(f.options.output,'partial'),'retained');throw Error('PRIVATE-TRANSCRIPT');}return f.run(req);};
  await assert.rejects(stageReviewedCandidate(f.options,{run}),/staging_/);assert.equal(await readFile(path.join(f.options.output,'partial'),'utf8'),'retained');
  const status=JSON.parse(await readFile(path.join(f.options.output,'STATUS.json')));assert.equal(status.status,'failed-retained');assert.equal(status.phase,phase);assert.ok(!JSON.stringify(status).includes('PRIVATE-TRANSCRIPT'));await absent(path.join(f.options.output,'STAGING.json'));
 }
});
test('changed archive bytes or candidate source pins reject before verifier and any installer',async t=>{
 for(const kind of ['archive','source','runtime']){
  const f=await setup(t),{stageReviewedCandidate}=await load();const run=async req=>{await f.run(req);if(req.phase==='build'){if(kind==='archive')await writeFile(path.join(f.options.output,'build',path.basename(f.archive)),'wrong');else{const c=structuredClone(f.c);if(kind==='source')c.source.commit='f'.repeat(40);else c.build.runtimeInputs[0].sha256='f'.repeat(64);await writeFile(path.join(f.options.output,'build',f.stem+'.candidate.json'),JSON.stringify(c));}}};
  await assert.rejects(stageReviewedCandidate(f.options,{run}));assert.equal(f.calls.length,1);await absent(path.join(f.options.output,'STAGING.json'));
 }
});
test('finite regular metadata reads refuse FIFO and oversized records without spawning',async t=>{
 for(const kind of ['fifo','size']){
  const f=await setup(t),{stageReviewedCandidate}=await load();await rm(f.recordsFile);
  if(kind==='fifo')assert.equal(spawnSync('/usr/bin/mkfifo',[f.recordsFile]).status,0);else{const h=await open(f.recordsFile,'w');await h.truncate(2*1024*1024+1);await h.close();}
  await assert.rejects(stageReviewedCandidate(f.options,{run:f.run}));assert.equal(f.calls.length,0);
 }
});
test('builder copies factual notices including supplemental upstream texts as inventoried regular files',async t=>{
 const f=await setup(t);const api=await import('../scripts/package-beta.mjs');assert.equal(typeof api.copyRequiredAssets,'function');
 const out=path.join(f.root,'copied runtime');await mkdir(out);await api.copyRequiredAssets(repo,out);
 for(const p of ['THIRD_PARTY_NOTICES.md','docs/DISTRIBUTION_PROVENANCE.md'])assert.deepEqual(await readFile(path.join(out,p)),await readFile(path.join(repo,p)));
 const notices=await readFile(path.join(out,'THIRD_PARTY_NOTICES.md'),'utf8');assert.ok(notices.includes('Copyright 2016 the V8 project authors.'));assert.ok(notices.includes('Copyright (C) 1993 by Sun Microsystems, Inc.'));
});
test('a self-consistent builder output cannot omit or substitute the required notices',async t=>{
 for(const kind of ['missing','substituted']){
  const f=await setup(t),{stageReviewedCandidate}=await load();const p='runtime/THIRD_PARTY_NOTICES.md';
  if(kind==='missing')f.manifest.files.splice(f.manifest.files.findIndex(r=>r.path===p),1);
  else{const b=Buffer.from('incomplete notices\n');f.payload.set(p,b);Object.assign(f.manifest.files.find(r=>r.path===p),{sha256:sha(b),bytes:b.length});}
  f.manifest.contentHash=digest(f.manifest.files);await f.saveArchive();
  await assert.rejects(stageReviewedCandidate(f.options,{run:f.run}));await absent(path.join(f.options.output,'STAGING.json'));
 }
});
test('bounded child argv preserves hostile filenames and never logs child credentials',async t=>{
 const f=await setup(t),{runStagingChild}=await load(),logs=path.join(f.root,'child logs');await mkdir(logs);
 const target=path.join(f.root,"literal $(touch NEVER) ' name" );
 await runStagingChild({file:process.execPath,args:['-e','require("fs").writeFileSync(process.argv[1],"argv preserved");process.stderr.write("PRIVATE-TRANSCRIPT");',target],cwd:f.root,env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,logDir:logs,phase:'verify'});
 assert.equal(await readFile(target,'utf8'),'argv preserved');assert.deepEqual((await readdir(logs)).sort(),['verify-owner.json','verify-result.json']);
 const result=JSON.parse(await readFile(path.join(logs,'verify-result.json')));assert.equal(result.quiescent,true);assert.ok(result.outputBytes>0);
 for(const p of await readdir(logs))assert.ok(!(await readFile(path.join(logs,p),'utf8')).includes('PRIVATE-TRANSCRIPT'));
});
test('child timeout is bounded, observed and retains its ownership evidence',async t=>{
 const f=await setup(t),{runStagingChild}=await load(),logs=path.join(f.root,'timeout logs');await mkdir(logs);const start=Date.now();
 await assert.rejects(runStagingChild({file:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:f.root,env:{PATH:'/usr/bin:/bin'},timeoutMs:200,logDir:logs,phase:'build'}));
 assert.ok(Date.now()-start<3000);const result=JSON.parse(await readFile(path.join(logs,'build-result.json')));assert.equal(result.timedOut,true);assert.equal(result.quiescent,true);
});
test('spawn failures produce bounded owned diagnostics rather than an unhandled child error',async t=>{
 const f=await setup(t),logs=path.join(f.root,'spawn logs');await mkdir(logs);const driver=path.join(f.root,'driver.mjs');
 await writeFile(driver,`import {runStagingChild} from ${JSON.stringify(modulePath.href)};\ntry { await runStagingChild({file:'/nonexistent-mosaic-fixture',args:[],cwd:${JSON.stringify(f.root)},env:{PATH:'/usr/bin:/bin'},timeoutMs:1000,logDir:${JSON.stringify(logs)},phase:'build'});process.exitCode=3;} catch(e) { console.log(e.code); }\n`);
 const r=spawnSync(process.execPath,[driver],{encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/staging_child_build_failed_or_unresolved/);assert.equal(r.stderr,'');
});
test('CLI rejects ambiguous or missing inputs with a fixed message and no private text',()=>{
 const r=spawnSync(process.execPath,[fileURLToPath(modulePath),'--source','PRIVATE-TRANSCRIPT','--source','also-private'],{encoding:'utf8',timeout:5000});assert.equal(r.status,2);assert.equal(r.stderr,'reviewed-staging: staging_duplicate_argument\n');
});
test('optional verification reference retains the builder repository-relative bytes contract',async t=>{
 const f=await setup(t),{stageReviewedCandidate}=await load();f.options.verificationRef='docs/DISTRIBUTION_PROVENANCE.md';f.c.verification.references=[{path:f.options.verificationRef,sha256:sha(await readFile(path.join(f.source,f.options.verificationRef)))}];await f.saveArchive();
 await stageReviewedCandidate(f.options,{run:f.run});const args=f.calls[0].args;assert.equal(args[args.indexOf('--verification-ref')+1],'docs/DISTRIBUTION_PROVENANCE.md');
 assert.deepEqual(JSON.parse(await readFile(path.join(f.options.output,'build',f.stem+'.candidate.json'))).verification.references,f.c.verification.references);
});
test('explicit empty evidence remains pending while a missing record rejects verification',async t=>{
 for(const empty of [true,false]){
  const f=await setup(t),{stageReviewedCandidate}=await load();if(empty){await writeFile(f.recordsFile,JSON.stringify({records:[]}));f.options.evidenceRecordsSha256=sha(await readFile(f.recordsFile));const result=await stageReviewedCandidate(f.options,{run:f.run});assert.equal(result.releaseAuthority,false);const report=JSON.parse(await readFile(path.join(f.options.output,'reports/portable-evidence.json')));assert.equal(report.suppliedEvidence.localAcceptance,'not-supplied');assert.equal(report.suppliedEvidence.records.length,0);}else{await rm(path.join(f.evidenceRoot,f.index.records[0].path));await assert.rejects(stageReviewedCandidate(f.options,{run:f.run}));await absent(path.join(f.options.output,'STAGING.json'));}
 }
});
test('child output ceiling terminates only the owned parent and records finite metadata',async t=>{
 const f=await setup(t),{runStagingChild}=await load(),logs=path.join(f.root,'overflow logs');await mkdir(logs);
 await assert.rejects(runStagingChild({file:process.execPath,args:['-e','process.stdout.write("x".repeat(2*1024*1024));setInterval(()=>{},1000);'],cwd:f.root,env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,logDir:logs,phase:'build'}));
 const result=JSON.parse(await readFile(path.join(logs,'build-result.json')));assert.equal(result.outputLimitExceeded,true);assert.equal(result.quiescent,true);assert.ok((await readFile(path.join(logs,'build-result.json'))).length<1024);
});
test('a surviving owned descendant prevents success and preserves its process group identity',async t=>{
 const f=await setup(t),{runStagingChild}=await load(),logs=path.join(f.root,'descendant logs');await mkdir(logs);
 await assert.rejects(runStagingChild({file:process.execPath,args:['-e','require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},800)"],{stdio:"inherit"});process.exit(0);'],cwd:f.root,env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,logDir:logs,phase:'build'}));
 const result=JSON.parse(await readFile(path.join(logs,'build-result.json')));assert.equal(result.exitCode,0);assert.equal(result.quiescent,false);assert.ok(result.processGroup>0);
 const until=Date.now()+4000;let absent=false;while(Date.now()<until){try{process.kill(-result.processGroup,0);}catch(e){absent=e.code==='ESRCH';if(absent)break;}await new Promise(r=>setTimeout(r,25));}assert.equal(absent,true,'owned finite descendant must finish before fixture cleanup');
});
test('isolating npm HOME cannot disable the existing owner-home native privacy check',async t=>{
 const f=await setup(t),{stageReviewedCandidate}=await load();await writeFile(path.join(f.options.checkArtifact,'node'),Buffer.from(os.homedir()+path.sep+'private-build-source'));
 await assert.rejects(stageReviewedCandidate(f.options,{run:f.run}));assert.equal(f.calls.length,0,'private native bytes must be rejected in the parent before builder execution');
});
test('timeout escalates and drains its owned process group even after the leader exits',async t=>{
 const f=await setup(t),{runStagingChild}=await load(),logs=path.join(f.root,'group timeout logs');await mkdir(logs);const marker=path.join(f.root,'after-timeout'),ready=path.join(f.root,'descendant-ready');
 const child=`process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'must not write'),3500);setTimeout(()=>{},3800);`;
 const parent=`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
 await assert.rejects(runStagingChild({file:process.execPath,args:['-e',parent],cwd:f.root,env:{PATH:'/usr/bin:/bin'},timeoutMs:1500,logDir:logs,phase:'build'}));
 const result=JSON.parse(await readFile(path.join(logs,'build-result.json')));assert.equal(await readFile(ready,'utf8'),'ready');
 const until=Date.now()+5000;let gone=false;while(Date.now()<until){try{process.kill(-result.processGroup,0);}catch(e){gone=e.code==='ESRCH';if(gone)break;}await new Promise(r=>setTimeout(r,25));}assert.equal(gone,true,'observe owned descendant absent before cleanup');
 assert.equal(result.quiescent,true,'the timeout must drain/escalate the known group before returning');await absent(marker);
});
test('fixed verifier reasons and npm failure codes survive without arbitrary private child text',async t=>{
 const f=await setup(t),{runStagingChild}=await load();
 for(const phase of ['verify','build']){
  const logs=path.join(f.root,phase+' diagnosis');await mkdir(logs);
  const args=phase==='verify'?[path.join(repo,'scripts/release/verify-portable-candidate.mjs')]:['-e','process.stderr.write("npm error code ENOTCACHED\\nPRIVATE-TRANSCRIPT https://private.invalid/?token=secret\\n");process.exit(1);'];
  await assert.rejects(runStagingChild({file:process.execPath,args,cwd:f.root,env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,logDir:logs,phase}));
  const raw=await readFile(path.join(logs,phase+'-result.json'),'utf8'),result=JSON.parse(raw);assert.equal(result.diagnostic,phase==='verify'?'missing_cli_arguments':'npm_ENOTCACHED');assert.ok(!raw.includes('PRIVATE-TRANSCRIPT'));assert.ok(!raw.includes('token=secret'));
 }
});
