import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {adapters, advance, calls, fixture, open, startTime} from './fixtures/mosaic-recovery/fixture.mjs';

let view;
try {
  view = await import('../src/harness/backlog/view.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.url?.endsWith('/harness/backlog/view.mjs')) throw error;
}
function project(input) {
  assert.equal(typeof view?.projectBacklog, 'function', 'backlog projection is implemented');
  return view.projectBacklog(input);
}
function inspect(input) {
  assert.equal(typeof view?.inspectBacklog, 'function', 'backlog inspection is implemented');
  return view.inspectBacklog(input);
}

const sampleGoal = {id:'goal', version:2, hash:'approved', status:'active', deadline:startTime + 60_000,
  manifest:{mode:{id:'collaborative',actors:['deepseek','codex'],review:'operator'}}};
const sampleTask = (id, status = 'queued', extra = {}) => ({
  id, status, goalId:sampleGoal.id, goalVersion:sampleGoal.version, sequence:1,
  spec:{kind:'coding', actor:'deepseek', priority:'normal', objective:id, dependsOn:[]}, ...extra,
});
const makeGroup = (goal, ids, id = 'group') => ({id, goalId:goal.id, goalVersion:goal.version,
  goalHash:goal.hash, submissionId:id, at:startTime, items:ids.map(taskId => ({key:taskId, taskId}))});
function projectTasks(tasks, {goal = sampleGoal, group = makeGroup(goal, tasks.map(t => t.id)), ...other} = {}) {
  return project({group, tasks, goal, now:startTime, ...other});
}

test('a ready task explains its inherited effective priority and its dependent waits for acceptance', () => {
  const parent = sampleTask('parent'), child = sampleTask('child');
  child.spec = {...child.spec, dependsOn:[parent.id], priority:'blocking'};
  const result = projectTasks([parent, child], {priorities:new Map([[parent.id,2],[child.id,2]])});
  assert.equal(result.status, 'ready');
  assert.equal(result.items[0].status, 'ready');
  assert.equal(result.items[0].priority, 'normal');
  assert.equal(result.items[0].effectivePriority, 'blocking');
  assert.match(result.items[0].priorityExplanation, /depend/i);
  assert.equal(result.items[1].status, 'waiting_dependency');
  assert.equal(result.items[1].sourceStatus, 'queued');
  assert.deepEqual(result.items[1].dependency, {taskId:parent.id, sourceStatus:'queued'});
});

test('a stopped dependency is identified instead of reporting the dependent as ready', () => {
  const parent = sampleTask('parent','stopped'), child = sampleTask('child');
  child.spec = {...child.spec, dependsOn:[parent.id]};
  const row = projectTasks([child, parent]).items[0];
  assert.equal(row.status, 'waiting_dependency');
  assert.equal(row.reasonCode, 'dependency_stopped');
  assert.match(row.explanation, /stopped/i);
});

test('a missing dependency is a blocked reference', () => {
  const child = sampleTask('child');
  child.spec.dependsOn = ['missing'];
  const row = projectTasks([child]).items[0];
  assert.equal(row.status, 'blocked');
  assert.equal(row.reasonCode, 'dependency_missing');
  assert.deepEqual(row.dependency, {taskId:'missing', sourceStatus:null});
});

test('a stale group preserves the task source status without implying that approval follows revisions', () => {
  const task = sampleTask('task'), group = makeGroup(sampleGoal, [task.id]);
  const result = projectTasks([task], {group, goal:{...sampleGoal, version:3, hash:'revised'}});
  assert.equal(result.stale, true);
  assert.equal(result.reasonCode, 'stale_group_approval');
  assert.equal(result.items[0].status, 'blocked');
  assert.equal(result.items[0].sourceStatus, 'queued');
  assert.equal(result.items[0].reasonCode, 'task_approval_stale');
});

test('a rebound task follows the current approval even while the group remains stale', () => {
  const group = makeGroup(sampleGoal, ['rebound']);
  const goal = {...sampleGoal, version:3, hash:'revised'};
  const task = sampleTask('rebound','queued',{goalVersion:goal.version});
  const result = projectTasks([task], {group, goal});
  assert.equal(result.stale, true);
  assert.equal(result.items[0].status, 'ready');
});

test('a paused native text owner may still require host confirmation', () => {
  const task = sampleTask('native-text','paused',{executionActor:'codex',controlReturnStatus:'codex_active'});
  task.spec.kind = 'consult';
  const row = projectTasks([task]).items[0];
  assert.equal(row.status, 'paused');
  assert.equal(row.reasonCode, 'pause_pending');
});

test('control stays pending while a task owns the saved integration boundary', () => {
  for (const [status,reasonCode] of [['stopped','stop_pending'],['paused','pause_pending']]) {
    const task = sampleTask('pending-integration',status,{controlReturnStatus:'ready_to_integrate'});
    const goal = {...sampleGoal, integrationPending:{taskId:task.id,importKey:'protected-import'}};
    const row = projectTasks([task],{goal}).items[0];
    assert.equal(row.sourceStatus,status);
    assert.equal(row.status,status);
    assert.equal(row.reasonCode,reasonCode);
    assert.match(row.explanation,/saved integration boundary/);
    assert.equal(row.integrationCommit,null);
  }
});

test('a certified reconnect cannot advance after the original request budget is spent', () => {
  const task = sampleTask('outage','suspended',{
    providerWait:{requestId:'spent',until:startTime + 1000,retryAt:startTime + 100},
    spent:{model:1},
  });
  task.spec.limits = {modelCalls:1};
  const evidence = new Map([[task.id,{request:{id:'spent',kind:'model',outcome:'not_dispatched'}}]]);
  const row = projectTasks([task], {evidence}).items[0];
  assert.equal(row.status, 'blocked');
  assert.equal(row.reasonCode, 'provider_budget_exhausted');
});

test('missing and foreign task references are shown without exposing foreign records', () => {
  const foreign = sampleTask('foreign','running',{goalId:'other'});
  const group = makeGroup(sampleGoal, ['missing', foreign.id]);
  const result = projectTasks([foreign], {group});
  assert.deepEqual(result.items.map(({reasonCode, sourceStatus}) => [reasonCode, sourceStatus]),
    [['task_missing',null],['task_goal_mismatch',null]]);
});

test('a paused goal holds otherwise ready work without changing its saved task status', () => {
  const result = projectTasks([sampleTask('task')], {goal:{...sampleGoal,status:'paused'}});
  assert.equal(result.sourceStatus, 'paused');
  assert.equal(result.items[0].status, 'paused');
  assert.equal(result.items[0].sourceStatus, 'queued');
  assert.equal(result.items[0].reasonCode, 'goal_paused');
});

test('expiration uses the original deadline and keeps earlier accepted and partial outcomes distinct', () => {
  const now = sampleGoal.deadline;
  const result = projectTasks([
    sampleTask('queued'), sampleTask('partial','partial',{reason:'Native partial preserved'}),
    sampleTask('accepted','accepted',{integration:{commit:'receipt'}}),
  ], {now});
  assert.deepEqual(result.items.map(row => row.status), ['expired','partial','accepted']);
  assert.equal(result.items[0].deadline, now);
  assert.equal(result.items[0].reasonCode, 'goal_deadline_expired');
});

test('saved native and review states do not imply a live host or integrated result', () => {
  const native = sampleTask('native','codex_ready');
  native.spec.actor = 'codex';
  const claimed = sampleTask('claimed','codex_active',{executionActor:'codex',native:{writerActive:true}});
  const review = sampleTask('review','awaiting_review',{result:{checks:[{id:'protected',passed:true}]}});
  const integration = sampleTask('integration','ready_to_integrate',{result:review.result});
  const rows = projectTasks([native,claimed,review,integration]).items;
  assert.deepEqual(rows.map(row => row.status), ['waiting_host','uncertain','waiting_review','waiting_review']);
  assert.equal(rows[0].reasonCode, 'native_host_required');
  assert.equal(rows[1].reasonCode, 'native_ownership_unverified');
  assert.equal(rows[2].reasonCode, 'operator_review_required');
  assert.equal(rows[3].reasonCode, 'integration_pending');
  assert.equal(rows[3].integrationCommit, null);
});

test('an unanswered saved question identifies the exact question and required answer authority', () => {
  const task = sampleTask('question','awaiting_user',{
    questions:[{id:'answered',text:'Old question'},{id:'open',text:'Current question'}],
    answers:[{questionId:'answered'}],
  });
  const row = projectTasks([task]).items[0];
  assert.equal(row.status, 'waiting_answer');
  assert.equal(row.reasonCode, 'owner_answer_required');
  assert.equal(row.questionId, 'open');
  assert.match(row.explanation, /question_answer/);
});

async function setupConsult(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-backlog-view-'));
  const coordinators = [];
  function reopen() {
    const c = new Coordinator({root, now:() => startTime});
    coordinators.push(c);
    return c;
  }
  t.after(async () => {
    for (const c of coordinators) c.close();
    await rm(root, {recursive:true,force:true});
  });
  const c = reopen();
  function goal(submissionId) {
    const g = c.prepareGoal({submissionId, objective:'Consult within scope', acceptance:['Answer saved'],
      mode:'collaborative', environment:'fixture'}, 'prepare-' + submissionId);
    return c.activateGoal({goalId:g.id,hash:g.hash}, 'activate-' + submissionId);
  }
  function task(g, submissionId, more = {}) {
    return c.submitTask({goalId:g.id,submissionId,kind:'consult',objective:'Consult within scope',
      acceptance:['Answer saved'],...more}, 'task-' + submissionId);
  }
  return {c, reopen, goal, task};
}

test('a saved consult result with zero review allowance reports the real review blocker', async t => {
  const {c,goal,task} = await setupConsult(t), g = goal('review-budget');
  const row = task(g,'review-budget',{limits:{reviews:0}});
  c.store.put('backlog_group',makeGroup(g,[row.id]));
  const owner = 'fixture-consult-review';
  c.acquireWorker(owner);
  const worker = new Worker({c,owner,config:{environment:'fixture'},
    provider:{complete:async () => ({content:'Saved consult answer',model:'fixture'})}});
  const saved = await worker.executeTick();
  assert.equal(saved.status,'awaiting_review');
  assert.throws(() => c.review({taskId:row.id,decision:'accept',feedback:'Candidate reviewed'},'review'),
    /Review limit reached/);

  const item = inspect({c,worker,goalId:g.id}).groups[0].items[0];
  assert.equal(item.sourceStatus,'awaiting_review');
  assert.equal(item.status,'blocked');
  assert.equal(item.reasonCode,'review_budget_exhausted');
  assert.equal(item.recovery.lastVerifiedCheckpoint.kind,'result_saved');
  assert.equal(item.spent.model,1);
});

test('a rebound consult preserves evidence when the revised mode prohibits operator review', async t => {
  const {c,goal,task} = await setupConsult(t), g = goal('review-mode');
  const row = task(g,'review-mode');
  c.store.put('backlog_group',makeGroup(g,[row.id]));
  const owner = 'fixture-mode-review';
  c.acquireWorker(owner);
  const worker = new Worker({c,owner,config:{environment:'fixture'},
    provider:{complete:async () => ({content:'Saved consult answer',model:'fixture'})}});
  assert.equal((await worker.executeTick()).status,'awaiting_review');

  const goals = new Goals(c);
  const revision = goals.prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:{
    submissionId:g.manifest.submissionId,objective:g.manifest.objective,acceptance:g.manifest.acceptance,
    mode:'deepseek_only',environment:'fixture',
  }},'prepare-mode-revision');
  const approved = goals.activateRevision({revisionId:revision.id,hash:revision.hash},'approve-mode-revision');
  assert.equal(goals.rebind({taskId:row.id},'rebind-mode-revision').goalVersion,approved.version);
  assert.throws(() => c.review({taskId:row.id,decision:'accept',feedback:'Candidate reviewed'},'review'),
    /Mode prohibits Codex operator review/);

  const group = inspect({c,worker,goalId:g.id}).groups[0];
  assert.equal(group.stale,true);
  const item = group.items[0];
  assert.equal(item.sourceStatus,'awaiting_review');
  assert.equal(item.status,'blocked');
  assert.equal(item.reasonCode,'mode_review_unavailable');
  assert.equal(item.recovery.lastVerifiedCheckpoint.kind,'result_saved');
});

