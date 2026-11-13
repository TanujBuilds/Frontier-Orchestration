import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough, Readable} from 'node:stream';
import {locations, privateDirectories, saveJson} from '../src/beta/files.mjs';
import {doctor, readSettings, setup} from '../src/beta/setup.mjs';
import {canonical,digest} from '../src/harness/contracts.mjs';
import {workerProfile} from '../src/harness/worker-profile.mjs';

const legacyProfile={
 baseUrl:'https://fixture.invalid/v1',model:'fixture-model',displayName:'Fixture worker',
 revision:'legacy-fixture-revision',streaming:false
};
const jsonManual={protocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual'};
const sseAdvertised={protocol:'mosaic-structured-v1',transports:['sse'],modelDiscovery:'advertised'};
const dummyKey='fixture-provider-key-z3nS';

async function settingsFixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-flexibility-profile-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const paths=locations(path.join(root,'home'),true);
 await privateDirectories(paths);
 const codexPath=path.join(paths.home,'.local','bin','codex');
 await mkdir(path.dirname(codexPath),{recursive:true});
 await writeFile(codexPath,'#!/bin/sh\nexit 0\n',{mode:0o700});
 return {paths,codexPath};
}

function transcript(){
 const output=new PassThrough();
 let text='';
 output.setEncoding('utf8');
 output.on('data',chunk=>{text+=chunk;});
 return {output,text:()=>text};
}

async function setupAnswers(paths,answers,{credentialInput=false}={}){
 const input=Readable.from([answers.join('\n')+'\n']);
 const {output,text}=transcript();
 if(credentialInput){input.isTTY=true;output.isTTY=true;}
 assert.equal(await setup(paths,{input,output}),true);
 return text();
}

