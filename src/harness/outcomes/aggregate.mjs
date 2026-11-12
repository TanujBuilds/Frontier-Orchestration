import {isDeepStrictEqual} from 'node:util';
import {digest} from '../contracts.mjs';
import {classifyTaskOutcome} from './classify.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameIdentity=(a,b)=>{try{return a!==undefined&&b!==undefined&&digest(a)===digest(b);}catch{return false;}};
const approvedHash=goal=>{try{return goal.hash===digest(goal.manifest);}catch{return false;}};
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const countBy = (rows,key) => {
 const counts = new Map();
 for(const row of rows){
  const value = key(row) ?? 'unknown';
  counts.set(value,(counts.get(value) ?? 0)+1);
 }
 return Object.fromEntries(counts);
};

function groupBy(rows,key){
 const groups = new Map();
 for(const row of rows){
  const value = key(row);
  if(!groups.has(value)) groups.set(value,[]);
  groups.get(value).push(row);
 }
 return groups;
}

function snapshotRows(snapshot,source,diagnostics){
 const rows = snapshot[source];
 if(!Array.isArray(rows)){
  diagnostics.push({code:'malformed_snapshot_collection',source});
  return [];
 }
 const valid = rows.filter(isObject);
 if(valid.length!==rows.length) diagnostics.push({code:'malformed_snapshot_row',source,count:rows.length-valid.length});
 return valid;
}

function uniqueRows(rows,key,isValid,source,diagnostics){
 const unique = [];
 for(const [id,observations] of groupBy(rows,key)){
  const [row] = observations;
  if(!isValid(id)){
   diagnostics.push({code:'invalid_record_identity',source,count:observations.length});
  }else if(observations.slice(1).some(other=>!isDeepStrictEqual(row,other))){
   const names = {events:'event',tasks:'task',goals:'goal'};
   diagnostics.push({code:'conflicting_'+names[source]+'_rows',source,id});
  }else{
   unique.push(row);
  }
 }
 return unique;
}

function readToken(raw,names){
 if(raw == null) return [null,'usage_not_recorded'];
 if(!isObject(raw)) return [null,'invalid_usage_object'];
 const values = names.filter(name=>Object.hasOwn(raw,name)).map(name=>raw[name]);
 if(!values.length) return [null,'field_not_recorded'];
 if(!values.every(nonnegative)) return [null,'invalid_token_value'];
 if(values.some(value=>value!==values[0])) return [null,'conflicting_token_fields'];
 return [values[0],null];
}

function retainProviderRaw(raw){
 const serialized = JSON.stringify(raw);
 // Keep bounded native detail, including cached/reasoning subsets, without
 // incorporating those fields into the input/output totals.
 if(Buffer.byteLength(serialized)>4096) return {providerRaw:null,providerRawReason:'provider_usage_detail_exceeds_4096_bytes'};
 return {providerRaw:JSON.parse(serialized),providerRawReason:raw===null?'usage_not_recorded':null};
}

function tokenTotals(eligible,field){
 const known = eligible.map(row=>row[field]).filter(value=>value!==null);
 const sum = known.reduce((total,n)=>total+n,0);
 const exact = known.length>0&&Number.isSafeInteger(sum);
 const reason = exact?null:!eligible.length?'no_completed_provider_requests':!known.length?'no_valid_token_values':'sum_exceeds_exact_integer_range';
 return {knownRequests:known.length,eligibleRequests:eligible.length,knownTokens:exact?sum:null,missingRequests:eligible.length-known.length,reason};
}

