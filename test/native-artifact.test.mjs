import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, readFile, readdir, lstat, rm, writeFile, chmod, symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {buildNativeCheckArtifact} from '../scripts/build-native-check-artifact.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const supported = process.platform === 'darwin' && process.arch === 'arm64';
const required = process.env.MOSAIC_REQUIRE_NATIVE === '1';
const explicitNode = process.env.MOSAIC_NATIVE_TEST_NODE;
const source = {version:'24.22.0',url:'https://nodejs.org/dist/v24.22.0/node-v24.22.0.tar.xz',sha256:'41f97cff2c666f1f8293dc5f85c65e8dd605c16b43fd9febd49ede32ee1e0329'};
const patch = {sha256:'840109e32a582faf92ed07f75987c6eb03c9b5659cf74b2f5231ac1e72594741',description:'Disable the Apple posix_spawn branch before file actions; use the existing libuv fork path.'};
async function fixture(t) {
 const root = await realpath(await mkdtemp(path.join(os.tmpdir(),'mosaic-native-artifact-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const builtNode=explicitNode??process.execPath;
 let nodeLicense=process.env.MOSAIC_NATIVE_TEST_LICENSE??path.resolve(builtNode,'../../../LICENSE');
 if(!explicitNode){nodeLicense=path.join(root,'LICENSE');await writeFile(nodeLicense,'Node.js test license; no artifact is created from this input.');}
 return {root,builtNode,builtNodeSha256:hash(await readFile(builtNode)),nodeLicense,nodeSource:source,nodePatch:patch};
}

test('native artifact gate requires an explicit supported runtime when native verification is required',()=>{
 if(required){assert.equal(supported,true,'Required native checks need Darwin arm64');assert.ok(explicitNode,'Set MOSAIC_NATIVE_TEST_NODE to the independently built fork-only Node');}
});

test('artifact builder copies explicit pinned bytes, compiles the trusted helper and emits reproducible inventory', {skip:!supported||(!explicitNode&&!required),timeout:30000},async t=>{
 const {root,...input}=await fixture(t),first=await buildNativeCheckArtifact({...input,outputDir:path.join(root,'first')}),second=await buildNativeCheckArtifact({...input,nodeSource:{sha256:source.sha256,url:source.url,version:source.version},nodePatch:{description:patch.description,sha256:patch.sha256},outputDir:path.join(root,'second')});
 assert.equal(first.fingerprint,second.fingerprint);
 assert.deepEqual((await readdir(first.root)).sort(),['NODE-LICENSE','artifact-manifest.json','mosaic-check-supervisor','node']);
 assert.equal(first.fingerprint,hash(await readFile(first.manifestPath)));
 const manifest=JSON.parse(await readFile(first.manifestPath,'utf8'));
 assert.deepEqual(Object.keys(manifest).sort(),['arch','files','nodeVersion','platform','provenance','schema','supervisorProtocol']);
 assert.equal(manifest.nodeVersion,'24.22.0');assert.equal(manifest.platform,'darwin');assert.equal(manifest.arch,'arm64');assert.equal(manifest.supervisorProtocol,1);
 assert.deepEqual(manifest.provenance.nodeSource,source);assert.deepEqual(manifest.provenance.nodePatch,patch);
 assert.equal(manifest.provenance.supervisorSourceSha256,hash(await readFile(new URL('../src/project/check-backends/native-supervisor.c',import.meta.url))));
 assert.match(manifest.provenance.build.compiler,/clang/i);assert.equal(manifest.provenance.build.platform,'darwin-arm64');
 assert.deepEqual(manifest.files.map(f=>[f.path,f.mode]),[['node','100755'],['mosaic-check-supervisor','100755'],['NODE-LICENSE','100644']]);
 for(const file of manifest.files){const bytes=await readFile(path.join(first.root,file.path)),stat=await lstat(path.join(first.root,file.path));assert.equal(file.sha256,hash(bytes));assert.equal(file.bytes,bytes.length);assert.equal(stat.mode&0o777,file.mode==='100755'?0o755:0o644);}
 assert.equal(manifest.files[0].sha256,input.builtNodeSha256);
 const {validateNativeCheckRuntime}=await import('../src/project/check-backends/darwin-seatbelt-v2.mjs');
 const identity=validateNativeCheckRuntime({schema:1,artifactManifestPath:first.manifestPath,artifactManifestSha256:first.fingerprint},first.fingerprint);
 assert.equal(identity.runtime.executable,path.join(first.root,'node'));assert.equal(identity.supervisor.executable,path.join(first.root,'mosaic-check-supervisor'));
});

test('artifact builder refuses wrong runtime pin and untrusted C source without leaving output', {skip:!supported,timeout:30000},async t=>{
 const {root,...input}=await fixture(t),outputDir=path.join(root,'artifact');
 await assert.rejects(buildNativeCheckArtifact({...input,outputDir,builtNodeSha256:'0'.repeat(64)}),/hash|pin|sha/i);
 await assert.rejects(lstat(outputDir),{code:'ENOENT'});
 const untrusted=path.join(root,'model-output.c');await writeFile(untrusted,'int main(void){return 0;}');
 await assert.rejects(buildNativeCheckArtifact({...input,outputDir,supervisorSource:untrusted}),/trusted.*source|source.*trusted/i);
 await assert.rejects(lstat(outputDir),{code:'ENOENT'});
});

test('artifact builder never overwrites an existing artifact', {skip:!supported||(!explicitNode&&!required),timeout:30000},async t=>{
 const {root,...input}=await fixture(t),outputDir=path.join(root,'artifact');
 const created=await buildNativeCheckArtifact({...input,outputDir});
 const before=await readFile(created.manifestPath);
 await assert.rejects(buildNativeCheckArtifact({...input,outputDir}),/exist|fresh/i);
 assert.deepEqual(await readFile(created.manifestPath),before);
});

test('artifact validator rejects mutated executable modes, license bytes and symbolic artifact aliases', {skip:!supported||(!explicitNode&&!required),timeout:30000},async t=>{
 const {root,...input}=await fixture(t),artifact=await buildNativeCheckArtifact({...input,outputDir:path.join(root,'artifact')});
 const {validateNativeCheckRuntime}=await import('../src/project/check-backends/darwin-seatbelt-v2.mjs');
 const config={schema:1,artifactManifestPath:artifact.manifestPath,artifactManifestSha256:artifact.fingerprint};
 await chmod(path.join(artifact.root,'node'),0o644);assert.throws(()=>validateNativeCheckRuntime(config),/mode|executable|artifact/i);await chmod(path.join(artifact.root,'node'),0o755);
 const license=await readFile(path.join(artifact.root,'NODE-LICENSE'));await writeFile(path.join(artifact.root,'NODE-LICENSE'),'changed license');assert.throws(()=>validateNativeCheckRuntime(config),/hash|bytes|artifact/i);await writeFile(path.join(artifact.root,'NODE-LICENSE'),license);
 await chmod(artifact.root,0o777);assert.throws(()=>validateNativeCheckRuntime(config),/owned|writable|private|mode|artifact/i);await chmod(artifact.root,0o700);
 await chmod(root,0o777);assert.throws(()=>validateNativeCheckRuntime(config),/owned|writable|private|mode|ancestor|artifact/i);await chmod(root,0o700);
 const alias=path.join(root,'alias');await symlink(artifact.root,alias);
 assert.throws(()=>validateNativeCheckRuntime({...config,artifactManifestPath:path.join(alias,'artifact-manifest.json')}),/canonical|alias|symlink|artifact/i);
});
