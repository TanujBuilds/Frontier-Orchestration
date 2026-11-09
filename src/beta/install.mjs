import {cp,rename,rm} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {isEntry} from '../harness/entry.mjs';
import {verifyPackage} from '../harness/package.mjs';
import {atomic,currentHome,entry,fileBytes,hash,jsonFile,localDirectory,locations,saveJson,shellQuote,withLock} from './files.mjs';
import {readSetupIntent,removeCodexBindings} from './setup.mjs';
import {rollbackLaunchAgent,startLaunchAgent,stopForMaintenance,verifyLaunchAgent} from './service.mjs';

const versionPattern=/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
const header='# BEGIN MOSAIC BETA PATH v1';
const footer='# END MOSAIC BETA PATH v1';
const block=`${header}\nexport PATH="$HOME/.local/bin:$PATH"\n${footer}\n`;

function launcherFor(paths,version){
 const installed=path.join(paths.versions,version,'runtime');
 const searchPath=shellQuote(path.join(installed,'bin'))+':'+shellQuote(path.dirname(paths.launcher))+':/opt/homebrew/bin:/usr/local/bin';
 return '#!/bin/sh\n# Mosaic Beta managed launcher v1\nPATH='+searchPath+':"$PATH"\nexport PATH\nexec '+shellQuote(path.join(installed,'bin','node'))+' '+
  shellQuote(path.join(installed,'src','beta','cli.mjs'))+(paths.isolated?' --home '+shellQuote(paths.home):'')+' "$@"\n';
}

export async function installedLauncher(paths){
 await localDirectory(paths,path.dirname(paths.launcher),{create:false});
 const receipt=await jsonFile(paths.installation,{privateFile:true,max:8192});
 const bytes=await fileBytes(paths.launcher,{max:16384}).catch(()=>{throw Error('Existing launcher is foreign. Preserve '+paths.launcher);});
 if(bytes&&(!receipt||!versionPattern.test(receipt.version)||hash(bytes)!==receipt.launcherHash||bytes.toString()!==launcherFor(paths,receipt.version)))
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
 if(manifest.layout!=='terminal-beta-v1'||manifest.version!==version||!manifest.dependenciesInstalled)
  throw Error('Invalid Mosaic Beta version manifest');
 return manifest;
}

export async function install(paths,payload,{noPath=false}={}){
 const manifest=await jsonFile(path.join(payload,'package-manifest.json'));
 if(!versionPattern.test(manifest?.version??''))throw Error('Invalid Mosaic Beta version');
 await verifyVersion(payload,manifest.version);
 const version=manifest.version;
 const installed=path.join(paths.versions,version);
 return withLock(paths,async()=>{
  const old=await installedLauncher(paths);
  if(old.receipt?.version===version&&old.receipt.contentHash!==manifest.contentHash)
   throw Error('The installed version receipt has different integrity checksums. Choose a new version.');
  const present=!!await entry(installed);
  if(present){
   const existing=await verifyVersion(installed,version);
   if(existing.contentHash!==manifest.contentHash)throw Error('Version already installed with different integrity checksums. Choose a new version.');
  }
  const launcher=launcherFor(paths,version);
  let receipt={schema:1,version,contentHash:manifest.contentHash,launcherHash:hash(launcher),...(old.receipt?.pathBlock?{pathBlock:old.receipt.pathBlock,pathFileCreated:old.receipt.pathFileCreated}:{})};
  const switched=!present||!old.bytes||old.receipt.version!==version;
  if(switched){
   const existed=await verifyLaunchAgent(paths);
   const registered=await stopForMaintenance(paths);
   const staged=path.join(paths.versions,'.install-'+randomUUID());
   let newVersion=false,changed=false,receiptChanged=false;
   try{
    if(!await entry(installed)){
     await cp(payload,staged,{recursive:true,force:false,errorOnExist:true});
     await verifyVersion(staged,version);
     await rename(staged,installed);newVersion=true;
    }
    await localDirectory(paths,path.dirname(paths.launcher));
    await atomic(paths.launcher,launcher,{mode:0o755});changed=true;
    await saveJson(paths.installation,receipt);receiptChanged=true;
    if(registered)await startLaunchAgent(paths);
   }catch(error){
    const failures=[];
    const recover=async action=>{try{await action();}catch{failures.push(true);}};
    if(changed)await recover(()=>old.bytes?atomic(paths.launcher,old.bytes,{mode:0o755}):rm(paths.launcher,{force:true}));
    if(receiptChanged)await recover(()=>old.receipt?saveJson(paths.installation,old.receipt):rm(paths.installation,{force:true}));
    if(registered)await recover(()=>rollbackLaunchAgent(paths,{existed,registered}));
    if(newVersion)await recover(()=>rm(installed,{recursive:true,force:true}));
    if(failures.length)throw Error(error.message+' Some beta bindings need inspection with mosaic doctor.');
    throw error;
   }finally{await rm(staged,{recursive:true,force:true});}
  }
  if(!noPath){
   try{receipt=await applyPath(paths,receipt);await saveJson(paths.installation,receipt);}
   catch(error){process.stderr.write('PATH unchanged or needs inspection. '+error.message+'\n');}
  }
  process.stdout.write(`Mosaic Beta ${version} installed.\nRun ${shellQuote(paths.launcher)} setup\n`);
 });
}

export async function uninstall(paths){
 return withLock(paths,async()=>{
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
