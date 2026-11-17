import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,cp,mkdir,writeFile,lstat,symlink,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {locations,privateDirectories,saveJson,hash,withLock} from '../src/beta/files.mjs';
import {canonical} from '../src/harness/contracts.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import * as settings from '../src/beta/settings.mjs';

const legacy={schema:1,host:{id:'codex',options:{}},codexPath:'/fixture/codex',worker:{profile:{baseUrl:'http://127.0.0.1:11434/v1',model:'fixture-local',displayName:'Fixture',revision:'r1',streaming:false},apiKey:'dummy-migration-"key\\value'}};
const names=['settings.json','credentials.json','migration-intent.json','migration-legacy.json','migration-receipt.json'];
let serial=0;
async function fixture(t,{hostOnly=false}={}){
 const home=await mkdtemp(path.join(os.tmpdir(),'mosaic-migration-conflicts-')),index=++serial;
 t.after(async()=>{
  const evidence=process.env.MOSAIC_MIGRATION_CONFLICT_EVIDENCE_DIR;
  if(evidence){await mkdir(evidence,{recursive:true,mode:0o700});await cp(home,path.join(evidence,String(index).padStart(3,'0')),{recursive:true});}
  await rm(home,{recursive:true,force:true});
 });
 const paths=locations(home,true);await privateDirectories(paths);
 await saveJson(paths.config,hostOnly?{...legacy,worker:null}:legacy);
 await saveJson(paths.credentials,{schema:1,entries:{unrelated:'dummy-unrelated-secret'}});
 return paths;
}
async function snapshot(paths){return Object.fromEntries(await Promise.all(names.map(async name=>[name,await readFile(path.join(paths.configDir,name)).catch(error=>{if(error.code==='ENOENT')return null;throw error;})])));}
async function unchanged(paths,before){const after=await snapshot(paths);for(const name of names)assert.ok(before[name]===null?after[name]===null:after[name]?.equals(before[name]),name+' must retain its exact conflict-boundary bytes');}
const lifecycle={verifyLaunchAgent:async()=>false,stopForMaintenance:async()=>false,startLaunchAgent:async()=>true};
async function change(paths,preview,kind){
 if(kind==='settings')await saveJson(paths.config,{...await settings.readSettings(paths),codexPath:'/fixture/newer-codex'});
 if(kind==='credentials')await saveJson(paths.credentials,{schema:1,entries:{...(await settings.readCredentials(paths)).entries,unrelated:'dummy-newer-secret'}});
 if(kind==='rotation')await saveJson(paths.credentials,{schema:1,entries:{...(await settings.readCredentials(paths)).entries,'legacy-worker-key':'dummy-rotated-secret'}});
 if(kind==='intent'){
  const {previewHash,...value}=preview;value.settings={...value.settings,codexPath:'/fixture/newer-intent'};
  await saveJson(path.join(paths.configDir,'migration-intent.json'),{...value,previewHash:hash(canonical(value))});
 }
 if(kind==='receipt')await saveJson(path.join(paths.configDir,'migration-receipt.json'),{schema:1,previewHash:'newer-receipt',complete:false});
 if(kind==='legacy')await saveJson(path.join(paths.configDir,'migration-legacy.json'),{...legacy,codexPath:'/fixture/newer-legacy'});
}

// Removing a boundary guard must allow a later production write or stale success.
for(const boundary of ['verify','stop','intent','credentials','settings','complete','restart'])for(const kind of ['settings','credentials','rotation','intent','receipt','legacy'])test(`apply preserves concurrent ${kind} at ${boundary}`,async t=>{
 const paths=await fixture(t),preview=await settings.previewSettingsMigration(paths);let before,reached=false;
 const inject=async at=>{if(at!==boundary)return;reached=true;await change(paths,preview,kind);before=await snapshot(paths);};
 const options={lifecycle:{...lifecycle,verifyLaunchAgent:async()=>{await inject('verify');return boundary==='restart';},stopForMaintenance:async()=>{await inject('stop');},startLaunchAgent:async()=>{await inject('restart');}},afterStep:inject};
 await assert.rejects(settings.applySettingsMigration(paths,preview,options),/changed|conflict|newer|preserv|incomplete/i);
 assert.ok(reached,'fixture boundary must execute');await unchanged(paths,before);
});

