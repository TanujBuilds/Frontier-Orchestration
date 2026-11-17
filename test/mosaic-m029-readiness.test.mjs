import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {locations,privateDirectories,saveJson} from '../src/beta/files.mjs';
import {normalizeSettings} from '../src/beta/settings.mjs';
import {setupPortable} from '../src/beta/portable-setup.mjs';
import {doctor} from '../src/beta/setup.mjs';
import {client} from '../src/beta/client.mjs';

// These homes, registrations and coordinator calls are disposable fixtures.
// None observes an actual coding app, sign-in, model or installed release.
async function fixture(t,host='cursor'){
 const home=await mkdtemp(path.join(os.tmpdir(),'Mosaic wave01 readiness '));t.after(()=>rm(home,{recursive:true,force:true}));const paths=locations(home,true);await privateDirectories(paths);await mkdir(path.dirname(paths.launcher),{recursive:true});await writeFile(paths.launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});
 const settings=normalizeSettings({schema:2,host:{id:host,options:{}},providers:[],defaults:{workerId:null,plannerWorkerId:null,review:{source:'host',hostId:host}},execution:{backend:'codex-sandbox',backendRevision:1},codexPath:process.execPath,serviceMaxConcurrentTasks:1,capacityGroups:[]});
 return {paths,settings};
}
function output(){let text='';return {write:value=>{text+=value;},text:()=>text};}
const ask=async prompt=>/Apply this exact|Save this local/.test(prompt)?'y':'n';
async function serve(t,paths){
 const child=spawn(process.execPath,[new URL('../src/beta/cli.mjs',import.meta.url).pathname,'--home',paths.home,'serve'],{stdio:['ignore','pipe','pipe']});let stderr='';child.stdout.resume();child.stderr.on('data',value=>stderr+=value);
 t.after(async()=>{if(child.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');await closed;}});
 const invoke=client(paths,{viewer:true,timeoutMs:200});for(let i=0;i<80;i++){if(child.exitCode!==null)break;try{await invoke('tools_list');return invoke;}catch{await delay(25);}}assert.fail('Fixture coordinator did not start: '+stderr);
}
function assertUnverified(text){
 assert.match(text,/UNVERIFIED\s+Host tools discovered/i);assert.match(text,/UNVERIFIED\s+Host tool call/i);assert.doesNotMatch(text,/OK\s+Host(?: capability| connection| tools| tool call|\s*·)/i);
 assert.match(text,/Next action:/);assert.equal((text.match(/Next action:/g)??[]).length,1);
}

for(const host of ['codex','cursor','claude-code','antigravity'])test(`${host} selection alone stays neutral and gives one registration action`,async t=>{
 const {paths,settings}=await fixture(t,host);await saveJson(paths.config,settings);const out=output();assert.equal(await doctor(paths,out),false);assertUnverified(out.text());assert.match(out.text(),/Host registration.*unverified/i);assert.doesNotMatch(out.text(),/signed in|version.*verified/i);
});

test('healthy fixture viewer and saved registration retain doctor true without actual-host proof',async t=>{
 const {paths,settings}=await fixture(t);await setupPortable(paths,{ask,output:output(),settings,verifyExecution:()=>{}});const invoke=await serve(t,paths);assert.ok((await invoke('tools_list')).length>0);
 const files=[paths.config,path.join(paths.configDir,'portable-binding.json'),path.join(paths.home,'.cursor','mcp.json')],before=await Promise.all(files.map(file=>readFile(file))),out=output();
 assert.equal(await doctor(paths,out),true);assertUnverified(out.text());assert.match(out.text(),/Coordinator.*Authenticated viewer/);assert.match(out.text(),/viewer.*does not prove|viewer.*not.*host/i);assert.match(out.text(),/Host registration.*fixture.*actual.*unverified/i);assert.match(out.text(),/Next action:.*actual.*Cursor.*discover/i);assert.deepEqual(await Promise.all(files.map(file=>readFile(file))),before);
});

test('manual-host boundary fixture records instructions without inspecting or changing host configuration',async t=>{
 const {paths,settings}=await fixture(t),hostFile=path.join(paths.home,'.cursor','mcp.json');await mkdir(path.dirname(hostFile),{recursive:true});await writeFile(hostFile,'{ "mcpServers": {"unrelated":{"command":"keep"}} }\n',{mode:0o600});const before=await readFile(hostFile);paths.isolated=false;
 const saved=output();assert.equal(await setupPortable(paths,{ask,output:saved,settings,verifyExecution:()=>{},lifecycle:{verifyLaunchAgent:async()=>false,stopForMaintenance:async()=>false,startLaunchAgent:async()=>true}}),true);assertUnverified(saved.text());assert.match(saved.text(),/Host registration instructions.*saved locally/i);assert.match(saved.text(),/Host registration.*unverified/i);assert.deepEqual(await readFile(hostFile),before);
 const out=output();await doctor(paths,out);assertUnverified(out.text());assert.match(out.text(),/Host registration instructions.*saved locally/i);assert.doesNotMatch(out.text(),/fixture registration.*saved/i);assert.deepEqual(await readFile(hostFile),before);
});

test('resumed manual setup retains one connection next action and unverified discovery/call',async t=>{
 const {paths,settings}=await fixture(t);paths.isolated=false;const lifecycle={verifyLaunchAgent:async()=>false,stopForMaintenance:async()=>false,startLaunchAgent:async()=>true};
 await assert.rejects(setupPortable(paths,{ask,output:output(),settings,verifyExecution:()=>{},lifecycle,afterStep:step=>{if(step==='complete')throw Error('fixture interrupted completion');}}),/fixture interrupted completion/);
 const out=output();assert.equal(await setupPortable(paths,{ask:()=>assert.fail('must resume'),output:out,verifyExecution:()=>{},lifecycle}),true);assert.match(out.text(),/Resumed interrupted setup/);assertUnverified(out.text());assert.match(out.text(),/Host registration instructions.*saved locally/i);assert.match(out.text(),/Next action:.*mosaic host-preview --host cursor/i);
});

test('a changed fixture binding stays a setup issue with actionable error, not actual-host discovery failure',async t=>{
 const {paths,settings}=await fixture(t);await setupPortable(paths,{ask,output:output(),settings,verifyExecution:()=>{}});await serve(t,paths);
 await saveJson(path.join(paths.home,'.cursor','mcp.json'),{mcpServers:{'mosaic-beta':{command:'/fixture/customized',args:['mcp']}}});const out=output();assert.equal(await doctor(paths,out),false);assert.match(out.text(),/CHECK\s+Setup/);assertUnverified(out.text());assert.match(out.text(),/Next action:.*mosaic setup/i);assert.doesNotMatch(out.text(),/CHECK\s+Host tools discovered|CHECK\s+Host tool call/i);
});
