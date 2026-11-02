import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {digest} from '../src/harness/contracts.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const execute=promisify(execFile),script=new URL('../scripts/release-readiness.mjs',import.meta.url);
const policy={version:2,finish:'selectors_only',discovery:'search_required'};
export async function readinessFixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'readiness-fixture-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const candidate=path.join(root,'candidate');await fs.mkdir(candidate);
 const files=[];for(const [name,body] of Object.entries({'runtime/src/harness/release-authority.mjs':'throw Error("CANDIDATE HELPER MUST NEVER EXECUTE");','scripts/harness.mjs':'throw Error("CANDIDATE MUST NEVER EXECUTE");','runtime/src/harness/cli.mjs':'throw Error("CANDIDATE MUST NEVER EXECUTE");',...Object.fromEntries(['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only'].map(n=>['skills/'+n+'/SKILL.md','FIXTURE'])),'runtime/package-lock.json':JSON.stringify({packages:{'node_modules/@modelcontextprotocol/sdk':{version:'1.32.2'}}}),'runtime/node_modules/@modelcontextprotocol/sdk/package.json':JSON.stringify({version:'1.32.2'})})){
  await fs.mkdir(path.dirname(path.join(candidate,name)),{recursive:true});await fs.writeFile(path.join(candidate,name),body);files.push({path:name,bytes:Buffer.byteLength(body),sha256:sha(body)});
 }
 const manifest={schema:1,layout:'shared-runtime-v1',skills:['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only'],sourceCommit:'a'.repeat(40),sourceDirty:false,nodeMajor:24,sdkVersion:'1.32.2',dependenciesInstalled:true,files,contentHash:digest(files)};
 const bytes=JSON.stringify(manifest);await fs.writeFile(path.join(candidate,'package-manifest.json'),bytes);
 const binding={contentHash:manifest.contentHash,manifestSha256:sha(bytes),sourceCommit:manifest.sourceCommit};
 const evidence=path.join(root,'evidence');await fs.mkdir(evidence);
 const artifact=async(name,value,role='proof')=>{const b=typeof value==='string'?value:JSON.stringify(value);await fs.writeFile(path.join(evidence,name),b);return {path:name,sha256:sha(b),bytes:Buffer.byteLength(b),role};};
 const proof=await artifact('proof.txt','SIMULATED fixture proof; no real installation');
 const receipt={schema:1,id:'fixture',candidate:binding,policy,gates:[{name:'implementation',status:'passed',applicability:'current',scope:'offline',authority:'independent_native',artifacts:[proof]}]};
 const save=async()=>fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt));await save();
 const opts={candidate,expectedContentHash:binding.contentHash,expectedManifestSha256:binding.manifestSha256,receipt:path.join(evidence,'receipt.json')};
 const run=extra=>execute(process.execPath,[fileURLToPath(script),...Object.entries({...opts,...extra}).flatMap(([k,v])=>[{'candidate':'--candidate',expectedContentHash:'--expected-content-hash',expectedManifestSha256:'--expected-manifest-sha256',receipt:'--receipt',output:'--output',evidenceIndex:'--evidence-index'}[k],v])],{maxBuffer:128*1024});
 return {root,candidate,evidence,binding,manifest,opts,receipt,save,artifact,run};
}
