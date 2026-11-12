import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {sha} from './beta-archive.mjs';
const exec=promisify(execFile);
export async function candidateManifest({repo,version,archiveName,archiveHash,manifest,manifestBytes,fixture,nativeProof,verificationRef}){
 const git=async(...args)=>(await exec('/usr/bin/git',args,{cwd:repo,encoding:'utf8'})).stdout.trim();
 const lock=JSON.parse(await readFile(path.join(repo,'package-lock.json')));
 let verification=[];
 if(verificationRef){if(path.isAbsolute(verificationRef)||verificationRef.split('/').some(p=>!p||p==='.'||p==='..')||verificationRef.includes('\\'))throw Error('Verification reference must be a repository relative path');const bytes=await readFile(path.join(repo,verificationRef));verification=[{path:verificationRef,sha256:sha(bytes)}];}
 const inputs=['package-lock.json','scripts/package-beta.mjs','scripts/lib/beta-archive.mjs','scripts/lib/beta-candidate.mjs','scripts/lib/beta-candidate.schema.json'];
 return {schema:1,kind:'mosaic-portable-beta-candidate',version,platform:'darwin-arm64',fixture,
  source:{commit:await git('rev-parse','HEAD'),tree:await git('rev-parse','HEAD^{tree}'),dirty:!!await git('status','--porcelain'),closureHash:sha(JSON.stringify(manifest.files.filter(f=>f.path.startsWith('runtime/src/'))))},
  archive:{file:archiveName,sha256:archiveHash},inventory:{file:'payload/package-manifest.json',sha256:sha(manifestBytes),contentHash:manifest.contentHash},
  versions:{coordinatorNode:manifest.nodeVersion,checkNode:manifest.nativeCheckArtifact?'24.22.0':null,sdk:lock.packages['node_modules/@modelcontextprotocol/sdk'].version,settingsSchemas:manifest.stateCompatibility.settings,databaseSchemas:manifest.stateCompatibility.database},
  build:{archiveFormat:'ustar-gzip-v1',timestamp:0,owner:0,group:0,inputs:await Promise.all(inputs.map(async file=>({path:file,sha256:sha(await readFile(path.join(repo,file)))}))),runtimeInputs:manifest.files.filter(f=>['runtime/bin/node','runtime/NODE-LICENSE','runtime/check-artifact/artifact-manifest.json'].includes(f.path))},
  verification:{references:verification,nativePreflight:nativeProof?{backend:nativeProof.backend,runtimeFingerprint:nativeProof.runtimeFingerprint,childProcessWorks:nativeProof.childProcessWorks,quiescent:nativeProof.quiescent,kernelContainment:true}:null},
  unpassedGates:['final-source-suite','independent-review','clean-machine','real-host-accounts','live-providers','other-platforms','signing-notarization','authenticated-download','public-source-license-audit','publication']};
}
