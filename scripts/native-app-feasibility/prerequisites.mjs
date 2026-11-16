import {lstat,realpath,readFile,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

export const sourceRoot=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function parseArgs(argv){
  const result={};
  const names={'--output':'output','--inspect':'inspect','--postgres-bin-dir':'postgresBinDir','--require-native':'requireNative','--require-browser':'requireBrowser'};
  for(let i=0;i<argv.length;i++){
    const key=names[argv[i]];if(!key||Object.hasOwn(result,key))throw Error('Unknown or duplicate option');
    if(key.startsWith('require'))result[key]=true;
    else {const value=argv[++i];if(!value||value.startsWith('--'))throw Error('Option requires a value');result[key]=value;}
  }
  if(Boolean(result.output)===Boolean(result.inspect)||result.inspect&&Object.keys(result).length!==1)throw Error('Use --output NEW_ROOT or --inspect EXISTING_ROOT');
  return result;
}
export function rejectGitOverrides(env=process.env){
  if(Object.keys(env).some(key=>key.startsWith('GIT_')&&key!=='GIT_PAGER'))throw Error('Clear Git override environment before qualification');
}
export async function safePath(value,{directory=true}={}){
  if(typeof value!=='string'||!path.isAbsolute(value)||path.normalize(value)!==value||value==='/'||value.length>3000||/[\x00-\x1f\x7f\\]/.test(value))throw Error('Expected a safe canonical absolute path');
  let cursor=value;
  for(;;){const s=await lstat(cursor);if(s.isSymbolicLink())throw Error('Symlink path is unsafe');if(cursor===value&&!(directory?s.isDirectory():s.isFile()))throw Error('Unexpected path type');if(cursor===path.dirname(cursor))break;cursor=path.dirname(cursor);}
  if(await realpath(value)!==value)throw Error('Aliased path is unsafe');return value;
}
export async function validateOutput(value,env=process.env){
  rejectGitOverrides(env);
  if(typeof value!=='string'||!path.isAbsolute(value)||path.normalize(value)!==value||value==='/'||/[\x00-\x1f\x7f\\]/.test(value))throw Error('Unsafe output path');
  const parent=await safePath(path.dirname(value));
  const s=await lstat(parent);if(s.uid!==process.getuid?.()||s.mode&0o022)throw Error('Output parent must be owned and private against other writers');
  try{await lstat(value);}catch(e){if(e.code==='ENOENT')return value;throw e;}
  throw Error('Output root already exists; choose a new root');
}
export function command(argv,{cwd=sourceRoot,timeout=5000,env}={}){
  const r=spawnSync(argv[0],argv.slice(1),{cwd,encoding:'utf8',timeout,maxBuffer:65536,env:env??{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C',HOME:cwd}});
  return {argv,code:r.status,signal:r.signal,errorCode:r.error?.code??null,stdout:(r.stdout??'').slice(0,8192),stderr:(r.stderr??'').slice(0,8192)};
}
export async function fileIdentity(file){
  const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>512*1024*1024)throw Error('Expected bounded regular input');
  return {path:file,bytes:s.size,mode:s.mode&0o777,sha256:hash(await readFile(file))};
}
export async function sourceInventory(){
  rejectGitOverrides();
  const run=(...args)=>{const r=command(['git',...args]);if(r.code!==0)throw Error('Cannot inventory source Git tree');return r.stdout.trim();};
  // ls-files can exceed the deliberately small general command output bound.
  const listed=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:sourceRoot,encoding:'utf8',maxBuffer:2*1024*1024});
  if(listed.status!==0)throw Error('Cannot list source');
  const files=[];for(const relative of [...new Set(listed.stdout.split('\0').filter(Boolean))].sort()){
    await safePath(path.join(sourceRoot,relative),{directory:false});
    const identity=await fileIdentity(path.join(sourceRoot,relative));files.push({...identity,path:relative});
  }
  return {commit:run('rev-parse','HEAD'),tree:run('rev-parse','HEAD^{tree}'),dirty:run('status','--porcelain'),files,sha256:hash(JSON.stringify(files))};
}
export async function inventoryPostgres(explicit,env=process.env){
  if(explicit!==undefined)await safePath(explicit);
  const names=['initdb','pg_ctl','psql','postgres','pg_config'],commands={},missing=[];
  for(const name of names){
    let selected;
    for(const dir of explicit?[explicit]:(env.PATH??'').split(path.delimiter).filter(p=>path.isAbsolute(p))){
      try{const file=path.join(dir,name);await access(file,constants.X_OK);const resolved=await realpath(file);await safePath(resolved,{directory:false});selected=resolved;break;}catch(e){if(!['ENOENT','ENOTDIR','EACCES'].includes(e.code)&&explicit)throw e;}
    }
    if(!selected){missing.push(name);commands[name]=null;continue;}
    commands[name]={...await fileIdentity(selected),version:command([selected,'--version'])};
  }
  return {supplied:explicit!==undefined,directory:explicit??null,commands,missing,executionProven:false};
}
