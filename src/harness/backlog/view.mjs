import {identifier} from '../contracts.mjs';
import {isOvernightV2} from '../overnight.mjs';
import {retainedProgress} from '../recovery-diagnostics.mjs';
import {MAX_BACKLOG_ITEMS} from './contract.mjs';
import {storedWorkerAttribution} from '../outcomes/attribution.mjs';

const prioritiesByRank = ['background', 'normal', 'blocking'];
const queued = new Set(['queued','suspended']);
const reviewStates = new Set(['awaiting_review','awaiting_legacy_review','legacy_reviewing','ready_to_integrate']);
const deadlineReasons = new Set(['Original deadline reached; saved evidence retained','Deadline reached']);
const short = value => typeof value === 'string' ? value.slice(0,240) : null;
const state = (status,reasonCode,explanation) => ({status,reasonCode,explanation});
const isHashBoundResearch = spec => spec.kind === 'research' && spec.researchPolicy?.version === 3;

function ownsWorkerTask(task, {workerLease}) {
  return task.owner && task.ownerLease && task.interruptedOwner !== task.owner &&
    workerLease?.token === task.owner && workerLease.generation === task.ownerLease;
}

function taskState(task, {goal, byId, hostState, request, researchReview, now, deadline}) {
  const {status, spec, id} = task;
  const actor = task.executionActor ?? spec.actor;
  const workerOwns = ownsWorkerTask(task,hostState);
  if (status === 'accepted') {
    if (spec.kind === 'coding' && !task.integration?.commit) {
      return state('blocked','integration_evidence_missing','The saved coding acceptance has no integration receipt. Inspect task_get before relying on it.');
    }
    return state('accepted','accepted',task.integration?.commit ? 'Accepted integration is saved.' : 'The coordinator saved an accepted result.');
  }
  if (status === 'failed' || status === 'cancelled') {
    return state('failed',status,status === 'failed' ? 'The coordinator saved a failed result.' : 'The coordinator cancelled this task and retained its record.');
  }
  if (status === 'partial' && !deadlineReasons.has(task.reason)) {
    return state('partial','partial_result','Only partial evidence is saved. Inspect task_get for the retained work.');
  }
  if (deadline !== null && now >= deadline) {
    const taskDeadline = task.deadline != null && (goal?.deadline == null || task.deadline < goal.deadline);
    const instruction = request?.outcome === 'unknown' ? ' Reconcile the original spent request.' : '';
    return state('expired',taskDeadline ? 'task_deadline_expired' : 'goal_deadline_expired',
      'The original deadline elapsed. Saved work and spending remain.' + instruction);
  }
  if (status === 'partial') return state('partial','partial_result','Only partial evidence is saved.');
  if (request?.outcome === 'unknown') {
    return state('uncertain','request_outcome_unknown','Reconcile the original spent request with its backend before attempting continuation.');
  }
  if (status === 'uncertain' || status === 'taking_over') {
    return state('uncertain','execution_uncertain','Inspect saved evidence and reconcile execution ownership before continuing.');
  }
  if (!goal || goal.id !== task.goalId) {
    return state('blocked','goal_missing','The task’s approval record is missing. Inspect goal_get.');
  }
  if (task.goalVersion !== goal.version) {
    return state('blocked','task_approval_stale','The task needs explicit rebind to the current approved goal version.');
  }
  const integrationPending = goal.integrationPending?.taskId === id;
  const pending = integrationPending || ['running','legacy_reviewing','codex_active'].includes(status) ||
    task.controlReturnStatus === 'codex_active' || task.native?.writerActive || goal.integrationOwner === id;
  const integrationControl = integrationPending ?
    'A protected import is pending. Inspect task_get and goal_get to verify the saved integration boundary.' : null;
  if (goal.status === 'stopped' || task.stopRequested || status === 'stopped') {
    return state('stopped',pending ? 'stop_pending' : goal.status === 'stopped' ? 'goal_stopped' : 'task_stopped',
      pending ? integrationControl ?? 'Stop is requested. Verify that the owner has reached a safe boundary before continuing.' :
        'Work is stopped. Resume explicitly through work_control within the original limits.');
  }
  if (goal.status === 'paused' || task.pauseRequested || status === 'paused') {
    return state('paused',pending ? 'pause_pending' : goal.status === 'paused' ? 'goal_paused' : 'task_paused',
      pending ? integrationControl ?? 'Pause is requested. The owner may still be reaching a safe boundary.' :
        'Work is paused. Resume explicitly through work_control within the original limits.');
  }
  if (goal.status !== 'active') return state('blocked','goal_inactive','The goal has no active execution window.');
  if (goal.deadline == null) return state('blocked','goal_deadline_missing','The original approval deadline is unavailable. Inspect goal_get.');
  if (spec.kind === 'coding' && goal.integrationSealed) {
    return state('blocked','integration_sealed','The goal integration workspace is retired. Inspect the retained partial result.');
  }
  if (status === 'awaiting_user' || status === 'awaiting_supervisor') {
    const question = task.questions?.at(-1);
    if (!question || task.answers?.some(answer => answer.questionId === question.id)) {
      return state('blocked','question_missing','The waiting state has no matching unanswered question. Inspect task_get.');
    }
    return status === 'awaiting_user'
      ? state('waiting_answer','owner_answer_required','The owner must answer the saved question through question_answer.')
      : state('waiting_answer','supervisor_answer_required','The main supervisor or owner must answer the saved question through question_answer.');
  }
  if (task.checkpoint?.phase === 'no_progress' && ['blocked','running','queued','suspended'].includes(status)) {
    return state('blocked','no_progress','No progress on repeated protected-check failures. Inspect the saved candidate and check evidence.');
  }
  if (task.routingWait && queued.has(status)) {
    const wait = task.routingWait;
    if (wait.goalHash === goal.hash && wait.goalVersion === goal.version && wait.taskHash === task.hash && wait.decision?.status === 'waiting') {
      return state('waiting_provider', wait.decision.reasonCode, short(wait.decision.explanation));
    }
  }
  const wait = task.providerWait;
  if (wait && (queued.has(status) || status === 'running' || status === 'blocked')) {
    if (request?.outcome !== 'not_dispatched') {
      return state('uncertain','provider_evidence_unverified','The reconnect record lacks a matching certified non-dispatch request. Reconcile the saved request.');
    }
    if (now >= wait.until) {
      return state('blocked','provider_reconnect_expired','The original provider reconnect window elapsed. The request remains spent.');
    }
    if (task.spent?.model >= spec.limits?.modelCalls) {
      return state('blocked','provider_budget_exhausted','The original request budget is spent. Inspect retained work before continuing.');
    }
    if (status !== 'blocked' && (!workerOwns || wait.readyOwner !== task.owner)) {
      return state('waiting_provider','provider_unavailable','The spent request did not dispatch. The existing worker can reconnect within the saved window and remaining limits.');
    }
  }
  if (status === 'blocked') return state('blocked','task_blocked','Inspect the saved blocker through task_get before continuing.');
  if (status === 'running') {
    return workerOwns
      ? state('running','worker_ownership_confirmed','The current worker holds the task. Inspect task_get for the latest saved boundary.')
      : state('uncertain','worker_ownership_unverified','Saved worker ownership could not be verified. Reconcile the execution boundary before continuing.');
  }
  if (status === 'codex_active') {
    return hostState.nativeTaskIds?.has(id)
      ? state('running','native_ownership_confirmed','The supported native host reports current task ownership.')
      : state('uncertain','native_ownership_unverified','Confirm whether the native host still owns this task. Saved ownership alone cannot establish current activity or quiescence.');
  }
  if (!queued.has(status) && status !== 'codex_ready' && !reviewStates.has(status)) {
    return state('blocked','unrecognized_task_status','Inspect task_get for this saved state.');
  }

  for (const taskId of spec.dependsOn) {
    const dependency = byId.get(taskId);
    if (!dependency || dependency.goalId !== task.goalId) {
      return {...state('blocked','dependency_missing','A referenced dependency is missing from the approved goal. Inspect task_get.'),
        dependency:{taskId,sourceStatus:null}};
    }
    if (dependency.status !== 'accepted' || (dependency.spec.kind === 'coding' && !dependency.integration?.commit)) {
      const stopped = dependency.status === 'stopped' || dependency.stopRequested;
      const failed = ['failed','partial','cancelled','blocked','uncertain'].includes(dependency.status);
      const reasonCode = stopped ? 'dependency_stopped' : failed ? 'dependency_blocked' : 'dependency_incomplete';
      const explanation = stopped ? 'The dependency is stopped. Resolve the stop and obtain acceptance before this task can advance.' :
        failed ? 'The dependency has a saved blocker or unfinished outcome. Inspect it before this task can advance.' :
          'The dependency has no accepted result yet.';
      return {...state('waiting_dependency',reasonCode,explanation),dependency:{taskId,sourceStatus:dependency.status}};
    }
  }

  const {mode} = goal.manifest;
  const {review} = mode;
  if (reviewStates.has(status)) {
    if (status === 'ready_to_integrate') {
      return state('waiting_review','integration_pending', review === 'operator' ?
        'The candidate awaits protected integration through task_integrate.' :
        'The candidate awaits the existing worker’s protected integration. An integration receipt is pending.');
    }
    if (status === 'awaiting_review') {
      // Research consumes a round on reservation and can submit a saved
      // ticket after reaching its round limit.
      const hashBoundResearch = isHashBoundResearch(spec);
      if (review !== 'operator' || hashBoundResearch && mode.id !== 'collaborative') {
        return state('blocked','mode_review_unavailable','The current approved mode prohibits the review required by this saved result.');
      }
      if (hashBoundResearch) {
        const cap = Math.min(2,spec.limits?.reviews);
        if (cap === 0 || researchReview?.reserved === false && task.reviews >= cap) {
          return state('blocked','review_budget_exhausted','The approved research review allowance is exhausted. Inspect the saved candidate through task_get.');
        }
        if (researchReview?.reserved === false && researchReview.total >= goal.manifest.limits?.reviewAgentRuns) {
          return state('blocked','reviewer_budget_exhausted','The goal’s approved reviewer-run allowance is exhausted. Inspect the saved candidate through task_get.');
        }
        return state('waiting_review','research_review_required','Inspect task_get for the hash-bound research candidate and its saved review tickets.');
      }
      if (task.reviews >= spec.limits?.reviews) {
        return state('blocked','review_budget_exhausted','The original operator review allowance is spent. Inspect the saved result through task_get.');
      }
      return state('waiting_review','operator_review_required','The saved candidate needs an operator review before acceptance.');
    }
    if (review !== 'legacy') {
      return state('blocked','mode_review_unavailable','The current approved mode prohibits the review required by this saved result.');
    }
    if (request?.kind === 'codexReview' && request.outcome === 'completed') {
      return state('waiting_review','saved_review_pending','A review response is saved and awaits coordinator processing.');
    }
    if (task.spent?.codexReview >= spec.limits?.reviews) {
      return state('blocked','review_budget_exhausted','The original background review allowance is spent. Inspect the saved result through task_get.');
    }
    return state('waiting_review','legacy_review_pending','The candidate awaits independent review under the approved mode.');
  }
  if (goal.manifest.mode.actors && !goal.manifest.mode.actors.includes(actor)) {
    return state('blocked','mode_actor_unavailable','The approved mode does not permit this execution actor.');
  }
  if (actor === 'codex' || status === 'codex_ready') {
    return state('waiting_host','native_host_required','Start or resume the task explicitly from a supported native host.');
  }
  return state('ready','dependency_and_approval_ready','The task meets the saved dependency and approval conditions for the existing worker queue.');
}

