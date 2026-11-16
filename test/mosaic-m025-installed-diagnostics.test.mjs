import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const required=process.env.MOSAIC_REQUIRE_INSTALLED==='1',archive=process.env.MOSAIC_INSTALLED_ARCHIVE;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function command(argv,{env,cwd,input='',timeout=90000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(argv[0],argv.slice(1),{env,cwd,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',timedOut=false;
  child.stdout.on('data',c=>{stdout+=c;});child.stderr.on('data',c=>{stderr+=c;});
  child.stdin.on('error',e=>{if(e.code!=='EPIPE')reject(e);});child.stdin.end(input);
  let escalation;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');escalation=setTimeout(()=>child.kill('SIGKILL'),5000);escalation.unref();},timeout);timer.unref();
  child.once('error',reject);child.once('close',(code,signal)=>{clearTimeout(timer);clearTimeout(escalation);resolve({argv,code,signal,timedOut,stdout,stderr});});
 });
}

// This catches omitted runtime modules/CLI options, accidental inference on
// metadata consent, manual-to-advertised promotion, and failed setup overwrites.
test('extracted installed command separates discovery, inference and readiness with real loopback fixtures',{
 skip:!archive&&!required,timeout:360000
},async t=>{
 assert.ok(archive,'MOSAIC_INSTALLED_ARCHIVE is required');
 assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
 const parent=process.env.MOSAIC_INSTALLED_ROOT_PARENT;
 if(required)assert.ok(parent&&path.isAbsolute(parent),'Use an owned durable installed parent');
 await mkdir(parent??os.tmpdir(),{recursive:true,mode:0o700});
 const root=await realpath(await mkdtemp(path.join(parent??os.tmpdir(),'Mosaic diagnostics proof ')));
 const source=await realpath(fileURLToPath(new URL('../',import.meta.url)));assert.ok(!root.startsWith(source+path.sep));
 const runs=[],calls=[],services=[];let mode='healthy',completed=false;
 const marker='PRIVATE_FIXTURE_RESPONSE_MUST_NOT_BE_PRINTED';
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;
  calls.push({method:req.method,url:req.url,...(body?{body:JSON.parse(body)}:{})});
  res.setHeader('content-type','application/json');
  if(req.method==='GET'){
   if(mode==='authentication'){res.writeHead(401);res.end(JSON.stringify({error:{message:marker}}));}
   else if(mode==='unsupported'){res.writeHead(404);res.end(JSON.stringify({error:{message:marker}}));}
   else res.end(JSON.stringify({data:[{id:'installed-fixture-model'},{id:'hostile\u001b[31m-id'}]}));
  }else if(mode==='model_not_found'||mode==='context_length_exceeded'){
   res.writeHead(400);res.end(JSON.stringify({error:{code:mode,message:marker}}));
  }else res.end(JSON.stringify({model:'installed-fixture-model',choices:[{message:{content:marker},finish_reason:'stop'}]}));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(async()=>{
  for(const service of services)await service.stop();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  const dir=process.env.MOSAIC_INSTALLED_EVIDENCE_DIR;
  if(dir){await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'setup02-installed-diagnostics.json'),JSON.stringify({schemaVersion:1,root,completed,fixtureOnly:true,liveModelCalls:false,sourceImports:false,archive,archiveSha256:sha(await readFile(archive)),calls,runs},null,2)+'\n');}
  if(completed)await rm(root,{recursive:true,force:true});
 });
 const extractHome=path.join(root,'Extract home');await mkdir(extractHome,{mode:0o700});
 const env={PATH:'/usr/bin:/bin',HOME:extractHome,TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',CI:'1'};
 const run=async(argv,opts={})=>{const r=await command(argv,{env,cwd:root,...opts});runs.push(r);assert.equal(r.timedOut,false);assert.ok(!r.stdout.includes(marker)&&!r.stderr.includes(marker),'Completion/error body must remain private');assert.ok(!r.stdout.includes('\u001b'),'Provider controls must not reach terminal');return r;};
 assert.equal((await run(['/usr/bin/tar','-xzf',archive,'-C',root])).code,0);
 const list=await run(['/usr/bin/tar','-tzf',archive]);assert.equal(list.code,0);
 const stem=list.stdout.split('\n').find(Boolean).split('/')[0],bundle=path.join(root,stem);
 assert.ok(list.stdout.includes('/payload/runtime/src/beta/provider-diagnostics.mjs'),'Diagnostics module must ship');
 const url=`http://127.0.0.1:${server.address().port}/v1`;
 let serial=0;
 async function install(){
  const home=path.join(root,'Case home '+(++serial));await mkdir(home,{mode:0o700});const caseEnv={...env,HOME:home};
  const installed=await run([path.join(bundle,'install'),'--home',home,'--no-path'],{env:caseEnv});assert.equal(installed.code,0,installed.stderr);
  return {home,env:caseEnv,cli:path.join(home,'.local/bin/mosaic'),config:path.join(home,'Library/Application Support/Mosaic Beta/config')};
 }
 const invoke=(f,args,input)=>run([f.cli,...args],{env:f.env,input});
 async function serve(f){
  const child=spawn(f.cli,['serve'],{env:f.env,cwd:root,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',closed=false;
  const exit=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;runs.push({service:'owned empty coordinator',code,signal,stdout,stderr});resolve();}));
  const ready=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Installed fixture coordinator did not become ready')),15000);timer.unref();
   child.stdout.on('data',b=>{stdout+=b;if(stdout.includes('"status":"ready"')){clearTimeout(timer);resolve();}});
   child.stderr.on('data',b=>{stderr+=b;});child.once('error',reject);child.once('close',()=>{clearTimeout(timer);reject(Error('Fixture service exited before ready: '+stderr));});
  });
  const service={async stop(){if(closed)return;child.kill('SIGTERM');const escalation=setTimeout(()=>child.kill('SIGKILL'),5000);escalation.unref();await exit;clearTimeout(escalation);}};services.push(service);await ready;return service;
 }
 const answers=(discovery,inference,{worker=true}={})=>['3',worker?'1':'4',...(worker?[url,'installed-fixture-model','n']:[]),'n',discovery,inference,'y'].join('\n')+'\n';
 const metadata=await install();
 let start=calls.length;
 let r=await invoke(metadata,['setup'],answers('y','n'));assert.equal(r.code,0,r.stderr+'\n'+r.stdout);
 assert.deepEqual(calls.slice(start).map(c=>c.method),['GET']);assert.match(r.stdout,/endpoint.*responded|responded.*endpoint/i);assert.match(r.stdout,/inference.*(?:not checked|untested)/i);assert.match(r.stdout,/coding.*untested/i);assert.match(r.stdout,/host.*unverified/i);
 const before=await readFile(path.join(metadata.config,'settings.json'));const settings=JSON.parse(before);
 assert.equal(settings.providers[0].capabilities.modelDiscovery,'manual');
 const docFiles=['settings.json','credentials.json','portable-binding.json','host-cursor-binding.json'];
 const snapshot=async()=>Promise.all(docFiles.map(f=>readFile(path.join(metadata.config,f)).catch(e=>{if(e.code==='ENOENT')return null;throw e;})));
 const saved=await snapshot();
 const coordinator=await serve(metadata);
 start=calls.length;r=await invoke(metadata,['doctor']);assert.equal(r.code,0,r.stderr);assert.equal(calls.length,start);
 r=await invoke(metadata,['doctor','--providers']);assert.equal(r.code,0,r.stderr+'\n'+r.stdout);assert.deepEqual(calls.slice(start).map(c=>c.method),['GET']);assert.deepEqual(await snapshot(),saved);
 r=await invoke(metadata,['doctor','--providers','--unknown']);assert.notEqual(r.code,0);assert.equal(calls.length,start+1);
 mode='authentication';start=calls.length;r=await invoke(metadata,['doctor','--providers']);assert.equal(r.code,1);assert.deepEqual(calls.slice(start).map(c=>c.method),['GET']);assert.match(r.stdout,/auth|access denied/i);assert.deepEqual(await snapshot(),saved);
 await coordinator.stop();
 // Both allowlisted provider-reported causes must travel the actual adapter/CLI.
 const configInput=path.join(root,'private-settings.json');await writeFile(configInput,before,{mode:0o600});
 for(const failure of ['model_not_found','context_length_exceeded']){
  mode=failure;start=calls.length;r=await invoke(metadata,['setup','--config',configInput],'n\ny\ny\n');
  assert.notEqual(r.code,0);assert.deepEqual(calls.slice(start).map(c=>c.method),['POST']);
  assert.match(r.stdout,/provider.reported/i);assert.match(r.stdout,failure==='model_not_found'?/model.*not.*found/i:/context.*(?:limit|length|capacity)/i);assert.match(r.stdout,/next|check|choose/i);
  assert.deepEqual(await snapshot(),saved,'Failed inference preserves last-good settings, credentials and bindings');
 }
 mode='unsupported';const manual=await install();start=calls.length;r=await invoke(manual,['setup'],answers('y','y'));assert.equal(r.code,0,r.stderr+'\n'+r.stdout);
 assert.deepEqual(calls.slice(start).map(c=>c.method),['GET','POST']);
 assert.match(r.stdout,/unsupported/i);assert.match(r.stdout,/response received/i);assert.match(r.stdout,/coding.*untested/i);
 const probe=calls.at(-1).body;assert.deepEqual(probe.messages,[{role:'user',content:'Mosaic setup connectivity probe. Reply with setup ok.'}]);assert.equal(probe.max_tokens,16);
 assert.equal(JSON.parse(await readFile(path.join(manual.config,'settings.json'))).providers[0].capabilities.modelDiscovery,'manual');
 await serve(manual);
 start=calls.length;r=await invoke(manual,['doctor','--providers']);assert.equal(r.code,0,r.stderr);assert.deepEqual(calls.slice(start).map(c=>c.method),['GET']);
 for(const [worker,discovery,inference] of [[true,'n','n'],[false,'y','y']]){
  const f=await install();start=calls.length;r=await invoke(f,['setup'],answers(discovery,inference,{worker}));assert.equal(r.code,0,r.stderr+'\n'+r.stdout);assert.equal(calls.length,start);
 }
 for(const worker of [true,false]){
  const declined=await install();start=calls.length;r=await invoke(declined,['setup'],answers(worker?'n':'y',worker?'n':'y',{worker}));assert.equal(r.code,0,r.stderr+'\n'+r.stdout);assert.equal(calls.length,start,'Declined diagnostics and no-worker yes produce zero requests');
 }
 completed=true;
});
