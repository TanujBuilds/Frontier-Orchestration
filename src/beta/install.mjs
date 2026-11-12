import {cp,rename,rm} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {isEntry} from '../harness/entry.mjs';
import {verifyPackage} from '../harness/package.mjs';
import {canonical} from '../harness/contracts.mjs';
import {readBundledNativeCheckRuntime} from './package-contract.mjs';
import {atomic,currentHome,entry,fileBytes,hash,jsonFile,localDirectory,locations,saveJson,shellQuote,withLock} from './files.mjs';
import {readSetupIntent,removeCodexBindings} from './setup.mjs';
import {assertMaintenanceIdle,rollbackLaunchAgent,startLaunchAgent,stopForMaintenance,verifyLaunchAgent} from './service.mjs';

const versionPattern=/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
const header='# BEGIN MOSAIC BETA PATH v1';
const footer='# END MOSAIC BETA PATH v1';
const block=`${header}\nexport PATH="$HOME/.local/bin:$PATH"\n${footer}\n`;

function launcherFor(paths,version,legacy=false){
 const installed=path.join(paths.versions,version,'runtime');
 const searchPath=shellQuote(path.join(installed,'bin'))+':'+shellQuote(path.dirname(paths.launcher))+(legacy?':/opt/homebrew/bin:/usr/local/bin':'');
 return '#!/bin/sh\n# Mosaic Beta managed launcher v1\nPATH='+searchPath+':"$PATH"\nexport PATH\nexec '+shellQuote(path.join(installed,'bin','node'))+' '+
  shellQuote(path.join(installed,'src','beta','cli.mjs'))+(paths.isolated?' --home '+shellQuote(paths.home):'')+' "$@"\n';
}

export async function installedLauncher(paths){
 await localDirectory(paths,path.dirname(paths.launcher),{create:false});
 const receipt=await jsonFile(paths.installation,{privateFile:true,max:8192});
 const bytes=await fileBytes(paths.launcher,{max:16384}).catch(()=>{throw Error('Existing launcher is foreign. Preserve '+paths.launcher);});
 if(bytes&&(!receipt||!versionPattern.test(receipt.version)||hash(bytes)!==receipt.launcherHash||![launcherFor(paths,receipt.version),launcherFor(paths,receipt.version,true)].includes(bytes.toString())))
  throw Error('Existing launcher is foreign or changed. Preserve '+paths.launcher);
 return {receipt,bytes};
}

async function applyPath(paths,receipt){
 if((process.env.PATH??'').split(path.delimiter).includes(path.dirname(paths.launcher)))return receipt;
 const output=process.stdout;
 output.write(`Add this block to ${paths.zshrc} to find mosaic\n\n${block}\n`);
 if(!process.stdin.isTTY||!output.isTTY){output.write(`Run ${shellQuote(paths.launcher)} until ~/.local/bin is on PATH.\n`);return receipt;}
 const rl=createInterface({input:process.stdin,output});
 let confirm;
 try{confirm=await rl.question('Append the PATH block? [y/N] ');}finally{rl.close();}
 if(!/^y(es)?$/i.test(confirm.trim()))return receipt;
 const info=await entry(paths.zshrc);
 const old=(await fileBytes(paths.zshrc)??Buffer.alloc(0)).toString();
 if(old.includes(header)||old.includes(footer)){
  if(receipt.pathBlock&&old.includes(receipt.pathBlock))return receipt;
  throw Error('An existing Mosaic Beta PATH block has changed. Preserve '+paths.zshrc);
 }
 const added=(old&&!old.endsWith('\n')?'\n':'')+block;
 await atomic(paths.zshrc,old+added,{mode:info?info.mode&0o777:0o600});
 return {...receipt,pathBlock:added,pathFileCreated:!info};
}

