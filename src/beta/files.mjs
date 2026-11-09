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
  await writeFile(tmp,bytes,{flag:'wx',mode});
  await rename(tmp,file);
 }finally{await rm(tmp,{force:true});}
}

export const saveJson=(file,value)=>atomic(file,JSON.stringify(value,null,2)+'\n');

export async function privateDirectories(paths){
 for(const directory of [paths.root,paths.configDir,paths.state,paths.versions]){
  await mkdir(directory,{recursive:true,mode:0o700});
  const info=await lstat(directory);
  if(!info.isDirectory()||info.mode&0o077||info.uid!==process.getuid()||await realpath(directory)!==path.join(await realpath(paths.home),path.relative(paths.home,directory)))
   throw Error('Use an owned private directory (0700) at '+directory);
 }
}

export async function withLock(paths,work){
 await privateDirectories(paths);
 const lock=path.join(paths.configDir,'maintenance.lock');
 let handle;
 try{handle=await open(lock,'wx',0o600);}catch(error){
  if(error.code!=='EEXIST')throw error;
  throw Error('Mosaic Beta maintenance is locked. If all setup/install/uninstall commands have exited, remove '+lock+' and retry.');
 }
 try{await handle.writeFile(String(process.pid)+'\n');return await work();}
 finally{await handle.close();await rm(lock,{force:true});}
}