function compactCheckpoint(saved) {
  if (!saved) return null;
  const {kind,eventSeq,requestId,phase,journalSequence,commit,at,attempt,checks} = saved;
  return {kind,eventSeq:eventSeq??null, ...(requestId?{requestId}:{}), ...(phase?{phase}:{}),
    ...(journalSequence?{journalSequence}:{}), ...(commit?{commit}:{}), ...(at!=null?{at}:{}),
    ...(attempt!=null?{attempt}:{}), ...(Array.isArray(checks)?{checks:checks.slice(0,20).map(({id,passed})=>({id,passed})),
      checksOmitted:Math.max(0,checks.length-20)}:{})};
}

function projectTask(ref, context) {
  const {goal, group, byId, priorities, evidence} = context;
  const task = byId.get(ref.taskId);
  const identity = {key:ref.key,taskId:ref.taskId,sourceStatus:null};
  if (!task) return {...identity,...state('blocked','task_missing','The group references a missing task record.')};
  if (task.goalId !== group.goalId) {
    return {...identity,...state('blocked','task_goal_mismatch','The referenced task belongs to a different goal.')};
  }
  const deadline = Math.min(task.deadline??Infinity,goal?.deadline??Infinity);
  const deadlineValue = Number.isFinite(deadline) ? deadline : null;
  const saved = evidence.get(task.id);
  const request = saved?.request?.pending && ownsWorkerTask(task,context.hostState) ? null : saved?.request??null;
  const projected = taskState(task,{...context,request,researchReview:saved?.researchReview,deadline:deadlineValue});
  const priority = task.priority ?? task.spec.priority ?? null;
  const effectivePriority = prioritiesByRank[priorities.get(task.id)] ?? null;
  const blocker = task.firstBlocker;
  return {
    ...identity, sourceStatus:task.status, ...projected, sourceReasonCode:task.reasonCode??null, sourceReason:short(task.reason),
    objective:short(task.spec.objective), actor:task.executionActor??task.spec.actor, kind:task.spec.kind, deadline:deadlineValue,
    priority, effectivePriority,
    priorityExplanation:effectivePriority && prioritiesByRank.indexOf(effectivePriority) > prioritiesByRank.indexOf(priority)
      ? 'An unfinished dependent raises this task’s effective priority.' : null,
    spent:task.spent??null, integrationCommit:task.integration?.commit??null,
    ...(goal?.manifest.providerPolicy ? {worker: context.store ? storedWorkerAttribution(context.store,task) : null,
      routing: task.spec.routing??null, route: task.route??null, routingWait: task.routingWait??null} : {}),
    questionId:projected.status === 'waiting_answer' ? task.questions.at(-1).id : null,
    recovery:{
      outcome:request?.outcome??null, requestId:request?.id??null, requestKind:request?.kind??null,
      reconnectUntil:task.providerWait?.until??null, retryAt:task.providerWait?.retryAt??null,
      lastVerifiedCheckpoint:compactCheckpoint(saved?.checkpoint),
      firstBlocker:blocker ? {at:blocker.at??null,reason:short(blocker.reason)} : null,
    },
  };
}

