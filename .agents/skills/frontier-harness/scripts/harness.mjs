#!/usr/bin/env node
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2);let config={};
try{config=JSON.parse(await readFile(path.join(directory,'local-config.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
let runtime=config.runtimeRoot??path.join(directory,'runtime');try{await access(path.join(runtime,'src/harness/cli.mjs'));}catch{runtime=path.resolve(directory,'../../..');}
if(!args.includes('--root')&&!args.includes('--help')&&args.length){if(!config.dataDir)throw Error('Provide --root STATE_DIR or configure private local-config.json dataDir');args.push('--root',config.dataDir);}
const {main}=await import(pathToFileURL(path.join(runtime,'src/harness/cli.mjs')).href);await main(args);