function summarizeUsage({requests,events,tasks,evidence,diagnostics,workerByTask,goals}){
 const starts = groupBy(events.filter(e=>e.type==='model.request.started'),e=>e.data?.requestId);
 const held = groupBy(events.filter(e=>['task.uncertain','task.interrupted'].includes(e.type)),e=>e.data?.requestId);
 const heldTasks = new Map(tasks.filter(task=>task.status==='uncertain').map(task=>[task.id,task]));
 const heldPlanners = new Map(evidence.filter(row=>row.kind==='planning'&&
  row.data?.status==='uncertain'&&row.id===row.data.id&&row.id===row.data.goalId&&
  nonnegative(row.data.attempt)&&row.data.attempt>0).map(row=>[row.id,row.data]));
 const planningHolds = groupBy(events.filter(e=>e.type==='planning.uncertain'&&e.task_id===null),e=>e.goal_id);
 const rows = [];
 const requestStates = {reserved:0,completed:0,failed:0,unknown:0};
 const compareFields = ({id,task_id,key,kind,status,data})=>({
  id,task_id,key,kind,status, malformed:!isObject(data),
  reservedAt:data?.reservedAt, savedAt:data?.savedAt, outcome:data?.requestOutcome,
  model:data?.result?.model, usage:data?.result?.usage,
  requestedModel:data?.result?.requestedModel,reportedModel:data?.result?.reportedModel,
  providerBinding:data?.providerBinding,routeHash:data?.routeHash,
 });
 for(const [id,observations] of groupBy(requests,row=>row.id)){
  if(typeof id!=='string'||!id.length){
   diagnostics.push({code:'request_without_identity',count:observations.length});
   continue;
  }
  const [row] = observations;
  const conflict = observations.slice(1).some(other=>!isDeepStrictEqual(compareFields(row),compareFields(other)));
  if(conflict) diagnostics.push({code:'conflicting_request_rows',id});
  const status = !conflict&&['reserved','completed','failed'].includes(row.status)?row.status:'unknown';
  requestStates[status]++;
  const started = (starts.get(id)??[]).filter(e=>e.task_id===row.task_id);
  const uncertainty = (held.get(id)??[]).filter(e=>e.task_id===row.task_id);
  const task = status==='reserved'?heldTasks.get(row.task_id):null;
  const planner = status==='reserved'&&row.kind==='model'?heldPlanners.get(row.task_id):null;
  const uncertaintyOwner = task?{kind:'task',id:task.id,status:task.status}
   :planner&&row.key==='plan-'+planner.attempt?{kind:'planning',id:planner.id,status:planner.status,attempt:planner.attempt}:null;
  if(row.kind==='model'&&status==='reserved'){
   uncertainty.push(...(planningHolds.get(row.task_id)??[]).filter(e=>
    nonnegative(e.data?.attempt)&&row.key==='plan-'+e.data.attempt));
  }
  const outcome = !conflict&&['not_dispatched','unknown','completed'].includes(row.data?.requestOutcome)?row.data.requestOutcome:null;
  const uncertain = status==='unknown'||status==='failed'&&(outcome==='unknown'||outcome===null)||status==='reserved'&&(uncertainty.length>0||uncertaintyOwner!==null||row.kind==='apiReview'&&outcome==='unknown');
  const providerRequest=['model','apiReview'].includes(row.kind);
  const eligible = status==='completed'&&providerRequest;
  const raw = eligible?row.data?.result?.usage??null:null;
  const missing = eligible
   ?isObject(row.data)?null:'malformed_request_data'
   :conflict?'conflicting_request_rows':!providerRequest?'not_a_provider_model_request':'request_not_completed';
  const [knownInputTokens,input] = missing?[null,missing]:readToken(raw,['prompt_tokens','input_tokens',...(row.kind==='apiReview'?['inputTokens']:[])]);
  const [knownOutputTokens,output] = missing?[null,missing]:readToken(raw,['completion_tokens','output_tokens',...(row.kind==='apiReview'?['outputTokens']:[])]);
  let attribution;
  if(row.kind==='model'&&row.data?.providerBinding){
   const worker=workerByTask.get(row.task_id),task=tasks.find(task=>task.id===row.task_id);
   const plannerGoal=goals.find(goal=>goal.id===row.task_id&&approvedHash(goal)),plannerBinding=plannerGoal?.manifest?.plannerBinding;
   const expected=worker?.bindingProvenance==='pinned'?{version:1,providerId:worker.providerId,revision:worker.revision,profileHash:worker.profileHash,policyHash:worker.policyHash}:plannerBinding;
   const routeMatches=worker?worker.routeProvenance==='recorded'?row.data.routeHash===worker.routeHash:worker.routeProvenance==='legacy_binding'&&row.data.routeHash===undefined:row.data.routeHash===undefined;
   const verified=!conflict&&sameIdentity(expected,row.data.providerBinding)&&routeMatches;
   const requested=worker?.requestedModel??plannerGoal?.manifest?.providerPolicy?.workers?.find(profile=>profile.id===plannerBinding?.providerId)?.model;
   attribution={role:task?'worker':plannerGoal?'planner':null,providerBinding:verified?row.data.providerBinding:null,
    routeHash:verified?row.data.routeHash??null:null,bindingProvenance:verified?'pinned':'unverified',
    requestedModel:verified&&typeof requested==='string'?requested.slice(0,200):null,
    reportedModel:eligible&&typeof row.data?.result?.model==='string'?row.data.result.model.slice(0,200):null};
  }
  rows.push({
   id,ownerId:conflict?null:row.task_id,kind:conflict?null:row.kind,status,
   providerOutcome:outcome,uncertain,
   observedStart:started.length>0,
   startEventIds:started.map(e=>e.seq),uncertaintyEventIds:uncertainty.map(e=>e.seq),uncertaintyOwner,
   reservedAt:!conflict&&nonnegative(row.data?.reservedAt)?row.data.reservedAt:null,
   savedAt:!conflict&&nonnegative(row.data?.savedAt)?row.data.savedAt:null,
   model:eligible&&typeof row.data?.result?.model==='string'?row.data.result.model.slice(0,200):null,
   ...(row.kind==='apiReview'?{role:'reviewer',
    requestedModel:!conflict&&typeof row.data?.result?.requestedModel==='string'?row.data.result.requestedModel.slice(0,200):null,
    reportedModel:!conflict&&typeof row.data?.result?.reportedModel==='string'?row.data.result.reportedModel.slice(0,200):null}:{}),
   ...attribution,
   knownInputTokens,knownOutputTokens,missingReasons:{input,output},
   ...(missing?{providerRaw:null,providerRawReason:missing}:retainProviderRaw(raw)),
  });
 }
 const eligible = rows.filter(row=>['model','apiReview'].includes(row.kind)&&row.status==='completed');
 return {
  reservations:rows.length,requestStates,byKind:countBy(rows,row=>row.kind),
  observedStarts:rows.filter(row=>row.observedStart).length,
  uncertainRequests:rows.filter(row=>row.uncertain).length,
  certifiedNonDispatch:rows.filter(row=>row.status==='failed'&&row.providerOutcome==='not_dispatched').length,
  eligibleCompletedRequests:eligible.length,
  knownUsageRequests:eligible.filter(row=>row.knownInputTokens!==null&&row.knownOutputTokens!==null).length,
  input:tokenTotals(eligible,'knownInputTokens'),output:tokenTotals(eligible,'knownOutputTokens'),
  nativeHost:{tokens:null,reason:'Native host token totals are unavailable in the request ledger'},
  definition:'One ledger row per request ID represents a spent reservation, even without dispatch. Starts are observed model invocation events. Uncertainty overlaps ledger states. Token coverage uses completed worker and API-review requests. Totals sum only valid recorded fields from saved results.',
  requests:rows,
 };
}

