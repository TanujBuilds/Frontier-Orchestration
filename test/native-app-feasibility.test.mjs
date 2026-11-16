import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, symlink, stat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const api = await import('../scripts/native-app-feasibility/prerequisites.mjs').catch(() => ({}));
const report = await import('../scripts/native-app-feasibility/report.mjs').catch(() => ({}));
const cli = fileURLToPath(new URL('../scripts/native-app-feasibility.mjs', import.meta.url));
const neutralParent = process.env.MOSAIC_FEASIBILITY_TEST_PARENT;
const temporary = async () => realpath(await mkdtemp(path.join(tmpdir(), 'native-feasibility-test-')));

test('strict CLI requires a single execution or inspect root', () => {
  assert.equal(typeof api.parseArgs, 'function');
  assert.deepEqual(api.parseArgs(['--output','/owned/new','--require-native','--require-browser']), {output:'/owned/new',requireNative:true,requireBrowser:true});
  for (const argv of [[],['--output'],['--output','x','--inspect','y'],['--output','x','--output','y'],['--wat'],['--inspect','/x','--require-native'],['--output','x','--postgres-bin-dir']]) assert.throws(() => api.parseArgs(argv));
});
test('refuses existing roots, aliased ancestors, unsafe paths and Git overrides before writes', async () => {
  assert.equal(typeof api.validateOutput, 'function');
  const root=await temporary();
  await assert.rejects(api.validateOutput(root));
  await mkdir(path.join(root,'real')); await symlink(path.join(root,'real'),path.join(root,'alias'));
  for(const value of [path.join(root,'alias/new'),root+'/real/../new','relative','/','/tmp/new\nroot']) await assert.rejects(api.validateOutput(value));
  await assert.rejects(api.validateOutput(path.join(root,'new'),{GIT_DIR:'/foreign'}));
  await assert.rejects(stat(path.join(root,'new')),{code:'ENOENT'});
});
test('Postgres inventory never treats missing commands as execution proof and validates explicit directories',async()=>{
  assert.equal(typeof api.inventoryPostgres,'function');
  const root=await temporary();
  const missing=await api.inventoryPostgres(undefined,{PATH:root});
  assert.deepEqual(missing.missing,['initdb','pg_ctl','psql','postgres','pg_config']);
  assert.equal(missing.executionProven,false);
  await assert.rejects(api.inventoryPostgres(path.join(root,'absent')));
  await symlink(root,path.join(root,'alias'));
  await assert.rejects(api.inventoryPostgres(path.join(root,'alias')));
  const explicit=await api.inventoryPostgres(root);
  assert.equal(explicit.supplied,true);assert.equal(explicit.missing.length,5);
});
test('only structured permission errors with two healthy canaries prove denial',()=>{
  assert.equal(typeof report.classifyConnection,'function');
  const healthy={passed:true};
  const result=(code,extra={})=>({code:0,stopped:false,quiescence:{groupESRCH:true,leaderReaped:true},observation:{schema:1,kind:'connection',connected:false,code},...extra});
  for(const code of ['EPERM','EACCES']) assert.equal(report.classifyConnection({before:healthy,after:healthy,result:result(code)}),'denied');
  for(const code of ['ECONNREFUSED','ETIMEDOUT',undefined]) assert.equal(report.classifyConnection({before:healthy,after:healthy,result:result(code)}),'inconclusive');
  assert.equal(report.classifyConnection({before:{passed:false},after:healthy,result:result('EPERM')}),'inconclusive');
  assert.equal(report.classifyConnection({before:healthy,after:healthy,result:result('EPERM',{quiescence:null})}),'inconclusive');
  assert.equal(report.classifyConnection({before:healthy,after:healthy,result:result(null,{observation:{schema:1,kind:'connection',connected:true,payload:'wrong'}})}),'failed');
  assert.equal(report.classifyConnection({before:healthy,after:healthy,token:'expected',result:result(null,{observation:{schema:1,kind:'connection',connected:true,payload:'expected'}})}),'passed');
});
test('CLI status keeps tool malfunction, capability blocking and full success distinct',()=>{
  assert.equal(typeof report.summary,'function');
  assert.equal(report.summary([{state:'passed'}]).exitCode,0);
  for(const state of ['denied','failed','inconclusive','not_run_missing_prerequisite']) {const s=report.summary([{state}]);assert.equal(s.exitCode,2);assert.equal(s.m001,'BLOCKED');}
  assert.equal(report.summary([{state:'passed'}],true).exitCode,1);
});
test('sealed reports bind evidence bytes and inspect has no write effects',async()=>{
  assert.equal(typeof report.sealReport,'function');
  const root=await temporary();await mkdir(path.join(root,'evidence'));
  await writeFile(path.join(root,'evidence/value.json'),'{}\n',{mode:0o600});
  await report.sealReport(root,{schema:1,capabilities:[{id:'postgres',state:'not_run_missing_prerequisite'}],...report.summary([{state:'not_run_missing_prerequisite'}])});
  const before=await stat(path.join(root,'report.json'));
  const inspected=await report.inspectReport(root);
  assert.equal(inspected.verified,true);assert.equal(inspected.report.exitCode,2);
  assert.equal((await stat(path.join(root,'report.json'))).mtimeMs,before.mtimeMs);
  assert.equal((await stat(path.join(root,'report.json'))).mode&0o077,0);
  await writeFile(path.join(root,'evidence/value.json'),'tampered');
  await assert.rejects(report.inspectReport(root),/hash|bytes/i);
});
test('required native/browser qualification executes actual revision2 and preserves blocked M001', {timeout:240000}, async t=>{
  const required=process.env.MOSAIC_REQUIRE_NATIVE==='1'||process.env.MOSAIC_REQUIRE_BROWSER==='1';
  if(!required) return t.skip('Set MOSAIC_REQUIRE_NATIVE=1 and MOSAIC_REQUIRE_BROWSER=1 for actual proof');
  assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
  assert.ok(neutralParent,'MOSAIC_FEASIBILITY_TEST_PARENT must name an existing owned canonical neutral directory');
  const output=path.join(neutralParent,'native-test-'+Date.now());
  const r=spawnSync(process.execPath,[cli,'--output',output,'--require-native','--require-browser'],{encoding:'utf8',timeout:220000,maxBuffer:1024*1024});
  assert.equal(r.status,2,r.stderr+r.stdout);
  const saved=JSON.parse(await readFile(path.join(output,'report.json'),'utf8'));
  assert.equal(saved.toolStatus,'completed',JSON.stringify(saved));
  for(const id of ['handler','offline_browser']) assert.equal(saved.capabilities.find(x=>x.id===id).state,'passed',JSON.stringify(saved.capabilities));
  for(const id of ['tcp','unix']) assert.ok(['denied','inconclusive'].includes(saved.capabilities.find(x=>x.id===id).state));
  assert.equal(saved.capabilities.find(x=>x.id==='postgres').state,saved.inventory.postgres.missing.length?'not_run_missing_prerequisite':'inconclusive');
  assert.ok(saved.ownership.length>=6); assert.ok(saved.ownership.every(x=>x.status==='quiescent'&&x.receipt.groupESRCH&&x.receipt.leaderReaped));
  assert.equal(saved.inventory.runtime.backend.revision,2);
  const inspected=spawnSync(process.execPath,[cli,'--inspect',output],{encoding:'utf8'});
  assert.equal(inspected.status,2,inspected.stderr);assert.equal(JSON.parse(inspected.stdout).verified,true);
  t.diagnostic('Retained actual proof '+output);
});

