import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../src/harness/contracts.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const skills=['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only'];
const safe={local:'quiescent',remote:'quiescent',pending:[],authorized:[]};
const api=()=>import('../scripts/deployment-checkpoint.mjs');
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'binding-checkpoint-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const candidate=path.join(root,'version'),personalRoot=path.join(root,'fake-personal'),state=path.join(root,'current-state');
 for(const dir of [candidate,personalRoot,state,path.join(personalRoot,'skills')])await fs.mkdir(dir,{recursive:true});
 const files=[];for(const [name,body] of Object.entries({'scripts/harness.mjs':'throw Error("NEVER EXECUTE CANDIDATE");','runtime/src/harness/cli.mjs':'throw Error("NEVER EXECUTE CANDIDATE");',...Object.fromEntries(skills.map(n=>['skills/'+n+'/SKILL.md','FIXTURE'])),'runtime/package-lock.json':JSON.stringify({packages:{'node_modules/@modelcontextprotocol/sdk':{version:'1.32.2'}}}),'runtime/node_modules/@modelcontextprotocol/sdk/package.json':JSON.stringify({version:'1.32.2'})})){
  await fs.mkdir(path.dirname(path.join(candidate,name)),{recursive:true});await fs.writeFile(path.join(candidate,name),body);files.push({path:name,bytes:Buffer.byteLength(body),sha256:hash(body)});
 }
 const manifest={schema:1,layout:'shared-runtime-v1',skills,sourceCommit:'a'.repeat(40),sourceDirty:false,nodeMajor:24,sdkVersion:'1.32.2',dependenciesInstalled:true,files,contentHash:digest(files)},bytes=JSON.stringify(manifest);await fs.writeFile(path.join(candidate,'package-manifest.json'),bytes);
 await fs.writeFile(path.join(state,'key'),'SECRET_SENTINEL');await fs.writeFile(path.join(state,'counters'),'6');
 const options={candidate,expectedContentHash:manifest.contentHash,expectedManifestSha256:hash(bytes),personalRoot,skillRoot:path.join(personalRoot,'skills'),launcherConfig:path.join(personalRoot,'launcher.json'),state,checkpoint:path.join(root,'checkpoint')};
 const prepare=async()=>{const {prepareBindings}=await api();const result=await prepareBindings(options);return {checkpoint:options.checkpoint,expectedPlanSha256:result.planSha256,expectedContentHash:options.expectedContentHash,expectedManifestSha256:options.expectedManifestSha256,safety:safe};};
 return {root,candidate,personalRoot,state,options,prepare};
}
// These fail if pins are trusted from the plan itself, unknown bindings are
// overwritten, or intent-before-write is removed from ambiguous replay.
test('prepare is nonmutating; apply/replay and removal only touch introduced bindings',async t=>{
 const f=await fixture(t),{applyBindings,removeBindings}=await api(),args=await f.prepare();
 assert.deepEqual(await fs.readdir(path.join(f.personalRoot,'skills')),[]);await assert.rejects(fs.stat(f.options.launcherConfig));
 const first=await applyBindings(args);assert.equal(first.status,'bindings_applied');assert.equal(first.installationAuthority,false);
 for(const name of skills)assert.equal(await fs.readlink(path.join(f.options.skillRoot,name)),path.join(f.candidate,'skills',name));
 assert.deepEqual(JSON.parse(await fs.readFile(f.options.launcherConfig)),{dataDir:f.state,runtimeRoot:path.join(f.candidate,'runtime')});
 assert.equal((await applyBindings(args)).status,'bindings_applied');
 await fs.writeFile(path.join(f.personalRoot,'unrelated'),'KEEP');await removeBindings(args);await removeBindings(args);
 assert.equal(await fs.readFile(path.join(f.personalRoot,'unrelated'),'utf8'),'KEEP');assert.equal(await fs.readFile(path.join(f.state,'key'),'utf8'),'SECRET_SENTINEL');assert.equal(await fs.readFile(path.join(f.state,'counters'),'utf8'),'6');assert.deepEqual(await fs.readdir(f.options.skillRoot),[]);
 await assert.rejects(applyBindings(args),/removed/);
 const publicResult=JSON.stringify(first);assert.ok(!publicResult.includes('SECRET_SENTINEL')&&!publicResult.includes(f.root));
});
test('wrong or stale candidate and plan pins stop before binding mutation',async t=>{
 const f=await fixture(t),{prepareBindings,applyBindings}=await api();await assert.rejects(prepareBindings({...f.options,expectedContentHash:'b'.repeat(64)}));
 const args=await f.prepare();await assert.rejects(applyBindings({...args,expectedPlanSha256:'b'.repeat(64)}));await assert.rejects(applyBindings({...args,expectedContentHash:'b'.repeat(64)}));
 await fs.writeFile(path.join(f.candidate,'scripts/harness.mjs'),'TAMPER');await assert.rejects(applyBindings(args));assert.deepEqual(await fs.readdir(f.options.skillRoot),[]);
});
test('unknown existing binding or someone else unit remains byte identical',async t=>{
 const f=await fixture(t),{prepareBindings}=await api(),target=path.join(f.options.skillRoot,skills[0]);await fs.symlink(path.join(f.candidate,'skills',skills[0]),target);
 await assert.rejects(prepareBindings(f.options),/existing_binding/);assert.equal(await fs.readlink(target),path.join(f.candidate,'skills',skills[0]));await fs.unlink(target);
 const unit=path.join(f.personalRoot,'other.service');await fs.writeFile(unit,'OWNER_SENTINEL');await assert.rejects(prepareBindings({...f.options,service:unit}));assert.equal(await fs.readFile(unit,'utf8'),'OWNER_SENTINEL');
});
test('partial replay resumes recorded intent but rejects an unowned matching binding',async t=>{
 const f=await fixture(t),{applyBindings}=await api(),args=await f.prepare();
 // An unrecorded path, even with matching bytes, does not belong to this install.
 await fs.symlink(path.join(f.candidate,'skills',skills[0]),path.join(f.options.skillRoot,skills[0]));await assert.rejects(applyBindings(args),/unowned_binding/);await fs.unlink(path.join(f.options.skillRoot,skills[0]));
 // Simulate interruption AFTER a durable intent and mutation but BEFORE completion.
 await fs.writeFile(path.join(args.checkpoint,'binding-0.intent.json'),JSON.stringify({schema:1,planSha256:args.expectedPlanSha256,index:0}));await fs.symlink(path.join(f.candidate,'skills',skills[0]),path.join(f.options.skillRoot,skills[0]));
 assert.equal((await applyBindings(args)).status,'bindings_applied');assert.ok((await fs.stat(path.join(args.checkpoint,'binding-0.done.json'))).isFile());
});
test('partial conflict preserves earlier progress without destructive rollback',async t=>{
 const f=await fixture(t),{applyBindings}=await api(),args=await f.prepare();await fs.writeFile(path.join(f.options.skillRoot,skills[1]),'FOREIGN');
 await assert.rejects(applyBindings(args),/unowned_binding/);assert.equal(await fs.readlink(path.join(f.options.skillRoot,skills[0])),path.join(f.candidate,'skills',skills[0]));assert.equal(await fs.readFile(path.join(f.options.skillRoot,skills[1]),'utf8'),'FOREIGN');
 await fs.unlink(path.join(f.options.skillRoot,skills[1]));assert.equal((await applyBindings(args)).status,'bindings_applied');
});
test('source/output traversal, symlinked parent, candidate overlap and state overwrite reject',async t=>{
 const f=await fixture(t),{prepareBindings}=await api();await fs.symlink(f.personalRoot,path.join(f.root,'alias'));
 for(const change of [{checkpoint:f.root+'/x/../escape'},{personalRoot:path.join(f.root,'alias')},{checkpoint:path.join(f.candidate,'ledger')},{launcherConfig:path.join(f.state,'key')},{skillRoot:f.root},{launcherConfig:path.join(f.personalRoot,'skills',skills[0])}])await assert.rejects(prepareBindings({...f.options,...change}));
 assert.equal(await fs.readFile(path.join(f.state,'key'),'utf8'),'SECRET_SENTINEL');
});
test('unknown remote ownership or unauthorized pending queue stops affected step',async t=>{
 const f=await fixture(t),{applyBindings}=await api(),args=await f.prepare();
 for(const safety of [{...safe,remote:'unknown'},{...safe,local:'running'},{...safe,pending:['old-job']},{...safe,pending:['old-job'],authorized:['new-job']}])await assert.rejects(applyBindings({...args,safety}));
 assert.deepEqual(await fs.readdir(f.options.skillRoot),[]);assert.equal((await applyBindings({...args,safety:{...safe,pending:['approved-job'],authorized:['approved-job']}})).status,'bindings_applied');
});
test('malformed rollback intent or modified introduced binding fails with current state retained',async t=>{
 const f=await fixture(t),{applyBindings,removeBindings}=await api(),args=await f.prepare();await applyBindings(args);
 await fs.writeFile(path.join(args.checkpoint,'binding-4.done.json'),'{}');await assert.rejects(removeBindings(args),/invalid_record/);assert.ok((await fs.stat(f.options.launcherConfig)).isFile());
 await fs.writeFile(path.join(args.checkpoint,'binding-4.done.json'),JSON.stringify({schema:1,planSha256:args.expectedPlanSha256,index:4}));await fs.writeFile(f.options.launcherConfig,'CHANGED_BY_OWNER');await assert.rejects(removeBindings(args),/changed_binding/);assert.equal(await fs.readFile(f.options.launcherConfig,'utf8'),'CHANGED_BY_OWNER');
});
test('old database restore and arbitrary command/secret fields have no execution surface',async t=>{
 const f=await fixture(t),{prepareBindings,applyBindings,removeBindings}=await api(),args=await f.prepare();
 await assert.rejects(prepareBindings({...f.options,token:'SECRET_SENTINEL'}));await assert.rejects(applyBindings({...args,command:['touch',path.join(f.root,'PWNED')]}));await assert.rejects(removeBindings({...args,restoreDatabase:path.join(f.root,'old.sqlite')}));await assert.rejects(fs.stat(path.join(f.root,'PWNED')));assert.equal(await fs.readFile(path.join(f.state,'counters'),'utf8'),'6');
});
test('WAL-consistent CURRENT backup preserves identities, exact approvals and spent counters',async t=>{
 const f=await fixture(t),{backupCurrentDatabase}=await api(),source=path.join(f.state,'state.sqlite'),db=new DatabaseSync(source);t.after(()=>db.close());db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=1; CREATE TABLE task(id TEXT,approval TEXT,deadline INTEGER,spent INTEGER); INSERT INTO task VALUES (\'task-1\',\'exact-approval\',123456,6)');
 assert.ok((await fs.stat(source+'-wal')).size>0);const output=path.join(f.root,'backup'),result=await backupCurrentDatabase({source,output});assert.equal(result.scope,'fixture_or_operator_backup');assert.equal(result.restorationSupported,false);
 const copy=new DatabaseSync(path.join(output,'current.sqlite'),{readOnly:true});try{assert.deepEqual({...copy.prepare('SELECT * FROM task').get()},{id:'task-1',approval:'exact-approval',deadline:123456,spent:6});assert.equal(copy.prepare('PRAGMA user_version').get().user_version,1);}finally{copy.close();}
 await assert.rejects(backupCurrentDatabase({source,output}));assert.equal(db.prepare('SELECT spent FROM task').get().spent,6);assert.equal((await fs.stat(path.join(output,'current.sqlite'))).mode&0o777,0o600);
});

test('private paths and secret-shaped inputs never escape bounded failure summaries',async t=>{
 const f=await fixture(t),{prepareBindings,backupCurrentDatabase}=await api();
 await fs.writeFile(path.join(f.state,'SECRET_SENTINEL.sqlite'),'not a database');
 for(const invoke of [()=>prepareBindings({...f.options,candidate:path.join(f.root,'SECRET_SENTINEL')}),()=>backupCurrentDatabase({source:path.join(f.state,'SECRET_SENTINEL.sqlite'),output:path.join(f.root,'failed-backup')})]){
  const error=await invoke().then(()=>null,e=>e);assert.ok(error);assert.match(error.message,/^[a-z][a-z0-9_]{1,80}$/);assert.ok(!error.message.includes('SECRET_SENTINEL'));
 }
});
