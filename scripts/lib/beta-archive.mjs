import {lstat,readFile,readdir,mkdir,cp,mkdtemp,realpath,rm,writeFile,chmod} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {atomic} from '../../src/beta/files.mjs';
import path from 'node:path';
import os from 'node:os';
import {readBundledNativeCheckRuntime} from '../../src/beta/package-contract.mjs';
import {CheckRunner} from '../../src/project/sandbox.mjs';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// Official coordinator bytes are separately pinned to the upstream release.
// A locally built check Node must not disclose this owner or private build roots.
export function assertPortableArtifactPrivacy(bytes){
 const markers=[os.homedir()+path.sep,'/.data/','/.codex/'];
 if(markers.some(value=>bytes.includes(Buffer.from(value))))throw Error('Check runtime contains private build paths; rebuild from the same approved source and patch under a neutral canonical build root.');
}
export const artifactNames=['NODE-LICENSE','artifact-manifest.json','mosaic-check-supervisor','node'];
export async function listFiles(directory,prefix=''){
 const result=[];
 for(const entry of (await readdir(path.join(directory,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
  const relative=path.posix.join(prefix,entry.name);
  if(entry.isDirectory())result.push(...await listFiles(directory,relative));
  else if(entry.isFile())result.push(relative);
  else throw Error('Package sources require regular files, not symlinks: '+relative);
 }
 return result.sort();
}
export async function sourceClosure(repo,entries){
 const found=new Set();
 async function walk(relative){
  if(found.has(relative))return;
  if(!/^src\/(?:beta|harness|project|adapters)\/[\w./-]+\.mjs$/.test(relative))throw Error('Unexpected beta runtime source '+relative);
  const file=path.join(repo,relative),stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||await realpath(file)!==file)throw Error('Runtime source must be a canonical regular file: '+relative);
  found.add(relative);const source=await readFile(file,'utf8');
  for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\.[^'"]+\.mjs)['"]/g))await walk(path.posix.normalize(path.posix.join(path.posix.dirname(relative),match[1])));
 }
 for(const entry of entries)await walk(entry);
 // Explicit non-module closure. No arbitrary checkout traversal or local data.
 for(const name of await listFiles(path.join(repo,'src/harness/workflow-recipes/definitions')))found.add('src/harness/workflow-recipes/definitions/'+name);
 const c='src/project/check-backends/native-supervisor.c',cFile=path.join(repo,c);if(!(await lstat(cFile)).isFile()||await realpath(cFile)!==cFile)throw Error('Missing or aliased supervisor C source');found.add(c);
 return [...found].sort();
}
export async function copyCheckArtifact(source,destination){
 const stat=await lstat(source);
 if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(source)!==source)throw Error('Check artifact must use its canonical directory');
 if(JSON.stringify((await readdir(source)).sort())!==JSON.stringify(artifactNames))throw Error('Check artifact must contain the exact four-file allowlist');
 // Validate original ownership/ancestor/modes before copying; do not launder aliases.
 const {validateNativeCheckRuntime}=await import('../../src/project/check-backends/darwin-seatbelt-v2.mjs');
 const manifestPath=path.join(source,'artifact-manifest.json'),manifestBytes=await readFile(manifestPath);
 validateNativeCheckRuntime({schema:1,artifactManifestPath:manifestPath,artifactManifestSha256:sha(manifestBytes)});
 await cp(source,destination,{recursive:true,errorOnExist:true,force:false});
 await chmod(destination,0o700);
}
export async function probeCheckArtifact(source){
 // Actual OS execution always occurs in an owned canonical temporary directory,
 // even when the output archive is being assembled under a checkout's .data/.
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'mosaic-package-probe-')));
 let uncertain=false;
 try{
  const runtime=path.join(root,'runtime');await mkdir(runtime,{mode:0o700});
  await copyCheckArtifact(source,path.join(runtime,'check-artifact'));
  const nativeCheckRuntime=await readBundledNativeCheckRuntime(runtime),workspaceRoot=path.join(root,'workspace'),journal=path.join(root,'journal');
  await mkdir(workspaceRoot,{mode:0o700});await mkdir(journal,{mode:0o700});
  const data=Buffer.from('protected probe input\n');await writeFile(path.join(workspaceRoot,'input.txt'),data,{mode:0o644});
  const workspace={root:workspaceRoot,journal:{dir:journal},manifest:{permissions:{readPaths:['input.txt']}},file:async name=>path.join(workspaceRoot,name),snapshot:async()=>({'input.txt':sha(data)}),inventory:async()=>[{path:'input.txt',hash:sha(data)}],fileMode:async()=> '100644'};
  const ownership={async begin(binding){
   const requestId=randomUUID(),stateFile=path.join(journal,requestId+'.owner.json'),receiptPath=path.join(journal,requestId+'.receipt.json');
   const save=state=>atomic(stateFile,JSON.stringify({schema:1,requestId,binding,...state})+'\n');await save({status:'starting'});
   return {requestId,receiptPath,async prepared(event){await save({status:'prepared',event});},authorizeGo(){const state=JSON.parse(readFileSync(stateFile));if(state.status!=='prepared'||state.binding.bindingHash!==binding.bindingHash)throw Error('Developer preflight ownership changed');},async complete(receipt){await save({status:'quiescent',receipt});},async uncertain(reason){uncertain=true;await save({status:'uncertain',reason});}};
  }};
  const runner=new CheckRunner(workspace,{backend:'darwin-seatbelt',backendRevision:2,backendOptions:{nativeCheckRuntime,ownership}});
  const proof=await runner.verify();
  return {backend:{id:'darwin-seatbelt',revision:2},runtimeFingerprint:nativeCheckRuntime.artifactManifestSha256,childProcessWorks:proof.childProcessWorks,kernelProbe:proof.nativeGroupProbe,quiescent:proof.quiescence?.outcome==='quiescent'||proof.quiescence?.status==='quiescent'||!!proof.quiescence};
 }catch(error){if(error.executionOutcome==='unknown'||uncertain){uncertain=true;error.message+='; retained unresolved developer preflight ownership at '+root;}throw error;}finally{if(!uncertain)await rm(root,{recursive:true,force:true});}
}
// ustar + gzip with deterministic order, owners, times, modes and no macOS xattrs.
export async function deterministicArchive(bundle,output){
 const parent=path.dirname(bundle),stem=path.basename(bundle),files=await listFiles(bundle),entries=new Set([stem+'/']);
 for(const file of files){let dir=path.posix.dirname(file);while(dir!=='.'){entries.add(stem+'/'+dir+'/');dir=path.posix.dirname(dir);}entries.add(stem+'/'+file);}
 const octal=(value,size)=>value.toString(8).padStart(size-1,'0')+'\0';
 async function* bytes(){for(const name of [...entries].sort()){
  const directory=name.endsWith('/'),relative=name.slice(stem.length+1),absolute=path.join(parent,name),info=await lstat(absolute),header=Buffer.alloc(512);
  let leaf=name,prefix='';if(Buffer.byteLength(leaf)>100){const split=leaf.lastIndexOf('/',leaf.length-(directory?2:1));prefix=leaf.slice(0,split);leaf=leaf.slice(split+1);if(directory&&!leaf.endsWith('/'))leaf+='/';if(Buffer.byteLength(prefix)>155||Buffer.byteLength(leaf)>100)throw Error('Archive path exceeds ustar bound: '+name);}
  header.write(leaf,0,100);header.write(octal(info.mode&0o777,8),100);header.write(octal(0,8),108);header.write(octal(0,8),116);header.write(octal(directory?0:info.size,12),124);header.write(octal(0,12),136);header.fill(32,148,156);header.write(directory?'5':'0',156);header.write('ustar\0',257);header.write('00',263);header.write(prefix,345,155);const sum=header.reduce((a,b)=>a+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);yield header;
  if(!directory){for await(const chunk of createReadStream(absolute))yield chunk;const pad=(512-info.size%512)%512;if(pad)yield Buffer.alloc(pad);}
 }yield Buffer.alloc(1024);}
 await pipeline(Readable.from(bytes()),createGzip({level:9}),createWriteStream(output,{flags:'wx',mode:0o644}));
}
