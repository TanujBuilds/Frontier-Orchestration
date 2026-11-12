#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chmod,copyFile,lstat,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashPattern=/^[a-f0-9]{64}$/;
const sourceUrl='https://nodejs.org/dist/v24.22.0/node-v24.22.0.tar.xz';
const sourceHash='41f97cff2c666f1f8293dc5f85c65e8dd605c16b43fd9febd49ede32ee1e0329';
const patchHash='840109e32a582faf92ed07f75987c6eb03c9b5659cf74b2f5231ac1e72594741';
const trustedSource=fileURLToPath(new URL('../src/project/check-backends/native-supervisor.c',import.meta.url));
const compiler='/usr/bin/clang';
const flags=['-std=c11','-O2','-Wall','-Wextra','-Werror'];

function checkKeys(value,allowed,label){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(key=>!allowed.includes(key)))throw Error('Invalid '+label);
}
async function regular(file,label,{executable=false}={}){
 if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw Error(label+' must be an absolute file path');
 const stat=await lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink())throw Error(label+' must be a regular file');
 const canonical=await realpath(file);
 if(path.normalize(file)!==file||canonical!==file)throw Error(label+' must use its canonical path');
 if(executable&&!(stat.mode&0o111))throw Error(label+' must be executable');
 return {path:canonical,bytes:await readFile(canonical)};
}
function run(executable,argv,label){
 const result=spawnSync(executable,argv,{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin',LANG:'C',HOME:'/var/empty'}});
 if(result.error||result.signal||result.status!==0)throw Error(label+' failed: '+(result.error?.message??result.stderr??result.signal));
 return result.stdout.trim();
}

// Developer-only, offline packaging. A task never calls this builder. Inputs are
// independently built/verified material, not instructions from a worker response.
export async function buildNativeCheckArtifact(options){
 checkKeys(options,['builtNode','builtNodeSha256','nodeLicense','nodeSource','nodePatch','outputDir','supervisorSource'],'native artifact options');
 const {builtNode,builtNodeSha256,nodeLicense,nodeSource,nodePatch,outputDir,supervisorSource=trustedSource}=options;
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Native check artifact build requires Darwin arm64');
 if(!hashPattern.test(builtNodeSha256??''))throw Error('Explicit built Node SHA-256 pin is required');
 checkKeys(nodeSource,['version','url','sha256'],'Node source provenance');
 if(nodeSource.version!=='24.22.0'||nodeSource.url!==sourceUrl||nodeSource.sha256!==sourceHash)throw Error('Unsupported Node source provenance');
 checkKeys(nodePatch,['sha256','description'],'Node patch provenance');
 if(nodePatch.sha256!==patchHash||typeof nodePatch.description!=='string'||!nodePatch.description.trim()||nodePatch.description.length>1000)throw Error('Unsupported fork-only Node patch provenance');
 if(path.resolve(supervisorSource)!==trustedSource||await realpath(supervisorSource)!==await realpath(trustedSource))throw Error('Only the trusted repository supervisor source may be compiled');
 const node=await regular(builtNode,'Built Node',{executable:true});
 if(sha256(node.bytes)!==builtNodeSha256)throw Error('Built Node SHA-256 pin does not match bytes');
 const license=await regular(nodeLicense,'Node license');
 if(!license.bytes.length||license.bytes.length>4*1024*1024)throw Error('Node license is empty or oversized');
 const source=await readFile(trustedSource);
 const reported=JSON.parse(run(node.path,['-p','JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'],'Built Node identity probe'));
 if(reported.version!=='24.22.0'||reported.platform!=='darwin'||reported.arch!=='arm64')throw Error('Built Node runtime must be Darwin arm64 version 24.22.0');
 if(typeof outputDir!=='string'||!path.isAbsolute(outputDir)||path.normalize(outputDir)!==outputDir)throw Error('Fresh output directory must be absolute and canonical');
 const parent=path.dirname(outputDir),parentReal=await realpath(parent),parentStat=await lstat(parent);
 if(parentReal!==parent||!parentStat.isDirectory()||parentStat.isSymbolicLink()||(parentStat.mode&0o022)||parentStat.uid!==process.getuid())throw Error('Output parent must be canonical, owned and private');
 // mkdir without recursive/overwrite establishes ownership of a fresh output.
 await mkdir(outputDir,{mode:0o700});
 try{
  const compilerVersion=run(compiler,['--version'],'Compiler identity').split('\n')[0];
  const helper=path.join(outputDir,'mosaic-check-supervisor');
  run(compiler,[...flags,trustedSource,'-o',helper],'Trusted native supervisor compilation');
  await copyFile(node.path,path.join(outputDir,'node'));
  await writeFile(path.join(outputDir,'NODE-LICENSE'),license.bytes,{flag:'wx',mode:0o644});
  await chmod(path.join(outputDir,'node'),0o755);await chmod(helper,0o755);await chmod(path.join(outputDir,'NODE-LICENSE'),0o644);
  // Re-read sources and outputs after every awaited compiler/copy boundary.
  if(sha256(await readFile(node.path))!==builtNodeSha256||sha256(await readFile(trustedSource))!==sha256(source)||sha256(await readFile(nodeLicense))!==sha256(license.bytes))throw Error('Build input changed while packaging');
  const files=[];
  for(const [name,mode] of [['node','100755'],['mosaic-check-supervisor','100755'],['NODE-LICENSE','100644']]){
   const file=await regular(path.join(outputDir,name),'Artifact '+name,{executable:mode==='100755'}),stat=await lstat(file.path);
   if((stat.mode&0o777)!==(mode==='100755'?0o755:0o644))throw Error('Artifact mode changed');
   files.push({path:name,sha256:sha256(file.bytes),bytes:file.bytes.length,mode});
  }
  if(files[0].sha256!==builtNodeSha256||files[2].sha256!==sha256(license.bytes))throw Error('Copied artifact bytes differ from inputs');
  const manifest={schema:1,platform:'darwin',arch:'arm64',nodeVersion:'24.22.0',supervisorProtocol:1,files,provenance:{nodeSource:{version:nodeSource.version,url:nodeSource.url,sha256:nodeSource.sha256},nodePatch:{sha256:nodePatch.sha256,description:nodePatch.description},supervisorSourceSha256:sha256(source),build:{compiler:compilerVersion+'; '+compiler+' '+flags.join(' '),platform:'darwin-arm64'}}};
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),manifestPath=path.join(outputDir,'artifact-manifest.json');
  await writeFile(manifestPath,bytes,{flag:'wx',mode:0o600});
  return {root:outputDir,manifestPath,fingerprint:sha256(bytes),manifest};
 }catch(error){await rm(outputDir,{recursive:true,force:true});throw error;}
}

async function main(argv){
 const accepted=new Set(['--built-node','--built-node-sha256','--node-license','--patch-file','--output']);
 const args={};
 for(let i=0;i<argv.length;i+=2){if(!accepted.has(argv[i])||args[argv[i]]||!argv[i+1])throw Error('Expected explicit --built-node, --built-node-sha256, --node-license, --patch-file and --output');args[argv[i]]=argv[i+1];}
 if(Object.keys(args).length!==accepted.size)throw Error('All build arguments are required; see docs/NATIVE_CHECK_ARTIFACT.md');
 const patch=await regular(args['--patch-file'],'Fork-only patch');
 const result=await buildNativeCheckArtifact({builtNode:args['--built-node'],builtNodeSha256:args['--built-node-sha256'],nodeLicense:args['--node-license'],nodeSource:{version:'24.22.0',url:sourceUrl,sha256:sourceHash},nodePatch:{sha256:sha256(patch.bytes),description:'Disable the Apple posix_spawn branch before file actions; use the existing libuv fork path.'},outputDir:args['--output']});
 process.stdout.write(JSON.stringify({artifactManifestPath:result.manifestPath,artifactManifestSha256:result.fingerprint})+'\n');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