export async function verifyVersion(directory,version){
 await verifyPackage(directory);
 const manifest=await jsonFile(path.join(directory,'package-manifest.json'));
 if(!['terminal-beta-v1','terminal-beta-v2'].includes(manifest.layout)||manifest.version!==version||!manifest.dependenciesInstalled)
  throw Error('Invalid Mosaic Beta version manifest');
 if(manifest.layout==='terminal-beta-v2'){
  const fingerprint=manifest.files.find(file=>file.path==='runtime/check-artifact/artifact-manifest.json')?.sha256;
  if(!fingerprint||manifest.nativeCheckArtifact?.fingerprint!==fingerprint||manifest.nativeCheckArtifact?.backend?.id!=='darwin-seatbelt'||manifest.nativeCheckArtifact?.backend?.revision!==2)throw Error('Invalid bundled native artifact binding');
  const bundled=await readBundledNativeCheckRuntime(path.join(directory,'runtime'));
  if(bundled.artifactManifestSha256!==fingerprint)throw Error('Bundled native artifact fingerprint differs from package inventory');
 }
 return manifest;
}

const nativeImplementationSources=['native-supervisor.c','native-supervisor.mjs','darwin-seatbelt-v2.mjs','darwin-seatbelt.mjs','contracts.mjs','../sandbox.mjs'];
function nativeImplementationHash(manifest){
 // Match the existing native backend implementationHash byte-for-byte. The
 // persisted runtime identity remains the authority; this is no new format.
 const sources=nativeImplementationSources.map(file=>{
  const source=manifest.files.find(entry=>entry.path===path.posix.normalize('runtime/src/project/check-backends/'+file));
  if(!source||!/^[a-f0-9]{64}$/.test(source.sha256))throw Error('Missing native implementation source inventory; retain the trusted installed version.');
  return {file,hash:source.sha256};
 });
 return hash(JSON.stringify(sources));
}

export async function assertStateCompatibility(paths,manifest){
 const compatible=manifest.stateCompatibility??{settings:[1],database:[0,1]};
 if(!compatible||!['settings','database'].every(key=>Array.isArray(compatible[key])&&compatible[key].length&&compatible[key].every(n=>Number.isInteger(n)&&n>=0)))throw Error('Invalid package state compatibility contract');
 const settings=await jsonFile(paths.config,{privateFile:true});
 if(settings&&!compatible.settings.includes(settings.schema))throw Error('Incompatible settings schema '+settings.schema+'. Keep the newer version; rollback does not restore an older state backup.');
 const database=path.join(paths.state,'harness.sqlite3'),info=await entry(database);
 let savedExecution=null,heldNative=false;
 if(info){
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077))throw Error('Unsafe Mosaic Beta state database');
  const db=new DatabaseSync(database,{readOnly:true});
  try{
   const version=db.prepare('PRAGMA user_version').get().user_version;
   if(!compatible.database.includes(version))throw Error('Incompatible database schema '+version+'. Keep the newer version; live state is never replaced by an older backup.');
   if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='records'").get()){
    const saved=db.prepare("SELECT data FROM records WHERE kind='execution_configuration' AND id='coordinator'").get();
    if(saved){try{savedExecution=JSON.parse(saved.data);}catch{throw Error('Invalid saved native execution identity; preserve the installed version for inspection.');}}
    heldNative=!!db.prepare(`SELECT 1 FROM records WHERE
     (kind='goal' AND json_extract(data,'$.manifest.executionPolicy.backend')='darwin-seatbelt' AND json_extract(data,'$.manifest.executionPolicy.backendRevision')=2 AND json_extract(data,'$.status') NOT IN ('completed','partial')) OR
     (kind='execution_owner' AND json_extract(data,'$.status')!='quiescent') LIMIT 1`).get();
   }
  }finally{db.close();}
 }
 const savedNative=savedExecution?.identity?.nativeRuntime;
 if(savedNative&&!settings?.nativeCheckRuntime)throw Error('Retain the saved native runtime configuration before switching the installed version.');
 if(settings?.nativeCheckRuntime){
  const source=manifest.files.find(file=>file.path==='runtime/src/project/check-backends/native-supervisor.c');
  const artifactBytes=await fileBytes(settings.nativeCheckRuntime.artifactManifestPath,{max:128*1024});
  if(!artifactBytes||hash(artifactBytes)!==settings.nativeCheckRuntime.artifactManifestSha256)throw Error('The retained native artifact manifest changed; restore its exact approved fingerprint before switching versions.');
  let artifact;try{artifact=JSON.parse(artifactBytes);}catch{throw Error('Invalid retained native artifact manifest');}
  if(!source||artifact?.provenance?.supervisorSourceSha256!==source.sha256)throw Error('The retained native artifact is incompatible with this package supervisor source. Keep its version and approvals; explicitly migrate the backend only after all resumable work is resolved.');
  const candidateImplementation=nativeImplementationHash(manifest);
  let previousImplementation;
  if(savedNative){
   if(savedExecution.schema!==2||hash(canonical(savedExecution.identity))!==savedExecution.hash||!/^[a-f0-9]{64}$/.test(savedNative.implementationHash??'')||savedNative.fingerprint!==settings.nativeCheckRuntime.artifactManifestSha256||savedNative.manifestPath!==settings.nativeCheckRuntime.artifactManifestPath)throw Error('Saved native execution identity differs from retained settings; preserve the exact approved configuration.');
   previousImplementation=savedNative.implementationHash;
  }else{
   // Before the first native coordinator boot there is no saved runtime. Only
   // an unchanged, fully verified owned prior package can supply the baseline,
   // and never when an approval or unresolved native owner needs that identity.
   if(heldNative)throw Error('Saved native implementation identity is missing for resumable work; retain the trusted version and resolve that work before updating.');
   const {receipt}=await installedLauncher(paths);
   if(!receipt)throw Error('Cannot establish prior native implementation compatibility; retain the trusted installed version.');
   const previousDirectory=path.join(paths.versions,receipt.version);await verifyPackage(previousDirectory);
   const previous=await jsonFile(path.join(previousDirectory,'package-manifest.json'));
   if(previous.version!==receipt.version||previous.contentHash!==receipt.contentHash)throw Error('Prior native package inventory differs from its ownership receipt.');
   previousImplementation=nativeImplementationHash(previous);
  }
  if(candidateImplementation!==previousImplementation)throw Error('The package native implementation differs from the saved execution identity. Retain the old version, runtime, approvals and literal check paths; resolve resumable work before explicit backend migration.');
 }
}

