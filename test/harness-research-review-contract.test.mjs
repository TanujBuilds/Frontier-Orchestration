import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {normalizeGoal,normalizeTask,Registry,digest} from '../src/harness/contracts.mjs';
const review={version:1,role:'independent_operator',maxRounds:2,maxRevisions:1,maxCorrectionModelCalls:2,rubricSha256:'a'.repeat(64)},policy={version:3,finish:'selectors_only',discovery:'search_required',review};
const goal=()=>({submissionId:'review-g',objective:'Cited research',acceptance:['Full independent review'],mode:'collaborative',researchPolicy:structuredClone(policy)});
test('v3 pins research@4/catalog2 review policy and rubric without changing old capabilities',async()=>{
 const pins=JSON.parse(await fs.readFile(new URL('./research/fixtures/review-legacy-capabilities.json',import.meta.url)));for(const c of new Registry().snapshot().capabilities)if(pins[c.id+'@'+c.version])assert.equal(digest(c),pins[c.id+'@'+c.version]);
 const g=normalizeGoal(goal());assert.equal(g.capabilities.find(c=>c.id==='research').version,4);
 const other=goal();other.researchPolicy.review.rubricSha256='b'.repeat(64);assert.notEqual(digest(g),digest(normalizeGoal(other)));
 const t=normalizeTask({submissionId:'r',kind:'research',objective:'Research',acceptance:['Cited'],limits:{questions:0}},g);assert.deepEqual(t.researchPolicy,policy);
});
test('v3 cannot hide a Codex fallback or increase model/review ceilings',()=>{
 normalizeGoal(goal());for(const mode of ['deepseek_only','codex_only','overnight_review'])assert.throws(()=>normalizeGoal({...goal(),mode}));
 for(const [field,value]of [['maxRounds',3],['maxRevisions',2],['verified',true]]){const g=goal();g.researchPolicy.review[field]=value;assert.throws(()=>normalizeGoal(g));}
 assert.throws(()=>normalizeTask({submissionId:'r',kind:'research',objective:'R',acceptance:['A'],limits:{modelCalls:21}},normalizeGoal(goal())));
});
test('repair context is explicitly pinned as research@5 without migrating research@4',()=>{
 const old=normalizeGoal(goal()),raw=goal();raw.researchPolicy.repairContextVersion=1;
 const next=normalizeGoal(raw);assert.equal(next.capabilities.find(c=>c.id==='research').version,5);
 assert.equal(old.capabilities.find(c=>c.id==='research').version,4);assert.notEqual(digest(old),digest(next));
 assert.equal(normalizeTask({submissionId:'r',kind:'research',objective:'R',acceptance:['A']},next).researchPolicy.repairContextVersion,1);
 for(const v of [0,2,true,'1',null]){raw.researchPolicy.repairContextVersion=v;assert.throws(()=>normalizeGoal(raw));}
 const reg=new Registry(),v4=reg.snapshot().capabilities.find(c=>c.id==='research'&&c.version===4),v5=reg.snapshot().capabilities.find(c=>c.id==='research'&&c.version===5);
 assert.equal(v4.inputSchema.properties.researchPolicy.properties.repairContextVersion,undefined);
 assert.equal(v5.inputSchema.properties.researchPolicy.properties.repairContextVersion.const,1);
});
test('research@5 still requires genuine local acceptance and exact capability binding',async t=>{
 const {fixture}=await import('../test-support/research-review-binding.mjs'),{readResearchAuthority}=await import('../src/harness/release-authority.mjs');
 const nextPolicy={...policy,repairContextVersion:1},f=await fixture(t,{researchPolicy:nextPolicy,environment:'fixture'});
 await f.accept();await f.collect();const task=f.c.getTask(f.task.id),receipt=JSON.parse(await fs.readFile(task.result.directory+'/receipt.json'));
 const args={stateRoot:f.root,taskId:task.id,receipt,policy:nextPolicy,reportBytes:Buffer.from(f.packet.canonical.report),sourceBytes:Buffer.from(f.packet.canonical.sources)};
 assert.equal((await readResearchAuthority(args)).status,'verified');
 const g=f.c.store.get('goal',f.g.id);g.manifest.capabilities.find(c=>c.id==='research').version=4;g.hash=digest(g.manifest);f.c.store.put('goal',g);
 await assert.rejects(readResearchAuthority(args),/authority_goal_binding_mismatch/);
});
test('all old normalized research goal approvals keep their exact frozen hashes',async()=>{
 const pins=JSON.parse(await fs.readFile(new URL('./research/fixtures/repair-context-legacy-goal-hashes.json',import.meta.url)));
 for(const version of [0,1,2,3]){const p=version?{version,finish:'selectors_only',discovery:'search_required',...(version===3?{review}:{})}:null;
  assert.equal(digest(normalizeGoal({submissionId:'compat-goal',objective:'Offline compatibility',acceptance:['Preserve approvals'],mode:'collaborative',...(p?{researchPolicy:p}:{})})),pins[String(version)]);
 }
});
