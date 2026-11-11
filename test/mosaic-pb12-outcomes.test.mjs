import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeOutcomes} from '../src/harness/outcomes/aggregate.mjs';
const snapshot=requests=>({schemaVersion:1,generatedAt:new Date(10000).toISOString(),sourceRevision:null,scope:{goalId:null,from:null,to:null,cursor:null},coverage:{complete:true,nextCursor:null},diagnostics:[],goals:[],tasks:[],events:[],requests,evidence:[]});
const request=(id,kind,result)=>({id,task_id:'fixture-task',key:id,kind,status:'completed',data:{reservedAt:1000,savedAt:2000,requestOutcome:'completed',result}});
test('API review usage has a reviewer role and preserves requested versus reported identity',()=>{
 const review=request('review','apiReview',{requestedModel:'configured-alias',reportedModel:'provider-alias',usage:{inputTokens:17,outputTokens:3}});
 const report=summarizeOutcomes(snapshot([review,structuredClone(review),request('worker','model',{model:'worker-alias',usage:{prompt_tokens:5,completion_tokens:2}})]));
 assert.equal(report.usage.reservations,2);
 assert.equal(report.usage.eligibleCompletedRequests,2);
 assert.equal(report.usage.input.knownTokens,22);
 assert.equal(report.usage.output.knownTokens,5);
 const row=report.usage.requests.find(x=>x.id==='review');
 assert.equal(row.role,'reviewer');assert.equal(row.requestedModel,'configured-alias');assert.equal(row.reportedModel,'provider-alias');
 assert.equal(report.usage.nativeHost.tokens,null);
});
test('ambiguous reviewer requests retain uncertainty and unavailable identity stays null',()=>{
 const row={...request('unknown','apiReview',null),status:'failed',data:{requestOutcome:'unknown',reservedAt:1000}};
 const report=summarizeOutcomes(snapshot([row]));
 assert.equal(report.usage.uncertainRequests,1);assert.equal(report.usage.requests[0].role,'reviewer');
 assert.equal(report.usage.requests[0].requestedModel,null);assert.equal(report.usage.requests[0].reportedModel,null);
 assert.equal(report.usage.input.knownTokens,null);assert.equal(report.usage.nativeHost.tokens,null);
});

import {digest,normalizeGoal,normalizeTask} from '../src/harness/contracts.mjs';
import {classifyTaskOutcome} from '../src/harness/outcomes/classify.mjs';
function acceptedHostFixture(){
 const manifest=normalizeGoal({submissionId:'host-outcome',objective:'Verify a code result',acceptance:['Value is checked'],environment:'fixture',mode:'collaborative',project:{repo:'/fixture',baseCommit:'a'.repeat(40),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'value',argv:['node','checks/value.mjs']}]}});
 manifest.reviewPolicy={version:1,source:'host',hostId:'cursor',fallback:'wait'};manifest.reviewPolicyHash=digest(manifest.reviewPolicy);
 const goal={id:'goal',version:1,status:'active',activatedAt:1000,deadline:10000,manifest,hash:digest(manifest)};
 const spec=normalizeTask({submissionId:'task',kind:'coding',objective:'Produce code',acceptance:['Value is checked']},manifest);
 const checks=[{id:'value',passed:true,code:0,screenshots:[]}];
 const result={baseCommit:'a'.repeat(40),snapshot:{'src/value.mjs':'f'.repeat(64)},checks};
 const binding={goalId:goal.id,goalVersion:1,goalHash:goal.hash,taskId:'task',candidateHash:'c'.repeat(64),checksHash:digest(checks),rubricHash:'d'.repeat(64),reviewPolicyHash:manifest.reviewPolicyHash,generation:0,expiresAt:9000};
 const reviewAcceptance={ticketId:'fixture-ticket',binding,source:'host',reviewer:{source:'host',hostId:'cursor',model:null,provenance:'unknown',usage:null},verdictHash:'e'.repeat(64),acceptedAt:3000};
 const integration={commit:'b'.repeat(40),candidateCommit:'c'.repeat(40),worktree:'/fixture/integration',checks,review:'host_review',reviewAcceptance};
 const task={id:'task',goalId:goal.id,goalVersion:1,spec,hash:digest(spec),createdAt:1000,startedAt:1500,deadline:9000,attempts:1,reviews:1,reviewed:true,owner:null,status:'accepted',result,integration,reviewAcceptance};
 const ev=(seq,type,data)=>({seq,at:1000+seq*1000,goal_id:goal.id,task_id:task.id,type,data});
 const events=[ev(1,'attempt.started',{attempt:1}),ev(2,'task.result',{result:structuredClone(result),status:'awaiting_review'}),ev(3,'task.reviewed',{decision:'accept',source:'host',ticketId:'fixture-ticket'}),ev(4,'task.integrated',structuredClone(integration))];
 return {task,goal,events,requests:[],evidence:[]};
}
test('host review counts useful work only with matching integration and review receipts',()=>{
 const raw=acceptedHostFixture();assert.equal(classifyTaskOutcome(raw).usefulAccepted,true);
 for(const corrupt of [
  x=>{x.events[2].data.source='api';},
  x=>{x.events[2].data.ticketId='other';},
  x=>{x.task.reviewAcceptance.binding.goalHash='a'.repeat(64);x.task.integration.reviewAcceptance=structuredClone(x.task.reviewAcceptance);x.events[3].data.reviewAcceptance=structuredClone(x.task.reviewAcceptance);},
  x=>{x.task.reviewAcceptance.binding.checksHash='a'.repeat(64);x.task.integration.reviewAcceptance=structuredClone(x.task.reviewAcceptance);x.events[3].data.reviewAcceptance=structuredClone(x.task.reviewAcceptance);},
  x=>{x.task.integration.review='codex_operator';x.events[3].data.review='codex_operator';},
 ]){const broken=structuredClone(raw);corrupt(broken);assert.equal(classifyTaskOutcome(broken).usefulAccepted,null);}
});

test('review interactions identify host/API sources without inventing legacy host identity',()=>{
 const raw=snapshot([]);raw.events=[
  {seq:1,at:2000,task_id:'task',goal_id:'goal',type:'task.reviewed',data:{decision:'accept',source:'host'}},
  {seq:2,at:3000,task_id:'other',goal_id:'goal',type:'task.reviewed',data:{decision:'revise',source:'api'}},
  {seq:3,at:4000,task_id:'old',goal_id:'goal',type:'task.legacy_reviewed',data:{decision:'accept'}},
 ];
 assert.deepEqual(summarizeOutcomes(raw).interactions.reviewSources,{host:1,api:1,unknown:1});
});

test('common-review accepted outcomes retain their saved approval after a goal revision',()=>{
 const raw=acceptedHostFixture();
 raw.evidence=[{kind:'goal_history',id:'goal-1',data:{...structuredClone(raw.goal),id:'goal-1',goalId:'goal'}}];
 raw.goal.version=2;raw.goal.manifest.objective='Later approved scope';raw.goal.hash=digest(raw.goal.manifest);
 assert.equal(classifyTaskOutcome(raw).usefulAccepted,true);
});