const transactionFile=paths=>path.join(paths.configDir,'install-transaction.json');
function validateTransaction(paths,tx){
 if(tx?.schema!==1||!versionPattern.test(tx.version??'')||!['prepared','staged','launcher','receipt','committed'].includes(tx.phase)||typeof tx.oldLauncher!=='string'&&tx.oldLauncher!==null||typeof tx.staged!=='string'||!/^\.install-[a-f0-9-]+$/.test(tx.staged)||typeof tx.registered!=='boolean'||typeof tx.existed!=='boolean')throw Error('Invalid installation recovery transaction; preserve it for inspection.');
 if(tx.oldReceipt&&tx.oldLauncher&&(!versionPattern.test(tx.oldReceipt.version??'')||hash(Buffer.from(tx.oldLauncher??'','base64'))!==tx.oldReceipt.launcherHash||![launcherFor(paths,tx.oldReceipt.version),launcherFor(paths,tx.oldReceipt.version,true)].includes(Buffer.from(tx.oldLauncher??'','base64').toString())))throw Error('Changed installation recovery ownership; preserve it for inspection.');
 if(tx.newReceipt?.version!==tx.version||tx.newReceipt.launcherHash!==hash(launcherFor(paths,tx.version)))throw Error('Changed installation recovery target; preserve it for inspection.');
}
async function recoverLocked(paths){
 const tx=await jsonFile(transactionFile(paths),{privateFile:true,max:65536});if(!tx)return false;
 validateTransaction(paths,tx);
 await assertMaintenanceIdle(paths);
 const current=await fileBytes(paths.launcher,{max:16384}),receipt=await jsonFile(paths.installation,{privateFile:true,max:8192});
 const currentHash=current?hash(current):null,oldHash=tx.oldLauncher?hash(Buffer.from(tx.oldLauncher,'base64')):null;
 if(![null,oldHash,tx.newReceipt.launcherHash].includes(currentHash)||receipt&&![hash(JSON.stringify(tx.oldReceipt)),hash(JSON.stringify(tx.newReceipt))].includes(hash(JSON.stringify(receipt))))throw Error('Installation pointer or receipt was modified after interruption; preserve it for inspection.');
 if(tx.phase==='committed'){
  const manifest=await verifyVersion(path.join(paths.versions,tx.version),tx.version);await assertStateCompatibility(paths,manifest);
  if(currentHash!==tx.newReceipt.launcherHash||JSON.stringify(receipt)!==JSON.stringify(tx.newReceipt))throw Error('Committed installation pointer changed; preserve it for inspection.');
  if(tx.registered)await startLaunchAgent(paths);
 }else{
  if(tx.oldReceipt&&await entry(path.join(paths.versions,tx.oldReceipt.version))){const previous=await verifyVersion(path.join(paths.versions,tx.oldReceipt.version),tx.oldReceipt.version);await assertStateCompatibility(paths,previous);}
  await stopForMaintenance(paths);
  if(tx.oldLauncher)await atomic(paths.launcher,Buffer.from(tx.oldLauncher,'base64'),{mode:0o755});else await rm(paths.launcher,{force:true});
  if(tx.oldReceipt){if(JSON.stringify(receipt)!==JSON.stringify(tx.oldReceipt))await saveJson(paths.installation,tx.oldReceipt);}else if(receipt)await rm(paths.installation,{force:true});
  if(tx.registered)await rollbackLaunchAgent(paths,{existed:tx.existed,registered:tx.registered});
 }
 await rm(path.join(paths.versions,tx.staged),{recursive:true,force:true});
 // Installed version directories and their artifact paths are retained. They may
 // be referenced by immutable stopped approvals even after a pointer switch.
 await rm(transactionFile(paths));return true;
}
export async function recoverInstallation(paths){return withLock(paths,()=>recoverLocked(paths));}