async function modelsFixture(t,{requiredKey}={}){
 const calls=[];
 const fixture={models:['fixture-model'],calls};
 const server=http.createServer((req,res)=>{
  calls.push({method:req.method,url:req.url,auth:req.headers.authorization});
  if(req.method!=='GET'||req.url!=='/v1/models'){
   res.writeHead(500).end('Unexpected provider request');
   return;
  }
  if(requiredKey&&req.headers.authorization!=='Bearer '+requiredKey){
   res.writeHead(401).end('Fixture authorization required');
   return;
  }
  res.end(JSON.stringify({data:fixture.models.map(id=>({id}))}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return Object.assign(fixture,{baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'});
}

test('explicit capability declarations retain their stored identity and keep the credential private',async t=>{
 const {paths,codexPath}=await settingsFixture(t);
 const profile={...legacyProfile,capabilities:{...jsonManual,transports:['sse','json']}};
 await saveJson(paths.config,{schema:1,codexPath,worker:{profile,apiKey:dummyKey}});
 const {worker}=await readSettings(paths);
 assert.equal(worker.apiKey,dummyKey);
 assert.equal(canonical(worker),canonical(JSON.parse(await readFile(paths.config,'utf8')).worker));
 assert.deepEqual(worker.profile,profile);
 assert.equal(JSON.stringify(worker.profile).includes(dummyKey),false);
});

test('worker profile rejects malformed, unsupported and transport-incompatible declarations',()=>{
 const {protocol,transports,modelDiscovery}=jsonManual;
 const malformed=[
  null,[],{}, {protocol,transports}, {protocol,transports,modelDiscovery:'dynamic'},
  {...jsonManual,protocol:'openai'}, {...jsonManual,tools:true}, {...jsonManual,apiKey:dummyKey},
  {...jsonManual,transports:'json'}, {...jsonManual,transports:[]},
  {...jsonManual,transports:['json','json']}, {...jsonManual,transports:['json','websocket']},
  {...jsonManual,transports:Array(1)}
 ];
 for(const capabilities of malformed)
  assert.throws(()=>workerProfile({...legacyProfile,capabilities}),/invalid API worker capabilities/i);
 assert.throws(()=>workerProfile({...legacyProfile,capabilities:sseAdvertised}),/response mode.*unsupported/i);
 assert.throws(()=>workerProfile({...legacyProfile,streaming:true,capabilities:jsonManual}),/response mode.*unsupported/i);
});

test('new setup declares the selected transport and manual model without probing',async t=>{
 const {paths}=await settingsFixture(t);
 const provider=await modelsFixture(t);
 await setupAnswers(paths,['2','Fixture worker',provider.baseUrl,'n','c','n','fixture-model','n','y']);
 const {worker}=await readSettings(paths);
 assert.deepEqual(worker.profile.capabilities,jsonManual);
 assert.equal(worker.profile.model,'fixture-model');
 assert.deepEqual(provider.calls,[]);
});

test('reapplying unchanged legacy settings preserves the saved profile bytes',async t=>{
 const {paths,codexPath}=await settingsFixture(t);
 const before={schema:1,codexPath,worker:{profile:legacyProfile,apiKey:dummyKey}};
 await saveJson(paths.config,before);
 const bytes=await readFile(paths.config,'utf8');
 await setupAnswers(paths,['','','','k','','n','','n','y']);
 assert.equal(await readFile(paths.config,'utf8'),bytes);
 const {worker}=await readSettings(paths);
 assert.equal(Object.hasOwn(worker.profile,'capabilities'),false);
 assert.equal(worker.profile.revision,legacyProfile.revision);
});

test('setup persists an advertised SSE model with authenticated discovery and private credentials',async t=>{
 const {paths}=await settingsFixture(t);
 const provider=await modelsFixture(t,{requiredKey:dummyKey});
 provider.models=[dummyKey,'fixture-model'];
 const output=await setupAnswers(paths,['2','Fixture worker',provider.baseUrl,'y',dummyKey,'s','y','1','n','y'],{credentialInput:true});
 const {worker}=await readSettings(paths);
 assert.deepEqual(worker.profile.capabilities,sseAdvertised);
 assert.equal(worker.profile.model,'fixture-model');
 assert.equal(worker.apiKey,dummyKey);
 assert.equal(output.includes(dummyKey),false);
 assert.deepEqual(provider.calls,[{method:'GET',url:'/v1/models',auth:'Bearer '+dummyKey}]);
});

test('setup states when a manually entered model was not advertised by discovery',async t=>{
 const {paths}=await settingsFixture(t);
 const provider=await modelsFixture(t);
 const output=await setupAnswers(paths,['2','Fixture worker',provider.baseUrl,'n','c','y','other-model','n','y']);
 const {worker}=await readSettings(paths);
 assert.deepEqual(worker.profile.capabilities,jsonManual);
 assert.match(output,/not advertised.*manual/i);
 assert.deepEqual(provider.calls.map(call=>call.method),['GET']);
});

test('advertised mode is retained during rediscovery even when the model has disappeared',async t=>{
 const {paths}=await settingsFixture(t);
 const provider=await modelsFixture(t);
 await setupAnswers(paths,['2','Fixture worker',provider.baseUrl,'n','s','y','1','n','y']);
 const bytes=await readFile(paths.config,'utf8');
 provider.models=['other-model'];
 await setupAnswers(paths,['','','','n','','','','n','y']);
 assert.equal(await readFile(paths.config,'utf8'),bytes);
 assert.deepEqual(provider.calls.map(call=>call.method),['GET','GET']);
});

test('doctor reports a missing required advertised model without sending a completion',async t=>{
 const {paths}=await settingsFixture(t);
 const provider=await modelsFixture(t);
 await setupAnswers(paths,['2','Fixture worker',provider.baseUrl,'n','s','y','1','n','y']);
 const available=transcript();
 await doctor(paths,available.output);
 assert.match(available.text(),/OK  API worker.*advertised.*SSE.*untested/i);
 provider.models=['other-model'];
 const missing=transcript();
 await doctor(paths,missing.output);
 assert.match(missing.text(),/CHECK  API worker.*required.*not advertised/i);
 assert.deepEqual(provider.calls.map(call=>call.method),['GET','GET','GET']);
});

test('the optional setup completion checks the advertised model again before POST',async t=>{
 const {paths}=await settingsFixture(t);
 const provider=await modelsFixture(t);
 Object.defineProperty(provider,'models',{get:()=>provider.calls.length===1?['fixture-model']:['other-model']});
 const output=await setupAnswers(paths,['2','Fixture worker',provider.baseUrl,'n','s','y','1','y','y']);
 assert.match(output,/Connection test failed/);
 assert.deepEqual(provider.calls.map(call=>call.method),['GET','GET']);
});

test('setup requires a valid model list before declaring advertised discovery',async t=>{
 const {paths}=await settingsFixture(t);
 const provider=await modelsFixture(t);
 provider.models=[null,'fixture-model'];
 const output=await setupAnswers(paths,['2','Fixture worker',provider.baseUrl,'n','c','y','fixture-model','n','y']);
 const {worker}=await readSettings(paths);
 assert.deepEqual(worker.profile.capabilities,jsonManual);
 assert.match(output,/Model discovery is unavailable/);
 assert.deepEqual(provider.calls.map(call=>call.method),['GET']);
});

test('doctor uses the dispatch model list validation for advertised profiles',async t=>{
 const {paths}=await settingsFixture(t);
 const provider=await modelsFixture(t);
 await setupAnswers(paths,['2','Fixture worker',provider.baseUrl,'n','c','y','1','n','y']);
 provider.models=['fixture-model',null];
 const diagnostics=transcript();
 await doctor(paths,diagnostics.output);
 assert.match(diagnostics.text(),/CHECK  API worker.*could not confirm the required model/i);
 assert.deepEqual(provider.calls.map(call=>call.method),['GET','GET']);
});

test('brand-new Codex setup records its explicit trusted host selection',async t=>{
 const {paths}=await settingsFixture(t);
 await setupAnswers(paths,['1','y']);
 assert.deepEqual((await readSettings(paths)).host,{id:'codex',options:{}});
});
test('unchanged explicit Codex host settings retain their exact saved bytes',async t=>{
 const {paths,codexPath}=await settingsFixture(t);
 await saveJson(paths.config,{schema:1,codexPath,worker:null,host:{id:'codex'}});
 const bytes=await readFile(paths.config,'utf8');
 await setupAnswers(paths,['1','y']);
 assert.equal(await readFile(paths.config,'utf8'),bytes);
});
for(const id of ['claude-code','cursor','antigravity'])test(`Codex-only interactive setup preserves an existing ${id} host and refuses a silent switch`,async t=>{
 const {paths,codexPath}=await settingsFixture(t);
 await saveJson(paths.config,{schema:1,codexPath,worker:null,host:{id,options:{}}});
 const bytes=await readFile(paths.config,'utf8'),diagnostic=transcript();
 const result=await setup(paths,{input:Readable.from(['1\ny\n']),output:diagnostic.output});
 assert.equal(result,false);assert.equal(await readFile(paths.config,'utf8'),bytes);assert.match(diagnostic.text(),/preserv|unchanged/i);assert.match(diagnostic.text(),/Codex.*setup|setup.*Codex/i);assert.match(diagnostic.text(),new RegExp(id));
 await assert.rejects(readFile(paths.setupIntent),{code:'ENOENT'});await assert.rejects(readFile(paths.ownership),{code:'ENOENT'});await assert.rejects(readFile(paths.isolatedMcp),{code:'ENOENT'});
});
test('resuming a Codex setup intent also preserves an explicitly selected non-Codex host',async t=>{
 const {paths,codexPath}=await settingsFixture(t);
 const before={schema:1,codexPath,worker:null,host:{id:'cursor',options:{}}};await saveJson(paths.config,before);
 const intent={schema:1,settings:{schema:1,codexPath,worker:null,host:{id:'codex',options:{}}},hadAgent:false,previousConfigHash:digest(before),previousMcpHash:null,previousSkillHash:null};
 await saveJson(paths.setupIntent,intent);const bytes=await readFile(paths.config,'utf8'),pending=await readFile(paths.setupIntent,'utf8'),diagnostic=transcript();
 assert.equal(await setup(paths,{input:Readable.from([]),output:diagnostic.output}),false);
 assert.equal(await readFile(paths.config,'utf8'),bytes);assert.equal(await readFile(paths.setupIntent,'utf8'),pending);assert.match(diagnostic.text(),/cursor/);assert.match(diagnostic.text(),/preserved/);
 await assert.rejects(readFile(paths.ownership),{code:'ENOENT'});await assert.rejects(readFile(paths.isolatedMcp),{code:'ENOENT'});
});
