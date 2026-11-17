import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {Store} from '../../../src/harness/store.mjs';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Journal,atomicJson} from '../../../src/project/journal.mjs';

const [name,root] = process.argv.slice(2);
assert.ok(path.isAbsolute(root));
const report = {case:name,checks:[],errors:[],classification:name==='store-rollback-cleanup'
  ? 'injected child-local rollback failure; not SQLite page exhaustion or OS disk/ACL proof'
  : name.startsWith('sqlite') || name.startsWith('store') || name==='coordinator-save'
  ? 'actual owned SQLite page exhaustion; not OS disk-full proof'
  : 'injected child-local filesystem error; not OS disk/ACL proof'};
const check = (label,fn) => {
  try {fn();report.checks.push({label,pass:true});}
  catch(error) {report.checks.push({label,pass:false,error:diagnostic(error)});}
};
function diagnostic(error) {
  if (!error) return null;
  return Object.fromEntries(['name','message','stack','code','errcode','errstr','syscall','path','dest'].filter(k => error[k]!==undefined).map(k => [k,error[k]]));
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (file,value) => fs.writeFile(path.join(root,file),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const snapshot = db => Object.fromEntries(['records','submissions','commands','events','requests','sqlite_sequence'].map(table => [table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
function ceiling(db) {
  const read = pragma => db.prepare('PRAGMA '+pragma).get()[pragma];
  const pageSize=read('page_size'),pageCount=read('page_count'),freelistCount=read('freelist_count');
  const maxPageCount=db.prepare('PRAGMA max_page_count='+(pageCount+2)).get().max_page_count;
  assert.equal(maxPageCount,pageCount+2);
  assert.ok(maxPageCount*pageSize<=2*1024*1024);
  return {pageSize,pageCount,freelistCount,maxPageCount,additionalPages:2,ceilingBytes:maxPageCount*pageSize};
}
const payload = () => 'x'.repeat(3*1024*1024);
const hasFull = e => e?.errcode===13 || /SQLITE_FULL|database or disk is full/i.test(e?.message??'');
// Pass-through diagnostic observer on this one owned connection only. It never
// injects SQLite failures or changes SQL, parameters, results or thrown objects.
function observe(db) {
  const prepare=db.prepare,exec=db.exec,errors=[],thrownErrors=[];
  db.prepare=function(sql,...args) {
    const statement=prepare.call(this,sql,...args);
    if (/^(INSERT|UPDATE)\b/i.test(sql)) {
      const run=statement.run;
      statement.run=function(...params) {
        try {return run.apply(this,params);}
        catch(error) {errors.push({operation:sql,error:diagnostic(error)});thrownErrors.push(error);throw error;}
      };
    }
    return statement;
  };
  db.exec=function(sql,...args) {
    try {return exec.call(this,sql,...args);}
    catch(error) {errors.push({operation:sql,error:diagnostic(error)});thrownErrors.push(error);throw error;}
  };
  return {errors,thrownErrors,restore(){db.prepare=prepare;db.exec=exec;}};
}
function fixture(unknown) {
  const c=new Coordinator({root:path.join(root,'state'),now:()=>1700000000000});
  const g=c.prepareGoal({submissionId:'storage-goal',objective:'Owned storage qualification',acceptance:['Truth survives failed writes'],project:null},'prepare');
  c.activateGoal({goalId:g.id,hash:g.hash},'activate');
  const task = key => c.submitTask({goalId:g.id,submissionId:key,kind:'research',objective:key,acceptance:['Retained state']},'submit-'+key);
  const a=task('saved');assert.equal(c.claimNext('fixture-owner').id,a.id);
  const saved=c.reserve(a.id,{key:'saved-request',kind:'model'},'fixture-owner');
  c.saveRequest(saved.id,{content:'Prior saved answer'});c.completeTask(a.id,{content:'Prior saved answer'},'fixture-owner');
  const b=task('failed');assert.equal(c.claimNext('fixture-owner').id,b.id);
  const failed=c.reserve(b.id,{key:'failed-request',kind:'model'},'fixture-owner');
  c.failModelRequest(failed.id,'fixture-owner',{reason:'Owned known non-dispatch',outcome:'not_dispatched',reconnect:false});
  const t=task('target');assert.equal(c.claimNext('fixture-owner').id,t.id);
  const target=c.reserve(t.id,{key:'target-request',kind:'model'},'fixture-owner');
  const unresolved=target; // One unresolved legacy inference reservation owns the slot.
  if(unknown)c.failModelRequest(unresolved.id,'fixture-owner',{reason:'Owned unknown specimen; no actual provider call',outcome:'unknown',reconnect:false});
  return {c,g,t,requests:{saved,failed,target,unresolved},unknown};
}
async function sqliteCase() {
  if(name==='sqlite-control') {
    const db=new DatabaseSync(path.join(root,'control.sqlite3'));
    try {
      db.exec('CREATE TABLE specimen(value TEXT)');report.bounds=ceiling(db);
      const statement=db.prepare('INSERT INTO specimen VALUES(?)');let error;
      try {statement.run(payload());}catch(e){error=e;}
      report.error=diagnostic(error);
      check('direct runtime positive control returns actual SQLITE_FULL errcode 13',()=>{assert.ok(hasFull(error));assert.equal(error.errcode,13);});
      check('failed direct write leaves no row',()=>assert.equal(db.prepare('SELECT COUNT(*) AS n FROM specimen').get().n,0));
    } finally {db.close();}
    return;
  }
  const f=fixture(name!=='coordinator-save'),{c}=f,db=c.store.db;
  try {
    const before=snapshot(db);await save('before.json',before);
    report.fixture={goalId:f.g.id,taskId:f.t.id,requests:f.requests,explicitUnknownFailure:f.unknown};
    report.spentBefore=Object.fromEntries(c.store.all('task').map(t=>[t.id,c.store.spent(t.id)]));
    report.bounds={...ceiling(db),payloadBytes:3*1024*1024};
    assert.ok(report.bounds.payloadBytes>report.bounds.ceilingBytes);
    let wakes=0;const wake=()=>wakes++;c.store.commitListeners.add(wake);
    const observer=observe(db);let thrown,reached=false,returned=false;
    try {
      if(name==='coordinator-save') {reached=true;c.saveRequest(f.requests.target.id,{content:payload()},'fixture-owner');}
      else {
        const action=()=>{reached=true;c.store.put('fault-probe',{id:'uncommitted',value:'must roll back'});c.store.event('fault.uncommitted',{data:{value:'must roll back'}});c.store.put('fault-probe',{id:'overflow',value:payload()});return {success:true};};
        if(name==='store-command')c.store.command('overflow-command',{case:name},action);
        else c.store.tx(action);
      }
      returned=true;
    } catch(error) {thrown=error;} finally {observer.restore();}
    report.observedSqlErrors=observer.errors;report.returnedError=diagnostic(thrown);report.returned=returned;report.reached=reached;
    report.observerRestored=db.prepare===DatabaseSync.prototype.prepare&&db.exec===DatabaseSync.prototype.exec;
    const after=snapshot(db);await save('after.json',after);
    check('intended real production write reached and rejected',()=>{assert.ok(reached);assert.equal(returned,false);assert.ok(thrown);});
    check('owned connection observer records actual primary SQLITE_FULL',()=>assert.ok(observer.errors.some(e=>hasFull(e.error))));
    check('caller receives primary SQLITE_FULL diagnostic (not a masking rollback error)',()=>assert.ok(hasFull(thrown),JSON.stringify(diagnostic(thrown))));
    check('caller receives the identical primary object with exact SQLite code and message',()=>{assert.strictEqual(thrown,observer.thrownErrors[0]);assert.equal(thrown.code,'ERR_SQLITE_ERROR');assert.equal(thrown.errcode,13);assert.equal(thrown.message,'database or disk is full');});
    report.rollbackError=diagnostic(thrown?.rollbackError);
    check('secondary rollback diagnostic is retained without replacing the primary',()=>{assert.equal(observer.thrownErrors.length,2);assert.strictEqual(thrown.rollbackError,observer.thrownErrors[1]);assert.strictEqual(c.store.lastRollbackError,observer.thrownErrors[1]);assert.equal(thrown.rollbackError.errcode,1);assert.match(thrown.rollbackError.message,/no transaction is active/);});
    check('all earlier rows, approval hashes, caps, deadlines, commands and event prefix unchanged',()=>assert.deepEqual(after,before));
    check('all original requests remain spent exactly',()=>assert.deepEqual(Object.fromEntries(c.store.all('task').map(t=>[t.id,c.store.spent(t.id)])),report.spentBefore));
    check('failed save or original unknown request has no false result or saved event',()=>{
      const row=c.store.request(f.t.id,'target-request');assert.equal(row.status,f.unknown?'failed':'reserved');assert.equal(row.result,undefined);
      assert.equal(after.events.some(e=>e.type==='request.saved'&&JSON.parse(e.data).id===row.id),false);
    });
    check('unknown or unresolved last reservation retains original owner and accounting',()=>{
      const row=c.store.request(f.t.id,'target-request');assert.equal(row.owner,'fixture-owner');assert.equal(row.status,f.unknown?'failed':'reserved');
      if(f.unknown){assert.equal(row.requestOutcome,'unknown');const t=c.store.get('task',f.t.id);assert.equal(t.status,'uncertain');assert.equal(t.owner,'fixture-owner');}
    });
    check('transaction depth restored and observers restored',()=>{assert.equal(c.store.depth,0);assert.equal(report.observerRestored,true);});
    check('failed transaction sends no commit notification and automatic rollback permits a later empty transaction',()=>{
      assert.equal(wakes,0);assert.equal(c.store.tx(()=>{assert.equal(c.store.depth,1);return 'ready';}),'ready');assert.equal(wakes,1);assert.equal(c.store.depth,0);
    });
    c.store.commitListeners.delete(wake);
    // Capture WAL/SHM before close; close may legitimately checkpoint/remove them.
    for(const suffix of ['', '-wal','-shm']) {
      const file=path.join(c.store.root,'harness.sqlite3'+suffix);
      try {await fs.copyFile(file,path.join(root,'retained-harness.sqlite3'+suffix));}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    c.close();
    const reopened=new DatabaseSync(path.join(c.store.root,'harness.sqlite3'),{readOnly:true});
    try {const state=snapshot(reopened);await save('reopened.json',state);report.integrity=reopened.prepare('PRAGMA integrity_check').get();check('raw read-only reopen preserves exact prior durable rows',()=>assert.deepEqual(state,before));}
    finally {reopened.close();}
  } finally {c.close();}
}

async function rollbackCleanupCase() {
  // Fail the cleanup before SQLite runs it. This proves preserving the primary
  // does not imply successful rollback or allow a new transaction to proceed.
  const store=new Store(path.join(root,'state')),db=store.db,exec=db.exec;
  const cause=new Error('prior cause'),primary=Object.freeze(Object.assign(new Error('owned primary failure',{cause}),{code:'OWNED_PRIMARY'}));
  const cleanup=Object.assign(new Error('owned rollback failure'),{code:'OWNED_ROLLBACK'});
  let hits=0,wakes=0,nextCalls=0,thrown;
  try {
    store.put('probe',{id:'prior',value:'exact prior row'});
    const before=snapshot(db);await save('before.json',before);
    store.commitListeners.add(()=>wakes++);
    db.exec=function(sql,...args){if(sql==='ROLLBACK'){hits++;throw cleanup;}return exec.call(this,sql,...args);};
    try {store.tx(()=>{store.put('probe',{id:'outer'});store.tx(()=>{store.put('probe',{id:'nested'});throw primary;});});}
    catch(error){thrown=error;}finally{db.exec=exec;}
    report.primary=diagnostic(thrown);report.cleanup=diagnostic(store.lastRollbackError);
    check('frozen primary identity, code, message and existing cause survive cleanup failure',()=>{assert.strictEqual(thrown,primary);assert.equal(thrown.code,'OWNED_PRIMARY');assert.equal(thrown.message,'owned primary failure');assert.strictEqual(thrown.cause,cause);});
    check('one child-local rollback failure is retained with depth restored and no commit notification',()=>{assert.equal(hits,1);assert.strictEqual(store.lastRollbackError,cleanup);assert.equal(store.depth,0);assert.equal(wakes,0);assert.strictEqual(db.exec,exec);});
    const reader=new DatabaseSync(path.join(store.root,'harness.sqlite3'),{readOnly:true});
    try {const visible=snapshot(reader);await save('visible-after-failed-cleanup.json',visible);check('failed cleanup reports no durable partial transaction',()=>assert.deepEqual(visible,before));}
    finally {reader.close();}
    check('failed cleanup leaves active writes explicit instead of claiming rollback or permitting another transaction',()=>{
      assert.equal(store.get('probe','outer').id,'outer');assert.equal(store.get('probe','nested').id,'nested');
      assert.throws(()=>store.tx(()=>nextCalls++),/within a transaction/);assert.equal(nextCalls,0);assert.equal(wakes,0);assert.equal(store.depth,0);
    });
    // Only this disposable fixture explicitly cleans up its still-active SQL
    // transaction. Production code does not infer recovery or authorize replay.
    db.exec('ROLLBACK');
    check('explicit fixture cleanup restores exact rows and later commits notify once',()=>{
      assert.deepEqual(snapshot(db),before);
      assert.equal(store.tx(()=>{store.put('probe',{id:'later'});return 'committed';}),'committed');
      assert.equal(wakes,1);assert.equal(store.depth,0);
    });
    await save('after-explicit-fixture-cleanup-and-commit.json',snapshot(db));
  } finally {db.exec=exec;store.close();}
}
const injected = (code,operation,file) => Object.assign(new Error('Owned '+operation+' fault'),{code,syscall:operation,path:file});
async function journalCase() {
  const id='11111111-1111-4111-8111-111111111111',j=new Journal(root,id);
  await j.append('fixture.prefix',{value:'prior complete event'});
  const before=await fs.readFile(j.file),memoryBefore=structuredClone(j.events);
  await fs.writeFile(path.join(root,'before.jsonl'),before);
  let hits=0,opens=0,actionCalls=0,thrown,returned=false;
  const open=fs.open;
  fs.open=async function(file,...args) {
    if(String(file)!==j.file)return open.call(this,file,...args);
    opens++;
    if(name==='journal-open-enospc'||name==='journal-open-eacces'||name==='journal-memo-completion'&&opens===2) {
      hits++;throw injected(name==='journal-open-eacces'?'EACCES':'ENOSPC','open',j.file);
    }
    const handle=await open.call(this,file,...args),write=handle.write,sync=handle.sync;
    if(name==='journal-partial')handle.write=async function(value,...rest) {
      hits++;const part=Buffer.from(value).subarray(0,23);await write.call(this,part);throw injected('ENOSPC','write',j.file);
    };
    if(name==='journal-sync')handle.sync=async function(){hits++;throw injected('ENOSPC','fsync',j.file);};
    // Restore even the closed owned handle methods, as well as fs.open below.
    const close=handle.close;
    handle.close=async function(){handle.write=write;handle.sync=sync;handle.close=close;return close.call(this);};
    return handle;
  };
  syncBuiltinESMExports();
  try {
    if(name.startsWith('journal-open')||name==='journal-memo-completion')await j.memo('owned-action',async()=>{actionCalls++;await fs.writeFile(path.join(root,'action-effect.txt'),'action executed once');return 'result';});
    else await j.append('fault.event',{value:'new event'});
    returned=true;
  } catch(error) {thrown=error;} finally {fs.open=open;syncBuiltinESMExports();}
  const after=await fs.readFile(j.file),loaded=await new Journal(root,id).load();
  report.injection={hits,opens,restored:fs.open===open,exactPath:j.file};report.returned=returned;report.error=diagnostic(thrown);
  report.actionCalls=actionCalls;report.memoryBefore=memoryBefore;report.memoryAfter=j.events;report.loadedEvents=loaded.events;report.tail=loaded.tail;
  report.bytes={before:before.length,after:after.length,beforeSha256:sha(before),afterSha256:sha(after)};
  report.durability='Readback proves visible bytes only; sync failure does not certify durability or absence of effects.';
  check('one exact owned child-local injection and restored hook',()=>{assert.equal(hits,1);assert.equal(fs.open,open);});
  check('production call rejects with selected OS code',()=>{assert.equal(returned,false);assert.equal(thrown?.code,name==='journal-open-eacces'?'EACCES':'ENOSPC');});
  check('prior complete disk and memory prefix retained',()=>{assert.ok(after.subarray(0,before.length).equals(before));assert.deepEqual(j.events.slice(0,1),memoryBefore);assert.deepEqual(loaded.events.slice(0,1),memoryBefore);});
  if(name.startsWith('journal-open'))check('pre-open failure retains exact bytes, no action and no in-memory success',()=>{assert.ok(after.equals(before));assert.equal(actionCalls,0);assert.deepEqual(j.events,memoryBefore);});
  if(name==='journal-partial') {
    let refusal;try {await loaded.append('must.refuse');}catch(e){refusal=e;}
    report.appendRefusal=diagnostic(refusal);
    check('partial tail retained and production reload refuses append',()=>{assert.equal(after.length,before.length+23);assert.equal(loaded.tail,after.subarray(before.length).toString());assert.equal(loaded.events.length,1);assert.deepEqual(j.events,memoryBefore);assert.match(refusal?.message??'',/Incomplete log tail/);});
    const afterRefusal=await fs.readFile(j.file);
    check('append refusal does not rewrite tail',()=>assert.equal(sha(after),sha(afterRefusal)));
  }
  if(name==='journal-sync')check('complete visible write with rejected sync stays ambiguous and memory has no success event',()=>{assert.deepEqual(j.events,memoryBefore);assert.equal(loaded.events.length,2);assert.equal(loaded.events[1].type,'fault.event');assert.equal(loaded.tail,'');});
  if(name==='journal-memo-completion') {
    report.uncertainty='Action executed; completion was not logged. No retry/replay or Coordinator hold release attempted.';
    check('one action effect, started receipt, no false completed receipt or replay',()=>{assert.equal(actionCalls,1);assert.equal(j.events.length,2);assert.equal(loaded.events.length,2);assert.equal(loaded.events[1].type,'operation.started');assert.equal(loaded.completed('owned-action'),undefined);});
  }
  // Keep raw journal, partial tail and separate disk/memory facts untouched.
}
async function atomicCase() {
  const file=path.join(root,'destination.json'),old=Buffer.from('{"prior":"exact bytes"}\n');await fs.writeFile(file,old);
  const write=fs.writeFile,rename=fs.rename;let hits=0,temp=null,thrown,returned=false;
  const isTemp = candidate => path.dirname(String(candidate))===root && /^destination\.json\.[a-f0-9-]{36}\.tmp$/.test(path.basename(String(candidate)));
  fs.writeFile=async function(candidate,value,...args) {
    if(!isTemp(candidate))return write.call(this,candidate,value,...args);
    assert.equal(temp,null);temp=String(candidate);
    if(name==='atomic-write'){hits++;await write.call(this,candidate,Buffer.from(value).subarray(0,11),...args);throw injected('ENOSPC','writeFile',temp);}
    return write.call(this,candidate,value,...args);
  };
  fs.rename=async function(from,to,...args) {
    if(from===temp&&to===file&&name==='atomic-rename'){hits++;throw injected('EACCES','rename',temp);}
    return rename.call(this,from,to,...args);
  };
  syncBuiltinESMExports();
  try {await atomicJson(file,{next:'must not replace prior destination'});returned=true;}
  catch(error) {thrown=error;} finally {fs.writeFile=write;fs.rename=rename;syncBuiltinESMExports();}
  const after=await fs.readFile(file),partial=temp?await fs.readFile(temp):null;
  report.injection={hits,exactDestination:file,exactTemporaryPath:temp,restored:fs.writeFile===write&&fs.rename===rename};report.error=diagnostic(thrown);report.returned=returned;
  report.bytes={destinationSha256:sha(after),priorSha256:sha(old),tempBytes:partial?.length,tempSha256:partial?sha(partial):null};
  check('one exact owned injection and finally-restored filesystem hooks',()=>{assert.equal(hits,1);assert.equal(report.injection.restored,true);});
  check('atomicJson rejects without replacing prior destination',()=>{assert.equal(returned,false);assert.equal(thrown?.code,name==='atomic-write'?'ENOSPC':'EACCES');assert.ok(after.equals(old));});
  check('unique partial or complete temporary file remains as evidence',()=>{assert.ok(temp);assert.ok(partial.length>0);if(name==='atomic-write')assert.equal(partial.length,11);else assert.equal(JSON.parse(partial).next,'must not replace prior destination');});
}
try {
  if(name==='store-rollback-cleanup')await rollbackCleanupCase();
  else if(['sqlite-control','store-tx','store-command','coordinator-save'].includes(name))await sqliteCase();
  else if(name.startsWith('journal-'))await journalCase();
  else if(['atomic-write','atomic-rename'].includes(name))await atomicCase();
  else throw Error('Unknown finite specimen');
} catch(error) {report.fatal=diagnostic(error);}
await save('measurement.json',report);
console.log(JSON.stringify({case:name,checks:report.checks.map(({label,pass})=>({label,pass})),fatal:report.fatal??null}));
process.exitCode=report.fatal || report.checks.some(c=>!c.pass) ? 1 : 0;