export async function install(paths,payload,{noPath=false,afterStep=()=>{}}={}){
 if(typeof afterStep!=='function')throw Error('Installation step observer must be a function');
 const manifest=await jsonFile(path.join(payload,'package-manifest.json'));
 if(!versionPattern.test(manifest?.version??''))throw Error('Invalid Mosaic Beta version');
 await verifyVersion(payload,manifest.version);
 const version=manifest.version,installed=path.join(paths.versions,version);
 return withLock(paths,async()=>{
  await recoverLocked(paths);
  const old=await installedLauncher(paths);
  await assertStateCompatibility(paths,manifest);
  if(old.receipt?.version===version&&old.receipt.contentHash!==manifest.contentHash)throw Error('The installed version receipt has different integrity checksums. Choose a new version.');
  const present=!!await entry(installed);
  if(present){const existing=await verifyVersion(installed,version);if(existing.contentHash!==manifest.contentHash)throw Error('Version already installed with different integrity checksums. Choose a new version.');}
  const launcher=launcherFor(paths,version);
  let receipt={schema:1,version,contentHash:manifest.contentHash,launcherHash:hash(launcher),...(old.receipt?.pathBlock?{pathBlock:old.receipt.pathBlock,pathFileCreated:old.receipt.pathFileCreated}:{})};
  const switched=!present||!old.bytes||old.receipt.version!==version;
  if(switched){
   const existed=await verifyLaunchAgent(paths),registered=await stopForMaintenance(paths),staged='.install-'+randomUUID();
   let tx={schema:1,version,phase:'prepared',oldLauncher:old.bytes?.toString('base64')??null,oldReceipt:old.receipt,newReceipt:receipt,existed,registered,staged};
   await saveJson(transactionFile(paths),tx);
   const advance=async(phase,event)=>{tx={...tx,phase};await saveJson(transactionFile(paths),tx);await afterStep(event);};
   let newVersion=false;
   try{
    await afterStep('transaction-prepared');
    if(!present){await cp(payload,path.join(paths.versions,staged),{recursive:true,force:false,errorOnExist:true});await verifyVersion(path.join(paths.versions,staged),version);await rename(path.join(paths.versions,staged),installed);newVersion=true;}
    await advance('staged','version-staged');
    await localDirectory(paths,path.dirname(paths.launcher));
    await atomic(paths.launcher,launcher,{mode:0o755});await advance('launcher','launcher-switched');
    await saveJson(paths.installation,receipt);await advance('receipt','receipt-switched');
    await advance('committed','committed');
    if(registered)await startLaunchAgent(paths);
    await rm(transactionFile(paths));
   }catch(error){
    // A durable committed transaction is finalized on recovery. Before commit,
    // restore only installer-owned pointers, never any database/settings backup.
    if(tx.phase!=='committed'){
     try{await recoverLocked(paths);if(newVersion)await rm(installed,{recursive:true,force:true});}
     catch(recovery){throw Error(error.message+' Installation recovery needs inspection: '+recovery.message);}
    }
    throw error;
   }
  }
  if(!noPath){try{receipt=await applyPath(paths,receipt);await saveJson(paths.installation,receipt);}catch(error){process.stderr.write('PATH unchanged or needs inspection. '+error.message+'\n');}}
  process.stdout.write(`Mosaic Beta ${version} installed.\nRun ${shellQuote(paths.launcher)} setup\n`);
 });
}
export async function rollbackVersion(paths,version,options={}){
 if(!versionPattern.test(version??''))throw Error('Choose an installed version for rollback');
 return install(paths,path.join(paths.versions,version),{noPath:true,...options});
}

