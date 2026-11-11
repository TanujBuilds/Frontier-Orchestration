import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {coordinator} from './fixtures/mosaic-assignment/coordinator.mjs';
import {assignment, repository} from './fixtures/mosaic-assignment/repository.mjs';
import {adapters, advance, fixture, open, startTime} from './fixtures/mosaic-recovery/fixture.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {LocalProvider} from '../src/harness/provider.mjs';
import {digest} from '../src/harness/contracts.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import path from 'node:path';

for (const mode of ['codex_only', 'deepseek_only']) {
  test(`beta assignment ${mode} uses the coordinator's actual normalized approval`, async t => {
    const service = await coordinator(t), repo = await repository(service);
    const profile = {baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-model', displayName: 'Fixture', revision: 'r1', streaming: false};
    const c = new Coordinator({root: path.join(service.root, 'beta-state'), beta: true, selectedHost: 'codex', workerProfile: profile});
    t.after(() => c.close());
    const dispatcher = new Dispatcher({c, config: {beta: true, environment: 'fixture'}});
    const manifest = assignment(repo, {mode});
    const input = {manifest, idempotencyKey: 'beta-assignment'};
    const prepared = await dispatcher.invoke('assignment_prepare', input);
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
    const goal = c.getGoal(prepared.goalId);
    assert.equal(prepared.hash, goal.hash);
    assert.equal(goal.hash, digest(goal.manifest));
    assert.equal(goal.manifest.capabilities.some(capability => capability.id === 'research'), false);
    if (mode === 'deepseek_only') assert.deepEqual(goal.manifest.workerProfile, c.workerProfile);
    else assert.equal(goal.manifest.workerProfile, undefined);
    assert.deepEqual(await dispatcher.invoke('assignment_prepare', input), prepared);
    assert.equal(goal.status, 'draft');
    assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
  });
}

test('assignment transport preserves behavioral authority in the exact draft hash', async t => {
  const service = await coordinator(t), repo = await repository(service);
  const manifest = assignment(repo);
  manifest.project.behavioralChecks = [{criterionId: 'csv', description: 'Every row is exported', checkIds: ['verify']}];
  const input = {manifest, idempotencyKey: 'mapped-assignment'};
  const prepared = await service.call('assignment_prepare', input);
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  const goal = await service.call('goal_get', {goalId: prepared.goalId});
  assert.deepEqual(goal.manifest.project.behavioralChecks, manifest.project.behavioralChecks);
  assert.equal(prepared.hash, digest(goal.manifest));
  assert.equal(goal.status, 'draft');
  assert.deepEqual(await service.call('assignment_prepare', input), prepared);
  const changed = structuredClone(input);
  changed.manifest.project.behavioralChecks[0].description = 'Changed acceptance';
  assert.equal((await service.request('assignment_prepare', changed)).status, 400);
  const invalid = structuredClone(input);
  invalid.idempotencyKey = 'invalid-mapping';
  invalid.manifest.submissionId = 'invalid-mapping';
  invalid.manifest.project.behavioralChecks[0].checkIds = ['not-approved'];
  const rejected = await service.call('assignment_prepare', invalid);
  assert.notEqual(rejected.status, 'prepared');
  assert.deepEqual((await service.call('goal_get')).goals.map(g => g.id), [goal.id]);
  assert.equal(service.savedRequestCount(), 0);
  assert.deepEqual(service.providerRequests, []);
});

for (const action of ['pause', 'stop', 'goal-pause', 'goal-stop', 'expiry']) {
  test(`initial discovery finishing after ${action} cannot dispatch, and held coding work resumes`, {timeout: 20000}, async t => {
    const f = await fixture(t);
    let now = startTime;
    const c = open(f, startTime);
    c.now = () => now;
    t.after(() => c.close());
    const owner = 'initial-discovery';
    c.acquireWorker(owner);
    const task = c.claimNext(owner);
    const attempt = c.beginAttempt(task.id, owner);
    c.boundary(task.id, {phase: 'model', attempt, exchange: 0, executionBase: f.baseCommit}, owner);
    const before = c.getTask(task.id);
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    let posts = 0, discoveries = 0;
    const server = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') {
        if (++discoveries === 1) { entered.resolve(); await finish.promise; }
        return res.end(JSON.stringify({data: [{id: 'fixture-model'}]}));
      }
      posts++;
      req.resume();
      res.end(JSON.stringify({model: 'fixture-model', choices: [{message: {content: 'saved fixture response'}, finish_reason: 'stop'}]}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { finish.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const worker = new Worker({c, owner, config: {environment: 'fixture'}, provider: new LocalProvider({baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-model'})});
    const pending = worker.model(before, owner, 'code-1-0', []).then(value => ({value}), error => ({error}));
    await entered.promise;
    const goalControl = action.startsWith('goal-');
    const controlAction = action.replace('goal-', '');
    if (action === 'expiry') now = before.deadline;
    else c.control({...goalControl ? {goalId: f.goal.id} : {taskId: task.id}, action: controlAction}, 'hold-discovery');
    finish.resolve();
    const result = await pending;
    assert.equal(posts, 0, 'No completion may be sent after control or expiry');
    assert.ok(result.error);
    const held = c.getTask(task.id);
    assert.equal(held.status, action === 'expiry' ? 'partial' : controlAction === 'pause' ? 'paused' : 'stopped');
    assert.equal(held.spent.model, 1);
    assert.equal(held.deadline, before.deadline);
    assert.equal(c.store.request(task.id, 'code-1-0').requestOutcome, 'not_dispatched');
    if (action !== 'expiry') {
      c.control({...goalControl ? {goalId: f.goal.id} : {taskId: task.id}, action: 'resume'}, 'resume-discovery');
      const resumed = c.claimNext(owner);
      assert.equal(resumed.id, task.id);
      const response = await worker.model(resumed, owner, `code-${resumed.checkpoint.attempt}-${resumed.checkpoint.exchange}`, []);
      assert.equal(response.content, 'saved fixture response');
      assert.equal(posts, 1);
      assert.equal(c.getTask(task.id).spent.model, 2);
      assert.equal(c.getTask(task.id).deadline, before.deadline);
    }
  });
}

for (const action of ['pause', 'stop']) {
  test(`pre-review ${action} resumes the original unspent review`, {timeout: 20000}, async t => {
    const f = await fixture(t), c = open(f, startTime);
    t.after(() => c.close());
    const owner = 'pre-review-control', taskId = f.goal.tasks[0].id;
    c.acquireWorker(owner);
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    let reviewCalls = 0;
    const options = adapters(f.root, {checkStarted: async label => {
      if (label.startsWith('legacy-')) { entered.resolve(); await finish.promise; }
    }});
    const reviewer = options.reviewer;
    options.reviewer = {reviewCode: async packet => { reviewCalls++; return reviewer.reviewCode(packet); }};
    const worker = new Worker({c, owner, ...options});
    await advance(worker, () => c.getTask(taskId).status === 'awaiting_legacy_review');
    const before = c.getTask(taskId), pending = worker.executeTick();
    await entered.promise;
    c.control({taskId, action}, 'hold-before-review');
    finish.resolve();
    await pending;
    assert.equal(reviewCalls, 0);
    assert.equal(c.getTask(taskId).spent.codexReview, 0);
    assert.equal(c.control({taskId, action: 'resume'}, 'resume-before-review').status, 'awaiting_legacy_review');
    await worker.executeTick();
    const ready = c.getTask(taskId);
    assert.equal(ready.status, 'ready_to_integrate');
    assert.equal(ready.deadline, before.deadline);
    assert.equal(ready.spent.codexReview, 1);
    assert.equal(reviewCalls, 1);
  });
}

test('worker profile changes during discovery block completion before POST', {timeout: 20000}, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let posts = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      entered.resolve(); await finish.promise;
      return res.end(JSON.stringify({data: [{id: 'fixture-model'}]}));
    }
    posts++; req.resume();
    res.end(JSON.stringify({model: 'fixture-model', choices: [{message: {content: 'unexpected'}, finish_reason: 'stop'}]}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { finish.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const profile = {baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-model', displayName: 'Fixture', revision: 'r1', streaming: false,
    capabilities: {protocol: 'mosaic-structured-v1', transports: ['json'], modelDiscovery: 'advertised'}};
  const c = new Coordinator({root: path.join(f.root, 'profile-state'), beta: true, selectedHost: 'codex', workerProfile: profile, now: () => startTime});
  t.after(() => c.close());
  const g = c.prepareGoal({submissionId: 'profile', objective: 'Profile guard', acceptance: ['No stale dispatch'], mode: 'collaborative', environment: 'fixture', project: f.goal.manifest.project}, 'prepare');
  c.activateGoal({goalId: g.id, hash: g.hash}, 'activate');
  const task = c.submitTask({goalId: g.id, submissionId: 'profile-task', kind: 'coding', objective: 'Profile guard', acceptance: ['No stale dispatch']}, 'submit');
  const owner = 'profile-owner';
  c.acquireWorker(owner); c.claimNext(owner); c.beginAttempt(task.id, owner);
  const before = c.boundary(task.id, {phase: 'model', attempt: 1, exchange: 0}, owner);
  const worker = new Worker({c, owner, config: {environment: 'fixture'}});
  const pending = worker.model(before, owner, 'code-1-0', []).then(value => ({value}), error => ({error}));
  await entered.promise;
  c.workerProfile = {...c.workerProfile, revision: 'r2'};
  finish.resolve();
  const result = await pending;
  assert.equal(posts, 0);
  assert.match(result.error?.message ?? '', /profile changed/i);
  assert.equal(c.getTask(task.id).status, 'blocked');
  assert.equal(c.getTask(task.id).spent.model, 1);
  assert.equal(c.store.request(task.id, 'code-1-0').requestOutcome, 'not_dispatched');
});

test('a caught reviewer failure retains the spent request identity in recovery reporting', {timeout: 20000}, async t => {
  const f = await fixture(t), c = open(f, startTime);
  t.after(() => c.close());
  const owner = 'failed-review', taskId = f.goal.tasks[0].id;
  c.acquireWorker(owner);
  const worker = new Worker({c, owner, ...adapters(f.root), reviewer: {reviewCode: async () => { throw Error('Fixture reviewer disconnected'); }}});
  await advance(worker, () => c.getTask(taskId).status === 'awaiting_legacy_review');
  await worker.tick();
  const task = c.getTask(taskId), request = c.store.request(taskId, 'legacy-review-1');
  assert.equal(task.status, 'blocked');
  assert.equal(task.spent.codexReview, 1);
  assert.equal(request.status, 'failed');
  const recovery = c.getGoal(f.goal.id).overnightRun.recovery;
  assert.equal(recovery.requestId, request.id);
  assert.equal(recovery.outcome, 'unknown');
  assert.equal(recovery.code, 'request_outcome_unknown');
});