const researchCounterKinds = ['model','search','download'];
function summarizeRemoteResearch(tasks){
 const research = tasks.filter(task=>task.spec?.kind==='research');
 const rows = research.map(task=>{
  const counters = task.remoteSpent;
  const commonReason = counters==null?'counters_not_recorded':!isObject(counters)?'invalid_counter_object':null;
  const fields = researchCounterKinds.map(kind=>{
   const reason = commonReason??(!Object.hasOwn(counters,kind)?'field_not_recorded':!nonnegative(counters[kind])?'invalid_counter_value':null);
   return {kind,reason,known:reason?null:counters[kind]};
  });
  const remoteJobId = task.checkpoint?.remoteJobId??task.result?.remoteJobId;
  return {
   taskId:task.id,goalId:task.goalId,
   remoteJobId:typeof remoteJobId==='string'?remoteJobId.slice(0,200):null,
   counts:Object.fromEntries(fields.map(({kind,known})=>[kind,known])),
   missingReasons:Object.fromEntries(fields.map(({kind,reason})=>[kind,reason])),
  };
 });
 const byKind = Object.fromEntries(researchCounterKinds.map(kind=>{
  const observed = rows.map(row=>row.counts[kind]).filter(value=>value!==null);
  const sum = observed.reduce((total,n)=>total+n,0);
  const exact = observed.length>0&&Number.isSafeInteger(sum);
  const reason = exact?null:!rows.length?'no_selected_research_tasks':!observed.length?'no_valid_counter_values':'sum_exceeds_exact_integer_range';
  return [kind,{knownReservations:exact?sum:null,knownTasks:observed.length,missingTasks:rows.length-observed.length,reason}];
 }));
 return {
  source:'task.remoteSpent',eligibleTasks:rows.length,byKind,tasks:rows,
  tokens:null,tokenReason:'Remote research counters record reservations. Remote token telemetry is unavailable in this report.',
  definition:'Last saved cumulative research backend counters for selected research tasks, including zero when recorded. The denominator is all selected research tasks. Totals sum only observed values for each kind, separately from local ledger totals.',
 };
}