export async function uninstall(paths){
 return withLock(paths,async()=>{
  await recoverLocked(paths);
  const {receipt,bytes}=await installedLauncher(paths).catch(error=>{
   if(!/foreign or changed/.test(error.message))throw error;
   process.stdout.write('Preserved modified mosaic launcher.\n');return {receipt:null,bytes:null};
  });
  const intent=await readSetupIntent(paths);
  const allowUnrecorded=!!intent&&!intent.hadAgent;
  const owned=await verifyLaunchAgent(paths,{allowUnrecorded});
  await stopForMaintenance(paths,{allowUnrecorded});
  const ownership=await jsonFile(paths.ownership,{privateFile:true,max:8192});
  if(ownership)await saveJson(paths.ownership,{...ownership,complete:false});
  if(owned)await rm(paths.plist);
  await removeCodexBindings(paths,process.stdout,intent);
  if(intent)await rm(paths.setupIntent);
  if(receipt?.pathBlock){
   const info=await entry(paths.zshrc);
   let existing;
   try{existing=(await fileBytes(paths.zshrc))?.toString();}catch{}
   if(existing?.includes(receipt.pathBlock)&&existing.indexOf(header)===existing.lastIndexOf(header)&&existing.indexOf(footer)===existing.lastIndexOf(footer)){
    const remaining=existing.replace(receipt.pathBlock,'');
    if(!remaining&&receipt.pathFileCreated)await rm(paths.zshrc);
    else await atomic(paths.zshrc,remaining,{mode:info.mode&0o777});
   }else if(info)process.stdout.write('Preserved modified Mosaic Beta PATH binding.\n');
  }
  if(bytes)await rm(paths.launcher);
  process.stdout.write('Removed owned Mosaic Beta bindings. Installed versions, private settings and evidence are retained at '+paths.root+'\n');
 });
}

async function main(){
 const args=process.argv.slice(2),opts={};
 while(args.length){
  const flag=args.shift();
  if(flag==='--help'){process.stdout.write('Usage: ./install [--no-path] [--home ISOLATED_DIRECTORY]\n');return;}
  if(flag==='--no-path'&&!opts.noPath){opts.noPath=true;continue;}
  if(flag==='--home'&&!opts.home&&args[0]){opts.home=args.shift();continue;}
  throw Error('Use ./install --help for options');
 }
 const paths=locations(opts.home??currentHome(),!!opts.home);
 const payload=fileURLToPath(new URL('../../../',import.meta.url));
 await install(paths,payload,opts);
}

if(isEntry(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