function groupState(items, groupIssue) {
  if (groupIssue) {
    return state('blocked',groupIssue,groupIssue === 'goal_missing' ?
      'The saved group has no matching goal record.' : 'The group references a superseded or mismatched approval.');
  }
  if (!items.length) return state('blocked','group_items_missing','The group has no saved task references.');
  if (items.some(item => item.sourceStatus === null)) {
    return state('blocked','group_task_reference_missing','Inspect the saved task references for this group.');
  }
  if (items.every(item => item.status === 'accepted')) return state('accepted','group_accepted','Every task has an accepted result.');
  if (items.every(item => ['accepted','partial','expired','failed'].includes(item.status))) {
    if (['expired','failed'].includes(items[0].status) && items.every(item => item.status === items[0].status)) {
      return state(items[0].status,items[0].reasonCode,items[0].explanation);
    }
    return state('partial','group_partial','The group contains retained work without complete acceptance.');
  }
  const next = items.find(item => item.status === 'running') ?? items.find(item => item.status === 'ready') ??
    items.find(item => !['accepted','failed','partial','expired'].includes(item.status));
  return state(next.status,next.reasonCode,next.explanation);
}

export function projectBacklog({group,tasks,goal,priorities=new Map(),hostState={},evidence=new Map(),now=Date.now(),store}) {
  // Ordinary workflow receipts pin a goal version, but do not save its hash.
  // Keep that absence visible instead of inventing a historical hash.
  const versionOnly = group.origin?.kind === 'workflow_run' && group.goalHash === null;
  const groupIssue = !goal || goal.id !== group.goalId ? 'goal_missing' :
    group.goalVersion !== goal.version || !versionOnly && group.goalHash !== goal.hash ? 'stale_group_approval' : null;
  const byId = tasks instanceof Map ? tasks : new Map(tasks.map(task => [task.id,task]));
  const items = (group.items??[]).slice(0,MAX_BACKLOG_ITEMS).map(ref => projectTask(ref,{group,goal,byId,priorities,hostState,evidence,now,store}));
  return {
    id:group.id,goalId:group.goalId,goalVersion:group.goalVersion,goalHash:group.goalHash,submissionId:group.submissionId,at:group.at,
    origin:group.origin??{kind:'backlog_group'},
    currentGoalVersion:goal?.version??null, sourceStatus:goal?.status??null, deadline:goal?.deadline??null,
    sourceRevision:goal?.manifest.project?.baseCommit??null, stale:groupIssue!==null,
    ...groupState(items,groupIssue), items,
  };
}