function planningCoverage(scope){
 const eligible = typeof scope?.planningRequestsIncluded==='boolean'?scope.planningRequestsIncluded:null;
 const reason = eligible===true
  ?'Goal planning reservations are eligible in this whole goal scope. Report coverage applies to the included rows.'
  :eligible===false
   ?'Planning reservations are outside this report. They are eligible for a complete, unpaged whole goal with no time window.'
   :'Planning reservation coverage is unknown for this snapshot.';
 return {eligible,reason};
}

const reviewDecisions = new Map([
 ['task.reviewed',['accept','revise']],
 ['task.legacy_reviewed',['accept','revise','blocked']],
 ['research.review_submitted',['accept','revise','reject']],
]);
function summarizeInteractions(events){
 const reviews = events.filter(e=>reviewDecisions.get(e.type)?.includes(e.data?.decision));
 const revisions = reviews.filter(e=>e.data.decision==='revise');
 const answers = events.filter(e=>e.type==='task.answered');
 const reviewerRuns = events.filter(e=>e.type==='reviewer.finished');
 return {
  reviews:reviews.length,revisionRequests:revisions.length,reviewDecisions:countBy(reviews,e=>e.data.decision),
  reviewSources:countBy(reviews,e=>['host','api'].includes(e.data?.source)?e.data.source:'unknown'),
  userAnswers:answers.filter(e=>e.data?.responder==='user').length,
  codexAnswers:answers.filter(e=>e.data?.responder==='codex').length,
  unknownAnswers:answers.filter(e=>!['user','codex'].includes(e.data?.responder)).length,
  reviewerRunsFinished:reviewerRuns.length,
  eventRefs:{reviews:reviews.map(e=>e.seq),revisions:revisions.map(e=>e.seq),answers:answers.map(e=>e.seq),reviewerRuns:reviewerRuns.map(e=>e.seq)},
  definition:'Counts distinct recorded decision and answer events. Reviewer run finishes are separate observations and may refer to the same review. Activity outside the log is unknown.',
 };
}

function elapsed(start,end,asOf,state){
 let reason = null;
 if(!nonnegative(asOf)) reason='invalid_snapshot_time';
 else if(!nonnegative(start)) reason=start==null?'start_not_recorded':'invalid_start';
 else if(!nonnegative(end)) reason=end==null?'end_not_recorded':'invalid_end';
 else if(start>end||end>asOf) reason='timestamps_out_of_order_or_after_snapshot';
 return {
  startedAt:nonnegative(start)?start:null,endedAt:state==='ongoing'||!nonnegative(end)?null:end,
  wallElapsedMs:reason?null:end-start,state:reason?'unknown':state,reason,
 };
}

const taskStartTypes = new Set(['task.claimed','task.native_started','attempt.started']);
const taskActiveStatuses = new Set(['running','queued','codex_ready','codex_active','suspended','awaiting_review','awaiting_legacy_review','legacy_reviewing','awaiting_supervisor','awaiting_user','ready_to_integrate']);
function taskTiming(task,outcome,events,asOf){
 const startEvent = events.find(e=>taskStartTypes.has(e.type));
 const start = outcome.attempted?task.startedAt??startEvent?.at:null;
 const status = outcome.sourceStatus;
 const endEvent = events.findLast(e=>
  e.type==='task.'+status||
  ['task.result','task.checkpoint','task.native_finished','task.recovered','task.integration_repaired'].includes(e.type)&&e.data?.status===status||
  status==='partial'&&e.type==='task.expired'||
  ['paused','stopped'].includes(status)&&task.controlReturnStatus!=null&&
    e.type==='work.control'&&e.data?.action===(status==='paused'?'pause':'stop')||
  status==='accepted'&&e.type==='task.integrated'||
  status==='accepted'&&e.type==='task.native_finished'&&typeof e.data?.commit==='string'&&Array.isArray(e.data?.checks)||
  status==='accepted'&&outcome.capability!=='coding'&&e.type==='task.reviewed'&&e.data?.decision==='accept');
 const ongoing = outcome.attempted&&taskActiveStatuses.has(status);
 // A matching transition may be old after a task resumes. Only use it as an
 // endpoint for a current held or terminal state.
 const end = ongoing?asOf:endEvent?.at;
 const state = ongoing?'ongoing':outcome.terminal?'ended':'held';
 return {id:task.id,...elapsed(start,end,asOf,state),startEventId:startEvent?.seq??null,endEventId:ongoing?null:endEvent?.seq??null};
}