for(const step of ['intent','credentials','settings','complete'])for(const hostOnly of [false,true])test(`approved ${hostOnly?'host-only':'worker'} migration resumes once after ${step}`,async t=>{
 const paths=await fixture(t,{hostOnly}),preview=await settings.previewSettingsMigration(paths),other=(await settings.readCredentials(paths)).entries.unrelated;
 await assert.rejects(settings.applySettingsMigration(paths,preview,{lifecycle,afterStep:async at=>{if(at===step)throw Error('fixture interruption');}}),/fixture interruption/);
 assert.equal(await settings.resumeSettingsMigration(paths,{lifecycle}),true);
 assert.equal(await settings.resumeSettingsMigration(paths,{lifecycle}),false);
 assert.equal((await settings.readSettings(paths)).schema,2);
 const credentials=await settings.readCredentials(paths);assert.ok(credentials.entries.unrelated===other,'unrelated credential value is exact');
 assert.ok(hostOnly?!Object.hasOwn(credentials.entries,'legacy-worker-key'):credentials.entries['legacy-worker-key']===legacy.worker.apiKey,'approved worker credential is exact');
});

for(const boundary of ['verify','stop','credentials','settings','complete','restart'])for(const kind of ['settings','credentials','rotation','intent','receipt'])test(`resume preserves concurrent ${kind} at ${boundary}`,async t=>{
 const paths=await fixture(t),preview=await settings.previewSettingsMigration(paths);
 await assert.rejects(settings.applySettingsMigration(paths,preview,{lifecycle,afterStep:async at=>{if(at==='intent')throw Error('fixture interruption');}}),/fixture interruption/);
 let before,reached=false;const inject=async at=>{if(at!==boundary)return;reached=true;await change(paths,preview,kind);before=await snapshot(paths);};
 await assert.rejects(settings.resumeSettingsMigration(paths,{lifecycle:{...lifecycle,verifyLaunchAgent:async()=>{await inject('verify');return boundary==='restart';},stopForMaintenance:async()=>{await inject('stop');},startLaunchAgent:async()=>{await inject('restart');}},afterStep:inject}),/changed|conflict|newer|preserv|incomplete/i);
 assert.ok(reached);await unchanged(paths,before);
});

for(const boundary of ['verify','restart'])for(const kind of ['settings','credentials','rotation','intent','receipt','legacy'])test(`completed resume preserves concurrent ${kind} at ${boundary}`,async t=>{
 const paths=await fixture(t),preview=await settings.previewSettingsMigration(paths);
 await assert.rejects(settings.applySettingsMigration(paths,preview,{lifecycle,afterStep:async at=>{if(at==='complete')throw Error('fixture interruption');}}),/fixture interruption/);
 let before,reached=false;const inject=async at=>{if(at===boundary){reached=true;await change(paths,preview,kind);before=await snapshot(paths);}};
 await assert.rejects(settings.resumeSettingsMigration(paths,{lifecycle:{...lifecycle,verifyLaunchAgent:async()=>{await inject('verify');return true;},startLaunchAgent:async()=>{await inject('restart');}},afterStep:async()=>{assert.fail('Completed migration must not replay durable writes');}}),/changed|conflict|newer|preserv|incomplete/i);
 assert.ok(reached);await unchanged(paths,before);
});

for(const step of ['intent','credentials','settings','complete'])for(const kind of ['receipt','legacy','intent'])test(`resume rejects ${kind} changed before interruption at ${step}`,async t=>{
 const paths=await fixture(t),preview=await settings.previewSettingsMigration(paths);
 await assert.rejects(settings.applySettingsMigration(paths,preview,{lifecycle,afterStep:async at=>{if(at===step){await change(paths,preview,kind);throw Error('fixture interruption');}}}),/fixture interruption/);
 const before=await snapshot(paths);
 await assert.rejects(settings.resumeSettingsMigration(paths,{lifecycle}),/changed|conflict|newer|preserv|incomplete/i);await unchanged(paths,before);
});