function readCursor(cursor, filter) {
  if (cursor === undefined) return null;
  try {
    if (typeof cursor !== 'string' || cursor.length > 400 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
    const decoded = Buffer.from(cursor,'base64url');
    if (decoded.toString('base64url') !== cursor) throw Error();
    const value = JSON.parse(decoded.toString('utf8'));
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 ||
        value[1] !== filter[0] || value[2] !== filter[1] || !Number.isSafeInteger(value[3]) || value[3] < 1) throw Error();
    return value[3];
  } catch {
    throw Error('Invalid backlog cursor for the requested filters');
  }
}

function groupEvidence(store, goal, tasks) {
  // Match request rows to the saved task and checkpoint. Captured model activity
  // is optional and cannot certify dispatch, response persistence or ownership.
  const byTask = goal && tasks.length ? retainedProgress(store,goal,tasks).byTask : new Map();
  const exactRequest = store.db.prepare(`SELECT id,kind,status,json_extract(data,'$.requestOutcome') AS outcome FROM requests
    WHERE task_id=? AND id=? AND kind='model'`);
  const reviewRequest = store.db.prepare(`SELECT id,kind,status,json_extract(data,'$.requestOutcome') AS outcome FROM requests
    WHERE task_id=? AND key=? AND kind='codexReview'`);
  const unknownModel = store.db.prepare(`SELECT id,kind,status FROM requests WHERE task_id=? AND kind='model'
    AND (status='reserved' OR (status='failed' AND COALESCE(json_extract(data,'$.requestOutcome'),'unknown')='unknown'))
    ORDER BY rowid DESC LIMIT 1`);
  const savedResponse = store.db.prepare(`SELECT id,json_extract(data,'$.savedAt') AS at
    FROM requests WHERE task_id=? AND kind='model' AND status='completed' ORDER BY rowid DESC LIMIT 1`);
  const reviewers = store.db.prepare(`SELECT COUNT(*) AS total, MAX(
    CASE WHEN json_extract(data,'$.taskId')=? AND json_extract(data,'$.status')='reserved' THEN 1 ELSE 0 END
    ) AS reserved FROM records WHERE kind='reviewer' AND json_extract(data,'$.goalId')=?`);
  return new Map(tasks.map(task => {
    const reviewKey = task.checkpoint?.legacyReviewKey;
    const review = reviewKey ? reviewRequest.get(task.id,reviewKey) : null;
    const unknown = (task.status === 'uncertain' || task.status === 'running' ? unknownModel.get(task.id) : null) ??
      (review && (review.status === 'reserved' || review.status === 'failed' && (review.outcome??'unknown') === 'unknown') ? review : null);
    const wait = task.providerWait ? exactRequest.get(task.id,task.providerWait.requestId??null) : null;
    let request = review?.status === 'completed' ? {id:review.id,kind:review.kind,outcome:'completed'} : null;
    if (wait?.status === 'failed' && wait.outcome === 'not_dispatched') request = {id:wait.id,kind:wait.kind,outcome:wait.outcome};
    // A normal running model can hold a reservation. That is only an unknown
    // execution outcome if the saved task's worker ownership cannot be verified.
    if (unknown) request = {id:unknown.id,kind:unknown.kind,outcome:'unknown',pending:task.status === 'running' && unknown.kind === 'model' && unknown.status === 'reserved'};
    let checkpoint = byTask.get(task.id);
    if (!checkpoint || checkpoint.kind === 'checkpoint_saved') {
      const response = savedResponse.get(task.id);
      if (response) checkpoint = {kind:'response_saved',requestId:response.id,at:response.at};
    }
    const reviewer = task.status === 'awaiting_review' && isHashBoundResearch(task.spec) ? reviewers.get(task.id,task.goalId) : null;
    const researchReview = reviewer ? {total:reviewer.total,reserved:reviewer.reserved === 1} : null;
    return [task.id,{request,checkpoint,researchReview}];
  }));
}