function goalTiming(goal,events,asOf){
 const ongoing = goal.status==='active';
 const terminal = ['completed','partial'].includes(goal.status);
 const startEvent = events.find(e=>e.type==='goal.activated');
 const endEvent = terminal
  ?events.findLast(e=>e.type==='goal.finalized'&&e.data?.status===goal.status)
  :events.findLast(e=>e.type==='work.control'&&e.data?.action===({paused:'pause',stopped:'stop'})[goal.status]);
 const end = ongoing?asOf:endEvent?.at??(terminal?goal.receipt?.finishedAt:null);
 return {
  id:goal.id,...elapsed(goal.activatedAt??startEvent?.at,end,asOf,ongoing?'ongoing':terminal?'ended':'held'),
  startEventId:startEvent?.seq??null,endEventId:ongoing?null:endEvent?.seq??null,
 };
}

function questionWaits(task,events,asOf){
 const questions = events.filter(e=>e.type==='task.question'&&typeof e.data?.id==='string');
 const answers = events.filter(e=>e.type==='task.answered');
 const savedQuestion = Array.isArray(task.questions)?task.questions.at(-1):null;
 const openId = ['awaiting_supervisor','awaiting_user'].includes(task.status)?savedQuestion?.id??questions.at(-1)?.data.id:null;
 return [...groupBy(questions,e=>e.data.id)].map(([questionId,[question]])=>{
  const answer = answers.find(e=>e.seq>question.seq&&e.data?.questionId===questionId);
  const ongoing = !answer&&questionId===openId;
  const result = elapsed(question.at,ongoing?asOf:answer?.at,asOf,ongoing?'ongoing':'ended');
  const {wallElapsedMs,...timing} = result;
  return {taskId:task.id,questionId,...timing,waitMs:wallElapsedMs,questionEventId:question.seq,answerEventId:answer?.seq??null};
 });
}

function comparisonPolicy(snapshot,goals,tasks){
 if(snapshot.coverage?.complete!==true||snapshot.diagnostics?.length||goals.length!==1) return null;
 const [goal] = goals;
 const {manifest} = goal;
 if(!manifest?.environment||!isObject(manifest.scope)||!Array.isArray(manifest.capabilities)||
    manifest.capabilities.some(capability=>typeof capability?.id!=='string'||!nonnegative(capability.version))||
    tasks.some(task=>task.goalVersion!==goal.version)) return null;
 const project = manifest.project;
 if(project!=null&&(typeof project.baseCommit!=='string'||!Array.isArray(project.checks))) return null;
 try{
  if(goal.hash!==digest(manifest)) return null;
  const taskPolicies = tasks.map(task=>digest({
   kind:task.spec?.kind??null,checks:task.spec?.permissions?.checks??null,
   sourceScope:task.spec?.scope??null,researchPolicy:task.spec?.researchPolicy??null,
  }));
  return digest({
   environment:manifest.environment,baseCommit:project?.baseCommit??null,
   checks:project?.checks??null,behavioralChecks:project?.behavioralChecks??null,
   sourceScope:manifest.scope,researchPolicy:manifest.researchPolicy??null,
   capabilities:manifest.capabilities.map(({id,version})=>({id,version})),
   taskPolicies:[...new Set(taskPolicies)].sort(),
   from:snapshot.scope?.from??null,to:snapshot.scope?.to??null,
  });
 }catch{
  return null;
 }
}