test('hash-bound research review remains distinct after a round is reserved', () => {
  const task = sampleTask('research','awaiting_review',{reviews:1,researchReviewTickets:[{id:'reserved'}]});
  task.spec = {...task.spec,kind:'research',researchPolicy:{version:3},limits:{reviews:1}};
  const item = projectTasks([task]).items[0];
  assert.equal(item.status,'waiting_review');
  assert.equal(item.reasonCode,'research_review_required');
});

test('inspection pages groups in insertion order using a cursor bound to both filters', async t => {
  const {c,goal,task} = await setupConsult(t), g = goal('first'), other = goal('second');
  const first = task(g,'first');
  const second = task(g,'second',{dependsOn:[first.id],priority:'blocking'});
  for (const group of [makeGroup(g,[first.id],'old'), makeGroup(other,[],'foreign'), makeGroup(g,[second.id],'new')]) {
    c.store.put('backlog_group', group);
  }
  const page = inspect({c,goalId:g.id,limit:1});
  assert.equal(page.schemaVersion, 1);
  assert.deepEqual(page.groups.map(group => group.id), ['new']);
  assert.ok(page.nextCursor);
  const newer = task(g,'third');
  c.store.put('backlog_group', makeGroup(g,[newer.id],'newest'));
  const next = inspect({c,goalId:g.id,limit:1,cursor:page.nextCursor});
  assert.deepEqual(next.groups.map(group => group.id), ['old']);
  assert.equal(next.groups[0].items[0].effectivePriority, 'blocking');
  assert.equal(next.nextCursor, null);
  assert.throws(() => inspect({c,cursor:page.nextCursor}), /cursor/i);
  assert.throws(() => inspect({c,goalId:g.id,groupId:'new',cursor:page.nextCursor}), /cursor/i);
  assert.throws(() => inspect({c,limit:101}), /limit/i);
  assert.throws(() => inspect({c,cursor:'invalid-cursor'}), /cursor/i);
  assert.deepEqual(inspect({c,groupId:'new'}).groups.map(group => group.id), ['new']);
  assert.deepEqual(inspect({c,goalId:other.id,groupId:'new'}).groups, []);
});

