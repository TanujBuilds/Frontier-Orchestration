import {mkdir,readFile,writeFile,copyFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isEntry} from './entry.mjs';
import {command,git} from '../project/process.mjs';
import {digest} from './contracts.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function files(root,prefix=''){const result=[];for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})){const file=path.join(prefix,entry.name);if(entry.isSymbolicLink())throw Error('Package source symlinks are unsupported');if(entry.isDirectory())result.push(...await files(root,file));else result.push(file);}return result;}
export async function packageHarness({sourceRoot,destination,dependencies=false,offline=false}){
 sourceRoot=path.resolve(sourceRoot);destination=path.resolve(destination);await mkdir(path.dirname(destination),{recursive:true});
 try{await mkdir(destination,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw Error('Package destination already exists; preserve it and select a new version directory');throw error;}
 const inventory=[];
 const copy=async(source,target)=>{const data=await readFile(source);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,data,{mode:0o600});inventory.push({path:path.relative(destination,target).split(path.sep).join('/'),sha256:hash(data),bytes:data.length});};
 const skill=path.join(sourceRoot,'.agents/skills/frontier-harness');for(const file of await files(skill))if(file!=='local-config.json'&&!file.startsWith('runtime/'))await copy(path.join(skill,file),path.join(destination,file));
 for(const file of await files(path.join(sourceRoot,'src')))await copy(path.join(sourceRoot,'src',file),path.join(destination,'runtime/src',file));
 for(const file of ['package.json','package-lock.json'])await copy(path.join(sourceRoot,file),path.join(destination,'runtime',file));
 const research='.agents/skills/deep-research';for(const file of await files(path.join(sourceRoot,research,'scripts')))if(file.endsWith('.py'))await copy(path.join(sourceRoot,research,'scripts',file),path.join(destination,'runtime',research,'scripts',file));
 for(const file of ['requirements.txt','requirements.lock'])await copy(path.join(sourceRoot,research,file),path.join(destination,'runtime',research,file));
 if(dependencies){const result=await command(['npm','ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund',...(offline?['--offline']:[])],{cwd:path.join(destination,'runtime')});if(result.code!==0)throw Error('Pinned runtime dependency installation failed: '+result.stderr.slice(-2000));}
 const manifest={schema:1,sourceCommit:await git(sourceRoot,'rev-parse','HEAD'),sourceDirty:!!await git(sourceRoot,'status','--porcelain'),nodeMajor:24,sdkVersion:'1.32.2',dependenciesInstalled:dependencies,files:inventory.sort((a,b)=>a.path.localeCompare(b.path))};manifest.contentHash=digest(manifest.files);await writeFile(path.join(destination,'package-manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});return manifest;
}
export async function verifyPackage(destination){
 const manifest=JSON.parse(await readFile(path.join(destination,'package-manifest.json'),'utf8'));if(manifest.contentHash!==digest(manifest.files))throw Error('Package manifest checksum mismatch');
 for(const file of manifest.files){if(path.isAbsolute(file.path)||file.path.split('/').some(p=>p==='..'||!p))throw Error('Invalid package path');const target=path.join(destination,file.path),info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||hash(await readFile(target))!==file.sha256)throw Error('Package file checksum mismatch: '+file.path);}
 return true;
}
export function renderLaunchAgent({node,entry,root,config,port=4332,logs}){
 for(const value of [node,entry,root,config,logs])if(!path.isAbsolute(value))throw Error('Deployment paths must be absolute');if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid service port');
 const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;'),argv=[node,entry,'serve','--root',root,'--config',config,'--port',String(port)];
 return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.frontier.harness</string><key>ProgramArguments</key><array>${argv.map(x=>'<string>'+escape(x)+'</string>').join('')}</array><key>WorkingDirectory</key><string>${escape(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>30</integer><key>StandardOutPath</key><string>${escape(path.join(logs,'coordinator.log'))}</string><key>StandardErrorPath</key><string>${escape(path.join(logs,'coordinator-error.log'))}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(path.dirname(node)+':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')}</string></dict></dict></plist>\n`;
}
async function main(){const args=process.argv.slice(2),options={};while(args.length){const flag=args.shift();if(['--dependencies','--offline'].includes(flag))options[flag.slice(2)]=true;else if(['--source-root','--destination'].includes(flag)&&args.length)options[flag==='--source-root'?'sourceRoot':'destination']=args.shift();else throw Error('Use --source-root REPO --destination NEW_DIRECTORY [--dependencies] [--offline]');}if(!options.sourceRoot||!options.destination)throw Error('Source and destination required');const manifest=await packageHarness(options);console.log(JSON.stringify({destination:options.destination,contentHash:manifest.contentHash,files:manifest.files.length,dependenciesInstalled:manifest.dependenciesInstalled}));}
if(isEntry(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
