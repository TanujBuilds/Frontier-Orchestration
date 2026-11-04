import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeGoal,Registry,digest} from '../src/harness/contracts.mjs';
const policy={version:3,finish:'selectors_only',discovery:'search_required',repairContextVersion:1,correctionStrategy:'targeted_v1',review:{version:1,role:'independent_operator',maxRounds:2,maxRevisions:1,maxCorrectionModelCalls:2,rubricSha256:'a'.repeat(64)}};
const goal={submissionId:'targeted',objective:'Correct named units',acceptance:['Independent B'],mode:'collaborative',researchPolicy:policy};
test('targeted strategy pins research@6 and keeps old policies isolated',()=>{
 const g=normalizeGoal(goal);assert.equal(g.capabilities.find(c=>c.id==='research').version,6);
 for(const mode of ['deepseek_only','codex_only','overnight_review'])assert.throws(()=>normalizeGoal({...goal,mode}));
 for(const p of [{...policy,repairContextVersion:undefined},{...policy,version:2},{...policy,correctionStrategy:'auto'}])assert.throws(()=>normalizeGoal({...goal,researchPolicy:p}));
 const r=new Registry();assert.equal(r.snapshot().capabilities.find(c=>c.id==='research'&&c.version===5).inputSchema.properties.researchPolicy.properties.correctionStrategy,undefined);
});
import fs from 'node:fs/promises';
import {verifyProposal} from '../src/harness/research-review.mjs';
const f=()=>fs.readFile(new URL('./research/fixtures/targeted-valid.json',import.meta.url),'utf8').then(JSON.parse);
test('Python assembled B is mechanically verified against local A revise',async()=>{const {packet,task}=await f();assert.equal(verifyProposal(packet,task).descriptor.version,2);});
test('self-hashed remote repair cannot substitute for local revise authority',async()=>{
 const {packet,task}=await f();task.researchReviewTickets=[];assert.throws(()=>verifyProposal(packet,task),/local|revise/i);
});
test('v2 cannot enter old approved policy even with valid proof hashes',async()=>{
 const {packet,task}=await f();delete task.spec.researchPolicy.correctionStrategy;assert.throws(()=>verifyProposal(packet,task),/policy|targeted/i);
});
test('patch plan receipt and canonical tampering reject',async()=>{
 for(const change of [p=>p.repair.patch.replacements[0].value.text+='!',p=>p.repair.plan.required=[],p=>p.repair.receipt.changed=[],p=>p.canonical.report+=' ']){const {packet,task}=await f();change(packet);assert.throws(()=>verifyProposal(packet,task));}
});
test('Python/Node Unicode offsets and mixed A/correction catalogs agree exactly',async()=>{
 const {packet,task}=JSON.parse(await fs.readFile(new URL('./research/fixtures/targeted-unicode.json',import.meta.url),'utf8'));
 assert.notEqual(packet.descriptor.request.offersSha256,packet.descriptor.offersSha256);
 assert.equal(JSON.parse(packet.canonical.offers).length,2);assert.equal(verifyProposal(packet,task),packet);
 const report=JSON.parse(packet.canonical.report);assert.match(report.claims[0].evidence[0].quote,/New premise/);assert.match(report.claims[1].evidence[0].quote,/😀 Old premise/);
});

test('both foreign edits and acknowledgements reject even with valid global manifest hashes',async()=>{
 for(const field of ['replacements','checked_units']){
  const {packet,task}=await f(),base=JSON.parse(packet.repair.base.report);
  packet.repair.patch[field].push({unit:'title',before_sha256:digest(base.title),...(field==='replacements'?{value:'Foreign changed title'}:{})});
  assert.throws(()=>verifyProposal(packet,task),/unit\/hash\/closure/);
 }
});
import {verifyReviewVerdict,verifyLocalAcceptance} from '../src/harness/research-review.mjs';
test('mechanical B requires whole report review and genuine local native acceptance authority',async()=>{
 const {packet,task}=await f(),d=verifyProposal(packet,task).descriptor;
 assert.throws(()=>verifyReviewVerdict({decision:'accept',findings:[],coverage:d.units.slice(0,1)},d),/full unique coverage/);
 assert.doesNotThrow(()=>verifyReviewVerdict({decision:'accept',findings:[],coverage:d.units},d));
 assert.throws(()=>verifyLocalAcceptance(task,()=>undefined));
});