test('startup without a pending migration ignores unrelated old migration artifacts',async t=>{
 const paths=await fixture(t);await saveJson(path.join(paths.configDir,'migration-receipt.json'),null);
 const {writeFile}=await import('node:fs/promises');await writeFile(path.join(paths.configDir,'migration-legacy.json'),'old non-JSON artifact',{mode:0o600});
 assert.equal(await settings.assertMigrationStartupReady(paths,await settings.readSettings(paths)),false);
});

test('startup readiness rejects a stale supplied settings snapshot',async t=>{
 const paths=await fixture(t),preview=await settings.previewSettingsMigration(paths);
 await assert.rejects(settings.applySettingsMigration(paths,preview,{lifecycle,afterStep:async at=>{if(at==='complete')throw Error('fixture interruption');}}),/fixture interruption/);
 const stale=await settings.readSettings(paths);await change(paths,preview,'settings');const before=await snapshot(paths);
 await assert.rejects(settings.assertMigrationStartupReady(paths,stale),/changed|incomplete|stale/i);await unchanged(paths,before);
});

test('startup receipt cannot certify credential rotation outside the approved intent',async t=>{
 const paths=await fixture(t),preview=await settings.previewSettingsMigration(paths);
 await assert.rejects(settings.applySettingsMigration(paths,preview,{lifecycle,afterStep:async at=>{if(at==='complete')throw Error('fixture interruption');}}),/fixture interruption/);
 await change(paths,preview,'rotation');const file=path.join(paths.configDir,'migration-receipt.json'),receipt=JSON.parse(await readFile(file,'utf8'));
 await saveJson(file,{...receipt,credentialsHash:hash(canonical(await settings.readCredentials(paths)))});const before=await snapshot(paths);
 await assert.rejects(settings.assertMigrationStartupReady(paths,await settings.readSettings(paths)),/incomplete|changed/i);await unchanged(paths,before);
});

for(const kind of ['legacy','intent','receipt'])test(`startup readiness preserves ${kind} changed after a completed interruption`,async t=>{
 const paths=await fixture(t),preview=await settings.previewSettingsMigration(paths);
 await assert.rejects(settings.applySettingsMigration(paths,preview,{lifecycle,afterStep:async at=>{if(at==='complete')throw Error('fixture interruption');}}),/fixture interruption/);
 assert.equal(await settings.assertMigrationStartupReady(paths,await settings.readSettings(paths)),true);
 await change(paths,preview,kind);const before=await snapshot(paths);
 await assert.rejects(settings.assertMigrationStartupReady(paths,await settings.readSettings(paths)),/changed|incomplete/i);await unchanged(paths,before);
});

for(const hostOnly of [false,true])test(`resume retains a preexisting approved credential reference for ${hostOnly?'host-only':'worker'}`,async t=>{
 const paths=await fixture(t,{hostOnly});await saveJson(paths.credentials,{schema:1,entries:{unrelated:'dummy-unrelated-secret','legacy-worker-key':legacy.worker.apiKey}});
 const before=await readFile(paths.credentials),preview=await settings.previewSettingsMigration(paths);
 await assert.rejects(settings.applySettingsMigration(paths,preview,{lifecycle,afterStep:async at=>{if(at==='credentials')throw Error('fixture interruption');}}),/fixture interruption/);
 assert.equal(await settings.resumeSettingsMigration(paths,{lifecycle}),true);assert.ok((await readFile(paths.credentials)).equals(before),'already approved credential store is byte-for-byte unchanged');
});

test('caller preview mutation during a phase cannot change the approved migration',async t=>{
 const paths=await fixture(t),preview=await settings.previewSettingsMigration(paths),approved=structuredClone(preview.settings);
 assert.equal(await settings.applySettingsMigration(paths,preview,{lifecycle,afterStep:async at=>{if(at==='credentials')preview.settings.codexPath='/fixture/caller-edit';}}),true);
 assert.deepEqual(await settings.readSettings(paths),approved);
});

