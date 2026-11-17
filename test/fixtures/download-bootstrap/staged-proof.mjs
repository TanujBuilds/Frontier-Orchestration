// Explicit maintainer fixture, excluded from test discovery. Never builds or
// downloads external inputs. Args: accepted-inputs.json evidence-dir proof-parent.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,mkdtemp,readFile,readdir,lstat,writeFile,realpath} from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const [inputFile,evidenceDir,proofParent]=process.argv.slice(2);
assert.ok(inputFile&&evidenceDir&&proofParent&&path.isAbsolute(proofParent));
const inputs=JSON.parse(await readFile(inputFile,'utf8')),accepted=inputs.acceptedPackages.find(a=>a.version==='0.1.0-beta.184');assert.ok(accepted);
const sha=b=>createHash('sha256').update(b).digest('hex');
async function hashFile(file){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
assert.equal(await hashFile(accepted.archive),accepted.sha256);
assert.equal(await hashFile(accepted.candidate),accepted.candidateSha256);
const metadata=JSON.parse(await readFile(accepted.candidate,'utf8'));
assert.equal(metadata.source.commit,inputs.source.commit);assert.equal(metadata.source.tree,inputs.source.tree);assert.equal(metadata.archive.sha256,accepted.sha256);assert.equal(metadata.fixture,false);
await mkdir(evidenceDir,{recursive:true,mode:0o700});await mkdir(proofParent,{recursive:true,mode:0o700});
const root=await realpath(await mkdtemp(path.join(proofParent,'staged-'))),home=path.join(root,"Disposable User's home"),tmp=path.join(root,'temporary data');await mkdir(home,{mode:0o700});await mkdir(tmp,{mode:0o700});
const script=fileURLToPath(new URL('../../../distribution/archive/install.sh',import.meta.url));
const installedDriver=fileURLToPath(new URL('./installed-proof.mjs',import.meta.url));
const runs=[],requests=[];let completed=false;
const server=createServer((req,res)=>{requests.push({method:req.method,path:req.url});if(req.method==='GET'&&req.url==='/beta184')createReadStream(accepted.archive).on('error',()=>res.destroy()).pipe(res);else res.writeHead(500).end('Unexpected fixture request');});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const env={PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,LANG:'en_US.UTF-8'};
async function command(argv){
 const result=await new Promise((resolve,reject)=>{const child=spawn(argv[0],argv.slice(1),{env,cwd:root,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',(code,signal)=>resolve({argv,code,signal,stdout,stderr}));});
 runs.push(result);await writeFile(path.join(evidenceDir,'staged-progress.json'),JSON.stringify({root,runs,requests},null,2)+'\n');return result;
}
const success=r=>assert.equal(r.code,0,r.stderr+'\n'+r.stdout);
const args=digest=>['/bin/sh',script,'--version',accepted.version,'--url',`http://127.0.0.1:${server.address().port}/beta184`,'--sha256',digest,'--home',home,'--no-path','--test-loopback-http'];
async function snapshot(directory,prefix=''){
 const rows=[];for(const name of (await readdir(path.join(directory,prefix))).sort()){const rel=path.join(prefix,name),full=path.join(directory,rel),s=await lstat(full);assert.equal(s.isSymbolicLink(),false);rows.push({path:rel,mode:s.mode&0o7777,kind:s.isDirectory()?'directory':'file',...(s.isFile()?{sha256:await hashFile(full)}:{})});if(s.isDirectory())rows.push(...await snapshot(directory,rel));}return rows;
}
try{
 success(await command(args(accepted.sha256)));
 const product=path.join(home,'Library/Application Support/Mosaic Beta'),runtime=path.join(product,'versions',accepted.version,'runtime'),node=path.join(runtime,'bin/node');
 success(await command([path.join(home,'.local/bin/mosaic'),'--help']));
 let r=await command([node,installedDriver,home,root,'pin-retained-runtime']);success(r);const installed=JSON.parse(r.stdout);assert.equal(installed.version,accepted.version);assert.equal(installed.manifestSha256,metadata.inventory.sha256);
 const before=await snapshot(home);await writeFile(path.join(evidenceDir,'installed-before.json'),JSON.stringify(before,null,2)+'\n');
 r=await command(args('0'.repeat(64)));assert.notEqual(r.code,0);assert.match(r.stderr,/SHA256 mismatch/);assert.deepEqual(await snapshot(home),before,'checksum failure preserves ordinary existing installation');
 success(await command(args(accepted.sha256)));assert.deepEqual(await snapshot(home),before,'original installer retains exact runtime/settings on idempotent install');
 const config=path.join(product,'config/settings.json'),settings=await readFile(config),bad=JSON.parse(settings);bad.nativeCheckRuntime.artifactManifestSha256='0'.repeat(64);await writeFile(config,JSON.stringify(bad),{mode:0o600});const invalidBefore=await snapshot(home);
 r=await command(args(accepted.sha256));assert.notEqual(r.code,0);assert.match(r.stderr,/original installer failed/i);assert.deepEqual(await snapshot(home),invalidBefore,'original installer refuses invalid retained runtime without replacing installation');await writeFile(config,settings,{mode:0o600});
 r=await command([node,installedDriver,home,root,'verify-native']);success(r);const native=JSON.parse(r.stdout);assert.equal(native.nativeCheckRuntime.artifactManifestSha256,metadata.verification.nativePreflight.runtimeFingerprint);await writeFile(path.join(evidenceDir,'native-installed.json'),JSON.stringify(native,null,2)+'\n');
 assert.deepEqual(await readdir(tmp),[]);assert.equal(requests.length,4);assert.ok(requests.every(r=>r.method==='GET'&&r.path==='/beta184'));completed=true;
}finally{
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 await writeFile(path.join(evidenceDir,'staged-proof.json'),JSON.stringify({schema:1,completed,root,home,sourceBinding:{source:metadata.source,candidateSha256:accepted.candidateSha256,archiveSha256:accepted.sha256},runs,requests,providerCalls:0,fixtureOnly:true,actualPublicDownload:false,cleanMac:false,retainedRoot:true,reason:'Disposable installation and native receipts retained for coordinating review; no automatic root deletion'},null,2)+'\n');
}
assert.equal(completed,true);console.log(JSON.stringify({completed,root,evidenceDir,archiveSha256:accepted.sha256,providerCalls:0}));
