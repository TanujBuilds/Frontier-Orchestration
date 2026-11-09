import {execFile} from 'node:child_process';
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {digest} from '../src/harness/contracts.mjs';
import {verifyPackage} from '../src/harness/package.mjs';

const exec=promisify(execFile);
const repo=fileURLToPath(new URL('../',import.meta.url));
const pinned='24.22.0';
const nodeName='node-v'+pinned+'-darwin-arm64';
const nodeArchiveHash='6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5';
const nodeBinaryHash='b468fb9c67427c9d3aec07ee1105e63020923a631a9a2a00beb71a7ba3768bfd';
const nodeLicenseHash='5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

function options(args){
 const opts={};
 while(args.length){
  const option=args.shift();
  if(['--offline','--fixture'].includes(option)&&!opts[option.slice(2)]){opts[option.slice(2)]=true;continue;}
  if(['--version','--output','--node','--node-license'].includes(option)&&args[0]&&!opts[option.slice(2)]){opts[option.slice(2)]=args.shift();continue;}
  throw Error('Invalid package option. Run node scripts/package-beta.mjs --help');
 }
 if(!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(opts.version??'')||!opts.output)throw Error('A version and an output directory are required');
 if(opts.node&&!opts['node-license']||!opts.node&&opts['node-license']||opts.offline&&!opts.node||opts.fixture&&!opts.node)
  throw Error('An explicit Node executable requires --node-license. Offline and fixture builds also require --node.');
 return opts;
}

async function runtimeNode(opts,staging){
 let node=opts.node?path.resolve(opts.node):null,license=opts['node-license']?path.resolve(opts['node-license']):null;
 if(!node){
  const response=await fetch(`https://nodejs.org/dist/v${pinned}/${nodeName}.tar.gz`,{redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error('Could not download pinned Node distribution');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(sha(bytes)!==nodeArchiveHash)throw Error('Node archive SHA256 mismatch');
  const archive=path.join(staging,'node.tar.gz');
  await writeFile(archive,bytes);
  await exec('/usr/bin/tar',['-xzf',archive,'-C',staging,nodeName+'/bin/node',nodeName+'/LICENSE']);
  node=path.join(staging,nodeName,'bin','node');
  license=path.join(staging,nodeName,'LICENSE');
 }
 if(!opts.fixture&&(sha(await readFile(node))!==nodeBinaryHash||sha(await readFile(license))!==nodeLicenseHash))
  throw Error('The Node executable and license must match the pinned official Darwin arm64 distribution');
 const {stdout}=await exec(node,['-p','JSON.stringify([process.versions.node,process.platform,process.arch])'],{timeout:5000,maxBuffer:4096});
 if(stdout.trim()!==JSON.stringify([pinned,'darwin','arm64']))throw Error('Packaging requires Node '+pinned+' for Darwin arm64');
 return {node,license};
}

async function sourceClosure(entries){
 const found=new Set();
 async function walk(relative){
  if(found.has(relative))return;
  if(!/^src\/(?:beta|harness|project|adapters)\/[\w./-]+\.mjs$/.test(relative))throw Error('Unexpected beta runtime source '+relative);
  found.add(relative);
  const source=await readFile(path.join(repo,relative),'utf8');
  for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)['"](\.[^'"]+\.mjs)['"]/g))
   await walk(path.posix.normalize(path.posix.join(path.posix.dirname(relative),match[1])));
 }
 for(const entry of entries)await walk(entry);
 return [...found].sort();
}

async function fileList(directory,prefix=''){
 const files=[];
 for(const entry of await readdir(path.join(directory,prefix),{withFileTypes:true})){
  const rel=path.posix.join(prefix,entry.name);
  if(entry.isDirectory())files.push(...await fileList(directory,rel));
  else if(entry.isFile())files.push(rel);
  else throw Error('Beta package requires regular files: '+rel);
 }
 return files;
}

function bootstrap(inventoryHash){
 return `#!/bin/sh
set -eu
if [ "$(/usr/bin/uname -s)" != Darwin ] || [ "$(/usr/bin/uname -m)" != arm64 ]; then
  printf '%s\\n' 'Mosaic Beta requires an Apple Silicon Mac and a native arm64 terminal.' >&2
  exit 1
fi
CDPATH= cd -- "$(/usr/bin/dirname -- "$0")"
printf '%s  %s\\n' '${inventoryHash}' verify.sha256 | /usr/bin/shasum -a 256 --check --status
if ! /usr/bin/shasum -a 256 --check --status verify.sha256; then
  printf '%s\\n' 'Mosaic Beta package integrity verification failed.' >&2
  exit 1
fi
exec "$PWD/payload/runtime/bin/node" "$PWD/payload/runtime/src/beta/install.mjs" "$@"
`;
}