test('inspection keeps priorities coherent across a concurrent SQLite commit', async t => {
  const {c,reopen,goal,task} = await setupConsult(t), g = goal('snapshot'), row = task(g,'snapshot');
  c.store.put('backlog_group',makeGroup(g,[row.id]));
  const writer = reopen();
  const effectivePriorities = c.effectivePriorities.bind(c);
  c.effectivePriorities = () => {
    const priorities = effectivePriorities();
    writer.setPriority({taskId:row.id,priority:'blocking',reason:'Concurrent owner update'},'concurrent-priority');
    c.effectivePriorities = effectivePriorities;
    return priorities;
  };

  const item = () => inspect({c,goalId:g.id}).groups[0].items[0];
  const first = item();
  assert.deepEqual([first.priority,first.effectivePriority],['normal','normal']);
  const next = item();
  assert.deepEqual([next.priority,next.effectivePriority],['blocking','blocking']);
});

test('inspection leaves the caller transaction open and reads its uncommitted task state', async t => {
  const {c,goal,task} = await setupConsult(t), g = goal('transaction'), row = task(g,'transaction');
  c.store.put('backlog_group',makeGroup(g,[row.id]));
  const item = () => inspect({c,goalId:g.id}).groups[0].items[0];
  assert.throws(() => c.store.tx(() => {
    c.setPriority({taskId:row.id,priority:'blocking',reason:'Test uncommitted change'},'uncommitted-priority');
    assert.equal(item().effectivePriority,'blocking');
    assert.equal(c.store.db.isTransaction,true);
    throw Error('Force caller rollback');
  }),/Force caller rollback/);
  assert.equal(item().priority,'normal');
});

