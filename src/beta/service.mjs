import {lstatSync,readFileSync} from 'node:fs';
import {canonical} from '../harness/contracts.mjs';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {serve} from '../harness/cli.mjs';
import {atomic,entry,fileBytes,hash,jsonFile,label,privateDirectories} from './files.mjs';
import {client} from './client.mjs';

const exec=promisify(execFile);
const launchctl=(...args)=>exec('/bin/launchctl',args,{timeout:5000,maxBuffer:65536});
const domain=()=>`gui/${process.getuid()}`;
const serviceId=()=>domain()+'/'+label;
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&apos;");

export function launchAgent(paths){
 const args=[paths.launcher,'serve'].map(value=>'<string>'+xml(value)+'</string>').join('');
 return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>WorkingDirectory</key><string>${xml(paths.state)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(path.join(paths.state,'coordinator.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(paths.state,'coordinator-error.log'))}</string>
</dict></plist>
`;
}

function assertIdle(db) {
 const guard=db.prepare(`SELECT kind FROM records WHERE
  (kind='goal' AND json_extract(data,'$.status') IN ('draft','active','paused')) OR
  (kind='task' AND (json_extract(data,'$.owner') IS NOT NULL OR json_extract(data,'$.native.writerActive')=1)) OR
  (kind='task' AND json_extract(data,'$.status')='legacy_reviewing') OR
  (kind='reviewer' AND json_extract(data,'$.status')='reserved') OR
  (kind='planning' AND json_extract(data,'$.status') IN ('running','uncertain')) OR
  (kind='operation' AND json_extract(data,'$.status') IN ('pending','retryable')) LIMIT 1`).get();
 if(guard)throw Error('Mosaic Beta has prepared, active or unresolved work. Resolve it in Codex before maintenance.');
}

async function diskIdle(paths){
 const file=path.join(paths.state,'harness.sqlite3');
 const info=await entry(file);
 if(!info)return;
 if(!info.isFile())throw Error('Unsafe Mosaic Beta state database');
 const db=new DatabaseSync(file,{readOnly:true});
 try{assertIdle(db);}finally{db.close();}
}

async function loaded(paths){
 if(paths.isolated)return false;
 try{await launchctl('print',serviceId());return true;}catch{return false;}
}

async function online(paths){
 try{await client(paths,{viewer:true,timeoutMs:800})('tools_list');return true;}catch{return false;}
}

export async function verifyLaunchAgent(paths,{allowUnrecorded=false}={}){
 if(paths.isolated)return false;
 const old=await fileBytes(paths.plist,{max:32768});
 const receipt=old&&!allowUnrecorded?await jsonFile(paths.ownership,{privateFile:true,max:8192}):null;
 if(old&&(old.toString()!==launchAgent(paths)||!allowUnrecorded&&receipt?.launchAgentHash!==hash(old))||!old&&await loaded(paths))throw Error('Existing LaunchAgent is foreign or has changed. Preserve it and inspect '+paths.plist);
 return !!old;
}

export async function stopForMaintenance(paths){
 const owned=await verifyLaunchAgent(paths);
 const registered=owned&&await loaded(paths);
 if(await online(paths)){
  if(paths.isolated||!registered)throw Error('Stop the foreground Mosaic Beta coordinator before maintenance.');
  await client(paths,{timeoutMs:2500})('service_stop',{idempotencyKey:randomUUID()});
  for(let i=0;i<20&&await online(paths);i++)await delay(150);
  if(await online(paths))throw Error('Mosaic Beta coordinator did not stop safely');
 }else{
  if(registered)throw Error('The registered Mosaic Beta coordinator is unreachable. Run mosaic doctor before maintenance.');
  await diskIdle(paths);
 }
 if(registered)await launchctl('bootout',serviceId());
 return registered;
}

export async function startLaunchAgent(paths){
 if(paths.isolated)return false;
 const owned=await verifyLaunchAgent(paths);
 if(!owned){
  await mkdir(path.dirname(paths.plist),{recursive:true,mode:0o700});
  await atomic(paths.plist,launchAgent(paths));
 }
 if(!await loaded(paths)){
  try{await launchctl('bootstrap',domain(),paths.plist);}catch{throw Error('Could not register Mosaic Beta in this macOS login session');}
 }else if(!await online(paths)){
  try{await launchctl('kickstart',serviceId());}catch{throw Error('Could not start the registered Mosaic Beta LaunchAgent');}
 }
 for(let i=0;i<30;i++){
  if(await online(paths))return true;
  await delay(150);
 }
 throw Error('Mosaic Beta coordinator did not become ready. Run mosaic doctor.');
}

export async function rollbackLaunchAgent(paths,{existed,registered}){
 if(paths.isolated)return;
 if(await loaded(paths))await launchctl('bootout',serviceId());
 if(!existed&&await verifyLaunchAgent(paths,{allowUnrecorded:true}))await rm(paths.plist);
 if(registered)await startLaunchAgent(paths);
}

export async function serveBeta(paths,settings){
 if(!settings)throw Error('Run mosaic setup before starting Mosaic Beta');
 await privateDirectories(paths);
 process.umask(0o077);
 const expectedWorker=canonical(settings.worker??null);
 const verifyCurrentWorker=()=>{
  try{
   const info=lstatSync(paths.config);
   if(!info.isFile()||info.size>16384||info.mode&0o077)throw Error();
   if(canonical(JSON.parse(readFileSync(paths.config,'utf8')).worker??null)===expectedWorker)return;
  }catch{}
  throw Error('Configured API worker settings changed. Restart Mosaic Beta safely and obtain a new goal approval.');
 };
 return serve({root:paths.state,port:0,headless:true,canStop:c=>assertIdle(c.store.db),verifyCurrentWorker,
  runtimeConfig:{beta:true,codexPath:settings.codexPath,workerProfile:settings.worker?.profile,workerApiKey:settings.worker?.apiKey}});
}
