import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {archive,entries,tar,header,stem,version,expandedBomb} from './fixtures/download-bootstrap/archive.mjs';
const script=fileURLToPath(new URL('../distribution/archive/install.sh',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const exists=async p=>access(p).then(()=>true,()=>false);
async function fixture(t,handler,{canCleanup=()=>true}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'Mosaic download tests ')),home=path.join(root,"Target User's home"),tmp=path.join(root,'temporary data');
 await mkdir(home);await mkdir(tmp);await writeFile(path.join(home,'keep'),'unchanged');
 let requests=0;
 const server=createServer((req,res)=>{requests++;handler(req,res);});server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{
  server.closeAllConnections();await new Promise(r=>server.close(r));
  if(!canCleanup()){t.diagnostic('Preserved potentially active fixture at '+root);return;}
  for(const name of await readdir(tmp)){
   const owner=await readFile(path.join(tmp,name,'installer-owner.txt'),'utf8').catch(()=>null);
   if(owner){const group=Number(owner.match(/processGroup=(\d+)/)?.[1]);if(group){let absent=false;try{process.kill(-group,0);}catch(error){absent=error.code==='ESRCH';}assert.ok(absent,'Preserve unresolved installer fixture at '+root);}}
  }
  await rm(root,{recursive:true,force:true});
 });
 return {root,home,tmp,url:`http://127.0.0.1:${server.address().port}/archive`,get requests(){return requests;}};
}
function run(f,bytes,{args,env={},scriptPath=script}={}){
 const params=args??['--version',version,'--url',f.url,'--sha256',sha(bytes),'--home',f.home,'--no-path','--test-loopback-http'];
 const child=spawn('/bin/sh',[scriptPath,...params],{env:{...process.env,PATH:'/usr/bin:/bin',TMPDIR:f.tmp,...env},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
 return {child,done};
}
async function rejected(f,result,pattern){
 assert.notEqual(result.code,0,result.stdout);assert.match(result.stderr,/Mosaic download:/);assert.match(result.stderr,pattern);
 assert.equal(await exists(path.join(f.home,'installer-called')),false,'rejected bytes must not execute the installer');
 assert.equal(await readFile(path.join(f.home,'keep'),'utf8'),'unchanged');
 assert.deepEqual(await readdir(f.tmp),[],'owned quiescent download staging is cleaned');
}
test('verified specimen delegates only installer flags, quoting path spaces and apostrophes',async t=>{
 const bytes=archive(),f=await fixture(t,(_,r)=>r.end(bytes));const result=await run(f,bytes).done;
 assert.equal(result.code,0,result.stderr);assert.equal(await readFile(path.join(f.home,'installer-called'),'utf8'),'invoked\n');
 assert.equal(await readFile(path.join(f.home,'installer-argv'),'utf8'),'--no-path\n');assert.deepEqual(await readdir(f.tmp),[]);assert.equal(f.requests,1);
});
test('missing, duplicate and malformed arguments fail before a request or target write',async t=>{
 const bytes=archive(),f=await fixture(t,(_,r)=>r.end(bytes));
 for(const args of [[],['--version','latest'],['--version',version,'--url',f.url,'--sha256','xyz','--home',f.home],['--version',version,'--version',version,'--url',f.url,'--sha256',sha(bytes),'--home',f.home],['--version',version,'--url',f.url,'--sha256',sha(bytes),'--home','relative']])await rejected(f,await run(f,bytes,{args}).done,/required|invalid|usage|absolute/i);
 assert.equal(f.requests,0);
});
test('plain HTTP needs explicit literal-loopback mode and rejects credential URLs without leaking query',async t=>{
 const bytes=archive(),f=await fixture(t,(_,r)=>r.end(bytes));
 for(const url of [f.url,'http://localhost:9/a?private-query','http://127.1/a','http://127.0.0.1.example/a','https://user:private-password@example.invalid/a?private-query']){
  const args=['--version',version,'--url',url,'--sha256',sha(bytes),'--home',f.home,...(url===f.url?[]:['--test-loopback-http'])];
  const result=await run(f,bytes,{args}).done;await rejected(f,result,/HTTPS|URL|loopback/i);assert.doesNotMatch(result.stderr,/private-query|private-password/);
 }
 assert.equal(f.requests,0);
});
test('wrong digest rejects complete bytes before archive code, preserving an existing target',async t=>{
 const bytes=archive(),f=await fixture(t,(_,r)=>r.end(bytes));await rejected(f,await run(f,bytes,{args:['--version',version,'--url',f.url,'--sha256','0'.repeat(64),'--home',f.home,'--test-loopback-http']}).done,/SHA256/i);
});
test('short transport and corrupted gzip both fail without invoking installer',async t=>{
 const bytes=archive();let partial=true;const f=await fixture(t,(_,r)=>{if(partial){r.writeHead(200,{'content-length':bytes.length+100});r.end(bytes.subarray(0,20));}else r.end(Buffer.from('wrong archive'));});
 await rejected(f,await run(f,bytes).done,/download/i);partial=false;await rejected(f,await run(f,Buffer.from('wrong archive')).done,/archive|gzip/i);
});
test('wrong selected stem, platform and manifest version are rejected',async t=>{
 let bytes;const f=await fixture(t,(_,r)=>r.end(bytes));
 for(const opts of [{root:'mosaic-beta-0.1.0-beta.185-darwin-arm64'},{root:'mosaic-beta-0.1.0-beta.184-darwin-x64'},{manifestVersion:'0.1.0-beta.185'}]){bytes=archive(opts);await rejected(f,await run(f,bytes).done,/archive|version|platform/i);}
});
test('unsafe names, links, duplicate paths, special entries and malformed tar never execute code',async t=>{
 let bytes;const f=await fixture(t,(_,r)=>r.end(bytes));
 const cases=[{name:'../escaped'},{name:'/absolute'},{name:stem+'/payload/../escaped'},{name:stem+'/payload//double'},{name:stem+'/payload/./dot'},{name:stem+'/payload/back\\slash'},{name:stem+'/payload/link',type:'2',link:f.home},{name:stem+'/payload/hard',type:'1',link:'../../keep'},{name:stem+'/payload/device',type:'3'},{name:stem+'/payload/fifo',type:'6'},{name:stem+'/payload/pax',type:'x'},{name:stem+'/install',body:'overwritten'}];
 for(const item of cases){bytes=gzipSync(tar([...entries(),item]));await rejected(f,await run(f,bytes).done,/archive|path|member|type/i);}
 bytes=gzipSync(Buffer.concat([header(stem+'/',{type:'5'}),Buffer.alloc(15)]));await rejected(f,await run(f,bytes).done,/archive|truncated/i);
 assert.equal(await exists(path.join(f.root,'escaped')),false);
});
test('redirects share one operation, allow three, reject a fourth and reject non-loopback HTTP',async t=>{
 const bytes=archive();let limit=3,external=false;
 const f=await fixture(t,(req,r)=>{const n=Number(new URL(req.url,'http://fixture').searchParams.get('n')??0);if(external){r.writeHead(302,{location:'http://localhost:9/private-query'});r.end();}else if(n<limit){r.writeHead(302,{location:`/archive?n=${n+1}`});r.end();}else r.end(bytes);});
 assert.equal((await run(f,bytes).done).code,0);await rm(path.join(f.home,'installer-called'));limit=4;await rejected(f,await run(f,bytes).done,/redirect/i);external=true;await rejected(f,await run(f,bytes).done,/loopback|HTTPS|URL/i);
});
test('interrupting a blocked download reaps it and removes only owned temporary data',async t=>{
 const bytes=archive();let started;const arrived=new Promise(r=>started=r),f=await fixture(t,(_,r)=>{r.writeHead(200);r.write(bytes.subarray(0,10));started();});
 const {child,done}=run(f,bytes);await Promise.race([arrived,done.then(r=>{throw Error('Script exited before downloading: '+r.stderr);})]);child.kill('SIGTERM');await rejected(f,await done,/interrupt/i);assert.equal(f.requests,1);
});
test('gzip trailing garbage and an additional empty gzip stream are rejected',async t=>{
 let bytes;const f=await fixture(t,(_,r)=>r.end(bytes));
 for(const tail of [Buffer.from('private-trailing-data'),gzipSync(Buffer.alloc(0))]){bytes=Buffer.concat([archive(),tail]);await rejected(f,await run(f,bytes).done,/archive|gzip/i);}
});
test('untrusted manifest diagnostics do not echo private fields',async t=>{
 const e=entries();e.at(-1).body=JSON.stringify({schema:'private-schema-value',version,layout:'terminal-beta-v2'});const bytes=gzipSync(tar(e)),f=await fixture(t,(_,r)=>r.end(bytes));
 const result=await run(f,bytes).done;await rejected(f,result,/manifest/i);assert.doesNotMatch(result.stdout+result.stderr,/private-schema-value/);
});
test('original installer failure remains a failure and quiescent staging is cleaned',async t=>{
 const bytes=archive({installerExit:7}),f=await fixture(t,(_,r)=>r.end(bytes));const result=await run(f,bytes).done;
 assert.notEqual(result.code,0);assert.match(result.stderr,/original installer failed/i);assert.equal(await exists(path.join(f.home,'installer-called')),true);assert.deepEqual(await readdir(f.tmp),[]);
});
test('installer descendant ownership retains staging until separately observed quiescent',async t=>{
 const e=entries();e[1].body='#!/bin/sh\n/bin/sleep 2 &\nexit 0\n';const bytes=gzipSync(tar(e)),f=await fixture(t,(_,r)=>r.end(bytes));const result=await run(f,bytes).done;
 assert.notEqual(result.code,0,'a lingering installer descendant cannot authorize staging deletion');assert.match(result.stderr,/ownership|quiescen/i);assert.equal((await readdir(f.tmp)).length,1);
 // close event waits for inherited pipes; the owned sleep has finished here.
});
test('member-size, metadata-size and member-count limits reject before installer execution',async t=>{
 let bytes;const f=await fixture(t,(_,r)=>r.end(bytes));
 const samples=[Buffer.concat([tar(entries()).subarray(0,-1024),header(stem+'/huge',{size:256*1024*1024+1}),Buffer.alloc(1024)]),tar(entries().map(e=>e.name.endsWith('package-manifest.json')?{...e,size:2*1024*1024+1}:e)),tar([...entries(),...Array.from({length:20000},(_,i)=>({name:stem+'/d'+i+'/',type:'5',mode:0o755}))])];
 for(const raw of samples){bytes=gzipSync(raw);await rejected(f,await run(f,bytes).done,/limit|exceeds|20000|256 MiB/i);}
});
test('streamed response byte ceiling works without Content-Length',async t=>{
 const bytes=archive(),block=Buffer.alloc(1024*1024);const f=await fixture(t,(_,r)=>{r.writeHead(200);let left=257;const next=()=>{if(r.destroyed)return;if(!left--){r.end();return;}r.write(block,next);};next();});
 await rejected(f,await run(f,bytes).done,/compressed-byte limit/i);
});
test('response metadata has a bounded header budget',async t=>{
 const bytes=archive(),f=await fixture(t,(_,r)=>{r.writeHead(200,{'x-fixture': 'x'.repeat(66000)});r.end(bytes);});await rejected(f,await run(f,bytes).done,/headers.*limit/i);
});

test('relative redirect from an authority-only URL retains the original host',async t=>{
 const bytes=archive(),f=await fixture(t,(req,r)=>{if(req.url.startsWith('/?'))r.writeHead(302,{location:'archive'}).end();else r.end(bytes);});
 const args=['--version',version,'--url',f.url.replace('/archive','?fixture-query'),'--sha256',sha(bytes),'--home',f.home,'--no-path','--test-loopback-http'];const result=await run(f,bytes,{args}).done;assert.equal(result.code,0,result.stderr);assert.equal(f.requests,2);
});
test('optional gzip metadata and damaged checksums fail before archive code',async t=>{
 let bytes;const f=await fixture(t,(_,r)=>r.end(bytes)),good=archive();const badCrc=Buffer.from(good);badCrc[badCrc.length-8]^=1;
 for(const flag of [8,16,4]){const h=Buffer.from(good.subarray(0,10));h[3]=flag;bytes=Buffer.concat([h,Buffer.alloc(256*1024,65),Buffer.from([0]),good.subarray(10)]);await rejected(f,await run(f,bytes).done,/gzip.*header/i);}
 bytes=badCrc;await rejected(f,await run(f,bytes).done,/archive|gzip/i);
});
test('one 120-second download deadline spans redirects and stalled body', {timeout:140000},async t=>{
 const bytes=archive(),timers=[];const f=await fixture(t,(req,r)=>{if(!req.url.includes('second')){r.writeHead(302,{location:'/second'});r.flushHeaders();timers.push(setTimeout(()=>r.end(),65000));}else{r.writeHead(200);r.write(bytes.subarray(0,10));timers.push(setTimeout(()=>r.end(bytes.subarray(10)),65000));}});
 t.after(()=>timers.forEach(clearTimeout));const began=performance.now();const result=await run(f,bytes).done;await rejected(f,result,/download.*deadline|download failed/i);assert.ok(performance.now()-began>=115000);assert.ok(performance.now()-began<130000);assert.equal(f.requests,2);
});

test('simulated non-Mac and x64 host results fail before a request',async t=>{
 const bytes=archive(),f=await fixture(t,(_,r)=>r.end(bytes)),source=await readFile(script,'utf8');
 // Only the OS query command is replaced in private test copies. The shipped
 // script always invokes absolute system uname, including in loopback mode.
 for(const [system,machine] of [['Linux','arm64'],['Darwin','x86_64']]){
  const uname=path.join(f.root,'fixture-uname');await writeFile(uname,`#!/bin/sh\ncase "$1" in -s) echo ${system};; -m) echo ${machine};; esac\n`,{mode:0o700});
  const copy=path.join(f.root,'host-specimen.sh'),quoted="'"+uname.replaceAll("'", "'\\''")+"'";
  assert.equal(source.split('/usr/bin/uname').length-1,2,'test copy replaces only the two OS query ports');await writeFile(copy,source.replaceAll('/usr/bin/uname',quoted));
  await rejected(f,await run(f,bytes,{scriptPath:copy}).done,/platform|arm64/i);
 }
 assert.equal(f.requests,0);
});

test('expanded gzip ceiling rejects a small compressed bomb before installer execution',{timeout:90000},async t=>{
 const bytes=await expandedBomb(),f=await fixture(t,(_,r)=>r.end(bytes));assert.ok(bytes.length<2*1024*1024);await rejected(f,await run(f,bytes).done,/expanded-byte limit/i);
});

test('interrupting an installer preserves its staged runtime and original owner',{timeout:25000},async t=>{
 const e=entries();e[1].body='#!/bin/sh\nprintf started > "$2/installer-started"\n/bin/sleep 2\nprintf complete > "$2/installer-complete"\n';const bytes=gzipSync(tar(e));let cleanupSafe=false;
 // Startup includes download/hash/extraction. Deliberately exceed the old1s
 // assumption, then interrupt only after the installer signals actual readiness.
 const responseDelayMs=1500;
 const f=await fixture(t,(_,r)=>{const timer=setTimeout(()=>r.end(bytes),responseDelayMs);r.once('close',()=>clearTimeout(timer));},{canCleanup:()=>cleanupSafe});
 const began=performance.now(),startupDeadline=began+15000,{child,done}=run(f,bytes);
 let closed=null;done.then(result=>closed=result,error=>closed={error:error.message});
 for(;;){
  assert.ok(!closed&&child.exitCode===null&&child.signalCode===null,'Wrapper exited before installer readiness: '+JSON.stringify(closed??{code:child.exitCode,signal:child.signalCode}));
  assert.ok(performance.now()<startupDeadline,'Installer startup readiness deadline exceeded;preserve fixture');
  if(await exists(path.join(f.home,'installer-started')))break;
  await new Promise(r=>setTimeout(r,20));
 }
 const readyAfterMs=performance.now()-began;assert.ok(readyAfterMs>=responseDelayMs);t.diagnostic('Installer readiness observed after '+Math.round(readyAfterMs)+'ms');
 assert.equal(child.kill('SIGTERM'),true);const result=await done;
 assert.notEqual(result.code,0);assert.match(result.stderr,/installer ownership unresolved/);assert.match(result.stderr,/Interrupted during installer/);
 assert.equal(await readFile(path.join(f.home,'installer-complete'),'utf8'),'complete');
 const names=await readdir(f.tmp);assert.equal(names.length,1);
 const owner=await readFile(path.join(f.tmp,names[0],'installer-owner.txt'),'utf8'),group=Number(owner.match(/processGroup=(\d+)/)?.[1]);assert.ok(group);
 assert.throws(()=>process.kill(-group,0),{code:'ESRCH'},'Installer ownership must be quiescent before fixture cleanup');
 cleanupSafe=true;
});