test('a failed inspection releases its own read transaction', async t => {
  const {c,goal,task} = await setupConsult(t), g = goal('failed-read'), row = task(g,'failed-read');
  c.store.put('backlog_group',makeGroup(g,[row.id]));
  c.effectivePriorities = () => {
    assert.equal(c.store.db.isTransaction,true);
    throw Error('Fixture read error');
  };
  assert.throws(() => inspect({c,goalId:g.id}),/Fixture read error/);
  assert.equal(c.store.db.isTransaction,false);
});

test('a pending reservation is running only with a matching current local worker lease', async t => {
  const {c,reopen,goal,task} = await setupConsult(t), g = goal('lease'), row = task(g,'lease');
  c.store.put('backlog_group', makeGroup(g,[row.id]));
  c.acquireWorker('original');
  c.claimNext('original');
  const request = c.reserve(row.id,{kind:'model',key:'consult-1'},'original');
  const current = inspect({c,goalId:g.id}).groups[0].items[0];
  assert.equal(current.status,'running');
  assert.equal(current.recovery.outcome,null);
  const foreign = reopen();
  const held = inspect({c:foreign,goalId:g.id}).groups[0].items[0];
  assert.equal(held.status,'uncertain');
  assert.equal(held.recovery.outcome,'unknown');
  assert.equal(held.recovery.requestId,request.id);
});