test('conflict diagnostics and preview do not include private credential values',async t=>{
 const paths=await fixture(t),preview=await settings.previewSettingsMigration(paths);let message='';
 await assert.rejects(settings.applySettingsMigration(paths,preview,{lifecycle,afterStep:async at=>{if(at==='credentials')await change(paths,preview,'rotation');}}),error=>{message=error.message;return /changed/i.test(message);});
 const summary=JSON.stringify({preview,message});for(const value of [legacy.worker.apiKey,'dummy-unrelated-secret','dummy-rotated-secret'])assert.ok(!summary.includes(value)&&!summary.includes(JSON.stringify(value).slice(1,-1)),'summary must not disclose a credential');
});

test('restart runs outside the mutex and revalidates before removing recovery evidence',async t=>{
 const paths=await fixture(t),preview=await settings.previewSettingsMigration(paths);let restarted=false;
 assert.equal(await settings.applySettingsMigration(paths,preview,{lifecycle:{...lifecycle,verifyLaunchAgent:async()=>true,startLaunchAgent:async()=>{await withLock(paths,async()=>{restarted=true;});}}}),true);
 assert.ok(restarted);assert.equal(await settings.resumeSettingsMigration(paths,{lifecycle}),false);
});

for(const status of ['active','stopped'])for(const hostOnly of [false,true])test(`${status} ${hostOnly?'host-only':'worker'} approval remains protected`,async t=>{
 const paths=await fixture(t,{hostOnly}),c=new Coordinator({root:paths.state,beta:true,selectedHost:'codex',codexPath:legacy.codexPath,...(!hostOnly?{workerProfile:legacy.worker.profile}:{})});
 t.after(()=>c.close());const goal=c.prepareGoal({submissionId:'protected',objective:'Keep approval',acceptance:['Exact binding'],mode:hostOnly?'codex_only':'collaborative',environment:'fixture'},'prepare');c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');if(status==='stopped')c.control({goalId:goal.id,action:'stop'},'stop');
 const before=await snapshot(paths),saved=structuredClone(c.getGoal(goal.id));await assert.rejects(settings.applySettingsMigration(paths,await settings.previewSettingsMigration(paths),{lifecycle}),/active|stopped|approval|prepared/i);
 await unchanged(paths,before);assert.deepEqual(c.getGoal(goal.id),saved);
});

test('migration keeps the maintenance exclusion and startup lease intact',async t=>{
 const paths=await fixture(t),preview=await settings.previewSettingsMigration(paths),before=await snapshot(paths);
 await withLock(paths,async()=>{await assert.rejects(settings.applySettingsMigration(paths,preview,{lifecycle}),/maintenance command/i);});await unchanged(paths,before);
 const c=new Coordinator({root:paths.state});try{const lease=c.acquireWorker('fixture-startup');await assert.rejects(settings.applySettingsMigration(paths,preview,{lifecycle}),/lease|startup|coordinator/i);assert.deepEqual(c.store.get('lease','coordinator'),lease);c.releaseWorker('fixture-startup');}finally{c.close();}
 await unchanged(paths,before);assert.equal(await settings.applySettingsMigration(paths,preview,{lifecycle}),true);
});

