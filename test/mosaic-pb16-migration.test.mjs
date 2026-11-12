import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {locations,privateDirectories,saveJson} from '../src/beta/files.mjs';
import * as settings from '../src/beta/settings.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
const legacy={schema:1,host:{id:'codex',options:{}},codexPath:'/fixture/codex',worker:{profile:{baseUrl:'http://127.0.0.1:11434/v1',model:'local-model',displayName:'Local',revision:'r1',streaming:false},apiKey:'dummy-"key\\value'}};
async function fixture(t){const home=await mkdtemp(path.join(os.tmpdir(),'mosaic-pb16-migration-'));t.after(()=>rm(home,{recursive:true,force:true}));const paths=locations(home,true);await privateDirectories(paths);await saveJson(paths.config,legacy);return paths;}
test('legacy migration preview is secret-free and cancel leaves config and logical goals intact',async t=>{
 const paths=await fixture(t),c=new Coordinator({root:paths.state});const goal=c.prepareLegacyGoal({submissionId:'saved',objective:'Preserve saved state',acceptance:['No edits'],mode:'codex_only',environment:'fixture'},'saved');c.close();
 const before=await readFile(paths.config),db=await readFile(path.join(paths.state,'harness.sqlite3'));
 assert.equal((await settings.readSettings(paths)).schema,1);
 const preview=await settings.previewSettingsMigration(paths);
 assert.equal(preview.settings.schema,2);assert.equal(preview.settings.defaults.workerId,'legacy-worker');assert.ok(!JSON.stringify(preview).includes(legacy.worker.apiKey));assert.ok(!JSON.stringify(preview).includes(JSON.stringify(legacy.worker.apiKey).slice(1,-1)));
 assert.deepEqual(await readFile(paths.config),before);assert.deepEqual(await readFile(path.join(paths.state,'harness.sqlite3')),db);assert.equal(goal.status,'draft');
});
for(const step of ['intent','credentials','settings','complete'])test(`explicit migration resumes after durable ${step} without credential loss`,async t=>{
 const paths=await fixture(t),preview=await settings.previewSettingsMigration(paths);
 await assert.rejects(settings.applySettingsMigration(paths,preview,{afterStep:at=>{if(at===step)throw Error('fixture interruption');}}),/interruption/);
 await settings.resumeSettingsMigration(paths);
 const current=await settings.readSettings(paths),credentials=JSON.parse(await readFile(path.join(paths.configDir,'credentials.json'),'utf8'));
 assert.equal(current.schema,2);assert.equal(credentials.entries['legacy-worker-key'],legacy.worker.apiKey);assert.equal((await stat(path.join(paths.configDir,'credentials.json'))).mode&0o777,0o600);assert.equal(current.codexPath,legacy.codexPath);
 assert.equal(await settings.resumeSettingsMigration(paths),false);
});
test('migration preserves existing credentials and rejects changed settings or credentials after preview',async t=>{
 const paths=await fixture(t),file=path.join(paths.configDir,'credentials.json');await saveJson(file,{schema:1,entries:{other:'unrelated'}});
 const preview=await settings.previewSettingsMigration(paths);await saveJson(file,{schema:1,entries:{other:'newer'}});
 await assert.rejects(settings.applySettingsMigration(paths,preview),/changed/);assert.equal((await settings.readSettings(paths)).schema,1);
 const next=await settings.previewSettingsMigration(paths);await settings.applySettingsMigration(paths,next);assert.equal(JSON.parse(await readFile(file,'utf8')).entries.other,'newer');
});
test('migration rejects unknown legacy fields losslessly and corrupt or unsafe credential files',async t=>{
 const paths=await fixture(t);await saveJson(paths.config,{...legacy,unknown:'must not drop'});await assert.rejects(settings.previewSettingsMigration(paths),/lossless|unknown|configuration/i);
 await saveJson(paths.config,legacy);await writeFile(path.join(paths.configDir,'credentials.json'),'{}',{mode:0o600});await assert.rejects(settings.previewSettingsMigration(paths),/credential/i);
});
for(const step of ['intent','credentials','settings','complete'])test(`SIGKILL migration at ${step} resumes through public CLI with unchanged credential ownership`,async t=>{
 const {spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url');const paths=await fixture(t),module=new URL('../src/beta/settings.mjs',import.meta.url).href;const script=`import {previewSettingsMigration,applySettingsMigration} from ${JSON.stringify(module)};const paths=${JSON.stringify(paths)};await applySettingsMigration(paths,await previewSettingsMigration(paths),{afterStep:step=>{if(step===${JSON.stringify(step)})process.kill(process.pid,'SIGKILL');}});`;
 const killed=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});assert.equal(killed.signal,'SIGKILL',killed.stderr);
 const resumed=spawnSync(process.execPath,[fileURLToPath(new URL('../src/beta/cli.mjs',import.meta.url)),'--home',paths.home,'migrate'],{encoding:'utf8',timeout:10000});assert.equal(resumed.status,0,resumed.stderr);assert.match(resumed.stdout,/Resumed approved settings migration/);assert.equal((await settings.readCredentials(paths)).entries['legacy-worker-key'],legacy.worker.apiKey);assert.equal((await stat(path.join(paths.configDir,'credentials.json'))).uid,process.getuid());
});

test('migration rejects stopped legacy API approval before writes and the original worker context resumes',async t=>{
 const paths=await fixture(t);let c=new Coordinator({root:paths.state,beta:true,selectedHost:'codex',workerProfile:legacy.worker.profile});let goal;
 try{goal=c.prepareGoal({submissionId:'legacy-stopped-api',objective:'Resume the original legacy worker',acceptance:['Keep approved worker'],environment:'live',mode:'collaborative'},'prepare-legacy-stopped');c.activateGoal({goalId:goal.id,hash:goal.hash},'activate-legacy-stopped');c.control({goalId:goal.id,action:'stop'},'stop-legacy-stopped');}finally{c.close();}
 const beforeSettings=await readFile(paths.config),beforeDb=await readFile(path.join(paths.state,'harness.sqlite3')),preview=await settings.previewSettingsMigration(paths);await assert.rejects(settings.applySettingsMigration(paths,preview),/legacy.*worker.*resume|resume.*finalize|stopped.*approval/i);assert.deepEqual(await readFile(paths.config),beforeSettings);assert.deepEqual(await readFile(path.join(paths.state,'harness.sqlite3')),beforeDb);for(const name of ['credentials.json','migration-intent.json','migration-legacy.json'])await assert.rejects(readFile(path.join(paths.configDir,name)),{code:'ENOENT'});
 const original=await settings.readSettings(paths);c=new Coordinator({root:paths.state,beta:true,selectedHost:'codex',workerProfile:original.worker.profile});try{const saved=c.getGoal(goal.id);assert.equal(saved.hash,goal.hash);c.verifyWorkerBinding(saved);assert.equal(c.control({goalId:goal.id,action:'resume'},'resume-original').status,'active');const task=c.submitTask({goalId:goal.id,submissionId:'original-worker-task',kind:'consult',actor:'deepseek',objective:'Use the approved legacy worker',acceptance:['Exact worker remains usable']},'original-worker-task');assert.equal(c.claimNext('original-owner').id,task.id);assert.equal(c.getTask(task.id).status,'running');assert.equal(c.getTask(task.id).owner,'original-owner');}finally{c.close();}
});
