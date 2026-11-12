import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,copyFile,chmod,mkdir,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {digest} from '../src/harness/contracts.mjs';
import {verifyPackage} from '../src/harness/package.mjs';
import {buildNativeCheckArtifact} from '../scripts/build-native-check-artifact.mjs';
const exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const repo=path.resolve(import.meta.dirname,'..');
const supported=process.platform==='darwin'&&process.arch==='arm64';
const required=process.env.MOSAIC_REQUIRE_NATIVE==='1',node=process.env.MOSAIC_NATIVE_TEST_NODE;
const source={version:'24.22.0',url:'https://nodejs.org/dist/v24.22.0/node-v24.22.0.tar.xz',sha256:'41f97cff2c666f1f8293dc5f85c65e8dd605c16b43fd9febd49ede32ee1e0329'};
const patch={sha256:'840109e32a582faf92ed07f75987c6eb03c9b5659cf74b2f5231ac1e72594741',description:'Disable the Apple posix_spawn branch before file actions; use the existing libuv fork path.'};
async function temp(t){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'Mosaic package 16 ')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('package verifier binds inventoried executable modes',async t=>{
 const root=await temp(t),data=Buffer.from('executable');await writeFile(path.join(root,'tool'),data,{mode:0o755});
 const files=[{path:'tool',sha256:sha(data),bytes:data.length,mode:'100755'}];
 await writeFile(path.join(root,'package-manifest.json'),JSON.stringify({schema:1,dependenciesInstalled:false,files,contentHash:digest(files)}));
 assert.equal(await verifyPackage(root),true);await chmod(path.join(root,'tool'),0o644);
 await assert.rejects(verifyPackage(root),/mode|executable/);
});
test('required package checks have an actual Darwin arm64 check runtime',()=>{if(required){assert.ok(supported);assert.ok(node,'MOSAIC_NATIVE_TEST_NODE required');}});
test('actual archive packaging repeats bytes, binds dynamic/source assets and works after relocation',{skip:!supported||!node&&!required,timeout:180000},async t=>{
 const root=await temp(t),materialized=path.join(root,'built-check-node');await copyFile(node,materialized);await chmod(materialized,0o755);const artifact=await buildNativeCheckArtifact({builtNode:materialized,builtNodeSha256:sha(await readFile(node)),nodeLicense:process.env.MOSAIC_NATIVE_TEST_LICENSE??path.resolve(node,'../../../LICENSE'),nodeSource:source,nodePatch:patch,outputDir:path.join(root,'check-artifact')});
 const build=async name=>{const output=path.join(root,name);await exec(process.execPath,['scripts/package-beta.mjs','--version','0.1.0-beta.160','--output',output,'--node',process.execPath,'--node-license',path.join(repo,'LICENSE'),'--check-artifact',artifact.root,'--offline','--fixture'],{cwd:repo,timeout:150000,maxBuffer:1048576});return output;};
 const a=await build('a'),b=await build('b'),stem='mosaic-beta-0.1.0-beta.160-darwin-arm64',archive=stem+'.tar.gz';
 assert.equal(sha(await readFile(path.join(a,archive))),sha(await readFile(path.join(b,archive))));
 assert.deepEqual(await readFile(path.join(a,stem+'.candidate.json')),await readFile(path.join(b,stem+'.candidate.json')));
 const candidate=JSON.parse(await readFile(path.join(a,stem+'.candidate.json')));assert.equal(candidate.archive.sha256,sha(await readFile(path.join(a,archive))));assert.match(candidate.source.commit,/^[a-f0-9]{40}$/);assert.ok(candidate.unpassedGates.includes('clean-machine'));
 const extracted=path.join(root,'Relocated package with spaces');await mkdir(extracted);await exec('/usr/bin/tar',['-xzf',path.join(a,archive),'-C',extracted]);
 const payload=path.join(extracted,stem,'payload'),runtime=path.join(payload,'runtime'),manifest=JSON.parse(await readFile(path.join(payload,'package-manifest.json')));
 for(const name of ['runtime/src/project/check-backends/native-supervisor.c','runtime/src/harness/integration.mjs','runtime/src/harness/workflow-recipes/definitions/feature.v1.json','runtime/docs/NATIVE_CHECK_ARTIFACT.md','runtime/docs/PORTABLE_BETA_INSTALL.md','runtime/docs/PORTABLE_BETA_RELEASE.md','runtime/provenance/beta-candidate.schema.json','runtime/provenance/fork-only.patch','runtime/src/beta/hosts/cursor.mjs'])assert.ok(manifest.files.some(f=>f.path===name),name);
 assert.equal(await verifyPackage(payload),true);
 const {readBundledNativeCheckRuntime}=await import('../src/beta/package-contract.mjs');const config=await readBundledNativeCheckRuntime(runtime);assert.equal(config.artifactManifestSha256,artifact.fingerprint);assert.equal(config.artifactManifestPath,path.join(runtime,'check-artifact/artifact-manifest.json'));
 const help=await exec(path.join(runtime,'bin/node'),[path.join(runtime,'src/beta/cli.mjs'),'--help'],{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:root}});assert.match(help.stdout,/Mosaic Beta/);
 for(const name of ['runtime/src/project/check-backends/native-supervisor.c','runtime/src/harness/workflow-recipes/definitions/feature.v1.json','runtime/src/harness/integration.mjs']){const file=path.join(payload,name),bytes=await readFile(file);await rm(file);await assert.rejects(verifyPackage(payload),/ENOENT|missing|checksum/);await writeFile(file,bytes,{mode:0o644});}
 const exe=path.join(runtime,'check-artifact/node');await chmod(exe,0o644);await assert.rejects(verifyPackage(payload),/mode/);await chmod(exe,0o755);
 const license=path.join(runtime,'check-artifact/NODE-LICENSE'),bytes=await readFile(license);await writeFile(license,'changed');await assert.rejects(readBundledNativeCheckRuntime(runtime),/bytes|checksum|artifact/);await writeFile(license,bytes);
 const alias=path.join(root,'alias');await symlink(runtime,alias);await assert.rejects(readBundledNativeCheckRuntime(alias),/canonical|alias|symlink/);
 await chmod(extracted,0o777);await assert.rejects(readBundledNativeCheckRuntime(runtime),/writable|mode/);await chmod(extracted,0o755);
});