export function inspectBacklog({c,worker,goalId,groupId,limit=50,cursor}) {
  if (goalId !== undefined) identifier(goalId,'goalId');
  if (groupId !== undefined) identifier(groupId,'groupId');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Backlog limit must be an integer from 1 to 100');
  const filter = [goalId??null,groupId??null];
  const before = readCursor(cursor,filter);
  const {db} = c.store;
  // SQLite WAL lets other connections write while this inspection keeps one
  // snapshot across group, priority, task, request and lease reads.
  const ownsSnapshot = !db.isTransaction;
  if (ownsSnapshot) db.exec('BEGIN DEFERRED');
  try {
    return readBacklogSnapshot({c,worker,filter,before,limit});
  } finally {
    if (ownsSnapshot) db.exec('ROLLBACK');
  }
}

function readBacklogSnapshot({c,worker,filter,before,limit}) {
  const {store} = c;
  const [goalId,groupId] = filter;
  const generatedAt = c.now();
  const rows = store.db.prepare(`SELECT r.rowid,r.kind,r.data FROM records r
    WHERE r.kind IN ('backlog_group','workflow_run','workflow_recipe_run')
    AND (r.kind!='workflow_run' OR NOT EXISTS (
      SELECT 1 FROM records recipe WHERE recipe.kind='workflow_recipe_run'
      AND json_extract(recipe.data,'$.goalId')=json_extract(r.data,'$.goalId')
      AND json_extract(recipe.data,'$.workflowRunId')=r.id))
    AND (? IS NULL OR json_extract(r.data,'$.goalId')=?) AND (? IS NULL OR r.id=?)
    AND (? IS NULL OR r.rowid<?) ORDER BY r.rowid DESC LIMIT ?`)
    .all(goalId,goalId,groupId,groupId,before,before,limit+1);
  const priorities = rows.length ? c.effectivePriorities() : new Map();
  const hostState = {};
  const workerToken = worker?.owner ?? c.workerLease?.token;
  if (workerToken) {
    try {hostState.workerLease = c.currentLease(workerToken);} catch { /* No verified local ownership. */ }
  }
  const groups = rows.slice(0,limit).map(({kind,data}) => {
    const group = receiptGroup(store,kind,JSON.parse(data));
    const goal = store.maybe('goal',group.goalId);
    const tasks = new Map();
    const members = [];
    for (const {taskId} of (group.items??[]).slice(0,MAX_BACKLOG_ITEMS)) {
      const task = store.maybe('task',taskId);
      if (!task) continue;
      if (task.goalId !== group.goalId) {tasks.set(taskId,task); continue;}
      const member = c.getTask(taskId);
      tasks.set(taskId,member);
      members.push(member);
    }
    for (const member of members) {
      for (const taskId of member.spec.dependsOn) {
        if (tasks.has(taskId)) continue;
        const task = store.maybe('task',taskId);
        if (task) tasks.set(taskId,task);
      }
    }
    const evidence = groupEvidence(store,goal,members);
    return projectBacklog({group,tasks,goal,priorities,hostState,evidence,now:generatedAt,store});
  });
  const sourceRevision = groups.every(group => group.sourceRevision === groups[0]?.sourceRevision) ? groups[0]?.sourceRevision??null : null;
  const queriedGoal = !groups.length && goalId ? store.maybe('goal',goalId) : null;
  const explanation = groups.length ?
    'States are derived from saved coordinator records and the original approval window.' :
    isOvernightV2(queriedGoal?.manifest) ?
      'Overnight v2 uses its planner-owned graph. Inspect its existing tasks with queue_get or goal_get.' :
      'No saved backlog or workflow groups match these filters. Inspect approved tasks with queue_get.';
  return {
    schemaVersion:1,generatedAt,sourceRevision,explanation,groups,
    nextCursor:rows.length > limit ? Buffer.from(JSON.stringify([1,...filter,rows[limit-1].rowid])).toString('base64url') : null,
  };
}

