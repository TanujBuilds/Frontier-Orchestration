import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,mkdir,writeFile,readFile,lstat,chmod,symlink,readdir,rm} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';

const exec=promisify(execFile);
const moduleUrl=new URL('../src/beta/support-bundle.mjs',import.meta.url);
const script=new URL('../scripts/support/mosaic-support-bundle.mjs',import.meta.url);
const raw=JSON.parse(await readFile(new URL('./fixtures/mosaic-m039-support-bundle/private-viewer.json',import.meta.url),'utf8'));
const digest=b=>createHash('sha256').update(b).digest('hex');
const root=home=>path.join(home,'Library','Application Support','Mosaic Beta');
async function fixture(t){
 const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'mosaic-support-')));
 await chmod(home,0o700);
 for(const dir of ['config','state','output'])await mkdir(path.join(root(home),dir),{recursive:true,mode:0o700});
 t.after(()=>rm(home,{recursive:true,force:true}));
 const put=async(name,value)=>{const file=path.join(root(home),name);await writeFile(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});return file;};
 const run=(...args)=>exec(process.execPath,[script.pathname,'--home',home,...args],{timeout:12000,maxBuffer:300000});
 return {home,put,run,output:path.join(root(home),'output')};
}
const transport=(snapshot=raw,timeline={events:raw.events})=>async name=>name==='observer_snapshot'?snapshot:timeline;
function clean(bytes){assert.doesNotMatch(bytes,/SENTINEL|PRIVATE_ID|PRIVATE_TASK|ordinary harmless|Bearer|127\.0\.0\.1|\/private\//);}
async function server(t,f,handle){
 const calls=[];
 const http=createServer(async(req,res)=>{
  let bytes='';for await(const b of req)bytes+=b;
  const call=JSON.parse(bytes);calls.push({name:call.name,input:call.input});
  assert.equal(req.headers.authorization,'Bearer '+'b'.repeat(64));
  handle(call,req,res);
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{http.closeAllConnections();await new Promise(resolve=>http.close(resolve));});
 await f.put('state/viewer-connection.json',{role:'viewer',url:`http://127.0.0.1:${http.address().port}/`,token:'b'.repeat(64)});
 return calls;
}

test('explicit projection removes real viewer free text, nested secrets and arbitrary IDs',async t=>{
 assert.match(JSON.stringify(raw),/SENTINEL_OBJECTIVE/,'dumping the current response is unsafe');
 const {collectSupportBundle,formatSupportBundle}=await import(moduleUrl);
 const f=await fixture(t),calls=[];
 const bundle=await collectSupportBundle({home:f.home},{invoke:async(name,input,signal)=>{
  calls.push({name,input});assert.ok(signal instanceof AbortSignal);return transport()(name);
 }});
 const bytes=formatSupportBundle(bundle);clean(bytes);
 assert.equal(bundle.schemaVersion,1);
 assert.deepEqual(calls,[{name:'observer_snapshot',input:{}},{name:'observer_timeline',input:{recent:true,limit:100}}]);
 assert.equal(bundle.snapshot.tasks.byStatus.codex_active,1);
 assert.equal(bundle.snapshot.tasks.byStatus.accepted,1);
 assert.equal(bundle.snapshot.agents.stale,1);
 assert.equal(bundle.usage.nativeTokens,null);
 assert.equal(bundle.usage.reportedTokens,42);
 assert.equal(bundle.usage.tasksWithUnknownTokens,1);
 assert.equal(bundle.timeline.byType['task.native_started'],1);
 assert.equal(bundle.timeline.byType.unknown,1);
 assert.ok(bundle.diagnostics.includes('NATIVE_USAGE_UNKNOWN'));
});

test('metadata exports shape only and leaves all original state/evidence/credentials untouched',async t=>{
 const {collectSupportBundle,formatSupportBundle}=await import(moduleUrl);
 const f=await fixture(t),files=[];
 files.push(await f.put('config/settings.json',{schema:2,host:{id:'codex',target:'/private/SENTINEL_PATH'},providers:[{model:'SENTINEL_MODEL',baseUrl:'SENTINEL_ENDPOINT',credentialRef:'SENTINEL_CREDENTIAL'}],capacityGroups:[{id:'SENTINEL_ID'}],serviceMaxConcurrentTasks:1,execution:{backend:'darwin-seatbelt',backendRevision:2},defaults:{review:{source:'host'}}}));
 files.push(await f.put('config/installation.json',{schema:1,version:'0.1.0-beta.186',contentHash:'b'.repeat(64),launcherHash:'a'.repeat(64),pathBlock:'SENTINEL_SOURCE'}));
 files.push(await f.put('config/portable-binding.json',{schema:1,complete:true,manualHost:true,hostId:'codex',hostReceipt:'/private/SENTINEL_PATH',credentialsHash:'SENTINEL_TOKEN'}));
 for(const name of ['config/credentials.json','config/setup-intent.json','state/harness.sqlite3','state/harness.sqlite3-wal','state/evidence.txt'])files.push(await f.put(name,'SENTINEL_ORIGINAL'));
 // A credential symlink must never be opened, followed or validated.
 await symlink('/missing/SENTINEL_AUTH',path.join(f.home,'.codex'));
 const before=await Promise.all(files.map(async file=>digest(await readFile(file))));
 const bundle=await collectSupportBundle({home:f.home},{invoke:transport()});
 const bytes=formatSupportBundle(bundle);clean(bytes);assert.ok(!bytes.includes('b'.repeat(64)));
 assert.equal(bundle.local.settings.providerCount,1);
 assert.equal(bundle.local.installation.version,'0.1.0-beta.186');
 assert.equal(bundle.local.installation.contentSha256Present,true);
 assert.equal(bundle.local.setup.complete,true);
 assert.equal(bundle.local.setup.manualHost,true);
 assert.deepEqual(await Promise.all(files.map(async file=>digest(await readFile(file)))),before);
});

test('absent/offline/stale collection produces useful finite diagnostics and never starts a service',async t=>{
 const {collectSupportBundle}=await import(moduleUrl);const f=await fixture(t);
 const absent=await collectSupportBundle({home:f.home});
 assert.equal(absent.collection.status,'unavailable');assert.ok(absent.diagnostics.includes('VIEWER_ABSENT'));
 const unavailable=await collectSupportBundle({home:f.home},{invoke:async()=>{throw Error('SENTINEL_ERROR /private/path');}});
 assert.ok(unavailable.diagnostics.includes('VIEWER_UNAVAILABLE'));clean(JSON.stringify(unavailable));
 const stale=await collectSupportBundle({home:f.home},{invoke:transport()});
 assert.ok(stale.diagnostics.includes('STALE_AGENT_REPORTS'));
 assert.equal(stale.usage.nativeTokens,null);
 assert.equal(await readdir(path.join(root(f.home),'state')).then(a=>a.length),0);
});

test('bounded traversal counts only the permitted rows/events and handles malformed hostile JSON',async t=>{
 const {collectSupportBundle,formatSupportBundle,SUPPORT_BUNDLE_LIMITS:limits}=await import(moduleUrl);const f=await fixture(t);
 const snapshot={version:1,tasks:Array.from({length:600},()=>({status:'SENTINEL_STATUS',actor:'SENTINEL_ACTOR'})),agents:Array(500).fill({}),goals:Array(120).fill({status:'SENTINEL_STATUS'})};
 const bundle=await collectSupportBundle({home:f.home},{invoke:transport(snapshot,{events:Array(200).fill({type:'SENTINEL_TYPE'})})});
 clean(formatSupportBundle(bundle));
 assert.equal(bundle.snapshot.tasks.processed+bundle.snapshot.agents.processed,500);
 assert.equal(bundle.snapshot.goals.processed,100);assert.equal(bundle.timeline.processed,100);
 assert.ok(bundle.diagnostics.includes('ROW_LIMIT'));assert.ok(bundle.diagnostics.includes('EVENT_LIMIT'));
 assert.ok(Buffer.byteLength(formatSupportBundle(bundle))<=limits.outputBytes);
 for(const bad of [null,[],{},'SENTINEL_ERROR',{version:1,tasks:{},goals:[],agents:[]}]){
  const result=await collectSupportBundle({home:f.home},{invoke:transport(bad,{events:null})});
  clean(formatSupportBundle(result));assert.ok(result.diagnostics.includes('SNAPSHOT_INVALID'));assert.ok(result.diagnostics.includes('TIMELINE_INVALID'));
 }
});

test('metadata rejects oversize, malformed, symlink and FIFO inputs without blocking',async t=>{
 const {collectSupportBundle}=await import(moduleUrl);
 for(const kind of ['oversize','malformed','symlink','fifo','public']){
  const f=await fixture(t),file=path.join(root(f.home),'config/settings.json');
  if(kind==='oversize')await writeFile(file,'x'.repeat(65537),{mode:0o600});
  if(kind==='malformed')await writeFile(file,'{"SENTINEL":',{mode:0o600});
  if(kind==='symlink')await symlink('/missing/SENTINEL_TARGET',file);
  if(kind==='fifo')await exec('/usr/bin/mkfifo',[file]);
  if(kind==='public'){await f.put('config/settings.json',{});await chmod(file,0o644);}
  const start=Date.now(),bundle=await collectSupportBundle({home:f.home},{invoke:transport()});
  assert.ok(Date.now()-start<2000);assert.ok(bundle.diagnostics.includes(kind==='oversize'?'LOCAL_FILE_TOO_LARGE':kind==='malformed'?'LOCAL_JSON_INVALID':'LOCAL_FILE_UNSAFE'));
  clean(JSON.stringify(bundle));
 }
});

test('viewer connection rejects nonregular/oversized paths and symlink parents without a request',async t=>{
 const {collectSupportBundle}=await import(moduleUrl);
 for(const kind of ['symlink','fifo','oversize','parent']){
  const f=await fixture(t),file=path.join(root(f.home),'state/viewer-connection.json');
  if(kind==='symlink')await symlink('/missing/SENTINEL_TARGET',file);
  if(kind==='fifo')await exec('/usr/bin/mkfifo',[file]);
  if(kind==='oversize')await writeFile(file,'x'.repeat(8193),{mode:0o600});
  if(kind==='parent'){await rm(path.dirname(file),{recursive:true});await symlink('/missing/SENTINEL_TARGET',path.dirname(file));}
  const bundle=await collectSupportBundle({home:f.home});
  assert.ok(bundle.diagnostics.includes('VIEWER_CONNECTION_UNSAFE'));assert.equal(bundle.collection.viewerCalls,0);clean(JSON.stringify(bundle));
 }
});

test('actual viewer client only sends the two fixed read calls; CLI preview equals written private bytes',async t=>{
 const f=await fixture(t);
 const calls=await server(t,f,(call,_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(call.name==='observer_snapshot'?raw:{events:raw.events}));});
 const file=path.join(f.output,'bundle.json');
 const {stdout,stderr}=await f.run('--output',file);assert.equal(stderr,'');clean(stdout);
 assert.equal(await readFile(file,'utf8'),stdout);assert.equal((await lstat(file)).mode&0o777,0o600);
 assert.deepEqual(calls,[{name:'observer_snapshot',input:{}},{name:'observer_timeline',input:{recent:true,limit:100}}]);
 const before=digest(await readFile(file));
 await assert.rejects(f.run('--output',file),error=>{assert.equal(error.code,2);assert.match(error.stderr,/OUTPUT_EXISTS/);clean(error.stderr);assert.equal(error.stdout,stdout);return true;});
 assert.equal(digest(await readFile(file)),before);
});

test('write rejects existing symlink/nonprivate/symlink parent directories after showing sanitized preview',async t=>{
 const f=await fixture(t);
 const target=await f.put('state/evidence.txt','SENTINEL_ORIGINAL');
 const file=path.join(f.output,'bundle.json');await symlink(target,file);
 await assert.rejects(f.run('--output',file),e=>{assert.equal(e.code,2);assert.match(e.stderr,/OUTPUT_EXISTS/);clean(e.stdout+e.stderr);return true;});
 assert.equal(await readFile(target,'utf8'),'SENTINEL_ORIGINAL');
 await symlink(f.output,path.join(f.home,'alias'));
 await assert.rejects(f.run('--output',path.join(f.home,'alias','new.json')),e=>{assert.equal(e.code,2);assert.match(e.stderr,/OUTPUT_UNSAFE/);return true;});
 await chmod(f.output,0o755);
 await assert.rejects(f.run('--output',path.join(f.output,'new.json')),e=>{assert.equal(e.code,2);assert.match(e.stderr,/OUTPUT_UNSAFE/);return true;});
 assert.deepEqual(await readdir(f.output),['bundle.json']);
});

test('hostile viewer errors, malformed replies, upstream 8MiB ceiling and slow bodies stay finite and redacted',async t=>{
 for(const kind of ['error','malformed','oversize','slow']){
  const f=await fixture(t),calls=await server(t,f,(_call,_req,res)=>{
   if(kind==='error'){res.statusCode=500;res.end(JSON.stringify({error:'SENTINEL_ERROR http://private/token'}));}
   if(kind==='malformed')res.end('{SENTINEL');
   if(kind==='oversize')res.end(JSON.stringify({secret:'SENTINEL'+'x'.repeat(8*1024*1024)}));
   if(kind==='slow'){res.writeHead(200,{'content-type':'application/json'});res.write('{');}
  });
  const started=Date.now(),{stdout}=await f.run();
  clean(stdout);const bundle=JSON.parse(stdout);
  assert.ok(bundle.diagnostics.includes(kind==='slow'?'VIEWER_TIMEOUT':'VIEWER_UNAVAILABLE'));
  assert.ok(calls.length<=2);assert.ok(Date.now()-started<6500);assert.ok(stdout.length<256*1024);
 }
});

test('injected request deadlines and overall collection deadline can only be tightened',async t=>{
 const {collectSupportBundle,SUPPORT_BUNDLE_LIMITS:limits}=await import(moduleUrl);const f=await fixture(t);
 let calls=0;const started=Date.now();
 const bundle=await collectSupportBundle({home:f.home},{invoke:async()=>{calls++;return new Promise(()=>{});},viewerTimeoutMs:25,deadlineMs:40});
 assert.ok(Date.now()-started<1000);assert.ok(calls<=2);assert.ok(bundle.diagnostics.includes('VIEWER_TIMEOUT')||bundle.diagnostics.includes('COLLECTION_DEADLINE'));
 assert.equal(limits.viewerTimeoutMs,2400);assert.equal(limits.deadlineMs,10000);assert.equal(limits.events,100);assert.equal(limits.rows,500);
 await assert.rejects(collectSupportBundle({home:f.home},{invoke:transport(),deadlineMs:10001}),/INVALID_LIMIT/);
});

test('partially reported provider tokens retain unknown usage instead of becoming a complete zero',async t=>{
 const {collectSupportBundle}=await import(moduleUrl);const f=await fixture(t);
 const snapshot={version:1,goals:[],agents:[],tasks:[
  {actor:'deepseek',usage:{reportedTokens:0,completedModelRequests:2,usageUnavailable:1}},
  {actor:'deepseek',usage:{reportedTokens:5,completedModelRequests:2,usageUnavailable:null}},
  {actor:'codex',usage:{reportedTokens:100,usageUnavailable:0}}
 ]};
 const bundle=await collectSupportBundle({home:f.home},{invoke:transport(snapshot,{events:[]})});
 assert.equal(bundle.usage.reportedTokens,5);
 assert.equal(bundle.usage.tasksWithReportedTokens,2);
 assert.equal(bundle.usage.tasksWithUnknownTokens,3);
 assert.equal(bundle.usage.nativeTokens,null);
});

test('overflowing usage counts each unknown task once and retains the known subtotal',async t=>{
 const {collectSupportBundle}=await import(moduleUrl);const f=await fixture(t);
 const snapshot={version:1,goals:[],agents:[],tasks:[
  {actor:'deepseek',usage:{reportedTokens:Number.MAX_SAFE_INTEGER,usageUnavailable:0}},
  {actor:'deepseek',usage:{reportedTokens:1,usageUnavailable:null}}
 ]};
 const bundle=await collectSupportBundle({home:f.home},{invoke:transport(snapshot,{events:[]})});
 assert.equal(bundle.usage.tasksWithUnknownTokens,1);
 assert.equal(bundle.usage.tasksWithReportedTokens,1);
 assert.equal(bundle.usage.reportedTokens,Number.MAX_SAFE_INTEGER);
 assert.ok(bundle.diagnostics.includes('USAGE_INVALID'));
});

test('parent deadline reaps its collector before returning a finite report',async t=>{
 const {collectSupportBundle}=await import(moduleUrl);const f=await fixture(t),started=Date.now();
 const bundle=await collectSupportBundle({home:f.home},{deadlineMs:1});
 assert.ok(bundle.diagnostics.includes('COLLECTION_DEADLINE'));
 assert.equal(bundle.collection.status,'unavailable');assert.ok(Date.now()-started<1000);
});

test('output ceiling rejects an oversized bundle and concurrent exclusive publication has one winner',async t=>{
 const {formatSupportBundle}=await import(moduleUrl);const f=await fixture(t);
 assert.throws(()=>formatSupportBundle({x:'a'.repeat(256*1024)}),/OUTPUT_TOO_LARGE/);
 const file=path.join(f.output,'bundle.json');
 const attempts=await Promise.allSettled([f.run('--output',file),f.run('--output',file)]);
 const winner=attempts.find(x=>x.status==='fulfilled'),loser=attempts.find(x=>x.status==='rejected');
 assert.ok(winner&&loser);assert.equal(loser.reason.code,2);assert.match(loser.reason.stderr,/OUTPUT_EXISTS/);
 assert.equal(await readFile(file,'utf8'),winner.value.stdout);
 assert.deepEqual(await readdir(f.output),['bundle.json']);
});

test('exclusive temp creation collision preserves the file this operation did not create',async t=>{
 const f=await fixture(t),file=path.join(f.output,'bundle.json'),unrelated=path.join(f.output,'.mosaic-support-fixture-collision');
 await writeFile(unrelated,'SENTINEL_UNRELATED_ORIGINAL',{mode:0o600});
 const preload=new URL('./fixtures/mosaic-m039-support-bundle/collision-preload.mjs',import.meta.url);
 await assert.rejects(exec(process.execPath,['--import',preload.href,script.pathname,'--home',f.home,'--output',file],{timeout:3000}),e=>{
  assert.equal(e.code,2);clean(e.stdout+e.stderr);return true;
 });
 assert.equal(await readFile(unrelated,'utf8'),'SENTINEL_UNRELATED_ORIGINAL');
 assert.deepEqual(await readdir(f.output),['.mosaic-support-fixture-collision']);
});

test('broken writable streams return fixed codes without arbitrary error text or local stack paths',async t=>{
 const f=await fixture(t),probe=new URL('./fixtures/mosaic-m039-support-bundle/failing-stream-probe.mjs',import.meta.url);
 for(const mode of ['stdout','both']){
  const {stdout,stderr}=await exec(process.execPath,[probe.pathname,f.home,mode],{timeout:3000});
  assert.equal(stderr,'');const result=JSON.parse(stdout);assert.equal(result.code,1);
  assert.equal(result.diagnostic,mode==='both'?'':'SUPPORT_BUNDLE_FAILED\n');clean(stdout);
 }
});

test('a closed actual CLI stdout pipe exposes only a fixed failure code on stderr',async t=>{
 const f=await fixture(t),child=spawn(process.execPath,[script.pathname,'--home',f.home],{stdio:['ignore','pipe','pipe']});
 child.stdout.destroy();let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes;});
 const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
 const result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
 assert.deepEqual(result,{code:1,signal:null});assert.equal(stderr,'SUPPORT_BUNDLE_FAILED\n');
});

test('strict standalone arguments never echo user text or implicitly search a home',async()=>{
 for(const args of [[],['--home','relative-SENTINEL'],['--home','/missing','--preview'],['--home','/missing','--home','/other'],['--home','/missing','--output','relative-SENTINEL'],['--help'],['--home','/missing','SENTINEL_EXTRA']]){
  await assert.rejects(exec(process.execPath,[script.pathname,...args],{timeout:2000}),e=>{assert.equal(e.code,2);assert.equal(e.stdout,'');assert.match(e.stderr,/USAGE/);clean(e.stderr);return true;});
 }
});