test('CLI refusal happens before writes and inspect faithfully returns all three exit classes',async()=>{
  const root=await temporary(),output=path.join(root,'new');
  const environment={...process.env,GIT_DIR:'/foreign'};
  const rejected=spawnSync(process.execPath,[cli,'--output',output],{env:environment,encoding:'utf8'});
  assert.equal(rejected.status,1);await assert.rejects(stat(output),{code:'ENOENT'});
  for(const exitCode of [0,1,2]){
    const saved=path.join(root,'saved-'+exitCode);await mkdir(saved);
    await report.sealReport(saved,{schema:1,exitCode,toolStatus:exitCode===1?'malfunction':'completed',m001:exitCode===0?'READY':'BLOCKED',capabilities:[]});
    const result=spawnSync(process.execPath,[cli,'--inspect',saved],{encoding:'utf8'});assert.equal(result.status,exitCode,result.stderr);
    assert.equal(JSON.parse(result.stdout).verified,true);
  }
});
test('required missing native prerequisites produce retained CLI2, never a false actual success',async()=>{
  const root=await temporary();
  const environment={...process.env};delete environment.MOSAIC_NATIVE_ARTIFACT_MANIFEST;delete environment.MOSAIC_NATIVE_ARTIFACT_SHA256;
  const output=path.join(root,'missing');
  const result=spawnSync(process.execPath,[cli,'--output',output,'--require-native','--require-browser','--postgres-bin-dir',root],{env:environment,encoding:'utf8',timeout:30000});
  assert.equal(result.status,2,result.stderr);
  const saved=JSON.parse(await readFile(path.join(output,'report.json'),'utf8'));
  assert.equal(saved.m001,'BLOCKED');assert.ok(saved.capabilities.every(c=>c.state==='not_run_missing_prerequisite'));
});
test('read-only inspect rejects traversal, missing report bindings and oversized evidence',async()=>{
  const root=await temporary();await mkdir(path.join(root,'evidence'));
  await writeFile(path.join(root,'evidence-index.json'),JSON.stringify({schema:1,entries:[{path:'evidence/../../outside',bytes:0,sha256:'0'.repeat(64)}]}));
  await assert.rejects(report.inspectReport(root),/unsafe/i);
  await writeFile(path.join(root,'evidence-index.json'),JSON.stringify({schema:1,entries:[]}));
  await assert.rejects(report.inspectReport(root),/not bound/i);
  await writeFile(path.join(root,'evidence-index.json'),' '.repeat(4*1024*1024+1));
  await assert.rejects(report.inspectReport(root),/bound/i);
});
test('host health observation validates token content and preserves connection refusal',async()=>{
  const {probeHost}=await import('../scripts/native-app-feasibility/run.mjs');
  assert.equal(typeof probeHost,'function');
  const net=await import('node:net');
  const server=net.createServer(socket=>socket.end('owned-token'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const target={host:'127.0.0.1',port:server.address().port};
  try{assert.equal((await probeHost(target,'owned-token')).passed,true);assert.equal((await probeHost(target,'wrong-token')).passed,false);}
  finally{await new Promise(resolve=>server.close(resolve));}
  const closed=await probeHost(target,'owned-token');assert.equal(closed.passed,false);assert.equal(closed.code,'ECONNREFUSED');
});

test('inspect returns the exact report/index bytes it hashed under concurrent edits',async()=>{
  const fs=(await import('node:fs/promises')).default;
  const {syncBuiltinESMExports}=await import('node:module');
  const {createHash}=await import('node:crypto');
  const root=await temporary();
  await report.sealReport(root,{schema:1,exitCode:2,m001:'BLOCKED',toolStatus:'completed',capabilities:[]});
  const index=await readFile(path.join(root,'evidence-index.json'));
  const expectedHash=createHash('sha256').update(index).digest('hex');
  const original=fs.readFile,originalOpen=fs.open;let changed=false;
  const replaceAfterReportRead=async file=>{
    if(String(file)===path.join(root,'REPORT.md')&&!changed){
      changed=true;
      await writeFile(path.join(root,'report.json'),JSON.stringify({schema:1,exitCode:0,m001:'READY',capabilities:[]}));
      await writeFile(path.join(root,'evidence-index.json'),JSON.stringify({schema:1,entries:[]}));
    }
  };
  fs.readFile=async function(file,...args){await replaceAfterReportRead(file);return original.call(this,file,...args);};
  fs.open=async function(file,...args){await replaceAfterReportRead(file);return originalOpen.call(this,file,...args);};
  syncBuiltinESMExports();
  let inspected;
  try{inspected=await report.inspectReport(root);}finally{fs.readFile=original;fs.open=originalOpen;syncBuiltinESMExports();}
  assert.equal(changed,true);assert.equal(inspected.report.exitCode,2);assert.equal(inspected.report.m001,'BLOCKED');assert.equal(inspected.indexSha256,expectedHash);
});
test('unsafe or missing explicitly supplied native manifest is refused before writes',async()=>{
  const root=await temporary();await writeFile(path.join(root,'manifest.json'),'{}');
  await symlink(path.join(root,'manifest.json'),path.join(root,'alias.json'));
  for(const manifest of [path.join(root,'alias.json'),path.join(root,'missing.json')]){
    const output=path.join(root,'new-'+path.basename(manifest));
    const result=spawnSync(process.execPath,[cli,'--output',output],{env:{...process.env,MOSAIC_NATIVE_ARTIFACT_MANIFEST:manifest,MOSAIC_NATIVE_ARTIFACT_SHA256:'a'.repeat(64)},encoding:'utf8'});
    assert.equal(result.status,1,result.stdout);await assert.rejects(stat(output),{code:'ENOENT'});
  }
});
test('uncertain native connection keeps before/after host health and propagates owner uncertainty',async()=>{
  const {canary}=await import('../scripts/native-app-feasibility/run.mjs');
  assert.equal(typeof canary,'function');const root=await temporary();await mkdir(path.join(root,'evidence'));
  const unknown=Object.assign(new Error('Lost native completion'),{executionOutcome:'unknown'});
  await assert.rejects(canary({kind:'tcp',root,execute:async()=>{throw unknown;}}),e=>e===unknown);
  const evidence=JSON.parse(await readFile(path.join(root,'evidence/canary-tcp-interrupted.json'),'utf8'));
  assert.equal(evidence.before.passed,true);assert.equal(evidence.after.passed,true);assert.equal(evidence.state,'inconclusive');
});
test('canary does not hide a tooling malfunction as a completed blocked capability',async()=>{
  const {canary}=await import('../scripts/native-app-feasibility/run.mjs');
  assert.equal(typeof canary,'function');const root=await temporary();await mkdir(path.join(root,'evidence'));
  const malfunction=Object.assign(new Error('Evidence storage unavailable'),{code:'ENOSPC'});
  await assert.rejects(canary({kind:'tcp',root,execute:async()=>{throw malfunction;}}),e=>e===malfunction);
});
test('scripted lifecycle safety fixture rejects a foreign cluster before migration (no PostgreSQL proof)',async()=>{
  const {chmod}=await import('node:fs/promises');
  const root=await temporary(),marker=path.join(root,'migration-attempted');
  const script=async(name,text)=>{const file=path.join(root,name);await writeFile(file,'#!/bin/sh\n'+text);await chmod(file,0o700);return file;};
  const initdb=await script('initdb','exit 0\n');
  const postgres=await script('postgres','exec /bin/sleep 10\n');
  const psql=await script('psql',`case "$*" in\n*data_directory*) printf '/foreign/cluster\\n';;\n*CREATE*) /usr/bin/touch '${marker}';;\n*'SELECT email'*) printf 'member@example.invalid\\n';;\n*) printf '1\\n';;\nesac\n`);
  const fixture=fileURLToPath(new URL('./fixtures/native-app-feasibility/checks/postgres.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[fixture,JSON.stringify({commands:{initdb,postgres,psql},port:54321})],{cwd:root,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);await assert.rejects(stat(marker),{code:'ENOENT'});
  const observation=JSON.parse(result.stdout);assert.equal(observation.steps.find(s=>s.name==='cluster_identity').passed,false);
  assert.match(observation.user,/^mosaic_[a-f0-9]{24}$/);
});

test('browser dependency copy failure is a tooling malfunction, not a missing prerequisite',async t=>{
  if(process.env.MOSAIC_REQUIRE_NATIVE!=='1')return t.skip('Requires the pinned actual native prerequisite');
  const fs=(await import('node:fs/promises')).default;
  const {syncBuiltinESMExports}=await import('node:module');
  const {runQualification}=await import('../scripts/native-app-feasibility/run.mjs');
  const output=path.join(neutralParent,'copy-failure-'+crypto.randomUUID());
  const original=fs.cp;let injected=false;
  fs.cp=async function(from,to,...args){
    if(String(to)===path.join(output,'fixture/node_modules/playwright')){
      injected=true;throw Object.assign(new Error('Owned injected copy failure'),{code:'ENOSPC'});
    }
    return original.call(this,from,to,...args);
  };
  syncBuiltinESMExports();
  let result;
  try{result=await runQualification({output,requireNative:true,requireBrowser:true});}
  finally{fs.cp=original;syncBuiltinESMExports();}
  assert.equal(injected,true);
  assert.equal(result.toolStatus,'malfunction');assert.equal(result.exitCode,1);
  assert.equal(JSON.parse(await readFile(path.join(output,'evidence/tool-error.json'),'utf8')).code,'ENOSPC');
});

for(const kind of ['growth','symlink','fifo'])test(`inspection race refuses ${kind} after pathname validation`,async()=>{
  const root=await temporary();
  await report.sealReport(root,{schema:1,exitCode:2,m001:'BLOCKED',toolStatus:'completed',capabilities:[]});
  const moduleUrl=new URL('../scripts/native-app-feasibility/report.mjs',import.meta.url).href;
  const code=`
    import fs from 'node:fs/promises';
    import {spawnSync} from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {inspectReport} from ${JSON.stringify(moduleUrl)};
    const root=${JSON.stringify(root)},kind=${JSON.stringify(kind)},target=root+'/evidence-index.json';
    const read=fs.readFile,open=fs.open;let injected=false;
    const mutate=async file=>{
      if(String(file)!==target||injected)return;injected=true;
      if(kind==='growth')await fs.writeFile(target,Buffer.concat([await read(target),Buffer.alloc(4*1024*1024,32)]));
      else{
        await fs.rename(target,target+'.original');
        if(kind==='symlink')await fs.symlink(target+'.original',target);
        else if(spawnSync('/usr/bin/mkfifo',[target]).status!==0)throw Error('Owned FIFO creation failed');
      }
    };
    fs.readFile=async function(file,...args){await mutate(file);return read.call(this,file,...args);};
    fs.open=async function(file,...args){await mutate(file);return open.call(this,file,...args);};
    syncBuiltinESMExports();
    try{await inspectReport(root);console.log(JSON.stringify({injected,verified:true}));}
    catch(error){console.log(JSON.stringify({injected,error:error.message}));process.exitCode=1;}
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:3000});
  assert.equal(result.status,1,'Inspection must reject the changed file without accepting it or blocking: '+result.stdout);
  const observation=JSON.parse(result.stdout);assert.equal(observation.injected,true);
  assert.match(observation.error,/bound|regular|ELOOP|symbolic/i);
});
