import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {acceptedFixture,checkerFixture,policy} from '../test-support/readiness-authority-fixture.mjs';
import {digest} from '../src/harness/contracts.mjs';
import {checkReadiness,prepareBundle} from '../scripts/release-readiness.mjs';
const reader=async args=>(await import('../src/harness/release-authority.mjs')).readResearchAuthority(args);
const script=fileURLToPath(new URL('../scripts/release-readiness.mjs',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const cli=(opts,extra=[])=>spawnSync(process.execPath,[script,...Object.entries(opts).flatMap(([k,v])=>[({candidate:'--candidate',expectedContentHash:'--expected-content-hash',expectedManifestSha256:'--expected-manifest-sha256',receipt:'--receipt',coordinatorStateRoot:'--coordinator-state-root',coordinatorTaskId:'--coordinator-task-id'})[k],v]),...extra],{encoding:'utf8',maxBuffer:2*1024*1024});
const mutate=(f,kind,fn)=>{const id=kind==='task'?f.task.id:kind==='goal'?f.g.id:f.c.getTask(f.task.id).researchReviewAcceptance.nativeReservationId;const v=f.c.store.get(kind,id);fn(v);f.c.store.put(kind,v);};
// Removing actual authority verification leaves this prospective-live result pending.
test('R01 genuine accepted operations wire checker to read-only authority',async t=>{
 const f=await checkerFixture(t),r=await checkReadiness(f.opts);assert.equal(r.gates.live_research_quality.status,'passed');assert.equal(r.prePromotion.status,'passed');assert.equal(r.localAuthority.status,'verified');assert.equal(r.installationAuthority,false);assert.equal(r.advisory,true);assert.equal(r.fullRelease,'INCOMPLETE');
 const proof=await reader(f.args);assert.equal(proof.status,'verified');assert.equal(proof.taskId,f.task.id);assert.equal(proof.environment,'live');assert.equal(proof.runtimeAttested,false);assert.doesNotMatch(JSON.stringify(proof),/directory|PRIVATE|Fixture|objective|\/Users|\/private|submissionIntent/);
});
test('R02 no selectors and R26 saved exports cannot replace fresh authority',async t=>{
 const f=await checkerFixture(t),r=await checkReadiness(f.r.opts);assert.equal(r.gates.live_research_quality.reason,'authoritative_local_acceptance_required');
 await checkReadiness(f.opts);mutate(f,'task',v=>delete v.researchReviewAcceptance);const again=await checkReadiness(f.opts);assert.equal(again.localAuthority.status,'pending');assert.equal(again.prePromotion.status,'pending');
});
test('R03 real CLI paired selectors, duplicate/unknown options and advisory exit semantics',async t=>{
 const f=await checkerFixture(t);assert.equal(cli(f.opts).status,0);assert.equal(cli(f.r.opts).status,3);
 for(const opt of [{...f.r.opts,coordinatorStateRoot:f.root},{...f.r.opts,coordinatorTaskId:f.task.id},{...f.opts,coordinatorTaskId:'../bad'}]){await assert.rejects(checkReadiness(opt));assert.equal(cli(opt).status,2);}
 for(const extra of [['--coordinator-task-id',f.task.id],['--force'],['--unknown','x']])assert.equal(cli(f.opts,extra).status,2);
 f.r.receipt.policy={version:2,finish:'selectors_only',discovery:'search_required'};await f.r.save();await assert.rejects(checkReadiness(f.opts));
});
test('R04 missing state is pending without creation; unsafe paths reject',async t=>{
 const f=await acceptedFixture(t),missing=path.join(f.root,'absent');assert.equal((await reader({...f.args,stateRoot:missing})).status,'pending');await assert.rejects(fs.stat(missing));
 const empty=path.join(f.root,'empty');await fs.mkdir(empty);assert.equal((await reader({...f.args,stateRoot:empty})).status,'pending');assert.deepEqual(await fs.readdir(empty),[]);
 const link=path.join(f.root,'link');await fs.symlink(f.root,link);
 for(const stateRoot of [link,f.root+'/x/../',':memory:','file:'+f.root,f.root+'/harness.sqlite3'])await assert.rejects(reader({...f.args,stateRoot}));
 const db=f.root+'/harness.sqlite3';f.c.close();await fs.rename(db,db+'.saved');await fs.symlink(db+'.saved',db);await assert.rejects(reader(f.args));
});
test('R05 schema, bounded rows and malformed JSON reject before trust',async t=>{
 const f=await acceptedFixture(t),db=f.c.store.db;
 db.exec('PRAGMA user_version=2');await assert.rejects(reader(f.args));db.exec('PRAGMA user_version=1');
 const old=f.c.store.get('task',f.task.id);for(const data of ['{','"'+ 'a'.repeat(1024*1024)+'"']){db.prepare('UPDATE records SET data=? WHERE kind=? AND id=?').run(data,'task',f.task.id);await assert.rejects(reader(f.args));}f.c.store.put('task',old);
 db.exec('ALTER TABLE records RENAME COLUMN data TO payload');await assert.rejects(reader(f.args));
});
test('R06 repeated reads leave logical state, file bytes and permissions unchanged',async t=>{
 const f=await acceptedFixture(t);f.c.close();const db=f.root+'/harness.sqlite3',before=await fs.readFile(db),mode=(await fs.stat(db)).mode;
 for(let i=0;i<3;i++)assert.equal((await reader(f.args)).status,'verified');assert.deepEqual(await fs.readFile(db),before);assert.equal((await fs.stat(db)).mode,mode);
});
test('R07 accepted uncheckpointed WAL rows remain readable with writer open',async t=>{
 const f=await acceptedFixture(t),wal=f.root+'/harness.sqlite3-wal';assert.ok((await fs.stat(wal)).size>0);const b=await fs.readFile(wal),main=await fs.readFile(f.root+'/harness.sqlite3');assert.equal((await reader(f.args)).status,'verified');assert.deepEqual(await fs.readFile(wal),b);assert.deepEqual(await fs.readFile(f.root+'/harness.sqlite3'),main);
});
test('R10 missing local approval or selected rows stays pending without remote backfill',async t=>{
 for(const target of ['acceptance','ticket','reviewer','task','goal']){const f=await acceptedFixture(t);if(target==='acceptance')mutate(f,'task',v=>delete v.researchReviewAcceptance);if(target==='ticket')mutate(f,'task',v=>v.researchReviewTickets=[]);if(['reviewer','goal','task'].includes(target)){const id=target==='task'?f.task.id:target==='goal'?f.g.id:f.c.getTask(f.task.id).researchReviewAcceptance.nativeReservationId;f.c.store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(target,id);}assert.equal((await reader(f.args)).status,'pending',target);}
});
for(const [name,kind,change]of [
 ['task policy','task',v=>v.spec.researchPolicy.version=2],['task hash','task',v=>v.hash='f'.repeat(64)],['task goal version','task',v=>v.goalVersion++],['actor','task',v=>v.spec.actor='codex'],['kind','task',v=>v.spec.kind='coding'],['goal hash','goal',v=>v.hash='f'.repeat(64)],['mode','goal',v=>v.manifest.mode.id='deepseek_only'],['unactivated','goal',v=>v.activatedAt=null],['parent deadline','goal',v=>v.deadline--],['child deadline','task',v=>v.deadline++],['result job','task',v=>v.result.remoteJobId='wrong'],['result receipt','task',v=>v.result.receiptStatus='partial'],['result checksums','task',v=>v.result.checksumsVerified=false],['result acceptance','task',v=>v.result.independentReview='pending'],['result binding','task',v=>v.result.reviewBinding.reportSha256='a'.repeat(64)],['owner','task',v=>v.owner='owner'],['uncertain','task',v=>v.status='uncertain'],['reviewer failed','reviewer',v=>v.status='failed'],['decision','task',v=>v.researchReviewAcceptance.input.decision='revise'],['ticket key','task',v=>v.researchReviewTickets[0].submissionIntent.submissionKey='wrong'],['ack','task',v=>v.researchReviewAcceptance.acknowledgment.jobId='wrong']
])test(`R11 R12 R13 R16 rejects mismatched ${name}`,async t=>{const f=await acceptedFixture(t);mutate(f,kind,change);await assert.rejects(reader(f.args));});
test('R14 historical accepted report remains inspectable after finalized deadline',async t=>{
 let now=Date.now()-10*3600000;const f=await acceptedFixture(t,{now:()=>now});mutate(f,'goal',v=>v.status='completed');assert.equal((await reader(f.args)).status,'verified');
});
for(const key of ['reportSha256','sourcesSha256','offersSha256','rubricSha256','jobId','manifestHash','request','units'])test(`R15 recomputed remote descriptor ${key} cannot replace local approval`,async t=>{
 const f=await acceptedFixture(t),r=structuredClone(f.receipt),d=r.quality.review_binding;d[key]=key==='request'?{...d.request,resultSha256:'e'.repeat(64)}:key==='units'?['title']:key==='jobId'?'other':'e'.repeat(64);delete d.candidateHash;d.candidateHash=digest(d);r.quality.accepted_candidate_hash=d.candidateHash;await assert.rejects(reader({...f.args,receipt:r}));
});
test('R17 exact whitespace Unicode and binary artifact bytes are binding',async t=>{
 const f=await acceptedFixture(t);for(const reportBytes of [Buffer.concat([f.args.reportBytes,Buffer.from(' ')]),Buffer.from('é'),Buffer.from([255,0])])await assert.rejects(reader({...f.args,reportBytes}));await assert.rejects(reader({...f.args,sourceBytes:Buffer.from('{}')}));
});
test('R19 stored fixture cannot become live through receipt relabeling',async t=>{
 const f=await checkerFixture(t,{environment:'fixture'});await assert.rejects(checkReadiness(f.opts));f.receipt.mode='live';Object.assign(f.r.receipt.gates[1].artifacts.at(-1),await f.r.artifact('worker.json',f.receipt,'receipt'));await f.r.save();await assert.rejects(checkReadiness(f.opts));f.receipt.mode='fixture';assert.equal((await reader(f.args)).environment,'fixture');
});
for(const status of ['passed','pending','failed'])test(`R20 R21 status ${status} preserves assessment and validates explicit corruption`,async t=>{
 const f=await checkerFixture(t,{status}),r=await checkReadiness(f.opts);assert.equal(r.prePromotion.status,status);mutate(f,'task',v=>delete v.researchReviewAcceptance);assert.equal((await checkReadiness(f.opts)).prePromotion.status,status==='failed'?'failed':'pending');await assert.rejects(checkReadiness({...f.opts,coordinatorStateRoot:':memory:'}));
});
test('R23 ignores database result paths and candidate executable payloads',async t=>{
 const f=await checkerFixture(t);mutate(f,'task',v=>v.result.directory='/NEVER_READ_PRIVATE');assert.equal((await checkReadiness(f.opts)).prePromotion.status,'passed');
});
test('R24 preparation cannot overlap trusted state, candidate or evidence; proof is redacted',async t=>{
 const f=await checkerFixture(t),r=await checkReadiness(f.opts);for(const output of [f.root,f.root+'/out',path.dirname(f.root),f.r.candidate+'/out',f.r.evidence+'/out'])await assert.rejects(prepareBundle({report:r,output}));assert.doesNotMatch(JSON.stringify(r.localAuthority),new RegExp(f.root));
});
// Each committed generation is invalid. Only mixing task A and reviewer B could pass.
test('R08 concurrent atomic replacement never mixes task and reviewer generations',async t=>{
 const f=await acceptedFixture(t),taskA=f.c.getTask(f.task.id),taskB=structuredClone(taskA),reviewerB=f.c.store.get('reviewer',taskA.researchReviewAcceptance.nativeReservationId),reviewerA=structuredClone(reviewerB);taskB.result.independentReview='pending';reviewerA.status='failed';f.c.store.put('reviewer',reviewerA);
 const argsFile=f.root+'/generations.json';await fs.writeFile(argsFile,JSON.stringify({taskA,taskB,reviewerA,reviewerB}));
 const code=`import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';const [dbfile,args]=process.argv.slice(1),v=JSON.parse(readFileSync(args)),db=new DatabaseSync(dbfile);db.exec('PRAGMA busy_timeout=1000');const put=db.prepare('UPDATE records SET data=? WHERE kind=? AND id=?');console.log('ready');for(let i=0;i<300;i++){const a=i%2===0,t=a?v.taskA:v.taskB,r=a?v.reviewerA:v.reviewerB;db.exec('BEGIN IMMEDIATE');put.run(JSON.stringify(t),'task',t.id);put.run(JSON.stringify(r),'reviewer',r.id);db.exec('COMMIT');}db.close();`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,f.root+'/harness.sqlite3',argsFile],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});const exit=once(child,'exit');await once(child.stdout,'data');let invalid=0;for(let i=0;i<40;i++){try{const proof=await reader(f.args);assert.notEqual(proof.status,'verified');}catch(e){assert.match(e.code??'',/authority/);invalid++;}}assert.ok(invalid>0);assert.deepEqual(await exit,[0,null]);
});
test('R09 killed blocked verifier releases its read; busy timeout is bounded and restart is unchanged',async t=>{
 const f=await acceptedFixture(t);f.c.close();const dbfile=f.root+'/harness.sqlite3',lock=new DatabaseSync(dbfile);t.after(()=>lock.close());lock.exec('PRAGMA journal_mode=DELETE');const before=await fs.readFile(dbfile),argsFile=f.root+'/reader-args.json';await fs.writeFile(argsFile,JSON.stringify({...f.args,reportBytes:f.args.reportBytes.toString(),sourceBytes:f.args.sourceBytes.toString()}));
 lock.exec('BEGIN EXCLUSIVE');
 const module=new URL('../src/harness/release-authority.mjs',import.meta.url).href,code=`import {readFileSync} from 'node:fs';import {readResearchAuthority} from ${JSON.stringify(module)};console.log('ready');await readResearchAuthority(JSON.parse(readFileSync(process.argv[1])));`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,argsFile],{stdio:['ignore','pipe','pipe']});const exit=once(child,'exit');t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});await once(child.stdout,'data');await new Promise(r=>setTimeout(r,120));child.kill('SIGKILL');assert.deepEqual(await exit,[null,'SIGKILL']);
 const start=Date.now();await assert.rejects(reader(f.args));assert.ok(Date.now()-start<1800,'busy wait must remain bounded');lock.exec('ROLLBACK');assert.deepEqual(await fs.readFile(dbfile),before);assert.equal((await reader(f.args)).status,'verified');assert.deepEqual(await fs.readFile(dbfile),before);
});
for(const status of ['awaiting_review','queued','paused','stopped','partial','running'])test(`R13 ${status} cannot supply accepted readiness`,async t=>{const f=await acceptedFixture(t);mutate(f,'task',v=>v.status=status);await assert.rejects(reader(f.args));});
for(const target of ['goal','reviewer'])test(`R05 ${target} row is bounded while unrelated corrupt records are ignored`,async t=>{
 const f=await acceptedFixture(t);f.c.store.db.prepare('INSERT INTO records VALUES(?,?,?)').run('task','unrelated','{');assert.equal((await reader(f.args)).status,'verified');const id=target==='goal'?f.g.id:f.c.getTask(f.task.id).researchReviewAcceptance.nativeReservationId;f.c.store.db.prepare('UPDATE records SET data=? WHERE kind=? AND id=?').run(' '.repeat(1024*1024+1),target,id);await assert.rejects(reader(f.args));
});
for(const [label,change]of [
 ['native reservation',v=>v.researchReviewAcceptance.nativeReservationId='wrong'],['coverage',v=>v.researchReviewAcceptance.input.coverage=[]],['findings',v=>v.researchReviewAcceptance.input.findings=[{text:'unreviewed'}]],['input hash',v=>v.researchReviewAcceptance.inputHash='f'.repeat(64)],['pending acknowledgment',v=>v.researchReviewTickets[0].submissionIntent.state='pending']
])test(`R16 ${label} cannot substitute for accepted local submission`,async t=>{const f=await acceptedFixture(t);mutate(f,'task',change);if(label==='pending acknowledgment'||label==='native reservation')assert.equal((await reader(f.args)).status,'pending');else await assert.rejects(reader(f.args));});
test('R18 candidate and independent assessment bindings still reject with valid authority',async t=>{
 const f=await checkerFixture(t);await assert.rejects(checkReadiness({...f.opts,expectedContentHash:'f'.repeat(64)}));await assert.rejects(checkReadiness({...f.opts,expectedManifestSha256:'f'.repeat(64)}));const gate=f.r.receipt.gates[1],ref=gate.artifacts.find(a=>a.role==='assessment'),a=JSON.parse(await fs.readFile(path.join(f.r.evidence,ref.path)));for(const change of [v=>v.reportSha256='f'.repeat(64),v=>v.sourceSha256s=['f'.repeat(64)],v=>v.reviewSha256='f'.repeat(64),v=>v.candidate.sourceCommit='f'.repeat(40)]){const v=structuredClone(a);change(v);Object.assign(ref,await f.r.artifact('assessment.json',v,'assessment'));await f.r.save();await assert.rejects(checkReadiness(f.opts));}
});
for(const declared of ['failed','pending','unknown'])test(`R21 explicit authority is validated under declared ${declared}`,async t=>{
 const f=await checkerFixture(t);f.r.receipt.gates[1].status=declared;await f.r.save();assert.equal((await checkReadiness(f.opts)).gates.live_research_quality.status,declared);mutate(f,'task',v=>v.hash='f'.repeat(64));await assert.rejects(checkReadiness(f.opts));
});
test('R04 nonregular database and sidecar symlinks fail without state changes',async t=>{
 const f=await acceptedFixture(t);f.c.close();const db=f.root+'/harness.sqlite3';await fs.mkdir(db+'-wal');await assert.rejects(reader(f.args));await fs.rm(db+'-wal',{recursive:true});await fs.symlink(db,db+'-shm');await assert.rejects(reader(f.args));await fs.rm(db+'-shm');await fs.rename(db,db+'.saved');await fs.mkdir(db);await assert.rejects(reader(f.args));
});
for(const [label,kind,change]of [
 ['unpinned capability','goal',v=>{v.manifest.capabilities=v.manifest.capabilities.map(c=>c.id==='research'?{...c,version:3}:c);v.hash=digest(v.manifest);}],
 ['missing actor permission','goal',v=>{v.manifest.mode.actors=['codex'];v.hash=digest(v.manifest);}],
 ['reviewer after acceptance','reviewer',v=>v.at=Number.MAX_SAFE_INTEGER],
 ['reviewer before activation','reviewer',v=>v.at=1]
])test(`R12 R16 validates ${label} beyond recomputed record hashes`,async t=>{const f=await acceptedFixture(t);mutate(f,kind,change);await assert.rejects(reader(f.args));});
for(const [label,change]of [
 ['saved paused remote cursor',v=>v.checkpoint.remotePaused=true],
 ['native execution owner',v=>v.executionActor='codex']
])test(`R13 terminal acceptance rejects unresolved ${label}`,async t=>{const f=await acceptedFixture(t);mutate(f,'task',change);await assert.rejects(reader(f.args));});