async function build(opts){
 const output=path.resolve(opts.output);
 const stem=`mosaic-beta-${opts.version}-darwin-arm64`;
 const archiveName=stem+'.tar.gz';
 await mkdir(output,{recursive:true});
 for(const file of [archiveName,archiveName+'.sha256']){
  if(await lstat(path.join(output,file)).catch(error=>{if(error.code!=='ENOENT')throw error;}))throw Error('Output already exists: '+file);
 }
 const staging=await mkdtemp(path.join(output,'.mosaic-beta-build-'));
 try{
  const bundle=path.join(staging,stem),payload=path.join(bundle,'payload');
  await mkdir(path.join(payload,'runtime','bin'),{recursive:true});
  const {node,license}=await runtimeNode(opts,staging);
  await copyFile(node,path.join(payload,'runtime','bin','node'));
  await chmod(path.join(payload,'runtime','bin','node'),0o755);
  await copyFile(license,path.join(payload,'runtime','NODE-LICENSE'));
  await copyFile(path.join(repo,'LICENSE'),path.join(payload,'LICENSE'));
  await copyFile(path.join(repo,'docs','TERMINAL_BETA.md'),path.join(bundle,'README.md'));
  const sources=await sourceClosure(['src/beta/cli.mjs']);
  for(const relative of [...sources,'package.json','package-lock.json']){
   const target=path.join(payload,'runtime',relative);
   await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(repo,relative),target);
  }
  const runtime=path.join(payload,'runtime');
  await exec('npm',['ci','--omit=dev','--ignore-scripts','--bin-links=false','--no-audit','--no-fund',...(opts.offline?['--offline']:[])],{cwd:runtime,timeout:90000,maxBuffer:1048576});
  const modules=await fileList(path.join(runtime,'node_modules'));
  const licenses=modules.filter(file=>/(?:^|\/)(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(file)).sort();
  if(!licenses.some(file=>file.startsWith('@modelcontextprotocol/sdk/')))throw Error('The pinned SDK license is missing');
  await writeFile(path.join(runtime,'DEPENDENCY-LICENSES.txt'),'License files included in node_modules\n\n'+licenses.join('\n')+'\n');
  const files=[];
  for(const relative of (await fileList(payload)).sort()){
   const bytes=await readFile(path.join(payload,relative));
   files.push({path:relative,sha256:sha(bytes),bytes:bytes.length});
  }
  const manifest={schema:1,layout:'terminal-beta-v1',version:opts.version,dependenciesInstalled:true,nodeVersion:pinned,fixture:!!opts.fixture,
   files,contentHash:digest(files)};
  const manifestBytes=JSON.stringify(manifest,null,2)+'\n';
  await writeFile(path.join(payload,'package-manifest.json'),manifestBytes);
  await verifyPackage(payload);
  const checksums=[...files,{path:'package-manifest.json',sha256:sha(manifestBytes)}].map(f=>f.sha256+'  payload/'+f.path).join('\n')+'\n';
  await writeFile(path.join(bundle,'verify.sha256'),checksums);
  await writeFile(path.join(bundle,'install'),bootstrap(sha(checksums)),{mode:0o755});
  const archive=path.join(staging,archiveName);
  await exec('/usr/bin/tar',['-czf',archive,'-C',staging,stem],{env:{...process.env,COPYFILE_DISABLE:'1'},timeout:90000,maxBuffer:1048576});
  const checksum=sha(await readFile(archive));
  await writeFile(archive+'.sha256',checksum+'  '+archiveName+'\n');
  await rename(archive,path.join(output,archiveName));
  await rename(archive+'.sha256',path.join(output,archiveName+'.sha256'));
  console.log(path.join(output,archiveName));
 }finally{await rm(staging,{recursive:true,force:true});}
}

if(process.argv.includes('--help'))console.log('node scripts/package-beta.mjs --version VERSION --output DIR [--node NODE --node-license LICENSE] [--offline] [--fixture]');
else build(options(process.argv.slice(2))).catch(error=>{console.error(error.message);process.exitCode=1;});
