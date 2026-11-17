import {rm} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {previewSettingsMigration,applySettingsMigration,resumeSettingsMigration,normalizeSettings} from './settings.mjs';
import {isEntry} from '../harness/entry.mjs';
import {startMcp} from '../harness/mcp.mjs';
import path from 'node:path';
import {currentHome,locations,jsonFile,saveJson,withLock} from './files.mjs';
import {client} from './client.mjs';
import {readSettings,setup,setupComplete,doctor,previewHostRegistration} from './setup.mjs';
import {serveBeta} from './service.mjs';
import {runObserver} from './observer.mjs';
import {observerClient} from './sources.mjs';
import {installedLauncher,uninstall,verifyVersion} from './install.mjs';

const help=`Mosaic Beta

mosaic                   Open setup or the read-only terminal observer
mosaic setup             Configure the selected host, worker profiles and review
mosaic doctor [--providers]  Check setup; optionally GET worker model lists (no inference)
mosaic migrate           Preview lossless schema1 migration; ask before applying
mosaic off               Stop new dispatch; retain running owners and saved work
mosaic on                Allow dispatch with the same approved configuration
mosaic rollback VERSION  Switch to a compatible retained version
mosaic recover           Resume an interrupted installation
mosaic status --once     Print saved status and recent handoffs once
mosaic --source core     Watch the existing frontier-harness installation
mosaic --source beta     Watch only the separate beta installation
mosaic host-preview --host ID  Preview a manual host registration; writes nothing
mosaic mcp               Start the authenticated host MCP stdio bridge
mosaic serve             Run the coordinator in the foreground (fixture or troubleshooting)
mosaic uninstall         Remove owned beta bindings and retain evidence
mosaic --help            Show these commands
`;

export async function main(args=process.argv.slice(2)){
 let home;
 if(args[0]==='--home'){args.shift();home=args.shift();if(!home)throw Error('Provide an absolute fixture home');}
 if(args.includes('--help')||args[0]==='help'){process.stdout.write(help);return;}
 let source='auto';
 const sourceIndex=args.indexOf('--source');
 if(sourceIndex!==-1){
  source=args[sourceIndex+1];
  if(!['auto','beta','core'].includes(source))throw Error('Observer source must be auto, beta or core');
  args.splice(sourceIndex,2);
 }
 const paths=locations(home??currentHome(),!!home),command=args.shift();
 if(sourceIndex!==-1&&command&&command!=='status')throw Error('--source is only supported by the terminal observer and status');
 if(command==='host-preview'){
  if(args.length!==2||args[0]!=='--host')throw Error('Use mosaic host-preview --host codex|claude-code|cursor|antigravity');
  process.stdout.write(JSON.stringify(previewHostRegistration(paths,args[1]),null,2)+'\n');return;
 }
 if(command==='setup'||!command&&sourceIndex===-1){
  let explicitCodex,settings;
  if(args.length===2&&args[0]==='--config'){args.shift();const file=args.shift();if(!path.isAbsolute(file))throw Error('Setup config must be an absolute private JSON path');settings=await jsonFile(file,{privateFile:true});if(normalizeSettings(settings).schema!==2)throw Error('Use migrate for schema1 settings');}
  if(args.length===2&&args[0]==='--codex'){args.shift();explicitCodex=args.shift();}
  if(args.length)throw Error('Use mosaic setup [--codex /absolute/path/to/codex]');
  if(command==='setup'||!await readSettings(paths)||!await setupComplete(paths)){
   if(!await setup(paths,{explicitCodex,settings}))process.exitCode=1;
   return;
  }
 }
 if(command==='status'||!command){
  if(args.length&&!(args.length===1&&args[0]==='--once'))throw Error('Use mosaic status [--once]');
  return runObserver({invoke:observerClient(paths,{source}),once:args.includes('--once')});
 }
 if(command==='rollback'){if(args.length!==1)throw Error('Use mosaic rollback VERSION');return (await import('./install.mjs')).rollbackVersion(paths,args[0]);}
 let providerDiagnostics=false;
 if(command==='doctor'){if(args.length>1||args.length===1&&args[0]!=='--providers')throw Error('Use mosaic doctor [--providers]');providerDiagnostics=args.shift()==='--providers';}
 if(args.length)throw Error('Use mosaic --help for command syntax');
 if(command==='recover')return (await import('./install.mjs')).recoverInstallation(paths);
 if(command==='off'||command==='on'){return withLock(paths,async()=>{if(command==='off'){await saveJson(paths.disabled,{schema:1,disabled:true});process.stdout.write('Mosaic is off. New dispatch is blocked; running owners and saved work are retained.\n');}else{await rm(paths.disabled,{force:true});process.stdout.write('Mosaic is on. Existing approval and execution guards still apply.\n');}});}
 if(command==='migrate'){if(await resumeSettingsMigration(paths)){process.stdout.write('Resumed approved settings migration.\n');return;}const preview=await previewSettingsMigration(paths);process.stdout.write(JSON.stringify(preview,null,2)+'\n');const rl=createInterface({input:process.stdin,output:process.stdout});let approved;try{approved=await rl.question('Apply this exact lossless migration? [y/N] ');}finally{rl.close();}if(/^y(es)?$/i.test(approved.trim())){await applySettingsMigration(paths,preview);process.stdout.write('Migration saved; refresh setup to configure portable bindings.\n');}return;}
 if(command==='doctor'){
  let valid=false;
  try{
   const {receipt,bytes}=await installedLauncher(paths);
   if(bytes){const manifest=await verifyVersion(path.join(paths.versions,receipt.version),receipt.version);valid=manifest.contentHash===receipt.contentHash;}
  }catch{}
  process.stdout.write(valid?'OK  Package integrity · installed version verified.\n':'CHECK  Package integrity · reinstall Mosaic Beta from a verified archive.\n');
  if(!await doctor(paths,process.stdout,{providers:providerDiagnostics})||!valid)process.exitCode=1;
  return;
 }
 if(command==='serve')return serveBeta(paths,await readSettings(paths));
 if(command==='mcp'){
  const invoke=client(paths),tools=(await invoke('tools_list')).filter(tool=>tool.name!=='service_stop');
  return startMcp({name:'mosaic-beta',invoke,tools});
 }
 if(command==='uninstall')return uninstall(paths);
 throw Error('Unknown Mosaic Beta command. Run mosaic --help.');
}

if(isEntry(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