test('source closure refuses missing C source and includes literal dynamic imports',async t=>{
 const {sourceClosure}=await import('../scripts/lib/beta-archive.mjs');const root=await temp(t);
 await mkdir(path.join(root,'src/beta'),{recursive:true});await mkdir(path.join(root,'src/harness/workflow-recipes/definitions'),{recursive:true});await mkdir(path.join(root,'src/project/check-backends'),{recursive:true});
 await writeFile(path.join(root,'src/beta/cli.mjs'),"await import('../harness/late.mjs');");await writeFile(path.join(root,'src/harness/late.mjs'),'export const loaded=true;');
 await assert.rejects(sourceClosure(root,['src/beta/cli.mjs']),/ENOENT|source/);await writeFile(path.join(root,'src/project/check-backends/native-supervisor.c'),'int main(void){return 0;}');
 const files=await sourceClosure(root,['src/beta/cli.mjs']);assert.ok(files.includes('src/harness/late.mjs'));
});
test('valid-looking same-version stock Node artifact fails actual packaging spawn preflight',{skip:!supported||!node&&!required,timeout:30000},async t=>{
 const root=await temp(t),artifact=await buildNativeCheckArtifact({builtNode:process.execPath,builtNodeSha256:sha(await readFile(process.execPath)),nodeLicense:process.env.MOSAIC_NATIVE_TEST_LICENSE??path.resolve(node,'../../../LICENSE'),nodeSource:source,nodePatch:patch,outputDir:path.join(root,'stock-artifact')});
 const {probeCheckArtifact}=await import('../scripts/lib/beta-archive.mjs');await assert.rejects(probeCheckArtifact(artifact.root),/probe|spawn|isolation|supervisor|permission/i);
});

test('release artifact privacy guard rejects owner build roots and private directories',async()=>{
 const {assertPortableArtifactPrivacy}=await import('../scripts/lib/beta-archive.mjs');
 assert.doesNotThrow(()=>assertPortableArtifactPrivacy(Buffer.from('/private/tmp/mosaic-node-v24.22.0/out/Release/node\0')));
 for(const value of [path.join(os.homedir(),'private-build/node'),'/private/tmp/source/.data/runtime/node','/private/tmp/source/.codex/runtime/node'])assert.throws(()=>assertPortableArtifactPrivacy(Buffer.from('prefix\0'+value+'\0suffix')),/private|neutral|build path/i);
});
