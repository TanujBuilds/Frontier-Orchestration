import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const required=process.env.MOSAIC_REQUIRE_INSTALLED==='1';
const archive=process.env.MOSAIC_INSTALLED_ARCHIVE;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function command(argv,{env,cwd,input='',timeout=90000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(argv[0],argv.slice(1),{env,cwd,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',timedOut=false;
  child.stdout.on('data',value=>{stdout+=value;});child.stderr.on('data',value=>{stderr+=value;});
  child.stdin.on('error',error=>{if(error.code!=='EPIPE')reject(error);});child.stdin.end(input);
  let escalation;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');escalation=setTimeout(()=>child.kill('SIGKILL'),5000);escalation.unref();},timeout);timer.unref();child.once('error',reject);
  child.once('close',(code,signal)=>{clearTimeout(timer);clearTimeout(escalation);resolve({argv,code,signal,timedOut,stdout,stderr});});
 });
}
async function evidence(name,value){
 const dir=process.env.MOSAIC_INSTALLED_EVIDENCE_DIR;
 if(dir){await mkdir(dir,{recursive:true});await writeFile(path.join(dir,name),JSON.stringify(value,null,2)+'\n');}
}

test('new extracted installed CLI saves simple one-worker and no-worker setup with actual native validation',{
 skip:!archive&&!required,timeout:240000
},async t=>{
 assert.ok(archive,'MOSAIC_INSTALLED_ARCHIVE must name the new candidate archive');
 assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
 const parent=process.env.MOSAIC_INSTALLED_ROOT_PARENT;
 if(required)assert.ok(parent&&path.isAbsolute(parent),'Required installed proof needs an owned durable parent');
 await mkdir(parent??os.tmpdir(),{recursive:true,mode:0o700});
 const root=await realpath(await mkdtemp(path.join(parent??os.tmpdir(),'Mosaic simple setup proof ')));
 const checkout=await realpath(fileURLToPath(new URL('../',import.meta.url)));
 assert.ok(root!==checkout&&!root.startsWith(checkout+path.sep));assert.match(root,/ /);
 const log=[],runs=[],calls=[];let completed=false;
 const server=http.createServer(async(req,res)=>{
  let bytes=0;for await(const chunk of req)bytes+=chunk.length;
  calls.push({method:req.method,url:req.url,bytes});res.writeHead(500).end('Setup must not contact this fixture without explicit opt-in');
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(async()=>{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await evidence('simple-wizard-installed.json',{schemaVersion:1,root,completed,fixtureOnly:true,liveCallsMade:false,sourceImports:false,archive,archiveSha256:sha(await readFile(archive)),calls,log,runs});
  if(completed)await rm(root,{recursive:true,force:true});
 });
 const emptyHome=path.join(root,'Extraction home');await mkdir(emptyHome,{mode:0o700});
 const env={PATH:'/usr/bin:/bin',HOME:emptyHome,TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',CI:'1'};
 const run=async(argv,options={})=>{const result=await command(argv,{env,cwd:root,...options});log.push(result);assert.equal(result.timedOut,false,JSON.stringify(result));assert.equal(result.code,0,result.stderr+'\n'+result.stdout);return result;};
 await run(['/usr/bin/tar','-xzf',archive,'-C',root]);
 const list=await run(['/usr/bin/tar','-tzf',archive]);
 const stem=list.stdout.split('\n').find(Boolean).split('/')[0],bundle=path.join(root,stem);
 const wizardRelative=stem+'/payload/runtime/src/beta/setup-wizard.mjs';
 assert.ok(list.stdout.split('\n').includes(wizardRelative),'New wizard helper must be included in the actual archive');
 const packagedWizard=await readFile(path.join(root,wizardRelative));
 const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
 for(const worker of [true,false]){
  const home=path.join(root,worker?'One worker home':'No worker home');await mkdir(home,{mode:0o700});
  const caseEnv={...env,HOME:home};
  await run([path.join(bundle,'install'),'--home',home,'--no-path'],{env:caseEnv});
  const product=path.join(home,'Library/Application Support/Mosaic Beta'),configDir=path.join(product,'config');
  const installation=JSON.parse(await readFile(path.join(configDir,'installation.json'),'utf8'));
  const runtime=path.join(product,'versions',installation.version,'runtime');
  assert.equal(sha(await readFile(path.join(runtime,'src/beta/setup-wizard.mjs'))),sha(packagedWizard));
  const answers=worker?['3','1',baseUrl,'installed-fixture-model','n','n','n','n','y']:['3','4','n','n','n','y'];
  // No injected settings, source imports, executable substitution or preflight bypass:
  // this is the installed CLI's own first-run path and bundled native identity check.
  const result=await run([path.join(runtime,'bin/node'),path.join(runtime,'src/beta/cli.mjs'),'--home',home,'setup'],{env:caseEnv,input:answers.join('\n')+'\n'});
  const settingsFile=path.join(configDir,'settings.json'),settings=JSON.parse(await readFile(settingsFile,'utf8'));
  assert.equal((await stat(settingsFile)).mode&0o777,0o600);
  assert.equal(settings.schema,2);assert.equal(settings.host.id,'cursor');
  assert.deepEqual(settings.defaults.review,{source:'host',hostId:'cursor'});
  assert.equal(settings.providers.length,worker?1:0);
  assert.equal(settings.defaults.workerId,worker?'worker-1':null);assert.equal(settings.defaults.plannerWorkerId,worker?'worker-1':null);
  assert.equal(settings.serviceMaxConcurrentTasks,1);
  if(worker){
   const profile=settings.providers[0];
   assert.equal(profile.id,'worker-1');assert.equal(profile.revision,'r1');assert.equal(profile.displayName,'Worker 1');assert.equal(profile.transport,'openai-chat');
   assert.equal(profile.baseUrl,baseUrl);assert.equal(profile.model,'installed-fixture-model');assert.equal(profile.credentialRef,null);assert.equal(profile.concurrency,1);
   assert.deepEqual(settings.capacityGroups,[{id:'worker-1',limit:1}]);
  }else assert.deepEqual(settings.capacityGroups,[]);
  const nativeManifest=path.join(runtime,'check-artifact/artifact-manifest.json'),fingerprint=sha(await readFile(nativeManifest));
  assert.equal(settings.execution.backend,'darwin-seatbelt');assert.equal(settings.execution.backendRevision,2);assert.equal(settings.execution.runtimeFingerprint,fingerprint);
  assert.deepEqual(settings.nativeCheckRuntime,{schema:1,artifactManifestPath:nativeManifest,artifactManifestSha256:fingerprint});
  assert.match(result.stdout,/fixture-tested registration; actual host compatibility unprobed/);
  assert.match(result.stdout,/Connectivity\/inference: untested; zero setup POSTs/);
  assert.match(result.stdout,/closed hosts wait durably/);
  assert.doesNotMatch(result.stdout,/Exact private setup preview/,'Simple path must not dump technical settings by default');
  const binding=JSON.parse(await readFile(path.join(configDir,'portable-binding.json'),'utf8'));assert.equal(binding.complete,true);assert.equal(binding.hostId,'cursor');
  const credentials=await readFile(path.join(configDir,'credentials.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return {schema:1,entries:{}};throw error;});assert.deepEqual(credentials,{schema:1,entries:{}});
  assert.deepEqual(calls,[],'Declined inference must send zero GETs and zero completion POSTs');
  runs.push({kind:worker?'one-worker':'no-worker',installationVersion:installation.version,settings,wizardSha256:sha(packagedWizard),nativeFingerprint:fingerprint,fixtureRegistration:true,actualHostConnectionProven:false,inferenceTested:false});
 }
 completed=true;
});
