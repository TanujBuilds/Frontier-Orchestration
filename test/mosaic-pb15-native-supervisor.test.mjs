import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../src/project/check-backends/native-supervisor.c',import.meta.url));
async function setup(t){
 assert.ok(existsSync(source),'production native supervisor must exist');
 const root=await mkdtemp('/private/tmp/mosaic-supervisor-test-');t.after(()=>rm(root,{recursive:true,force:true}));
 const helper=path.join(root,'helper'),fixture=path.join(root,'fixture'),profile=path.join(root,'policy.sb');
 execFileSync('/usr/bin/clang',['-Wall','-Wextra','-Werror','-O2',source,'-o',helper]);
 execFileSync('/usr/bin/clang',['-O2',fileURLToPath(new URL('fixtures/mosaic-pb15-v2-backend/descendants.c',import.meta.url)),'-o',fixture]);
 await writeFile(profile,'(version 1)\n(allow default)\n(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid))\n(deny syscall-unix (with errno ENOSYS) (syscall-number SYS_posix_spawn))\n');
 return {root,helper,fixture,profile};
}
async function run(s,mode,{control='go',timeout=1000,limit=4096}={}){
 const receipt=path.join(s.root,'receipt-'+mode+'-'+control),marker=path.join(s.root,'late-'+mode+'-'+control);
 const child=spawn(s.helper,['11111111-1111-4111-8111-111111111111','a'.repeat(64),receipt,String(timeout),String(limit),s.root,s.profile,'--',s.fixture,mode,marker],{stdio:['ignore','pipe','pipe','pipe','pipe']});
 let events='',stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdio[3].on('data',b=>{events+=b; if(events.includes('"type":"prepared"')&&!child.sent){child.sent=true;if(control==='eof')child.stdio[4].end();else child.stdio[4].write(control+'\n');}});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});
 const saved=JSON.parse(await readFile(receipt,'utf8'));return {code,saved,events:events.trim().split('\n').map(JSON.parse),stdout,stderr,marker};
}
const mac={skip:process.platform!=='darwin'||process.arch!=='arm64',timeout:15000};
test('native supervisor drains surviving ignored-stdio descendants after normal zero exit',mac,async t=>{const s=await setup(t),r=await run(s,'normal');assert.equal(r.code,0);assert.equal(r.saved.code,0);assert.equal(r.saved.reason,'exit');assert.equal(r.saved.groupESRCH,true);assert.equal(r.saved.leaderReaped,true);assert.equal(r.saved.nonzeroSignalsAfterReap,0);assert.equal(r.stdout.trim(),'parent-zero');await new Promise(r=>setTimeout(r,850));await assert.rejects(access(r.marker),{code:'ENOENT'});});
test('native supervisor proves timeout cleanup without accepting child exit as success',mac,async t=>{const s=await setup(t),r=await run(s,'timeout',{timeout:500});assert.equal(r.saved.reason,'timeout');assert.equal(r.saved.groupESRCH,true);assert.ok([9,15].includes(r.saved.termSignal));});
test('native supervisor cancels startup without executing child code',mac,async t=>{const s=await setup(t),r=await run(s,'normal',{control:'cancel'});assert.equal(r.saved.reason,'startup-cancel');assert.equal(r.saved.groupESRCH,true);assert.equal(r.stdout,'');});
test('native supervisor drains after coordinator control EOF',mac,async t=>{const s=await setup(t),r=await run(s,'normal',{control:'eof'});assert.equal(r.saved.reason,'control-eof');assert.equal(r.saved.groupESRCH,true);assert.equal(r.stdout,'');});
test('native supervisor caps untrusted output and proves cleanup',mac,async t=>{const s=await setup(t),r=await run(s,'output',{limit:512});assert.equal(r.saved.reason,'output-limit');assert.ok(Buffer.byteLength(r.stdout)+Buffer.byteLength(r.stderr)<=512);assert.equal(r.saved.groupESRCH,true);});
test('native supervisor drains concurrent fork flood with no late writes',mac,async t=>{const s=await setup(t),r=await run(s,'flood',{timeout:45});assert.equal(r.saved.groupESRCH,true);assert.equal(r.saved.nonzeroSignalsAfterReap,0);await new Promise(r=>setTimeout(r,850));await assert.rejects(access(r.marker),{code:'ENOENT'});});
test('native supervisor proves cleanup when child startup chdir fails',mac,async t=>{const s=await setup(t);s.root=path.join(s.root,'missing-directory');const original=s.root;/* Receipt must remain in an existing private directory. */const base=path.dirname(original),child=spawn(s.helper,['22222222-2222-4222-8222-222222222222','b'.repeat(64),path.join(base,'startup-failure-receipt'),'1000','4096',original,s.profile,'--',s.fixture,'normal',path.join(base,'late')],{stdio:['ignore','pipe','pipe','pipe','pipe']});let protocol='';child.stdio[3].on('data',b=>protocol+=b);const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,0);const receipt=JSON.parse(await readFile(path.join(base,'startup-failure-receipt'),'utf8'));assert.equal(receipt.reason,'startup-cancel');assert.equal(receipt.groupESRCH,true);assert.equal(receipt.leaderReaped,true);assert.equal(receipt.nonzeroSignalsAfterReap,0);});
test('native supervisor control probe proves kernel denials from a nonleader and detects an unrestricted profile',mac,async t=>{const s=await setup(t);const probe=profile=>new Promise((resolve,reject)=>{const c=spawn('/usr/bin/sandbox-exec',['-f',profile,s.helper,'--probe',process.execPath]);let stdout='';c.stdout.on('data',b=>stdout+=b);c.on('error',reject);c.on('close',code=>resolve({code,stdout}));});const blocked=await probe(s.profile);assert.equal(blocked.code,0);const p=JSON.parse(blocked.stdout);assert.notEqual(p.pid,p.beforePgid);assert.equal(p.setsid.rc,-1);assert.equal(p.setsid.errno,1);assert.equal(p.setpgid.rc,-1);assert.equal(p.setpgid.errno,1);assert.equal(p.spawn.rc,78);assert.equal(p.spawnDetached.rc,78);await writeFile(s.profile,'(version 1)\n(allow default)\n');const open=await probe(s.profile),q=JSON.parse(open.stdout);assert.ok(q.setsid.rc>0);assert.equal(q.spawn.rc,0);assert.equal(q.spawnDetached.rc,0);});
test('native supervisor retains and drains its reserved leader after waitid observation error',mac,async t=>{const s=await setup(t);const helper=path.join(s.root,'fault-helper');execFileSync('/usr/bin/clang',['-std=c11','-O2','-Wall','-Wextra','-Werror',fileURLToPath(new URL('fixtures/mosaic-pb15-v2-backend/waitid-error-supervisor.c',import.meta.url)),'-o',helper]);s.helper=helper;const r=await run(s,'normal');assert.equal(r.code,0);assert.equal(r.saved.groupESRCH,true);assert.equal(r.saved.leaderReaped,true);assert.ok(r.events.some(e=>e.type==='uncertain'));await new Promise(r=>setTimeout(r,850));await assert.rejects(access(r.marker),{code:'ENOENT'});});
