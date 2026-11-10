import assert from 'node:assert/strict';
import test from 'node:test';
import {digest} from '../src/harness/contracts.mjs';
import {compareOutcomeReports, summarizeOutcomes} from '../src/harness/outcomes/aggregate.mjs';
import {renderOutcomeMarkdown} from '../src/harness/outcomes/render.mjs';

const asOf = 10_000;
const scope = {goalId:'goal', from:null, to:null, cursor:null};
const manifest = {
  schema:1, environment:'fixture', mode:{id:'collaborative',version:1},
  capabilities:[{id:'coding',version:1}],
  project:{baseCommit:'a'.repeat(40), checks:[{id:'unit'}]},
  scope:{includeDomains:[], excludeDomains:[], seedUrls:[]},
};
const goal = {id:'goal', version:1, status:'active', activatedAt:1000, manifest, hash:digest(manifest)};
const event = (seq,type,{at=seq*100,taskId='task',goalId='goal',data={}}={}) =>
 ({seq,at,goal_id:goalId,task_id:taskId,type,data});
const task = (id,status,extra={}) =>
 ({id,goalId:'goal',goalVersion:1,status,spec:{kind:'coding',actor:'deepseek',permissions:{checks:['unit']}},createdAt:1000,startedAt:null,attempts:0,...extra});
const request = (id,status,usage,extra={}) =>
 ({id,task_id:'task',key:id,kind:'model',status,data:{reservedAt:1200,...extra,...(status==='completed'?{result:{model:'fixture',usage}}:{})}});
const snapshot = (extra={}) => ({
 schemaVersion:1,generatedAt:new Date(asOf).toISOString(),sourceRevision:null,
 scope,coverage:{complete:true,nextCursor:null},diagnostics:[],goals:[goal],
 tasks:[],events:[],requests:[],evidence:[],...extra,
});

test('counts a request once using its saved result, independent of captures and fragments', () => {
 const first = request('one','completed',{prompt_tokens:10,completion_tokens:5,prompt_tokens_details:{cached_tokens:8},completion_tokens_details:{reasoning_tokens:4}});
 const report = summarizeOutcomes(snapshot({
  tasks:[task('task','failed',{startedAt:1000,attempts:3})],
  requests:[first,structuredClone(first),request('two','completed',null)],
  events:[
   event(20,'model.request.started',{data:{requestId:'one'}}),
   event(21,'model.output',{data:{requestId:'one',usage:{prompt_tokens:99,completion_tokens:99}}}),
   event(22,'model.request.completed',{data:{requestId:'one',usage:first.data.result.usage}}),
   event(23,'model.request.completed',{data:{requestId:'one',usage:first.data.result.usage}}),
  ],
  evidence:[2,3].map(n=>({kind:'outcome',id:'capture-'+n,data:{reportedUsage:[first.data.result.usage]}})),
 }));
 assert.equal(report.counts.attempted,1);
 assert.equal(report.counts.usefulAccepted,0);
 assert.equal(report.counts.acceptanceRate.denominator,1);
 assert.equal(report.retries.knownWorkerAttempts,3);
 assert.equal(report.retries.knownWorkerRetries,2);
 assert.equal(report.usage.requestStates.completed,2);
 assert.equal(report.usage.eligibleCompletedRequests,2);
 assert.equal(report.usage.knownUsageRequests,1);
 assert.deepEqual(report.usage.input,{knownRequests:1,eligibleRequests:2,knownTokens:10,missingRequests:1,reason:null});
 assert.deepEqual(report.usage.output,{knownRequests:1,eligibleRequests:2,knownTokens:5,missingRequests:1,reason:null});
 assert.equal(report.usage.observedStarts,1);
 assert.equal(report.usage.requests[0].providerRaw.prompt_tokens_details.cached_tokens,8);
 assert.equal(report.usage.requests[1].knownInputTokens,null);
 assert.equal(report.usage.requests[1].missingReasons.input,'usage_not_recorded');
 assert.equal(report.usage.nativeHost.tokens,null);
});

test('uses separate input and output coverage and preserves a reported zero', () => {
 const report = summarizeOutcomes(snapshot({requests:[
  request('one','completed',{prompt_tokens:0,completion_tokens:-1}),
  request('two','completed',{input_tokens:'20',output_tokens:0}),
  request('three','completed',{prompt_tokens:3,input_tokens:9,completion_tokens:2.5}),
  request('four','completed',{prompt_tokens:Infinity,completion_tokens:NaN}),
 ]}));
 assert.deepEqual(report.usage.input,{knownRequests:1,eligibleRequests:4,knownTokens:0,missingRequests:3,reason:null});
 assert.deepEqual(report.usage.output,{knownRequests:1,eligibleRequests:4,knownTokens:0,missingRequests:3,reason:null});
 assert.equal(report.usage.knownUsageRequests,0);
 assert.equal(report.usage.requests[2].missingReasons.input,'conflicting_token_fields');
});

