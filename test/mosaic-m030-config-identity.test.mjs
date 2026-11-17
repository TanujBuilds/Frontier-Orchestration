import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {locations,privateDirectories,saveJson} from '../src/beta/files.mjs';
import {setupPortable} from '../src/beta/portable-setup.mjs';

// Saved dummy key, disposable homes and inert provider identities only.
const key='review/key',unicode=[...key].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''),json=JSON.stringify(unicode).slice(1,-1);
async function fixture(t){
 const home=await mkdtemp(path.join(os.tmpdir(),'Mosaic wave01 config identity '));t.after(()=>rm(home,{recursive:true,force:true}));const paths=locations(home,true);await privateDirectories(paths);await mkdir(path.dirname(paths.launcher),{recursive:true});await writeFile(paths.launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});await saveJson(paths.credentials,{schema:1,entries:{retained:key}});return paths;
}
function configuration(){
 return {schema:2,host:{id:'cursor',options:{}},providers:[{schema:1,id:'worker',revision:'r1',displayName:'Fixture worker',transport:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',model:'fixture-model',roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding']},maxContextTokens:null,maxOutputTokens:4096,concurrency:1,capacityGroup:'worker',credentialRef:null,streaming:false}],defaults:{workerId:'worker',plannerWorkerId:'worker',review:{source:'host',hostId:'cursor'}},execution:{backend:'codex-sandbox',backendRevision:1},codexPath:process.execPath,serviceMaxConcurrentTasks:1,capacityGroups:[{id:'worker',limit:1}]};
}
for(const field of ['model','url'])for(const percent of [false,true])test(`public --config rejects raw ${percent?'percent-':''}JSON saved-key identity in ${field} before publication`,async t=>{
 const paths=await fixture(t),old=configuration(),proposed=structuredClone(old),encoded=percent?encodeURIComponent(json):json;
 proposed.providers[0][field==='url'?'baseUrl':'model']=field==='url'?old.providers[0].baseUrl+'/'+encoded:encoded;await saveJson(paths.config,old);const file=path.join(paths.configDir,'proposed-settings.json');await saveJson(file,proposed);const before=await Promise.all([paths.config,paths.credentials,file].map(f=>readFile(f)));
 const child=spawn(process.execPath,[new URL('../src/beta/cli.mjs',import.meta.url).pathname,'--home',paths.home,'setup','--config',file],{stdio:['pipe','pipe','pipe'],timeout:5000});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.stdin.end('n\nn\nn\n');const code=await new Promise(resolve=>child.once('close',resolve));
 assert.equal(code,1);assert.match(stderr,/Credential values must occur only/);assert.doesNotMatch(stdout,/Mosaic setup summary|Exact private setup preview/);assert.ok(!stdout.includes(encoded));assert.deepEqual(await Promise.all([paths.config,paths.credentials,file].map(f=>readFile(f))),before);await assert.rejects(readFile(paths.setupIntent),{code:'ENOENT'});
});

for(const field of ['model','url'])for(const percent of [false,true])test(`simple setup rejects raw ${percent?'percent-':''}JSON retained-key identity in ${field} before preflight`,async t=>{
 const paths=await fixture(t),encoded=percent?encodeURIComponent(json):json,answers=['3','1','http://127.0.0.1:1/v1'+(field==='url'?'/'+encoded:''),field==='model'?encoded:'fixture-model','n','n','n','n','n'];let text='',preflight=false;const before=await readFile(paths.credentials),fingerprint='a'.repeat(64);
 await assert.rejects(setupPortable(paths,{ask:async()=>answers.shift(),output:{write:v=>{text+=v;}},execution:{backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:fingerprint},nativeCheckRuntime:{schema:1,artifactManifestPath:'/fixture/retained-native/artifact-manifest.json',artifactManifestSha256:fingerprint},verifyExecution:()=>{preflight=true;}}),/Credential values must occur only/);
 assert.equal(preflight,false);assert.doesNotMatch(text,/Mosaic setup summary|Exact private setup preview/);assert.ok(!text.includes(encoded));assert.deepEqual(await readFile(paths.credentials),before);await assert.rejects(readFile(paths.config),{code:'ENOENT'});await assert.rejects(readFile(paths.setupIntent),{code:'ENOENT'});
});