export function summarizeOutcomes(snapshot){
 if(!isObject(snapshot)) throw Error('Expected an outcome snapshot');
 const {sourceRevision=null,scope=null} = snapshot;
 const diagnostics = [];
 diagnostics.push(...snapshotRows(snapshot,'diagnostics',diagnostics));
 const rows = source=>snapshotRows(snapshot,source,diagnostics);
 const hasId = id=>typeof id==='string'&&id.length>0;
 const goals = uniqueRows(rows('goals'),row=>row.id,hasId,'goals',diagnostics);
 const tasks = uniqueRows(rows('tasks'),row=>row.id,hasId,'tasks',diagnostics);
 const events = uniqueRows(rows('events'),row=>row.seq,nonnegative,'events',diagnostics).sort((a,b)=>a.seq-b.seq);
 const requests = rows('requests');
 const evidence = rows('evidence');
 const asOf = typeof snapshot.generatedAt==='string'?Date.parse(snapshot.generatedAt):NaN;
 const generatedAt = nonnegative(asOf)?new Date(asOf).toISOString():null;
 if(generatedAt===null) diagnostics.push({code:'invalid_snapshot_time'});
 for(const event of events){
  if(!nonnegative(event.at)||event.at>asOf) diagnostics.push({code:'invalid_event_timestamp',source:'events',id:event.seq});
 }
 const taskEvents = groupBy(events,e=>e.task_id);
 const goalEvents = groupBy(events.filter(e=>e.task_id===null),e=>e.goal_id);
 const requestsByOwner = groupBy(requests,row=>row.task_id);
 const byGoal = new Map(goals.map(goal=>[goal.id,goal]));
 const taskTimes = [], waits = [];
 const classified = tasks.map(task=>{
  const events = (taskEvents.get(task.id)??[]).filter(event=>event.goal_id===task.goalId);
  const outcome = classifyTaskOutcome({task,goal:byGoal.get(task.goalId),events,requests:requestsByOwner.get(task.id)??[],evidence});
  taskTimes.push(taskTiming(task,outcome,events,asOf));
  waits.push(...questionWaits(task,events,asOf));
  return outcome;
 });
 const attempted = classified.filter(row=>row.attempted);
 const accepted = classified.filter(row=>row.usefulAccepted===true);
 const acceptedAttempted = attempted.filter(row=>row.usefulAccepted===true).length;
 const terminal = classified.filter(row=>row.terminal).length;
 const knownAttempts = classified.map(row=>row.attemptCount).filter(nonnegative);
 const failureReasons = new Map([
  ['attempt.protocol_failed','protocol_failure'],['checks.failed','check_failure'],['task.provider_wait','provider_reconnect_wait'],
  ['task.uncertain','task_ownership_or_request_uncertain'],['task.interrupted','task_ownership_interrupted'],['task.blocked','task_blocked'],['task.failed','task_failed'],
  ['task.expired','task_deadline_reached'],['planning.blocked','planning_blocked'],['planning.uncertain','planning_request_uncertain'],
  ['planning.provider_wait','planning_provider_reconnect_wait'],['legacy_review.failed','legacy_review_failure'],
 ]);
 const failures = events.filter(e=>failureReasons.has(e.type));
 const failureEvidence = failures.map(e=>({
  eventId:e.seq,taskId:e.task_id,goalId:e.goal_id,type:e.type,
  reason:e.type==='task.blocked'&&e.data?.category==='no_progress'?'no_progress':failureReasons.get(e.type),
 }));
 const usage = {
  ...summarizeUsage({requests,events,tasks,evidence,diagnostics,goals,workerByTask:new Map(classified.filter(row=>row.worker).map(row=>[row.id,row.worker]))}),
  planning:planningCoverage(scope),remoteResearch:summarizeRemoteResearch(tasks),
 };
 const storedDiagnostics = Array.isArray(snapshot.diagnostics)?snapshot.diagnostics.length:0;
 const diagnosticCount = Math.max(storedDiagnostics,snapshot.coverage?.diagnosticCount??0)+diagnostics.length-storedDiagnostics;
 const coverage = {...snapshot.coverage,complete:snapshot.coverage?.complete===true&&diagnosticCount===0,diagnosticCount};
 return {
  schemaVersion:1,generatedAt,sourceRevision,scope,coverage,diagnostics,
  evidenceExplanation:'Classification uses saved coordinator state and exact acceptance evidence. Activity counts describe only selected tasks and recorded events. Coverage describes how much of the selected scope is represented.',
  comparisonPolicyHash:diagnostics.length?null:comparisonPolicy(snapshot,goals,tasks),
  counts:{
   tasks:classified.length,attempted:attempted.length,queued:classified.filter(row=>row.queued).length,
   terminal,nonterminal:classified.length-terminal,usefulAccepted:accepted.length,
   acceptedCoding:accepted.filter(row=>row.capability==='coding').length,
   acceptedResearch:accepted.filter(row=>row.capability==='research').length,
   unverified:classified.filter(row=>row.usefulAccepted===null).length,
   byDisposition:countBy(classified,row=>row.disposition),
   byCapability:countBy(classified,row=>row.capability),
   acceptanceRate:{
    numerator:acceptedAttempted,denominator:attempted.length,
    value:attempted.length?acceptedAttempted/attempted.length:null,
    reason:attempted.length?null:'no_attempted_tasks',
    definition:'Verified useful acceptances among all attempted tasks in scope, including failures and tasks with unverified evidence in the denominator.',
   },
  },
  usage,interactions:summarizeInteractions(events),
  retries:{
   knownWorkerAttempts:knownAttempts.length?knownAttempts.reduce((n,x)=>n+x,0):null,
   knownWorkerRetries:knownAttempts.length?knownAttempts.reduce((n,x)=>n+Math.max(0,x-1),0):null,
   tasksWithKnownAttemptCount:knownAttempts.length,eligibleTasks:classified.length,
   observedFailureEvents:countBy(failures,e=>e.type),failureReasons:countBy(failureEvidence,row=>row.reason),failureEvidence,
   definition:'Worker retry count is the saved or evidenced attempt count beyond the first per task. Native starts are separate from the worker counter. Event breakdowns can overlap one attempt.',
  },
  timing:{
   goals:goals.map(goal=>goalTiming(goal,goalEvents.get(goal.id)??[],asOf)),tasks:taskTimes,questionWaits:waits,
   definition:'Goal wall starts at activation. Task wall starts at first recorded execution. Endpoints are matching settlement events or the snapshot time for ongoing work. Question waits pair matching question and answer IDs. Intervals can overlap and include idle time.',
  },
  tasks:classified,
  limitations:[
   'Open intervals are as of the snapshot. No total of overlapping timelines, active-time estimate or human labor estimate is reported.',
   'Provider-native usage details may contain subsets such as cached and reasoning tokens. Only recognized input/output fields enter token totals.',
   'A report describes observed outcomes and recorded usage. It cannot estimate spending, savings or causal effects.',
  ],
 };
}

