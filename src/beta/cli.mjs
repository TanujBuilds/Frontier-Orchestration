import {isEntry} from '../harness/entry.mjs';
import {startMcp} from '../harness/mcp.mjs';
import path from 'node:path';
import {currentHome,locations} from './files.mjs';
import {client} from './client.mjs';
import {readSettings,setup,doctor} from './setup.mjs';
import {serveBeta} from './service.mjs';
import {runObserver} from './observer.mjs';
import {installedLauncher,uninstall,verifyVersion} from './install.mjs';

const help=`Mosaic Beta

mosaic                   Open setup or the read-only terminal observer
mosaic setup             Configure Codex and an optional API worker
mosaic doctor            Check installation, Codex, MCP and provider discovery
mosaic status --once     Print saved status and recent handoffs once
mosaic mcp               Start the authenticated Codex MCP stdio bridge
mosaic serve             Run the coordinator in the foreground (fixture or troubleshooting)
mosaic uninstall         Remove owned beta bindings and retain evidence
mosaic --help            Show these commands
`;

export async function main(args=process.argv.slice(2)){
 let home;
 if(args[0]==='--home'){args.shift();home=args.shift();if(!home)throw Error('Provide an absolute fixture home');}
 if(args.includes('--help')||args[0]==='help'){process.stdout.write(help);return;}
 const paths=locations(home??currentHome(),!!home),command=args.shift();
 if(command==='setup'||!command){
  let explicitCodex;
  if(args.length===2&&args[0]==='--codex'){args.shift();explicitCodex=args.shift();}
  if(args.length)throw Error('Use mosaic setup [--codex /absolute/path/to/codex]');
  if(command==='setup'||!await readSettings(paths)){
   if(!await setup(paths,{explicitCodex}))process.exitCode=1;
   return;
  }
 }
 if(command==='status'||!command){
  if(args.length&&!(args.length===1&&args[0]==='--once'))throw Error('Use mosaic status [--once]');
  return runObserver({invoke:client(paths,{viewer:true}),once:args.includes('--once')});
 }
 if(args.length)throw Error('Use mosaic --help for command syntax');
 if(command==='doctor'){
  let valid=false;
  try{
   const {receipt,bytes}=await installedLauncher(paths);
   if(bytes){const manifest=await verifyVersion(path.join(paths.versions,receipt.version),receipt.version);valid=manifest.contentHash===receipt.contentHash;}
  }catch{}
  process.stdout.write(valid?'OK  Package integrity · installed version verified.\n':'CHECK  Package integrity · reinstall Mosaic Beta from a verified archive.\n');
  if(!await doctor(paths)||!valid)process.exitCode=1;
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