test('separates request reservation, observed start, certified failure and uncertainty', () => {
 const report = summarizeOutcomes(snapshot({
  requests:[
   request('pending','reserved'),
   request('aborted','failed',undefined,{requestOutcome:'unknown'}),
   request('held','failed',undefined,{requestOutcome:'not_dispatched'}),
   request('pending-ambiguous','reserved'),
   {...request('legacy','completed',null),kind:'codexReview'},
  ],
  events:[
   event(20,'model.request.started',{data:{requestId:'pending'}}),
   event(21,'model.request.started',{data:{requestId:'aborted'}}),
   event(22,'model.request.started',{data:{requestId:'held'}}),
   event(23,'task.uncertain',{data:{requestId:'pending-ambiguous'}}),
  ],
 }));
 assert.equal(report.usage.reservations,5);
 assert.equal(report.usage.observedStarts,3);
 assert.deepEqual(report.usage.requestStates,{reserved:2,completed:1,failed:2,unknown:0});
 assert.equal(report.usage.uncertainRequests,2);
 assert.equal(report.usage.certifiedNonDispatch,1);
 assert.equal(report.usage.eligibleCompletedRequests,0);
 assert.equal(report.usage.input.knownTokens,null);
 assert.equal(report.usage.input.reason,'no_completed_provider_requests');
});

test('reports conflicting observations for one request without summing either payload', () => {
 const report = summarizeOutcomes(snapshot({
  requests:[request('one','completed',{prompt_tokens:10}),request('one','completed',{prompt_tokens:12})],
 }));
 assert.equal(report.usage.reservations,1);
 assert.equal(report.usage.input.knownTokens,null);
 assert.equal(report.usage.requestStates.unknown,1);
 assert.ok(report.diagnostics.some(d=>d.code==='conflicting_request_rows'));
});

test('keeps queued, failed, blocked, stopped and unverified evidence visible in denominators', () => {
 const report = summarizeOutcomes(snapshot({tasks:[
  task('queued','queued'),
  task('blocked','blocked',{startedAt:1000,attempts:1}),
  task('stopped','stopped',{startedAt:1000,attempts:2}),
  task('expired','partial',{startedAt:1000,attempts:2}),
  task('unverified','accepted',{startedAt:1000,attempts:1}),
 ],events:[event(25,'task.expired',{taskId:'expired'})]}));
 assert.equal(report.counts.tasks,5);
 assert.equal(report.counts.attempted,4);
 assert.equal(report.counts.queued,1);
 assert.equal(report.counts.terminal,2);
 assert.equal(report.counts.nonterminal,3);
 assert.equal(report.counts.byDisposition.expired,1);
 assert.equal(report.counts.byDisposition.blocked,1);
 assert.equal(report.counts.byDisposition.stopped,1);
 assert.equal(report.counts.unverified,1);
 assert.equal(report.counts.acceptanceRate.denominator,4);
});

test('zero selected work has an undefined ratio and unknown native usage', () => {
 const report = summarizeOutcomes(snapshot());
 assert.equal(report.counts.attempted,0);
 assert.equal(report.counts.acceptanceRate.value,null);
 assert.equal(report.counts.acceptanceRate.reason,'no_attempted_tasks');
 assert.equal(report.usage.nativeHost.tokens,null);
 assert.equal(report.usage.knownUsageRequests,0);
});

test('reports wall elapsed per task and goal without adding overlapping timelines', () => {
 const report = summarizeOutcomes(snapshot({
  goals:[{...goal,status:'completed'}],
  tasks:[
   task('closed','failed',{startedAt:2000,attempts:1}),
   task('active','running',{startedAt:2500,attempts:1}),
   task('bad','failed',{startedAt:'bad',attempts:1}),
   task('held','blocked',{startedAt:6000,attempts:1}),
  ],
  events:[
   event(40,'task.failed',{taskId:'closed',at:6000}),
   event(41,'task.failed',{taskId:'bad',at:1000}),
   event(42,'task.blocked',{taskId:'held',at:6500}),
   event(50,'goal.finalized',{taskId:null,at:8000,data:{status:'completed'}}),
  ],
 }));
 assert.deepEqual(report.timing.tasks.map(x=>[x.id,x.wallElapsedMs,x.state]),[
  ['closed',4000,'ended'],['active',7500,'ongoing'],['bad',null,'unknown'],['held',500,'held'],
 ]);
 assert.equal(report.timing.goals[0].wallElapsedMs,7000);
 assert.equal(report.timing.totalTaskWallMs,undefined);
});

