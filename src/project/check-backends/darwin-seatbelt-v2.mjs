import {readFileSync,lstatSync,realpathSync,readdirSync,readlinkSync,openSync,closeSync,readSync,fstatSync,constants} from 'node:fs';
import {mkdir,writeFile,readFile,rm,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {Pause,digest,relativePath,secretPath} from '../contracts.mjs';
import {validateExecution} from './contracts.mjs';
import {compileDarwinSeatbeltPolicy} from './darwin-seatbelt.mjs';
import {executeSupervised} from './native-supervisor.mjs';
const isolation=m=>new Pause(m,'isolation');
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const within=(root,file)=>file===root||file.startsWith(root+path.sep);
const keys=(v,names)=>record(v)&&Object.keys(v).length===names.length&&names.every(n=>Object.hasOwn(v,n));
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function canonical(file,{directory=false}={}){
 if(typeof file!=='string'||!path.isAbsolute(file)||path.normalize(file)!==file||/[\x00-\x1f\x7f\\]/.test(file))throw isolation('Native artifact requires canonical absolute paths');
 let stat;try{stat=lstatSync(file);if(stat.isSymbolicLink()||realpathSync(file)!==file||!(directory?stat.isDirectory():stat.isFile()))throw Error('alias');}catch{throw isolation('Native artifact path is missing, nonregular or aliased: '+file);}return stat;
}
function artifactDirectory(root){
 for(let current=root;;current=path.dirname(current)){
  const stat=canonical(current,{directory:true}),owner=process.getuid();
  if(stat.uid!==owner&&stat.uid!==0||current===root&&stat.uid!==owner)throw isolation('Native artifact directory has an untrusted owner');
  const protectedStickyParent=current!==root&&stat.uid===0&&(stat.mode&0o1000)!==0;
  if((stat.mode&0o022)!==0&&!protectedStickyParent)throw isolation('Native artifact directory or ancestor is group/world writable');
  if(current===path.dirname(current))return;
 }
}
function implementationHash(){return digest(['native-supervisor.c','native-supervisor.mjs','darwin-seatbelt-v2.mjs','darwin-seatbelt.mjs','contracts.mjs','../sandbox.mjs'].map(file=>({file,hash:digest(readFileSync(fileURLToPath(new URL(file,import.meta.url))))})));}
export function validateNativeCheckRuntime(config,expectedFingerprint){
 if(process.platform!=='darwin'||process.arch!=='arm64')throw isolation('Native revision 2 requires Darwin arm64');
 if(!keys(config,['schema','artifactManifestPath','artifactManifestSha256'])||config.schema!==1||!hex(config.artifactManifestSha256)||expectedFingerprint!==undefined&&expectedFingerprint!==config.artifactManifestSha256)throw isolation('Native runtime configuration or approved runtime fingerprint differs');
 const manifestPath=config.artifactManifestPath,stat=canonical(manifestPath),root=path.dirname(manifestPath);artifactDirectory(root);
 if(path.basename(manifestPath)!=='artifact-manifest.json'||root==='/'||secretPath(root)||stat.size>128*1024||(stat.mode&0o022)!==0||stat.uid!==process.getuid())throw isolation('Native artifact manifest is not safely owned outside credential roots');
 const bytes=readFileSync(manifestPath);if(digest(bytes)!==config.artifactManifestSha256)throw isolation('Native artifact manifest bytes changed');
 let manifest;try{manifest=JSON.parse(bytes);}catch{throw isolation('Native artifact manifest is not JSON');}
 if(!keys(manifest,['schema','platform','arch','nodeVersion','supervisorProtocol','files','provenance'])||manifest.schema!==1||manifest.platform!=='darwin'||manifest.arch!=='arm64'||manifest.nodeVersion!=='24.22.0'||manifest.supervisorProtocol!==1||!Array.isArray(manifest.files)||manifest.files.length!==3)throw isolation('Unsupported native artifact manifest');
 const provenance=manifest.provenance;
 if(!keys(provenance,['nodeSource','nodePatch','supervisorSourceSha256','build'])||!keys(provenance.nodeSource,['version','url','sha256'])||provenance.nodeSource.version!=='24.22.0'||provenance.nodeSource.url!=='https://nodejs.org/dist/v24.22.0/node-v24.22.0.tar.xz'||!hex(provenance.nodeSource.sha256)||!keys(provenance.nodePatch,['sha256','description'])||!hex(provenance.nodePatch.sha256)||typeof provenance.nodePatch.description!=='string'||!provenance.nodePatch.description||provenance.nodePatch.description.length>2000||!hex(provenance.supervisorSourceSha256)||!keys(provenance.build,['compiler','platform'])||typeof provenance.build.compiler!=='string'||!provenance.build.compiler||typeof provenance.build.platform!=='string'||!provenance.build.platform)throw isolation('Native artifact provenance is incomplete');
 if(provenance.supervisorSourceSha256!==digest(readFileSync(fileURLToPath(new URL('native-supervisor.c',import.meta.url)))))throw isolation('Native supervisor source protocol changed; rebuild the explicitly approved artifact');
 const found=new Map();for(const entry of manifest.files){
  if(!keys(entry,['path','sha256','bytes','mode'])||!['node','mosaic-check-supervisor','NODE-LICENSE'].includes(entry.path)||found.has(entry.path)||!hex(entry.sha256)||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>512*1024*1024||entry.mode!==(entry.path==='NODE-LICENSE'?'100644':'100755'))throw isolation('Invalid native artifact inventory');
  const file=path.join(root,entry.path),s=canonical(file);if(s.uid!==process.getuid()||(s.mode&0o7777)!==(entry.mode==='100755'?0o755:0o644)||s.size!==entry.bytes||digest(readFileSync(file))!==entry.sha256)throw isolation('Native artifact bytes, size or executable mode changed: '+entry.path);found.set(entry.path,{executable:file,sha256:entry.sha256});
 }
 if([...found.keys()].length!==3)throw isolation('Missing native artifact files');
 const sandbox='/usr/bin/sandbox-exec';canonical(sandbox);
 return freeze({fingerprint:config.artifactManifestSha256,manifestPath,root,runtime:found.get('node'),supervisor:{...found.get('mosaic-check-supervisor'),protocol:1},sandbox:{executable:sandbox,sha256:digest(readFileSync(sandbox))},implementationHash:implementationHash(),platform:'darwin',arch:'arm64',nodeVersion:'24.22.0',manifest});
}
// Root-independent evidence permits exact comparison of source and copied dependencies.
export function nativeDependencyInventory(root){
 if(typeof root!=='string'||!path.isAbsolute(root)||path.normalize(root)!==root||/[\x00-\x1f\x7f\\]/.test(root))throw isolation('Native dependency root must be canonical');
 let rootStat;try{rootStat=lstatSync(root);}catch(error){if(error.code!=='ENOENT')throw isolation('Native dependency root is unreadable');if(realpathSync(path.dirname(root))!==path.dirname(root))throw isolation('Native dependency parent is aliased');const data={schema:1,present:false,rootMode:null,entries:[]};return freeze({...data,hash:digest(data)});}
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||realpathSync(root)!==root)throw isolation('Native dependency root is aliased or non-directory');
 const entries=[];let totalBytes=0;const buffer=Buffer.allocUnsafe(1024*1024);
 function walk(dir,prefix=''){
  for(const name of readdirSync(dir).sort()){
   const relative=prefix+name,file=path.join(dir,name),stat=lstatSync(file);if(entries.length>=100000||relative.length>4096)throw isolation('Native dependency inventory exceeds its bound');
   if(stat.isSymbolicLink()){
    let resolved;try{resolved=realpathSync(file);}catch{throw isolation('Native dependency link is broken or cyclic');}
    if(!within(root,resolved))throw isolation('Native dependency link escapes its canonical root');entries.push({path:relative,kind:'symlink',target:readlinkSync(file),resolved:path.relative(root,resolved)});
   }else if(stat.isDirectory()){
    if(realpathSync(file)!==file)throw isolation('Native dependency directory is aliased');entries.push({path:relative,kind:'directory',mode:stat.mode&0o7777});walk(file,relative+'/');
   }else if(stat.isFile()){
    if(stat.size>512*1024*1024||(totalBytes+=stat.size)>2*1024*1024*1024||realpathSync(file)!==file)throw isolation('Native dependency bytes exceed their bound or are aliased');
    const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256');try{const before=fstatSync(fd);if(before.ino!==stat.ino||before.dev!==stat.dev||before.mode!==stat.mode||before.size!==stat.size)throw isolation('Native dependency changed before hashing');let count=0,n;while((n=readSync(fd,buffer,0,buffer.length,null))>0){count+=n;if(count>stat.size)throw isolation('Native dependency grew during hashing');hash.update(buffer.subarray(0,n));}const after=fstatSync(fd);if(count!==stat.size||after.ino!==before.ino||after.dev!==before.dev||after.mode!==before.mode||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw isolation('Native dependency changed during hashing');}finally{closeSync(fd);}
    entries.push({path:relative,kind:'file',sha256:hash.digest('hex'),bytes:stat.size,mode:stat.mode&0o100?'100755':'100644'});
   }else throw isolation('Native dependency inventory contains an unsupported file type');
  }
 }
 walk(root);const data={schema:1,present:true,rootMode:rootStat.mode&0o7777,entries};return freeze({...data,hash:digest(data)});
}
export function nativeCheckArgv(config,script,args=[]){
 const runtime=validateNativeCheckRuntime(config);try{relativePath(script);}catch{throw isolation('Native check script must be an approved relative path');}
 if(!Array.isArray(args)||args.some(v=>typeof v!=='string'||v.includes('\0')))throw isolation('Native check arguments must be literal strings');return [runtime.runtime.executable,script,...args];
}
async function canonicalRoot(file){const s=await lstat(file);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(file)!==file)throw isolation('Native check root is aliased');return {path:file,realPath:file};}
export async function nativeInputInventory(workspace){
 const inventory=await workspace.inventory();if(!Array.isArray(inventory)||inventory.length>10000)throw isolation('Invalid native workspace inventory');
 const seen=new Set(),result=[];for(const entry of inventory){
  try{relativePath(entry.path);}catch{throw isolation('Invalid native source input');}if(seen.has(entry.path))throw isolation('Duplicate native source input');seen.add(entry.path);
  const file=await workspace.file(entry.path),s=await lstat(file),mode=await workspace.fileMode(entry.path);
  if(!s.isFile()||s.isSymbolicLink()||await realpath(file)!==file||!['100644','100755'].includes(mode)||(s.mode&0o100?'100755':'100644')!==mode||digest(await readFile(file))!==entry.hash)throw isolation('Native source bytes, path or mode changed during inventory');
  result.push({path:entry.path,realPath:file,hash:entry.hash,mode});
 }return result.sort((a,b)=>a.path.localeCompare(b.path));
}
export function compileDarwinSeatbeltPolicyV2(spec,runtime){
 const compiled=compileDarwinSeatbeltPolicy(spec),helper=JSON.stringify(runtime.supervisor.executable),profile=compiled.profile+'(deny syscall-unix (with errno ENOSYS) (syscall-number SYS_posix_spawn))\n'+`(allow process-exec (literal ${helper}))\n(allow file-read* file-map-executable (literal ${helper}))\n`;
 return {profile,evidence:{...compiled.evidence,backend:{id:'darwin-seatbelt',revision:2},diagnosticOnly:false,profileHash:digest(profile),runtimeFingerprint:runtime.fingerprint,implementationHash:runtime.implementationHash}};
}
export function createDarwinSeatbeltV2Backend({workspace,options={}}){
 const config=options.nativeCheckRuntime,identityRuntime=validateNativeCheckRuntime(config,options.expectedRuntimeFingerprint),identity=freeze({id:'darwin-seatbelt',revision:2,executable:identityRuntime.sandbox.executable,runtime:identityRuntime});
 async function compile(request){
  const runtime=validateNativeCheckRuntime(config,options.expectedRuntimeFingerprint);if(digest(runtime)!==digest(identityRuntime))throw isolation('Pinned native runtime identity changed');
  const root=await canonicalRoot(workspace.root);if(within(root.path,runtime.root)||within(runtime.root,root.path))throw isolation('Native artifact overlaps the check workspace');
  const inventory=await nativeInputInventory(workspace),outputs=[];for(const name of ['dist','.overnight-output']){await mkdir(path.join(root.path,name),{recursive:true});outputs.push(await canonicalRoot(path.join(root.path,name)));}
  const dependencyInventory=nativeDependencyInventory(path.join(root.path,'node_modules'));if(options.expectedDependencyHash!==undefined&&(!hex(options.expectedDependencyHash)||dependencyInventory.hash!==options.expectedDependencyHash))throw isolation('Native copied dependencies differ from the approved source bytes or executable modes');
  const dependencies=[];if(dependencyInventory.present)dependencies.push(await canonicalRoot(path.join(root.path,'node_modules')));
  const deniedPaths=[];for(const rule of request.permissions.filesystem.rules.filter(r=>r.access==='deny')){let realPath=rule.path;try{realPath=await realpath(rule.path);}catch(error){if(error.code!=='ENOENT')throw error;}deniedPaths.push({path:rule.path,realPath});}
  const stagedInputs=[];for(const stage of request.stagedInputs??[]){const stageRoot=await canonicalRoot(stage.root);const entries=[];for(const file of inventory){const absolute=path.join(stage.root,file.path),s=await lstat(absolute);if(!s.isFile()||s.isSymbolicLink()||await realpath(absolute)!==absolute||digest(await readFile(absolute))!==file.hash||(s.mode&0o7777)!==(file.mode==='100755'?0o755:0o644))throw isolation('Staged native input bytes, executable mode or path changed');entries.push({...file,realPath:absolute});}if(digest(entries.map(({realPath,...f})=>f))!==stage.inventoryHash)throw isolation('Native staged input inventory changed');stagedInputs.push({root:stageRoot,inventory:entries});}
  const spec={workspace:root,permissions:request.permissions,readPaths:workspace.manifest.permissions.readPaths,inventory,dependencies,outputs,executable:{path:runtime.runtime.executable,realPath:runtime.runtime.executable},stagedInputs,deniedPaths};const compiled=compileDarwinSeatbeltPolicyV2(spec,runtime);return {...compiled,evidence:{...compiled.evidence,dependencyInventoryHash:dependencyInventory.hash}};
 }
 return {identity:()=>identity,async execute(request){
  validateExecution(request,workspace);if(request.argv[0]!==identityRuntime.runtime.executable)throw isolation('Native revision 2 requires the explicitly approved literal pinned runtime launcher; prepare new exact check argv');
  const compiled=await compile(request),profileDir=path.join(workspace.journal.dir,'native-check-profiles');await mkdir(profileDir,{recursive:true,mode:0o700});const stat=await lstat(profileDir);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||await realpath(profileDir)!==profileDir||within(workspace.root,profileDir))throw isolation('Native profile storage must be private outside the check workspace');
  const profilePath=path.join(profileDir,randomUUID()+'.sb');await writeFile(profilePath,compiled.profile,{mode:0o600,flag:'wx'});
  const data={schema:1,backend:{id:identity.id,revision:identity.revision},argv:[...request.argv],cwd:request.cwd,profileHash:compiled.evidence.profileHash,inputInventoryHash:compiled.evidence.inventoryHash,dependencyInventoryHash:compiled.evidence.dependencyInventoryHash,runtimeFingerprint:identityRuntime.fingerprint,runtimeHash:identityRuntime.runtime.sha256,supervisorHash:identityRuntime.supervisor.sha256},binding={...data,bindingHash:digest(data)};
  const revalidate=async()=>{const again=await compile(request);if(digest(again)!==digest(compiled)||digest(await readFile(profilePath))!==compiled.evidence.profileHash)throw isolation('Native profile, inputs or runtime changed across an authority boundary');};
  let outcome;try{outcome=await executeSupervised({...request,profilePath,identity,ownership:options.ownership,binding,revalidate});return {...outcome,provenance:{...compiled.evidence,argv:[...request.argv],resolvedExecutable:identityRuntime.runtime.executable,requestId:outcome.quiescence.requestId,bindingHash:binding.bindingHash}};}catch(error){if(error.executionOutcome!=='unknown')await rm(profilePath,{force:true});throw error;}finally{if(outcome)await rm(profilePath,{force:true});}
 }};
}
