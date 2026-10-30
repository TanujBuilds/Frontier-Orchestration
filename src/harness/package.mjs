import {mkdir,readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isEntry} from './entry.mjs';
import {command,git} from '../project/process.mjs';
import {digest} from './contracts.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const SKILLS=['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only'];
const privateEntry=name=>['local-config.json','connection.json','node_modules','runtime','.data','.git','__pycache__'].includes(name)||/\.(?:sqlite(?:-wal|-shm)?|db|pyc)$/.test(name);
const reviewedSkillFile=file=>file==='SKILL.md'||file==='agents/openai.yaml'||file==='scripts/harness.mjs'||/^references\/[\w/-]+\.md$/.test(file)||/^roles\/(?:implementer|explorer|reviewer)\.toml$/.test(file)||/^examples\/(?:local-config|provider-config)\.json$/.test(file);
async function files(root,prefix='',portableSkill=false){const result=[];if((await lstat(path.join(root,prefix))).isSymbolicLink())throw Error('Package source symlinks are unsupported');for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})){if(portableSkill&&privateEntry(entry.name)&&!(prefix==='examples'&&entry.name==='local-config.json'))continue;const file=path.join(prefix,entry.name);if(entry.isSymbolicLink())throw Error('Package source symlinks are unsupported');if(entry.isDirectory())result.push(...await files(root,file,portableSkill));else if(entry.isFile())result.push(file);else throw Error('Package sources must be regular files');}return result;}
export async function packageHarness({sourceRoot,destination,dependencies=false,offline=false}){
 sourceRoot=path.resolve(sourceRoot);destination=path.resolve(destination);await mkdir(path.dirname(destination),{recursive:true});
 try{await mkdir(destination,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw Error('Package destination already exists; preserve it and select a new version directory');throw error;}
 const inventory=[];
 const copy=async(source,target,transform)=>{if(!(await lstat(source)).isFile())throw Error('Package sources must be regular files');let data=await readFile(source);if(transform)data=Buffer.from(transform(data.toString('utf8')));await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,data,{mode:0o600});inventory.push({path:path.relative(destination,target).split(path.sep).join('/'),sha256:hash(data),bytes:data.length});};
 for(const name of SKILLS){const skill=path.join(sourceRoot,'.agents/skills',name);for(const file of (await files(skill,'',true)).filter(reviewedSkillFile)){
  await copy(path.join(skill,file),path.join(destination,'skills',name,file));
  // Retain the old top-level primary skill and launcher without another runtime.
  if(name==='frontier-harness')await copy(path.join(skill,file),path.join(destination,file),file==='SKILL.md'?text=>text.replaceAll('](../frontier-','](skills/frontier-'):undefined);
 }}
 for(const file of await files(path.join(sourceRoot,'src')))await copy(path.join(sourceRoot,'src',file),path.join(destination,'runtime/src',file));
 for(const file of ['package.json','package-lock.json'])await copy(path.join(sourceRoot,file),path.join(destination,'runtime',file));
 const research='.agents/skills/deep-research';for(const file of await files(path.join(sourceRoot,research,'scripts')))if(file.endsWith('.py'))await copy(path.join(sourceRoot,research,'scripts',file),path.join(destination,'runtime',research,'scripts',file));
 for(const file of ['requirements.txt','requirements.lock'])await copy(path.join(sourceRoot,research,file),path.join(destination,'runtime',research,file));
 if(dependencies){const result=await command(['npm','ci','--omit=dev','--ignore-scripts','--bin-links=false','--no-audit','--no-fund',...(offline?['--offline']:[])],{cwd:path.join(destination,'runtime')});if(result.code!==0)throw Error('Pinned runtime dependency installation failed: '+result.stderr.slice(-2000));
  const modules=path.join(destination,'runtime/node_modules');for(const file of await files(modules)){const data=await readFile(path.join(modules,file));inventory.push({path:'runtime/node_modules/'+file.split(path.sep).join('/'),sha256:hash(data),bytes:data.length});}
 }
 const manifest={schema:1,layout:'shared-runtime-v1',skills:SKILLS,sourceCommit:await git(sourceRoot,'rev-parse','HEAD'),sourceDirty:!!await git(sourceRoot,'status','--porcelain'),nodeMajor:24,sdkVersion:'1.32.2',dependenciesInstalled:dependencies,files:inventory.sort((a,b)=>a.path.localeCompare(b.path))};manifest.contentHash=digest(manifest.files);await writeFile(path.join(destination,'package-manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});return manifest;
}
export async function verifyPackage(destination){
 destination=path.resolve(destination);
 const rootInfo=await lstat(destination),manifestInfo=await lstat(path.join(destination,'package-manifest.json'));if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||!manifestInfo.isFile()||manifestInfo.isSymbolicLink())throw Error('Package and manifest must be regular entries, not symlinks');
 const manifest=JSON.parse(await readFile(path.join(destination,'package-manifest.json'),'utf8'));if(!manifest||manifest.schema!==1||!Array.isArray(manifest.files)||!manifest.files.length||typeof manifest.dependenciesInstalled!=='boolean')throw Error('Invalid package manifest');if(manifest.contentHash!==digest(manifest.files))throw Error('Package manifest checksum mismatch');
 const seen=new Set();
 for(const file of manifest.files){if(!file||typeof file.path!=='string'||path.isAbsolute(file.path)||file.path.includes('\\')||file.path.split('/').some(p=>p==='..'||p==='.'||!p)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid package path or file metadata');if(seen.has(file.path))throw Error('Duplicate package path');seen.add(file.path);
  let target=destination;for(const part of file.path.split('/')){const info=await lstat(target);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Package parent must be a regular directory, not a symlink');target=path.join(target,part);}
  const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||info.size!==file.bytes||hash(await readFile(target))!==file.sha256)throw Error('Package file checksum mismatch: '+file.path);
 }
 const directories=new Set(['']);for(const file of seen){let parent=path.posix.dirname(file);while(parent!=='.'){directories.add(parent);parent=path.posix.dirname(parent);}}
 const inspect=async(prefix='')=>{for(const entry of await readdir(path.join(destination,prefix),{withFileTypes:true})){const relative=prefix?prefix+'/'+entry.name:entry.name;if(entry.isSymbolicLink())throw Error('Unexpected package symlink: '+relative);if(entry.isDirectory()){if(!directories.has(relative))throw Error('Unlisted package directory: '+relative);await inspect(relative);}else if(!entry.isFile()||relative!=='package-manifest.json'&&!seen.has(relative))throw Error('Unlisted or nonregular package entry: '+relative);}};
 await inspect();
 if(manifest.dependenciesInstalled){const lock=JSON.parse(await readFile(path.join(destination,'runtime/package-lock.json'),'utf8')),sdk=JSON.parse(await readFile(path.join(destination,'runtime/node_modules/@modelcontextprotocol/sdk/package.json'),'utf8'));if(sdk.version!==lock.packages['node_modules/@modelcontextprotocol/sdk'].version)throw Error('Pinned runtime dependency mismatch');}
 return true;
}
export function renderLaunchAgent({node,entry,root,config,port=4332,logs}){
 for(const value of [node,entry,root,config,logs])if(!path.isAbsolute(value))throw Error('Deployment paths must be absolute');if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid service port');
 const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;'),argv=[node,entry,'serve','--root',root,'--config',config,'--port',String(port)];
 return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.frontier.harness</string><key>ProgramArguments</key><array>${argv.map(x=>'<string>'+escape(x)+'</string>').join('')}</array><key>WorkingDirectory</key><string>${escape(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>30</integer><key>StandardOutPath</key><string>${escape(path.join(logs,'coordinator.log'))}</string><key>StandardErrorPath</key><string>${escape(path.join(logs,'coordinator-error.log'))}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(path.dirname(node)+':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')}</string></dict></dict></plist>\n`;
}
async function main(){const args=process.argv.slice(2),options={};while(args.length){const flag=args.shift();if(['--dependencies','--offline'].includes(flag))options[flag.slice(2)]=true;else if(['--source-root','--destination'].includes(flag)&&args.length)options[flag==='--source-root'?'sourceRoot':'destination']=args.shift();else throw Error('Use --source-root REPO --destination NEW_DIRECTORY [--dependencies] [--offline]');}if(!options.sourceRoot||!options.destination)throw Error('Source and destination required');const manifest=await packageHarness(options);console.log(JSON.stringify({destination:options.destination,contentHash:manifest.contentHash,files:manifest.files.length,dependenciesInstalled:manifest.dependenciesInstalled}));}
if(isEntry(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