const cohortFields = ['scenario','sourcePolicy','checkPolicy','cohort'];
export function compareOutcomeReports(selection){
 if(!Array.isArray(selection)||selection.length<2||selection.length>10||!selection.every(isObject)) {
  throw Error('Select 2 to 10 outcome reports to compare');
 }
 const first = selection[0];
 const hasCohort = entry=>cohortFields.every(field=>typeof entry.cohort?.[field]==='string'&&entry.cohort[field].trim()&&entry.cohort[field].length<=200);
 const complete = entry=>entry.report?.schemaVersion===1&&entry.report.coverage?.complete===true&&typeof entry.report.comparisonPolicyHash==='string';
 const reasons = [];
 if(!selection.every(hasCohort)) reasons.push('cohort_metadata_missing_or_invalid');
 else if(!selection.every(entry=>cohortFields.every(field=>entry.cohort[field]===first.cohort[field]))) reasons.push('cohort_metadata_mismatch');
 if(!selection.every(complete)) reasons.push('incomplete_scope_or_unverified_policy');
 else if(!selection.every(entry=>entry.report.comparisonPolicyHash===first.report.comparisonPolicyHash)) reasons.push('source_or_check_policy_mismatch');
 const times = selection.map(entry=>entry.report?.generatedAt).filter(time=>typeof time==='string'&&nonnegative(Date.parse(time)));
 const revisions = new Set(selection.map(entry=>entry.report?.sourceRevision??null));
 return {
  schemaVersion:1,compatible:reasons.length===0,reasons,
  generatedAt:times.length?new Date(Math.max(...times.map(time=>Date.parse(time)))).toISOString():null,
  sourceRevision:revisions.size===1?[...revisions][0]:null,
  evidenceExplanation:reasons.length?'Comparability could not be established. Rows are descriptive.':'Selected rows have matching declared cohort and saved source/check policy. Differences are descriptive.',
  rows:selection.map(({report,cohort})=>({
   cohort:Object.fromEntries(cohortFields.map(field=>[field,typeof cohort?.[field]==='string'?cohort[field].slice(0,200):null])),
   scope:report?.scope??null,generatedAt:report?.generatedAt??null,sourceRevision:report?.sourceRevision??null,
   counts:report?.counts??null,
   usage:report?.usage?{input:report.usage.input,output:report.usage.output}:null,
  })),
 };
}