test('counts recorded interventions and computes only evidenced clarification waits', () => {
 const question = event(20,'task.question',{data:{id:'q'}});
 const report = summarizeOutcomes(snapshot({
  tasks:[task('task','awaiting_user',{startedAt:1000,attempts:1})],
  events:[
   question,structuredClone(question),
   event(30,'task.answered',{data:{questionId:'q',responder:'user'}}),
   event(40,'task.reviewed',{data:{decision:'revise'}}),
   event(50,'reviewer.finished',{data:{status:'completed'}}),
   event(60,'research.review_submitted',{data:{decision:'accept'}}),
   event(70,'task.question',{data:{id:'open'}}),
  ],
 }));
 assert.equal(report.interactions.reviews,2);
 assert.equal(report.interactions.revisionRequests,1);
 assert.equal(report.interactions.userAnswers,1);
 assert.equal(report.interactions.reviewerRunsFinished,1);
 assert.deepEqual(report.timing.questionWaits.map(x=>[x.questionId,x.waitMs,x.state]),[
  ['q',1000,'ended'],['open',3000,'ongoing'],
 ]);
});

test('compares only explicitly selected, matching cohorts and exposes mismatches descriptively', () => {
 const report = summarizeOutcomes(snapshot());
 const cohort = {scenario:'fixed fixture',cohort:'controlled set',sourcePolicy:'fixture input',checkPolicy:'unit-v1'};
 const first = {report,cohort};
 const same = {report:summarizeOutcomes(snapshot({generatedAt:new Date(asOf+1000).toISOString()})),cohort};
 assert.equal(compareOutcomeReports([first,same]).compatible,true);
 assert.equal(compareOutcomeReports([first,{...same,cohort:{...cohort,scenario:'different'}}]).compatible,false);
 const otherManifest = {...goal.manifest,project:{baseCommit:'b'.repeat(40),checks:[{id:'unit'}]}};
 const policyChanged = summarizeOutcomes(snapshot({goals:[{...goal,manifest:otherManifest,hash:digest(otherManifest)}]}));
 assert.equal(compareOutcomeReports([first,{report:policyChanged,cohort}]).compatible,false);
 const partial = {report:{...report,coverage:{complete:false}},cohort};
 assert.equal(compareOutcomeReports([first,partial]).compatible,false);
 assert.equal(compareOutcomeReports([first,{report}]).compatible,false);
 assert.equal(compareOutcomeReports([first,{report}]).rows.length,2);
});

test('renders partial coverage and unknown values in compact Markdown without raw provider content', () => {
 const report = summarizeOutcomes(snapshot({
  coverage:{complete:false,nextCursor:'cursor'},
  scope:{...scope,goalId:'<script>**fake**</script>'},
  requests:[request('one','completed',{prompt_tokens:0,debug:'do not print provider prose'})],
 }));
 const markdown = renderOutcomeMarkdown(report);
 assert.match(markdown,/Partial/i);
 assert.match(markdown,/0 tokens.*1 of 1/);
 assert.match(markdown,/unknown.*0 of 1/i);
 assert.match(markdown,/native host.*unavailable/i);
 assert.doesNotMatch(markdown,/<script>|do not print provider prose/);
});

test('planner uncertainty uses the matching reserved attempt and does not imply observed invocation', () => {
 const plan = n => ({...request('plan-row-'+n,'reserved'),task_id:'goal',key:'plan-'+n});
 const report = summarizeOutcomes(snapshot({
  requests:[plan(1),plan(2)],
  events:[event(20,'planning.uncertain',{taskId:null,data:{attempt:2}})],
 }));
 assert.equal(report.usage.uncertainRequests,1);
 assert.equal(report.usage.observedStarts,0);
 assert.deepEqual(report.usage.requests.map(row=>row.uncertaintyEventIds),[[],[20]]);
});

test('retains rejected research decisions and stable blocker event evidence', () => {
 const report = summarizeOutcomes(snapshot({events:[
  event(20,'research.review_submitted',{data:{decision:'reject'}}),
  event(21,'task.legacy_reviewed',{data:{decision:'blocked'}}),
  event(22,'task.blocked',{data:{category:'no_progress',reason:'provider prose'} }),
 ]}));
 assert.equal(report.interactions.reviews,2);
 assert.deepEqual(report.interactions.reviewDecisions,{reject:1,blocked:1});
 assert.deepEqual(report.retries.failureEvidence,[{eventId:22,taskId:'task',goalId:'goal',type:'task.blocked',reason:'no_progress'}]);
});

test('preserves valid rows when collections, event identities and timestamps are malformed', () => {
 const report = summarizeOutcomes(snapshot({
  generatedAt:'not-a-time',
  tasks:[null,task('task','running',{startedAt:1000,questions:{malformed:true}})],
  events:[event(1,'task.claimed'),event(1,'task.failed'),event(20,'task.blocked',{at:'bad'})],
  requests:null,
 }));
 assert.equal(report.coverage.complete,false);
 assert.equal(report.counts.tasks,1);
 assert.equal(report.generatedAt,null);
 assert.equal(report.timing.tasks[0].wallElapsedMs,null);
 assert.deepEqual(new Set(report.diagnostics.map(row=>row.code)),new Set([
  'invalid_snapshot_time','malformed_snapshot_row','malformed_snapshot_collection','conflicting_event_rows','invalid_event_timestamp',
 ]));
});