function receiptGroup(store, kind, receipt) {
  if (kind === 'backlog_group') return receipt;
  const recipe = kind === 'workflow_recipe_run';
  const submission = recipe ? null : store.db.prepare(
    "SELECT key FROM submissions WHERE kind='workflow_run' AND scope=? AND id=?",
  ).get(receipt.goalId,receipt.id);
  const prefix = recipe ? `recipe-${receipt.id}-` : submission ? `${submission.key}-` : null;
  return {
    id:receipt.id,goalId:receipt.goalId,goalVersion:receipt.goalVersion,
    goalHash:recipe ? receipt.goalHash : null,submissionId:receipt.submissionId??submission?.key??null,at:receipt.at,
    origin:recipe ? {kind,workflowRunId:receipt.workflowRunId,recipeId:receipt.recipeId,version:receipt.version}
      : {kind,workflowId:receipt.workflowId,version:receipt.version},
    items:(receipt.tasks??[]).slice(0,MAX_BACKLOG_ITEMS).map(taskId => {
      const task = store.maybe('task',taskId);
      const submissionId = task?.goalId === receipt.goalId ? task.spec.submissionId : null;
      const key = prefix && submissionId?.startsWith(prefix) ? submissionId.slice(prefix.length) : taskId;
      return {key,taskId};
    }),
  };
}
