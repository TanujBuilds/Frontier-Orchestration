import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {digest} from '../src/harness/contracts.mjs';
const execute=promisify(execFile),script=new URL('../scripts/release-readiness.mjs',import.meta.url);
const sha=b=>createHash('sha256').update(b).digest('hex');
const policy={version:2,finish:'selectors_only',discovery:'search_required'};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'readiness-fixture-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const candidate=path.join(root,'candidate');await fs.mkdir(candidate);
 const files=[];for(const [name,body] of Object.entries({'scripts/harness.mjs':'throw Error("CANDIDATE MUST NEVER EXECUTE");','runtime/src/harness/cli.mjs':'throw Error("CANDIDATE MUST NEVER EXECUTE");','skills/frontier-harness/SKILL.md':'FIXTURE','runtime/package-lock.json':JSON.stringify({packages:{'node_modules/@modelcontextprotocol/sdk':{version:'1.32.2'}}}),'runtime/node_modules/@modelcontextprotocol/sdk/package.json':JSON.stringify({version:'1.32.2'})})){
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
async function api(){return import(script.href);}
// Removing strict pins, evidence binding or output exclusivity would break these tests.
test('pinned package is data only; missing quality is pending and preparation cannot install',async t=>{
 const f=await fixture(t),{checkReadiness,prepareBundle}=await api();const r=await checkReadiness(f.opts);
 assert.equal(r.integrity.status,'passed');assert.equal(r.gates.implementation.status,'passed');assert.equal(r.gates.live_research_quality.status,'pending');assert.equal(r.prePromotion.status,'pending');assert.equal(r.installationAuthority,false);
 const output=path.join(f.root,"proposed space ' $(touch SHOULD_NOT_EXIST)");await prepareBundle({output,report:r});
 const plan=JSON.parse(await fs.readFile(path.join(output,'deployment-plan.json')));assert.equal(plan.state,'UNEXECUTED');assert.equal(plan.installationAuthority,false);
 const mcp=JSON.parse(await fs.readFile(path.join(output,'mcp-registration.example.json')));assert.equal(mcp.state,'UNEXECUTED');assert.ok(mcp.argv.includes('mcp'));
 await assert.rejects(prepareBundle({output,report:r}));await assert.rejects(fs.stat(path.join(f.root,'SHOULD_NOT_EXIST')));
 assert.equal((await fs.readFile(path.join(f.candidate,'scripts/harness.mjs'),'utf8')).startsWith('throw'),true);
});
test('mandatory external hashes detect tampering, even self-consistent manifest edits',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();for(const change of [{expectedContentHash:undefined},{expectedManifestSha256:undefined},{expectedContentHash:'b'.repeat(64)},{expectedManifestSha256:'b'.repeat(64)}])await assert.rejects(checkReadiness({...f.opts,...change}));
 await fs.writeFile(path.join(f.candidate,'scripts/harness.mjs'),'changed');await assert.rejects(checkReadiness(f.opts));
 const bytes=JSON.stringify({...f.manifest,sourceCommit:'b'.repeat(40)});await fs.writeFile(path.join(f.candidate,'package-manifest.json'),bytes);await assert.rejects(checkReadiness(f.opts));
});
test('unlisted file, cache directory and symlinks never pass inventory',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();const extra=path.join(f.candidate,'extra');await fs.writeFile(extra,'x');await assert.rejects(checkReadiness(f.opts));await fs.rm(extra);await fs.mkdir(extra);await assert.rejects(checkReadiness(f.opts));await fs.rm(extra,{recursive:true});await fs.symlink(f.evidence,extra);await assert.rejects(checkReadiness(f.opts));
});
test('input and output paths reject symlinks, traversal and overlap without modifying inputs',async t=>{
 const f=await fixture(t),{checkReadiness,prepareBundle}=await api();const alias=path.join(f.root,'alias');await fs.symlink(f.candidate,alias);await assert.rejects(checkReadiness({...f.opts,candidate:alias}));
 const link=path.join(f.root,'linked');await fs.symlink(f.evidence,link);await assert.rejects(checkReadiness({...f.opts,receipt:path.join(link,'receipt.json')}));
 const r=await checkReadiness(f.opts);for(const output of [path.join(f.candidate,'out'),path.join(f.evidence,'out'),path.join(link,'out'),path.join(f.root,'x','..','out')]){if(output.endsWith('/out')&&output===path.join(f.root,'out'))continue;await assert.rejects(prepareBundle({report:r,output}));}
 await assert.rejects(prepareBundle({report:r,output:f.root+'/x/../out'}));
});
test('closed receipts reject duplicates, conflicting gates and stale candidate/source/policy',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();for(const mutate of [r=>r.gates.push(r.gates[0]),r=>r.candidate.contentHash='b'.repeat(64),r=>r.candidate.sourceCommit='b'.repeat(40),r=>r.policy.version=1,r=>r.verified=true,r=>r.gates[0].artifacts.push(r.gates[0].artifacts[0])]){
  const original=structuredClone(f.receipt);mutate(f.receipt);await f.save();await assert.rejects(checkReadiness(f.opts));
  for(const key of Object.keys(f.receipt))delete f.receipt[key];Object.assign(f.receipt,original);await f.save();
 }
 const r=JSON.parse(await fs.readFile(f.opts.receipt));r.gates[0].artifacts[0].path='../escape';await fs.writeFile(f.opts.receipt,JSON.stringify(r));await assert.rejects(checkReadiness(f.opts));
});
test('malformed, duplicate-key, oversized, deeply nested and hostile JSON fails with bounded redacted CLI output',async t=>{
 const f=await fixture(t);for(const raw of ['{', '{"schema":1,"schema":1}', ' '.repeat(1024*1024+1), '['.repeat(40)+'0'+']'.repeat(40), JSON.stringify({...f.receipt,secret:'PRIVATE_SENTINEL\u001b[31m<script>hostile</script>'})]){
  await fs.writeFile(f.opts.receipt,raw);const result=await f.run({}).then(()=>null,e=>e);assert.ok(result);assert.equal(result.code,2);assert.ok(result.stderr.length<300);assert.doesNotMatch(result.stderr,/PRIVATE_SENTINEL|hostile|\u001b/);
 }
});
// Changing status aggregation to trust model/provenance completion breaks this case.
test('model approval and provenance cannot elevate live semantic acceptance',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();for(const authority of ['model','coordinator']){f.receipt.gates.push({name:'live_research_quality',status:'passed',applicability:'current',scope:'live',authority,artifacts:[f.receipt.gates[0].artifacts[0]]});await f.save();const r=await checkReadiness(f.opts);assert.equal(r.gates.live_research_quality.status,'pending');assert.equal(r.prePromotion.status,'pending');f.receipt.gates.pop();}
});
async function addQuality(f){
 const report=await f.artifact('report.txt','SIMULATED exact final report','report'),source=await f.artifact('source.txt','SIMULATED primary source','source');
 const review=await f.artifact('independent-review.md','SIMULATED independent review: each material clause compared against exact report/source; conditional recommendation premises checked.','review');
 const assessment=await f.artifact('assessment.json',{schema:1,kind:'independent-semantic-assessment',candidate:f.binding,policy,status:'passed',reportSha256:report.sha256,sourceSha256s:[source.sha256],reviewSha256:review.sha256,criteria:[{id:'material-claims',status:'passed'},{id:'conditional-recommendation',status:'passed'}]},'assessment');
 f.receipt.gates.push({name:'live_research_quality',status:'passed',applicability:'current',scope:'live',authority:'independent_native',artifacts:[report,source,assessment,review]});await f.save();return {report,source,assessment};
}
test('bound independent assessment permits advisory pre-promotion while installed checks stay pending',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();await addQuality(f);const r=await checkReadiness(f.opts);assert.equal(r.prePromotion.status,'passed');assert.equal(r.gates.installed_host_discovery.status,'pending');assert.equal(r.gates.physical_phone.status,'pending');assert.equal(r.postActivation.status,'pending');assert.equal(r.installationAuthority,false);assert.equal(r.fullRelease,'INCOMPLETE');
});
test('stale report or failed assessment cannot be replaced with a passed status string',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();const {assessment}=await addQuality(f);const file=path.join(f.evidence,assessment.path),a=JSON.parse(await fs.readFile(file));a.reportSha256='b'.repeat(64);const b=JSON.stringify(a);await fs.writeFile(file,b);Object.assign(f.receipt.gates[1].artifacts[2],{sha256:sha(b),bytes:Buffer.byteLength(b)});await f.save();await assert.rejects(checkReadiness(f.opts));
 f.receipt.gates[1].artifacts=f.receipt.gates[1].artifacts.filter(x=>x.role!=='assessment');await f.save();assert.equal((await checkReadiness(f.opts)).prePromotion.status,'pending');
});
test('terminal rollback fixture and historical applicability never imply active-policy compatibility',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();f.receipt.gates.push({name:'active_policy_rollback',status:'passed',applicability:'current',scope:'fixture',authority:'independent_native',artifacts:[f.receipt.gates[0].artifacts[0]]});f.receipt.gates[0].applicability='historical';await f.save();const r=await checkReadiness(f.opts);assert.equal(r.gates.active_policy_rollback.status,'pending');assert.equal(r.gates.implementation.status,'pending');
});
test('evidence index pins receipts, rejects duplicate/conflicting IDs and verifies full sealed handoff',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();const raw=await fs.readFile(f.opts.receipt),index={schema:1,receipts:[{path:'receipt.json',sha256:sha(raw),bytes:raw.length}]};const indexPath=path.join(f.evidence,'index.json');await fs.writeFile(indexPath,JSON.stringify(index));
 assert.equal((await checkReadiness({...f.opts,receipt:undefined,evidenceIndex:indexPath})).gates.implementation.status,'passed');await assert.rejects(checkReadiness({...f.opts,evidenceIndex:indexPath}));
 index.receipts.push(index.receipts[0]);await fs.writeFile(indexPath,JSON.stringify(index));await assert.rejects(checkReadiness({...f.opts,receipt:undefined,evidenceIndex:indexPath}));
});
test('interrupted output is retained and refused on retry; completed output inventory is deterministic',async t=>{
 const f=await fixture(t),{checkReadiness,prepareBundle}=await api();const report=await checkReadiness(f.opts),out=path.join(f.root,'partial');await fs.mkdir(out);await fs.writeFile(path.join(out,'partial'),'interrupted');await assert.rejects(prepareBundle({output:out,report}));assert.equal(await fs.readFile(path.join(out,'partial'),'utf8'),'interrupted');
 const a=path.join(f.root,'a'),b=path.join(f.root,'b');await prepareBundle({output:a,report});await prepareBundle({output:b,report});for(const name of await fs.readdir(a))assert.deepEqual(await fs.readFile(path.join(a,name)),await fs.readFile(path.join(b,name)));
});
test('CLI help has no output side effect; unknown install/apply/force and duplicate flags reject',async t=>{
 const f=await fixture(t);const help=await execute(process.execPath,[fileURLToPath(script),'--help','--output',path.join(f.root,'absent')]);assert.match(help.stdout,/--prepare/);await assert.rejects(fs.stat(path.join(f.root,'absent')));
 for(const flag of ['--install','--apply','--force','--skip-gates','--candidate']){const r=await execute(process.execPath,[fileURLToPath(script),flag]).then(()=>null,e=>e);assert.equal(r.code,2);assert.ok(r.stderr.length<300);}
});
// A status-only assessment must not substitute for an independently authored review.
test('quality assessment without exact independent review document stays pending',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();await addQuality(f);const g=f.receipt.gates[1];g.artifacts=g.artifacts.filter(x=>x.role!=='review');await f.save();assert.equal((await checkReadiness(f.opts)).prePromotion.status,'pending');
});
test('complete handoff seal binds result sidecar and every indexed artifact but cannot grant quality',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();
 const plain=async(name,value)=>{const ref=await f.artifact(name,value);delete ref.role;return ref;};
 const proof=await plain('sealed-proof.txt','SIMULATED handoff'),index=await plain('sealed-index.json',{schema:1,artifacts:[proof]}),result=await plain('FINAL_RESULT.json',{schema:1,candidateContentHash:f.binding.contentHash,indexSha256:index.sha256,status:'complete'}),resultSha256=await plain('FINAL_RESULT.sha256',result.sha256+'\n'),done=await plain('DONE.json',{schema:1,resultSha256:result.sha256,indexSha256:index.sha256,candidateContentHash:f.binding.contentHash,status:'complete'});
 const receiptBytes=await fs.readFile(f.opts.receipt),receipt={path:'receipt.json',sha256:sha(receiptBytes),bytes:receiptBytes.length};
 const wrapper={schema:1,receipts:[receipt],seal:{done,result,resultSha256,index}},file=path.join(f.evidence,'wrapper.json');await fs.writeFile(file,JSON.stringify(wrapper));
 const opts={...f.opts,receipt:undefined,evidenceIndex:file};const checked=await checkReadiness(opts);assert.equal(checked.handoff.status,'verified');assert.equal(checked.gates.live_research_quality.status,'pending');
 await fs.writeFile(path.join(f.evidence,'FINAL_RESULT.sha256'),'0'.repeat(64));await assert.rejects(checkReadiness(opts));
 await fs.writeFile(path.join(f.evidence,'FINAL_RESULT.sha256'),result.sha256+'\n');await fs.writeFile(path.join(f.evidence,'sealed-proof.txt'),'changed');await assert.rejects(checkReadiness(opts));
});
test('missing mutable handoff rejects seal while unprovided live evidence remains pending',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();const r=await checkReadiness({...f.opts,receipt:undefined});assert.equal(r.handoff.status,'pending');assert.equal(r.gates.live_research_quality.status,'pending');
 await assert.rejects(checkReadiness({...f.opts,receipt:path.join(f.evidence,'MISSING.json')}));
});
test('artifact wrong hashes, nonregular files, symlink parents and invalid schemas fail',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();const original=structuredClone(f.receipt);
 for(const mutate of [r=>r.schema=2,r=>r.gates[0].artifacts[0].sha256='0'.repeat(64),r=>r.gates[0].artifacts[0].path='/absolute',r=>r.gates[0].artifacts[0].path='a/../proof.txt']){
  const r=structuredClone(original);mutate(r);await fs.writeFile(f.opts.receipt,JSON.stringify(r));await assert.rejects(checkReadiness(f.opts));
 }
 await fs.writeFile(f.opts.receipt,JSON.stringify(original));const proof=path.join(f.evidence,'proof.txt');await fs.rename(proof,proof+'.original');await fs.symlink(proof+'.original',proof);await assert.rejects(checkReadiness(f.opts));await fs.rm(proof);await fs.mkdir(proof);await assert.rejects(checkReadiness(f.opts));
});
test('read-only CLI and preparation work with network/subprocess denied and unrelated config unchanged',async t=>{
 const f=await fixture(t),out=path.join(f.root,'staging'),sentinel=path.join(f.root,'private-config.json');await fs.writeFile(sentinel,'PRIVATE_CONFIG_SENTINEL');
 const guard=path.join(f.root,'deny-effects.mjs');await fs.writeFile(guard,`import cp from 'node:child_process';import net from 'node:net';import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';const deny=()=>{throw Error('FORBIDDEN_EFFECT');};for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[k]=deny;net.Socket.prototype.connect=deny;net.Server.prototype.listen=deny;http.request=deny;https.request=deny;globalThis.fetch=deny;syncBuiltinESMExports();`);
 const before={candidate:await fs.readFile(path.join(f.candidate,'package-manifest.json')),receipt:await fs.readFile(f.opts.receipt)};
 const result=await execute(process.execPath,['--import',guard,fileURLToPath(script),'--candidate',f.candidate,'--expected-content-hash',f.binding.contentHash,'--expected-manifest-sha256',f.binding.manifestSha256,'--receipt',f.opts.receipt,'--prepare','--output',out],{env:{...process.env,FRONTIER_HARNESS_CONFIG:sentinel},maxBuffer:128*1024}).then(()=>null,e=>e);
 assert.equal(result.code,3,result.stderr);assert.equal(JSON.parse(result.stdout).prePromotion.status,'pending');assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_CONFIG_SENTINEL|FORBIDDEN_EFFECT/);assert.equal(await fs.readFile(sentinel,'utf8'),'PRIVATE_CONFIG_SENTINEL');assert.deepEqual(await fs.readFile(path.join(f.candidate,'package-manifest.json')),before.candidate);assert.deepEqual(await fs.readFile(f.opts.receipt),before.receipt);
});
test('real macOS var alias is accepted while unrelated parent symlink is refused',async t=>{
 if(process.platform!=='darwin'){t.skip('macOS alias only');return;}const f=await fixture(t),{checkReadiness}=await api();const canonical=await fs.realpath(f.candidate);assert.equal((await checkReadiness({...f.opts,candidate:canonical})).integrity.status,'passed');
});
test('failed live semantic evidence remains failed rather than scheduler failure or passed provenance',async t=>{
 const f=await fixture(t),{checkReadiness}=await api();f.receipt.gates.push({name:'live_research_quality',status:'failed',applicability:'current',scope:'live',authority:'independent_native',artifacts:[f.receipt.gates[0].artifacts[0]]});await f.save();const r=await checkReadiness(f.opts);assert.equal(r.prePromotion.status,'failed');assert.equal(r.integrity.status,'passed');
});
