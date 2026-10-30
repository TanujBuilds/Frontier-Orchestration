#!/usr/bin/env node
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2);let config={};
try{config=JSON.parse(await readFile(process.env.FRONTIER_HARNESS_CONFIG??path.join(directory,'local-config.json'),'utf8'));}catch(error){if(error.code!=='ENOENT'||process.env.FRONTIER_HARNESS_CONFIG)throw error;}
let runtime=config.runtimeRoot;
if(runtime&&!path.isAbsolute(runtime))throw Error('Private runtimeRoot must be absolute');
if(!runtime){for(const candidate of [path.join(directory,'runtime'),path.resolve(directory,'../../runtime')]){try{await access(path.join(candidate,'src/harness/cli.mjs'));runtime=candidate;break;}catch{}}
 // Source-only compatibility. Installed bundles never fall back to a checkout.
 if(!runtime&&path.basename(directory)==='frontier-harness'&&path.basename(path.dirname(directory))==='skills'&&path.basename(path.resolve(directory,'../..'))==='.agents'){
  const candidate=path.resolve(directory,'../../..');try{await access(path.join(candidate,'.git'));await access(path.join(candidate,'src/harness/cli.mjs'));runtime=candidate;}catch{}
 }
}
if(!runtime)throw Error('Shared packaged runtime unavailable; preserve configuration and install a complete version bundle');
if(!args.includes('--root')&&!args.includes('--help')&&args.length){if(!config.dataDir)throw Error('Provide --root STATE_DIR or configure private local-config.json dataDir');args.push('--root',config.dataDir);}
const {main}=await import(pathToFileURL(path.join(runtime,'src/harness/cli.mjs')).href);await main(args);