test('a durable saved response can be inspected before and after real ownership recovery', async t => {
  const {c,reopen,goal,task} = await setupConsult(t), g = goal('saved'), row = task(g,'saved');
  c.store.put('backlog_group', makeGroup(g,[row.id]));
  c.acquireWorker('original');
  const running = c.claimNext('original');
  const request = c.reserve(row.id,{kind:'model',key:'consult-1'},'original');
  c.saveRequest(request.id,{content:'Saved reply',model:'fixture'},'original');
  c.releaseWorker('original');
  c.close();
  const fresh = reopen();
  fresh.acquireWorker('replacement');
  const held = inspect({c:fresh,goalId:g.id}).groups[0].items[0];
  assert.equal(held.status,'uncertain');
  assert.equal(held.reasonCode,'execution_uncertain');
  assert.equal(held.recovery.lastVerifiedCheckpoint.kind,'response_saved');
  assert.equal(held.recovery.lastVerifiedCheckpoint.requestId,request.id);

  fresh.recoverSaved(row.id,'replacement');
  const recovered = inspect({c:fresh,goalId:g.id}).groups[0].items[0];
  assert.equal(recovered.status,'ready');
  assert.equal(recovered.recovery.lastVerifiedCheckpoint.requestId,request.id);
  assert.equal(recovered.deadline,running.deadline);
  assert.equal(recovered.spent.model,1);
  assert.equal(fresh.store.request(row.id,'consult-1').id,request.id);
});

test('an interrupted unknown request is held without requiring a captured uncertain event', async t => {
  const {c,reopen,goal,task} = await setupConsult(t), g = goal('held'), row = task(g,'held');
  c.store.put('backlog_group', makeGroup(g,[row.id]));
  c.acquireWorker('original');
  c.claimNext('original');
  const request = c.reserve(row.id,{kind:'model',key:'consult-1'},'original');
  c.releaseWorker('original');
  c.close();
  const fresh = reopen();
  fresh.acquireWorker('replacement');
  assert.throws(() => fresh.recoverSaved(row.id,'replacement'), /ambiguous/i);
  const held = inspect({c:fresh,goalId:g.id}).groups[0].items[0];
  assert.equal(held.status,'uncertain');
  assert.equal(held.reasonCode,'request_outcome_unknown');
  assert.equal(held.recovery.outcome,'unknown');
  assert.equal(held.recovery.requestId,request.id);
  assert.equal(held.spent.model,1);
});

