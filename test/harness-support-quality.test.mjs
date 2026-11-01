import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry,normalizeGoal,normalizeTask,digest,goalInputSchema} from '../src/harness/contracts.mjs';
const brief={submissionId:'quality',objective:'Compare evidence',acceptance:['Supported premises'],environment:'fixture',mode:'deepseek_only'};
const policy={version:2,finish:'selectors_only',discovery:'search_required'};
test('support quality requires explicit policy v2 and research@3 without changing old schemas/hashes',()=>{
 const legacy=normalizeGoal(brief),v1=normalizeGoal({...brief,researchPolicy:{...policy,version:1}}),v2=normalizeGoal({...brief,researchPolicy:policy});
 assert.equal(digest(legacy),'708773535c8b4c6675703cc43b7df19ad77a5bfa59bc3950fedafc4c4f50a356');assert.equal(digest(v1),'5190022d461addbadb38861bde02797fcb122cb05e808e33f8f20b6d06bea699');
 assert.equal(legacy.capabilities.find(c=>c.id==='research').version,1);
 assert.equal(v1.capabilities.find(c=>c.id==='research').version,2);
 assert.equal(v2.capabilities.find(c=>c.id==='research').version,3);
 assert.deepEqual(v1.capabilities.find(c=>c.id==='research').inputSchema.properties.researchPolicy.properties.version.enum,[1]);
 assert.deepEqual(v2.capabilities.find(c=>c.id==='research').inputSchema.properties.researchPolicy.properties.version.enum,[2]);
 const task={submissionId:'task',kind:'research',objective:'Compare evidence',acceptance:['Supported premises']};
 assert.deepEqual(normalizeTask(task,v2).researchPolicy,policy);
 assert.throws(()=>normalizeTask({...task,researchPolicy:{...policy,version:1}},v2),/approved|policy/i);
 for(const version of [3,true,'2'])assert.throws(()=>normalizeGoal({...brief,researchPolicy:{...policy,version}}),/policy/i);
 assert.deepEqual(goalInputSchema.properties.researchPolicy.properties.version.enum,[1,2]);
});
