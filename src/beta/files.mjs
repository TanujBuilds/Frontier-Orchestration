import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {lstat,mkdir,open,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const label='com.mosaic.beta';
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const shellQuote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
export const currentHome=()=>os.homedir();

export function locations(home,isolated=false){
 if(!path.isAbsolute(home)||/[\x00-\x1f]/u.test(home))throw Error('Home must be an absolute local directory');
 const root=path.join(home,'Library','Application Support','Mosaic Beta');
 const configDir=path.join(root,'config');
 const codexHome=!isolated&&process.env.CODEX_HOME?path.resolve(process.env.CODEX_HOME):path.join(home,'.codex');
 return {home,root,isolated,codexHome,configDir,versions:path.join(root,'versions'),state:path.join(root,'state'),
  launcher:path.join(home,'.local','bin','mosaic'),config:path.join(configDir,'settings.json'),
  ownership:path.join(configDir,'bindings.json'),installation:path.join(configDir,'installation.json'),
  setupIntent:path.join(configDir,'setup-intent.json'),isolatedMcp:path.join(configDir,'isolated-mcp.json'),
  plist:path.join(home,'Library','LaunchAgents',label+'.plist'),
  skill:path.join(codexHome,'skills','mosaic-beta','SKILL.md'),zshrc:path.join(home,'.zshrc')};
}

export async function entry(file){
 try{return await lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}

export async function fileBytes(file,{max=1024*1024,privateFile=false}={}){
 const info=await entry(file);
 if(!info)return null;
 if(!info.isFile()||info.size>max||privateFile&&(info.mode&0o077))throw Error('Unsafe file permissions or type at '+file);
 return readFile(file);
}

export async function jsonFile(file,options){
 const data=await fileBytes(file,options);
 if(!data)return null;
 try{return JSON.parse(data);}catch{throw Error('Invalid JSON file at '+file);}
}

export async function atomic(file,bytes,{mode=0o600}={}){
 const tmp=path.join(path.dirname(file),'.mosaic-beta-'+randomUUID());
 try{
  await writeFile(tmp,bytes,{flag:'wx',mode,flush:true});
  await rename(tmp,file);
 }finally{await rm(tmp,{force:true});}
}

export const saveJson=(file,value)=>atomic(file,JSON.stringify(value,null,2)+'\n');

export async function localDirectory(paths,directory,{create=true}={}){
 if(!paths.isolated){
  if(create)await mkdir(directory,{recursive:true,mode:0o700});
  return;
 }
 const parts=path.relative(paths.home,directory).split(path.sep);
 if(parts[0]==='..'||path.isAbsolute(parts.join(path.sep)))throw Error('Fixture paths must stay within the isolated home');
 if(create)await mkdir(paths.home,{recursive:true,mode:0o700});
 let current=paths.home;
 for(const part of ['',...parts.filter(Boolean)]){
  current=path.join(current,part);
  if(part&&create)await mkdir(current,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const info=await entry(current);
  if(!info&&!create)return;
  if(!info?.isDirectory())throw Error('Unsafe directory in isolated fixture at '+current);
 }
}

export async function privateDirectories(paths){
 for(const directory of [paths.root,paths.configDir,paths.state,paths.versions]){
  await localDirectory(paths,directory);
  const info=await lstat(directory);
  if(!info.isDirectory()||info.mode&0o077||info.uid!==process.getuid()||await realpath(directory)!==path.join(await realpath(paths.home),path.relative(paths.home,directory)))
   throw Error('Use an owned private directory (0700) at '+directory);
 }
}

export async function withLock(paths,work){
 await privateDirectories(paths);
 const file=path.join(paths.configDir,'maintenance.sqlite3');
 try{const handle=await open(file,'wx',0o600);await handle.close();}
 catch(error){if(error.code!=='EEXIST')throw error;}
 const info=await lstat(file);
 if(!info.isFile()||info.mode&0o077||info.uid!==process.getuid())throw Error('Unsafe Mosaic Beta maintenance lock');
 const lock=new DatabaseSync(file);
 try{
  // SQLite releases the operating-system lock when a process exits, including SIGKILL.
  try{lock.exec('BEGIN IMMEDIATE');}
  catch(error){if(error.errcode!==5)throw error;throw Error('Another Mosaic Beta maintenance command is running. Retry when it finishes.');}
  return await work();
 }finally{lock.close();}
}
