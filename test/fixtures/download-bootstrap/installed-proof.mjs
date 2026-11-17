// Run with the newly installed bundled Node, never development runtime imports.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [home,proofRoot,mode]=process.argv.slice(2);
const hash=b=>createHash('sha256').update(b).digest('hex');
const product=path.join(home,'Library/Application Support/Mosaic Beta');
const receipt=JSON.parse(await readFile(path.join(product,'config/installation.json'),'utf8'));
const installed=path.join(product,'versions',receipt.version),runtime=path.join(installed,'runtime');
const load=name=>import(pathToFileURL(path.join(runtime,name)).href);
const manifest=JSON.parse(await readFile(path.join(installed,'package-manifest.json'),'utf8'));
assert.equal(manifest.version,receipt.version);assert.equal(manifest.contentHash,receipt.contentHash);
const {readBundledNativeCheckRuntime}=await load('src/beta/package-contract.mjs');
const nativeCheckRuntime=await readBundledNativeCheckRuntime(runtime);
assert.equal(manifest.nativeCheckArtifact.fingerprint,nativeCheckRuntime.artifactManifestSha256);
if(mode==='pin-retained-runtime'){
 const {normalizeSettings}=await load('src/beta/settings.mjs');
 const settings=normalizeSettings({schema:2,host:{id:'codex',options:{}},providers:[],defaults:{workerId:null,plannerWorkerId:null,review:{source:'host',hostId:'codex'}},execution:{backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:nativeCheckRuntime.artifactManifestSha256},nativeCheckRuntime,serviceMaxConcurrentTasks:1,capacityGroups:[]});
 await writeFile(path.join(product,'config/settings.json'),JSON.stringify(settings,null,2)+'\n',{mode:0o600});
}
let nativeProof=null;
if(mode==='verify-native'){
 const {CheckRunner}=await load('src/project/sandbox.mjs');
 const {atomic}=await load('src/beta/files.mjs');
 const root=path.join(proofRoot,'native proof'),workspaceRoot=path.join(root,'workspace'),journal=path.join(root,'journal');
 await mkdir(workspaceRoot,{recursive:true,mode:0o700});await mkdir(journal,{mode:0o700});
 const data=Buffer.from('protected probe input\n');await writeFile(path.join(workspaceRoot,'input.txt'),data,{mode:0o644});
 const workspace={root:workspaceRoot,journal:{dir:journal},manifest:{permissions:{readPaths:['input.txt']}},file:async name=>path.join(workspaceRoot,name),snapshot:async()=>({'input.txt':hash(data)}),inventory:async()=>[{path:'input.txt',hash:hash(data)}],fileMode:async()=> '100644'};
 let uncertain=false;
 // Same persisted ownership/authorizeGo contract used by the accepted package
 // probe. No preflight bypass and no providers/hosts/coordinator startup.
 const ownership={async begin(binding){
  const requestId=randomUUID(),stateFile=path.join(journal,requestId+'.owner.json'),receiptPath=path.join(journal,requestId+'.receipt.json');
  const save=state=>atomic(stateFile,JSON.stringify({schema:1,requestId,binding,...state})+'\n');await save({status:'starting'});
  return {requestId,receiptPath,async prepared(event){await save({status:'prepared',event});},authorizeGo(){const state=JSON.parse(readFileSync(stateFile));if(state.status!=='prepared'||state.binding.bindingHash!==binding.bindingHash)throw Error('Installed fixture ownership changed');},async complete(receipt){await save({status:'quiescent',receipt});},async uncertain(reason){uncertain=true;await save({status:'uncertain',reason});}};
 }};
 try{
  const runner=new CheckRunner(workspace,{backend:'darwin-seatbelt',backendRevision:2,backendOptions:{nativeCheckRuntime,expectedRuntimeFingerprint:nativeCheckRuntime.artifactManifestSha256,ownership}});
  nativeProof=await runner.verify();assert.equal(nativeProof.childProcessWorks,true);assert.equal(nativeProof.backend.revision,2);assert.equal(uncertain,false);
 }catch(error){await writeFile(path.join(proofRoot,'native-uncertain.json'),JSON.stringify({error:error.message,executionOutcome:error.executionOutcome??null,uncertain,root},null,2)+'\n');throw error;}
}
console.log(JSON.stringify({receipt,version:manifest.version,manifestSha256:hash(await readFile(path.join(installed,'package-manifest.json'))),nativeCheckRuntime,nativeProof,sourceImports:false,providers:[],preflightBypassed:false}));
