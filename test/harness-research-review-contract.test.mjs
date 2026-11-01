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