// The parent watchdog remains effective even when a production sync open blocks
// its child event loop. No process ever opens these FIFOs for writing.
for(const api of ['readiness','apply','resume'])for(const name of api==='readiness'?['migration-intent.json','migration-legacy.json','migration-receipt.json']:['migration-legacy.json','migration-receipt.json'])test(`${api} rejects writerless private FIFO at ${name} without hanging`,async t=>{
 const paths=await fixture(t);
 if(api!=='apply')await assert.rejects(settings.applySettingsMigration(paths,await settings.previewSettingsMigration(paths),{lifecycle,afterStep:async at=>{if(at==='complete')throw Error('fixture interruption');}}),/fixture interruption/);
 const before=await snapshot(paths),target=path.join(paths.configDir,name);await rm(target,{force:true});
 const made=spawnSync('/usr/bin/mkfifo',['-m','600',target],{encoding:'utf8',timeout:2000});assert.equal(made.status,0,made.stderr);
 const initial=await lstat(target),child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/mosaic-migration-conflicts/read-record.mjs',import.meta.url)),paths.home,api],{encoding:'utf8',timeout:2000,killSignal:'SIGKILL',maxBuffer:8192,env:{PATH:'/usr/bin:/bin',HOME:paths.home}});
 let reaped=false;try{process.kill(child.pid,0);}catch(error){if(error.code==='ESRCH')reaped=true;else throw error;}
 const after=await lstat(target),record={api,name,pid:child.pid,status:child.status,signal:child.signal,watchdogError:child.error?.code??null,reaped,stdout:child.stdout,stderr:child.stderr,fifoBefore:{type:initial.isFIFO()?'FIFO':'other',mode:initial.mode&0o777,uid:initial.uid,dev:initial.dev,ino:initial.ino},fifoAfter:{type:after.isFIFO()?'FIFO':'other',dev:after.dev,ino:after.ino}};
 await saveJson(path.join(paths.home,'fifo-child-evidence.json'),record);
 await rm(target,{force:true});if(before[name]!==null)await writeFile(target,before[name],{mode:0o600});
 assert.ok(initial.isFIFO()&&(initial.mode&0o777)===0o600&&initial.uid===process.getuid());assert.ok(reaped,'owned child must be killed/reaped or exit normally');
 assert.match(child.stdout,new RegExp('entered:'+api));assert.equal(child.error?.code,undefined,'production migration reader hung until the finite watchdog killed its owned child');
 assert.equal(child.status,0,child.stderr);const outcome=JSON.parse(child.stdout.trim().split('\n').at(-1));assert.equal(outcome.rejected,true);assert.match(outcome.message,/unsafe|invalid/i);
 if(api==='readiness')assert.equal(outcome.descriptorsAfter,outcome.descriptorsBefore,'rejected descriptor must close');
 assert.ok(after.isFIFO()&&after.dev===initial.dev&&after.ino===initial.ino,'rejection must preserve the FIFO identity');await unchanged(paths,before);
});

for(const name of ['migration-intent.json','migration-legacy.json','migration-receipt.json'])for(const kind of ['directory','symlink','oversize','malformed','public-mode','exact-cap'])test(`readiness ${kind==='exact-cap'?'accepts':'rejects'} ${kind} at ${name}`,async t=>{
 const paths=await fixture(t);await assert.rejects(settings.applySettingsMigration(paths,await settings.previewSettingsMigration(paths),{lifecycle,afterStep:async at=>{if(at==='complete')throw Error('fixture interruption');}}),/fixture interruption/);
 const target=path.join(paths.configDir,name),original=await readFile(target);
 if(kind==='directory'){await rm(target);await mkdir(target,{mode:0o700});}
 if(kind==='symlink'){const backing=path.join(paths.home,'owned-record.json');await writeFile(backing,original,{mode:0o600});await rm(target);await symlink(backing,target);}
 if(kind==='oversize'||kind==='exact-cap')await writeFile(target,Buffer.concat([original,Buffer.alloc(131072-original.length+(kind==='oversize'?1:0),0x20)]));
 if(kind==='malformed')await writeFile(target,'{broken-json');
 if(kind==='public-mode')await chmod(target,0o644);
 const info=await lstat(target);await saveJson(path.join(paths.home,'record-type-evidence.json'),{kind,name,size:info.size,mode:info.mode&0o777,uid:info.uid,regular:info.isFile(),directory:info.isDirectory(),symlink:info.isSymbolicLink()});
 if(kind==='exact-cap')assert.equal(await settings.assertMigrationStartupReady(paths,await settings.readSettings(paths)),true);
 else await assert.rejects(settings.assertMigrationStartupReady(paths,await settings.readSettings(paths)),/unsafe|invalid/i);
});