test('the accepted recovery fixture projects a certified non-dispatch outage within its saved window', async t => {
  const f = await fixture(t);
  const c = open(f,startTime + 1000);
  t.after(() => c.close());
  const row = f.goal.tasks[0];
  c.store.put('backlog_group', makeGroup(f.goal,[row.id]));
  c.acquireWorker('fixture-provider');
  c.claimNext('fixture-provider');
  const attempt = c.beginAttempt(row.id,'fixture-provider');
  c.boundary(row.id,{phase:'model',attempt,exchange:0},'fixture-provider');
  const request = c.reserve(row.id,{kind:'model',key:'code-1-0'},'fixture-provider');
  const saved = c.failModelRequest(request.id,'fixture-provider',{outcome:'not_dispatched',reconnect:true,reason:'Discovery unavailable'});
  const result = inspect({c,goalId:f.goal.id}).groups[0].items[0];
  assert.equal(result.status,'waiting_provider');
  assert.equal(result.reasonCode,'provider_unavailable');
  assert.equal(result.recovery.outcome,'not_dispatched');
  assert.equal(result.recovery.requestId,request.id);
  assert.equal(result.recovery.reconnectUntil,saved.providerWait.until);
  assert.equal(result.deadline,saved.deadline);
  assert.equal(result.spent.model,1);
});

test('the accepted recovery fixture retains a no-progress block across ownership restart', async t => {
  const f = await fixture(t);
  const c = open(f,startTime + 1000);
  t.after(() => c.close());
  const row = f.goal.tasks[0];
  c.store.put('backlog_group', makeGroup(f.goal,[row.id]));
  c.acquireWorker('fixture-repair');
  const fake = adapters(f.root);
  const complete = fake.provider.complete;
  fake.provider.complete = async (...args) => {
    const input = JSON.parse(args[0].at(-1).content);
    const result = await complete(...args);
    const action = JSON.parse(result.content);
    if (action.type === 'apply_changes') {
      const edit = action.edits[0];
      edit.baseHash = input.inventory.find(file => file.path === edit.path)?.hash ?? null;
      edit.content = "export const value = 'broken';\n";
    }
    return {...result, content:JSON.stringify(action)};
  };
  const worker = new Worker({c,owner:'fixture-repair',...fake});
  await advance(worker,() => c.getTask(row.id).status === 'blocked');
  const saved = c.getTask(row.id);
  assert.equal(saved.checkpoint.phase,'no_progress');
  const requests = await calls(f.root,'model');
  c.releaseWorker('fixture-repair');
  const fresh = open(f,startTime + 2000);
  t.after(() => fresh.close());
  fresh.acquireWorker('fixture-replacement');
  const blocked = inspect({c:fresh,goalId:f.goal.id}).groups[0].items[0];
  assert.equal(blocked.sourceStatus,'blocked');
  assert.equal(blocked.status,'blocked');
  assert.equal(blocked.reasonCode,'no_progress');
  assert.match(blocked.explanation,/no progress/i);
  assert.deepEqual(blocked.spent,saved.spent);
  assert.deepEqual(await calls(f.root,'model'),requests);
});

test('legacy review uses saved gate and request evidence without claiming an integrated result', async t => {
  const f = await fixture(t);
  const c = open(f,startTime + 1000);
  t.after(() => c.close());
  const row = f.goal.tasks[0];
  c.store.put('backlog_group', makeGroup(f.goal,[row.id]));
  c.acquireWorker('fixture-review');
  let dispatched, finish;
  const started = new Promise(resolve => {dispatched = resolve;});
  const hold = new Promise(resolve => {finish = resolve;});
  const fake = adapters(f.root,{reviewDispatched:() => {dispatched();return hold;}});
  const worker = new Worker({c,owner:'fixture-review',...fake});
  const item = () => inspect({c,worker,goalId:f.goal.id}).groups[0].items[0];
  await advance(worker,() => c.getTask(row.id).status === 'awaiting_legacy_review');
  assert.equal(item().status,'waiting_review');
  assert.equal(item().reasonCode,'legacy_review_pending');
  assert.equal(item().integrationCommit,null);

  const review = worker.legacyReview.tick();
  try {
    await Promise.race([started,review.then(() => assert.fail('Reviewer did not dispatch'))]);
    const reserved = item();
    assert.equal(reserved.sourceStatus,'legacy_reviewing');
    assert.equal(reserved.reasonCode,'request_outcome_unknown');
    assert.equal(reserved.recovery.requestKind,'codexReview');
    assert.equal(reserved.integrationCommit,null);
  } finally {
    finish();
    await review;
  }
  const approved = item();
  assert.equal(approved.status,'waiting_review');
  assert.equal(approved.reasonCode,'integration_pending');
  assert.equal(approved.integrationCommit,null);
});
