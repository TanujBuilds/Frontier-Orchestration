// Fresh portable beta work selects a host; explicit nonportable legacy reconnect fixtures omit it.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {OvernightPreflight} from '../src/harness/overnight-preflight.mjs';
import {git} from '../src/project/process.mjs';

const clock = Date.UTC(2026, 10, 11);
const test = (name, fn) => nodeTest(name, {timeout: 15000}, fn);
const config = {environment: 'fixture', codexPath: process.execPath};
const keys = {'credential-a': 'dummy-provider-a-secret', 'credential-b': 'dummy-provider-b-secret'};
const profile = (id, baseUrl, extra = {}) => ({
  schema: 1, id: `worker-${id}`, revision: 'revision-1', displayName: `Fixture ${id}`,
  transport: 'openai-chat', baseUrl, model: `alias-${id}`, roles: ['worker'],
  capabilities: {workerProtocol: 'mosaic-structured-v1', transports: ['json'], modelDiscovery: 'manual', taskKinds: ['coding', 'consult']},
  maxContextTokens: null, maxOutputTokens: 2048, concurrency: 1, capacityGroup: `service-${id}`,
  credentialRef: `credential-${id}`, streaming: false, ...extra,
});
const registryFor = profiles => ProviderRegistry({profiles, credentialResolver: ref => keys[ref]});
const policyFor = (registry, profiles, {defaultWorkerId = 'worker-a', plannerWorkerId = defaultWorkerId} = {}) => {
  const workers = registry.snapshot(profiles.map(({id, revision}) => ({id, revision})));
  return {version: 1, workers, defaultWorkerId, plannerWorkerId, maxConcurrentTasks: 1,
    capacityGroups: workers.map(p => ({id: p.capacityGroup, limit: 1}))};
};
const checksFactory = () => ({verify: async () => ({fixture: true}), run: async checks => checks.map(({id}) => ({id, passed: true}))});

async function endpoint(t, id, options = {}) {
  const calls = [], discovery = Promise.withResolvers(), posted = Promise.withResolvers();
  const state = {status: 200, holdDiscovery: false, truncated: false, holdPost: false, ...options};
  const release = Promise.withResolvers();
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({url: req.url, auth: req.headers.authorization, body});
    if (req.url === '/v1/models') {
      discovery.resolve();
      if (state.holdDiscovery) await release.promise;
      if (state.manualMissing) return res.writeHead(404).end('Discovery unavailable');
      if (state.modelsStatus && state.modelsStatus !== 200) return res.writeHead(state.modelsStatus).end('Discovery unavailable');
      return res.end(JSON.stringify({data: [{id: `alias-${id}`}]}));
    }
    posted.resolve();
    if (req.headers.authorization !== `Bearer ${state.requiredKey ?? keys[`credential-${id}`]}`) return res.writeHead(401).end('Wrong fixture bearer');
    if (state.holdPost) return;
    if (state.status !== 200) return res.writeHead(state.status).end('Fixture rejection');
    const input = JSON.parse(body.messages.at(-1).content);
    const content = input.goal
      ? JSON.stringify(state.plan ?? {tasks: [{key: 'answer', kind: 'consult', objective: 'Answer with the default worker', acceptance: ['Bound answer']}]})
      : `answer-${id}`;
    state.beforeResponse?.();
    if (body.stream) {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write('data: ' + JSON.stringify({model: `reported-${id}`, choices: [{delta: {content}, finish_reason: state.truncated ? null : 'stop'}]}) + '\n\n');
      return res.end(state.truncated ? '' : 'data: [DONE]\n\n');
    }
    res.end(JSON.stringify({model: `reported-${id}`, choices: [{message: {content}, finish_reason: 'stop'}], usage: {total_tokens: 7}}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { release.resolve(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return {baseUrl: `http://127.0.0.1:${server.address().port}/v1`, calls, state, discovery, posted, release,
    posts: () => calls.filter(c => c.body), gets: () => calls.filter(c => !c.body)};
}

async function fixture(t, profiles, {beta = true} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-pb11-runtime-'));
  const registry = registryFor(profiles), opened = [], children = [];
  let now = clock, sequence = 0;
  const open = (providerRegistry = registry) => { const c = new Coordinator({root: path.join(root, 'state'), now: () => now, beta, ...(beta ? {selectedHost: 'codex'} : {}), providerRegistry}); opened.push(c); return c; };
  t.after(async () => {
    for (const {child, closed} of children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
    for (const c of opened) c.close(); await rm(root, {recursive: true, force: true});
  });
  const c = open();
  const prepare = async ({mode = 'collaborative', defaultWorkerId, plannerWorkerId, submit = true, portable = true, ...extra} = {}) => {
    const n = ++sequence;
    const raw = {submissionId: `goal-${n}`, objective: 'Exercise approved provider transport', acceptance: ['Exact binding'],
      mode, environment: 'fixture', ...(mode === 'codex_only' || !portable ? {} : {providerPolicy: policyFor(registry, profiles, {defaultWorkerId, plannerWorkerId})}), ...extra};
    if (mode === 'overnight_review') {
      const repo = path.join(root, `repo-${n}`); await mkdir(path.join(repo, 'src'), {recursive: true});
      await writeFile(path.join(repo, 'src', 'probe.mjs'), 'export const fixture = 1;\n');
      await git(repo, 'init', '-q'); await git(repo, 'add', '.');
      await git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
      raw.project = {repo, baseCommit: await git(repo, 'rev-parse', 'HEAD'), readPaths: ['src/'], writePaths: ['src/'], checks: [{id: 'probe', argv: [process.execPath, 'src/probe.mjs']}]};
      raw.modeVersion = 2; raw.overnightPolicy = {preflightCheckIds: ['probe'], finalOnlyCheckIds: [], reconnectMs: 30000};
    }
    const goal = c.prepareGoal(raw, `prepare-${n}`);
    if (mode === 'overnight_review') assert.equal((await new OvernightPreflight({c, config, checksFactory}).run({goalId: goal.id, hash: goal.hash}, `preflight-${n}`)).passed, true);
    c.activateGoal({goalId: goal.id, hash: goal.hash}, `activate-${n}`);
    const task = submit ? c.submitTask({goalId: goal.id, submissionId: `task-${n}`, kind: mode === 'overnight_review' ? 'coding' : 'consult',
      objective: 'Use only the approved default worker', acceptance: ['Bound answer'],
      ...(mode === 'overnight_review' ? {role: 'implementation', permissions: {readPaths: ['src/'], writePaths: ['src/'], checks: ['probe']}} : {})}, `submit-${n}`) : null;
    return {goal: c.getGoal(goal.id), task};
  };
  return {root, c, registry, open, prepare, profiles, children, setNow: value => {now = value;}};
}

function assertPrivate(c) {
  const serialized = JSON.stringify({records: c.store.db.prepare('SELECT data FROM records').all(), requests: c.store.db.prepare('SELECT data FROM requests').all(), events: c.store.events(0, 1000)});
  for (const [ref, value] of Object.entries(keys)) { assert.equal(serialized.includes(ref), false); assert.equal(serialized.includes(value), false); }
}

test('one worker executes distinct bound JSON and SSE endpoints without sharing auth, model or callbacks', async t => {
  const a = await endpoint(t, 'a'), b = await endpoint(t, 'b');
  const f = await fixture(t, [profile('a', a.baseUrl), profile('b', b.baseUrl, {streaming: true, capabilities: {workerProtocol: 'mosaic-structured-v1', transports: ['sse'], modelDiscovery: 'manual', taskKinds: ['coding', 'consult']}})]);
  const first = await f.prepare(), second = await f.prepare({defaultWorkerId: 'worker-b'});
  const worker = new Worker({c: f.c, config}); await worker.tick(); await worker.tick();
  assert.equal(f.c.getTask(first.task.id).result?.content, 'answer-a');
  assert.equal(f.c.getTask(second.task.id).result?.content, 'answer-b');
  assert.equal(a.posts().length, 1); assert.equal(b.posts().length, 1);
  assert.equal(a.posts()[0].auth, 'Bearer dummy-provider-a-secret'); assert.equal(b.posts()[0].auth, 'Bearer dummy-provider-b-secret');
  assert.equal(a.posts()[0].body.model, 'alias-a'); assert.equal(b.posts()[0].body.model, 'alias-b');
  assert.equal(a.posts()[0].body.stream, false); assert.equal(b.posts()[0].body.stream, true);
  assert.equal(a.posts()[0].body.max_tokens, 2048); assert.equal(b.posts()[0].body.max_tokens, 2048);
  assert.equal(f.c.getTask(first.task.id).providerModel, 'alias-a'); assert.equal(f.c.getTask(second.task.id).providerModel, 'alias-b');
  const outputs = f.c.store.events(0, 1000).filter(e => e.type === 'model.output');
  assert.ok(outputs.length > 0); assert.ok(outputs.every(e => e.task_id === second.task.id && e.data.content === 'answer-b'));
  for (const item of [first, second]) assert.deepEqual(f.c.store.request(item.task.id, 'consult-1').providerBinding, f.c.getTask(item.task.id).providerBinding);
  assertPrivate(f.c);
});

test('replacing the catalog with unchanged public identity uses its new private credential resolver', async t => {
  const a = await endpoint(t, 'a'), f = await fixture(t, [profile('a', a.baseUrl)]);
  const first = await f.prepare(), worker = new Worker({c: f.c, config}); await worker.tick();
  a.state.requiredKey = 'rotated-dummy-key';
  f.c.providerRegistry = ProviderRegistry({profiles: [{...f.profiles[0], credentialRef: 'rotated-private-ref'}], credentialResolver: ref => ref === 'rotated-private-ref' ? 'rotated-dummy-key' : undefined});
  const second = await f.prepare(); await worker.tick();
  assert.equal(f.c.getTask(first.task.id).result.content, 'answer-a'); assert.equal(f.c.getTask(second.task.id).result.content, 'answer-a');
  assert.deepEqual(a.posts().map(call => call.auth), ['Bearer dummy-provider-a-secret', 'Bearer rotated-dummy-key']);
  assert.equal(first.goal.manifest.providerPolicyHash, second.goal.manifest.providerPolicyHash);
  const publicData = JSON.stringify(f.c.snapshot()); assert.equal(publicData.includes('rotated-private-ref'), false); assert.equal(publicData.includes('rotated-dummy-key'), false);
});

test('API planning uses plannerWorkerId while the resulting task uses defaultWorkerId', async t => {
  const a = await endpoint(t, 'a'), b = await endpoint(t, 'b');
  const f = await fixture(t, [profile('a', a.baseUrl), profile('b', b.baseUrl)]);
  const {goal} = await f.prepare({mode: 'deepseek_only', plannerWorkerId: 'worker-b', defaultWorkerId: 'worker-a', submit: false});
  const worker = new Worker({c: f.c, config}); await worker.planner.tick();
  const planned = f.c.getGoal(goal.id); assert.equal(planned.tasks.length, 1);
  assert.equal(b.posts().length, 1); assert.equal(a.posts().length, 0);
  assert.equal(b.posts()[0].body.model, 'alias-b');
  assert.equal(planned.planning.providerBinding.providerId, 'worker-b');
  assert.deepEqual(f.c.store.request(goal.id, 'plan-1').providerBinding, goal.manifest.plannerBinding);
  await worker.tick(); assert.equal(a.posts().length, 1); assert.equal(b.posts().length, 1);
  assert.equal(f.c.getTask(planned.tasks[0].id).result.content, 'answer-a'); assertPrivate(f.c);
});

test('saved planner response reopens with its original planner pin and materializes once without a POST', async t => {
  const a = await endpoint(t, 'a'), b = await endpoint(t, 'b');
  const f = await fixture(t, [profile('a', a.baseUrl), profile('b', b.baseUrl)]);
  const {goal} = await f.prepare({mode: 'deepseek_only', plannerWorkerId: 'worker-b', submit: false});
  const owner = 'planner-before-restart'; f.c.acquireWorker(owner);
  const emit = f.c.emit.bind(f.c);
  f.c.emit = (type, ...args) => { const result = emit(type, ...args); if (type === 'planning.saved') f.c.control({goalId: goal.id, action: 'pause'}, 'hold-planner'); return result; };
  await new Worker({c: f.c, owner, config}).planner.tick();
  const original = f.c.store.request(goal.id, 'plan-1'); assert.equal(original.status, 'completed');
  assert.equal(f.c.getGoal(goal.id).tasks.length, 0); f.c.releaseWorker(owner); f.c.close();
  const c = f.open(); c.acquireWorker('planner-after-restart');
  c.control({goalId: goal.id, action: 'resume'}, 'resume-planner');
  const worker = new Worker({c, owner: 'planner-after-restart', config}); await worker.planner.tick(); await worker.planner.tick();
  const saved = c.getGoal(goal.id); assert.equal(saved.tasks.length, 1); assert.equal(saved.planning.status, 'completed');
  assert.equal(saved.planning.providerBinding.providerId, 'worker-b');
  assert.equal(saved.tasks[0].providerBinding.providerId, 'worker-a');
  assert.equal(c.store.request(goal.id, 'plan-1').id, original.id); assert.deepEqual(c.store.request(goal.id, 'plan-1').providerBinding, goal.manifest.plannerBinding);
  assert.equal(saved.deadline, goal.deadline); assert.equal(saved.planning.spent, 1); assert.equal(a.calls.length, 0); assert.equal(b.posts().length, 1);
});

test('a successful planner reply stays saved under its original binding when the catalog changes after POST', async t => {
  const a = await endpoint(t, 'a'), b = await endpoint(t, 'b'), f = await fixture(t, [profile('a', a.baseUrl), profile('b', b.baseUrl)]);
  const {goal} = await f.prepare({mode: 'deepseek_only', plannerWorkerId: 'worker-b', submit: false});
  b.state.beforeResponse = () => {f.c.providerRegistry = registryFor(f.profiles.map(p => p.id === 'worker-b' ? {...p, revision: 'revision-2'} : p));};
  const worker = new Worker({c: f.c, config}); await worker.planner.tick();
  const request = f.c.store.request(goal.id, 'plan-1'); assert.equal(request.status, 'completed');
  assert.equal(JSON.parse(request.result.content).tasks.length, 1); assert.deepEqual(request.providerBinding, goal.manifest.plannerBinding);
  assert.equal(f.c.getGoal(goal.id).planning.status, 'blocked'); assert.equal(f.c.getGoal(goal.id).planning.spent, 1);
  assert.equal(f.c.getGoal(goal.id).tasks.length, 0); await worker.planner.tick();
  assert.equal(a.calls.length, 0); assert.equal(b.posts().length, 1);
});

for (const record of ['planning', 'request']) test(`a saved ${record} pin cannot substitute another approved pool member for the planner`, async t => {
  const a = await endpoint(t, 'a'), b = await endpoint(t, 'b'), f = await fixture(t, [profile('a', a.baseUrl), profile('b', b.baseUrl)]);
  const {goal} = await f.prepare({mode: 'deepseek_only', plannerWorkerId: 'worker-b', submit: false});
  const owner = 'pinned-planner'; f.c.acquireWorker(owner); const emit = f.c.emit.bind(f.c);
  f.c.emit = (type, ...args) => {const result = emit(type, ...args); if (type === 'planning.saved') f.c.control({goalId: goal.id, action: 'pause'}, 'hold-pin'); return result;};
  const worker = new Worker({c: f.c, owner, config}); await worker.planner.tick();
  const replacement = f.c.providerBinding(goal, 'worker-a');
  if (record === 'planning') {const p = f.c.store.get('planning', goal.id); p.providerBinding = replacement; f.c.store.put('planning', p);}
  else {const row = f.c.store.db.prepare('SELECT * FROM requests WHERE task_id=?').get(goal.id); f.c.store.db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data), providerBinding: replacement}), row.id);}
  f.c.control({goalId: goal.id, action: 'resume'}, 'resume-pin'); await worker.planner.tick();
  assert.equal(f.c.getGoal(goal.id).tasks.length, 0); assert.equal(f.c.getGoal(goal.id).planning.status, 'blocked');
  assert.match(f.c.getGoal(goal.id).planning.reason, /planner.*binding|binding.*planner/i);
  assert.equal(f.c.getGoal(goal.id).planning.spent, 1); assert.equal(a.calls.length, 0); assert.equal(b.posts().length, 1);
});

for (const mode of ['collaborative', 'codex_only']) test(`${mode} host planning adds no API requests`, async t => {
  const a = await endpoint(t, 'a'), f = await fixture(t, [profile('a', a.baseUrl)]);
  await f.prepare({mode, submit: false}); assert.equal(await new Worker({c: f.c, config}).planner.tick(), null);
  assert.equal(a.calls.length, 0);
});

for (const actor of ['task', 'planner']) for (const control of ['stop', 'deadline', 'profile-change']) test(`${actor} discovery finishing after ${control} sends no completion POST`, async t => {
  const a = await endpoint(t, 'a', {holdDiscovery: true});
  const f = await fixture(t, [profile('a', a.baseUrl, {capabilities: {workerProtocol: 'mosaic-structured-v1', transports: ['json'], modelDiscovery: 'advertised', taskKinds: ['coding', 'consult']}})]);
  const item = await f.prepare({mode: actor === 'planner' ? 'deepseek_only' : 'collaborative', submit: actor !== 'planner'});
  const worker = new Worker({c: f.c, config}); const pending = actor === 'planner' ? worker.planner.tick() : worker.tick();
  await Promise.race([a.discovery.promise, pending.then(() => assert.fail('Request never reached bound discovery'))]);
  if (control === 'stop') f.c.control({goalId: item.goal.id, action: 'stop'}, 'hold');
  else if (control === 'deadline') f.setNow(actor === 'planner' ? item.goal.deadline : f.c.getTask(item.task.id).deadline);
  else f.c.providerRegistry = registryFor([{...f.profiles[0], revision: 'revision-2'}]);
  a.release.resolve(); await pending;
  assert.equal(a.posts().length, 0);
  const request = f.c.store.request(actor === 'planner' ? item.goal.id : item.task.id, actor === 'planner' ? 'plan-1' : 'consult-1');
  assert.equal(request.requestOutcome, 'not_dispatched');
  assert.equal(f.c.store.spent(actor === 'planner' ? item.goal.id : item.task.id).model, 1);
});

for (const failure of ['auth', 'truncated', 'gateway-timeout']) test(`bound ${failure} failure retains spend and cannot fall back to another endpoint`, async t => {
  const a = await endpoint(t, 'a', {status: failure === 'auth' ? 401 : failure === 'gateway-timeout' ? 408 : 200, truncated: failure === 'truncated'}), b = await endpoint(t, 'b');
  const f = await fixture(t, [profile('a', a.baseUrl, failure === 'truncated' ? {streaming: true, capabilities: {workerProtocol: 'mosaic-structured-v1', transports: ['sse'], modelDiscovery: 'manual', taskKinds: ['coding', 'consult']}} : {}), profile('b', b.baseUrl)]);
  const {task} = await f.prepare(); const worker = new Worker({c: f.c, config}); await worker.tick(); await worker.tick();
  const saved = f.c.getTask(task.id), request = f.c.store.request(task.id, 'consult-1');
  assert.equal(saved.status, failure === 'auth' ? 'blocked' : 'uncertain'); assert.equal(saved.spent.model, 1);
  assert.equal(request.requestOutcome, failure === 'auth' ? 'not_dispatched' : 'unknown');
  assert.equal(request.providerBinding.providerId, 'worker-a'); assert.equal(a.posts().length, 1); assert.equal(b.calls.length, 0); assertPrivate(f.c);
});

for (const manualMissing of [false, true]) test(`reconnect probes stay on the task binding${manualMissing ? ' and manual endpoints without models retry without discovery' : ''}`, async t => {
  const a = await endpoint(t, 'a'), b = await endpoint(t, 'b', {status: 429, manualMissing});
  const f = await fixture(t, [profile('a', a.baseUrl), profile('b', b.baseUrl, {capabilities: {workerProtocol: 'mosaic-structured-v1', transports: ['json'], modelDiscovery: manualMissing ? 'manual' : 'advertised', taskKinds: ['coding', 'consult']}})]);
  const {goal, task} = await f.prepare({mode: 'overnight_review', defaultWorkerId: 'worker-b', plannerWorkerId: 'worker-a'});
  const owner = 'bound-probe-worker'; f.c.acquireWorker(owner); f.c.claimNext(owner); f.c.beginAttempt(task.id, owner);
  f.c.boundary(task.id, {phase: 'model', attempt: 1, exchange: 0, executionBase: goal.manifest.project.baseCommit}, owner);
  const worker = new Worker({c: f.c, config, owner, adapters: {coding: {step: (current, token) => worker.model(current, token, `code-1-${current.checkpoint.exchange}`, [{role: 'user', content: '{}'}])}}});
  await worker.tick(); const waited = f.c.getTask(task.id); assert.equal(waited.status, 'suspended');
  const original = f.c.store.request(task.id, 'code-1-0');
  assert.equal(waited.spent.model, 1); assert.equal(original.id, waited.providerWait.requestId);
  assert.equal(original.status, 'failed'); assert.equal(original.requestOutcome, 'not_dispatched');
  b.state.status = 200; f.setNow(waited.providerWait.retryAt); await worker.tick();
  assert.equal(a.calls.length, 0); if (manualMissing) assert.equal(b.gets().length, 0); else assert.ok(b.gets().length >= 1);
  assert.equal(b.posts().length, 2);
  const current = f.c.getTask(task.id); assert.equal(current.spent.model, 2);
  assert.equal(current.providerBinding.providerId, 'worker-b');
  assert.deepEqual(current.providerBinding, waited.providerBinding); assert.equal(current.providerModel, waited.providerModel);
  assert.equal(current.deadline, waited.deadline); assert.equal(f.c.getGoal(goal.id).deadline, goal.deadline);
  assert.equal(current.attempts, 1); assert.equal(current.status, 'running'); assert.equal(current.providerWait, undefined);
  assert.equal(current.providerReconnectStartedAt, waited.providerWait.startedAt);
  const retried = f.c.store.request(task.id, 'code-1-1');
  assert.equal(retried.status, 'completed'); assert.notEqual(retried.id, original.id);
  assert.deepEqual(retried.providerBinding, original.providerBinding); assert.equal(retried.result.requestedModel, 'alias-b');
  assert.equal(retried.reconnectUntil, waited.providerWait.until); assert.deepEqual(f.c.store.request(task.id, 'code-1-0'), original);
  if (manualMissing) {
    for (const at of [waited.providerWait.until, waited.deadline]) {
      f.setNow(at); await worker.tick(); const after = f.c.getTask(task.id);
      assert.equal(after.status, at === waited.deadline ? 'partial' : 'running');
      assert.equal(b.gets().length, 0); assert.equal(b.posts().length, 2); assert.equal(a.calls.length, 0); assert.equal(after.spent.model, 2);
      assert.deepEqual(after.providerBinding, waited.providerBinding); assert.equal(after.providerModel, waited.providerModel);
      assert.equal(after.deadline, waited.deadline); assert.equal(f.c.getGoal(goal.id).deadline, goal.deadline);
      assert.deepEqual(f.c.store.request(task.id, 'code-1-0'), original); assert.deepEqual(f.c.store.request(task.id, 'code-1-1'), retried);
      assert.equal(f.c.store.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE task_id=?').get(task.id).n, 2);
    }
  }
});

test('planner discovery HTTP408 stays known non-dispatch and readiness probes its distinct pinned provider', async t => {
  const a = await endpoint(t, 'a'), b = await endpoint(t, 'b', {modelsStatus: 408});
  const f = await fixture(t, [profile('a', a.baseUrl), profile('b', b.baseUrl, {capabilities: {workerProtocol: 'mosaic-structured-v1', transports: ['json'], modelDiscovery: 'advertised', taskKinds: ['coding', 'consult']}})]);
  const {goal} = await f.prepare({mode: 'overnight_review', plannerWorkerId: 'worker-b', defaultWorkerId: 'worker-a', submit: false});
  const worker = new Worker({c: f.c, config}); await worker.planner.tick();
  const waited = f.c.getGoal(goal.id).planning, request = f.c.store.request(goal.id, 'plan-1');
  assert.equal(request.requestOutcome, 'not_dispatched'); assert.equal(waited.status, 'queued'); assert.ok(waited.providerWait);
  assert.equal(a.calls.length, 0); assert.equal(b.posts().length, 0);
  b.state.modelsStatus = 200; b.state.plan = {tasks: [{key: 'final', kind: 'coding', role: 'final', objective: 'Verify the bound fixture', acceptance: ['Protected probe passes'], dependsOn: [], permissions: {readPaths: ['src/'], writePaths: ['src/'], checks: ['probe']}}]};
  f.setNow(waited.providerWait.retryAt); await worker.planner.tick();
  const completed = f.c.getGoal(goal.id); assert.equal(completed.planning.status, 'completed'); assert.equal(completed.planning.spent, 2);
  assert.equal(completed.tasks[0].providerBinding.providerId, 'worker-a'); assert.equal(a.calls.length, 0); assert.equal(b.posts().length, 1);
  assert.equal(b.posts()[0].body.max_tokens, 2048); assert.equal(b.gets().length, 3);
  assert.deepEqual(f.c.store.request(goal.id, 'plan-2').providerBinding, goal.manifest.plannerBinding);
});

test('legacy reconnect retains its original wait when provider construction cannot complete', async t => {
  const a = await endpoint(t, 'a'), f = await fixture(t, [profile('a', a.baseUrl)], {beta: false});
  const {goal, task} = await f.prepare({mode: 'overnight_review', portable: false});
  const owner = 'legacy-probe'; f.c.acquireWorker(owner); f.c.claimNext(owner); f.c.beginAttempt(task.id, owner);
  f.c.boundary(task.id, {phase: 'model', attempt: 1, exchange: 0, executionBase: goal.manifest.project.baseCommit}, owner);
  const worker = new Worker({c: f.c, owner, config, provider: {complete: async () => {throw Object.assign(Error('Fixture unavailable'), {requestOutcome: 'not_dispatched'});}}, adapters: {coding: {step: (current, token) => worker.model(current, token, `code-1-${current.checkpoint.exchange}`, [])}}});
  await worker.tick(); const waited = f.c.getTask(task.id); assert.equal(waited.status, 'suspended');
  const original = f.c.store.request(task.id, 'code-1-0');
  worker.provider = null; f.setNow(waited.providerWait.retryAt); await worker.tick();
  const saved = f.c.getTask(task.id); assert.equal(saved.status, 'blocked'); assert.equal(saved.providerWait.until, waited.providerWait.until);
  assert.match(saved.reason, /No eligible provider retry remains in original reconnect window/);
  assert.deepEqual(f.c.store.request(task.id, 'code-1-0'), original);
  assert.equal(saved.spent.model, 1); assert.equal(a.calls.length, 0);
});

const childDriver = fileURLToPath(new URL('./fixtures/mosaic-pb11/runtime-child.mjs', import.meta.url));
function childMarker(child) {
  return new Promise((resolve, reject) => {
    let output = '', stderr = '';
    const timer = setTimeout(() => reject(Error('Owned runtime child did not reach barrier: ' + stderr)), 10000);
    child.stderr.on('data', part => {stderr += part;});
    child.stdio[3].on('data', part => {output += part; if (output.includes('\n')) {clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0]));}});
    child.once('close', code => {clearTimeout(timer); reject(Error(`Owned runtime child exited ${code}: ${stderr}`));});
  });
}

for (const point of ['response-saved', 'request-inflight']) test(`owned-child restart at ${point} preserves binding, request id and original spend`, async t => {
  const a = await endpoint(t, 'a', {holdPost: point === 'request-inflight'});
  const f = await fixture(t, [profile('a', a.baseUrl)]); const {goal, task} = await f.prepare(); f.c.close();
  const child = spawn(process.execPath, [childDriver, JSON.stringify({root: path.join(f.root, 'state'), now: clock, profiles: f.profiles, point})], {env: {PATH: process.env.PATH, TMPDIR: f.root}, stdio: ['ignore', 'ignore', 'pipe', 'pipe']});
  const closed = once(child, 'close');
  f.children.push({child, closed});
  const marker = await childMarker(child); assert.equal(marker.pid, child.pid);
  if (point === 'request-inflight') await Promise.race([a.posted.promise, closed.then(([code, signal]) => {throw Error(`Owned runtime child exited before POST (${code}, ${signal})`);})]);
  child.kill('SIGKILL'); assert.deepEqual(await closed, [null, 'SIGKILL']);
  const c = f.open(); c.acquireWorker('restart-owner');
  const original = c.store.request(task.id, 'consult-1'); assert.equal(original.providerBinding.providerId, 'worker-a');
  assert.deepEqual(original.providerBinding, c.getTask(task.id).providerBinding); assert.equal(c.getTask(task.id).spent.model, 1);
  assert.equal(c.getTask(task.id).deadline, clock + c.getTask(task.id).spec.limits.seconds * 1000);
  assert.equal(c.getGoal(goal.id).deadline, goal.deadline);
  if (point === 'response-saved') {
    assert.equal(original.status, 'completed'); c.recoverSaved(task.id, 'restart-owner');
    await new Worker({c, owner: 'restart-owner', config}).tick();
    assert.equal(c.getTask(task.id).result.content, 'answer-a'); assert.equal(c.getTask(task.id).status, 'awaiting_review');
  } else {
    assert.equal(original.status, 'reserved'); assert.throws(() => c.recoverSaved(task.id, 'restart-owner'), /ambiguous|pending/i);
    await new Worker({c, owner: 'restart-owner', config}).tick(); assert.equal(c.getTask(task.id).status, 'uncertain');
  }
  assert.equal(c.store.request(task.id, 'consult-1').id, original.id); assert.equal(c.getTask(task.id).spent.model, 1); assert.equal(a.posts().length, 1); assertPrivate(c);
});


function prepareCurrentConsult(c, profiles, submissionId) {
  const goal = c.prepareGoal({submissionId, objective: 'Run separately approved current-profile work', acceptance: ['Bound healthy answer'],
    mode: 'collaborative', environment: 'fixture', providerPolicy: policyFor(c.providerRegistry, profiles)}, 'prepare-' + submissionId);
  c.activateGoal({goalId: goal.id, hash: goal.hash}, 'activate-' + submissionId);
  const task = c.submitTask({goalId: goal.id, submissionId: 'task-' + submissionId, kind: 'consult',
    objective: 'Use only the separately approved current worker', acceptance: ['Bound healthy answer']}, 'submit-' + submissionId);
  return {goal, task};
}

test('reopened stale queued binding is blocked once while separately approved current work runs', async t => {
  const a = await endpoint(t, 'a'), b = await endpoint(t, 'b'), f = await fixture(t, [profile('a', a.baseUrl)]);
  const stale = await f.prepare(); f.c.close();
  const revised = profile('a', b.baseUrl, {revision: 'revision-2', model: 'alias-b', credentialRef: 'credential-b'});
  const c = f.open(registryFor([revised])), healthy = prepareCurrentConsult(c, [revised], 'healthy-current');
  const worker = new Worker({c, config});
  for (let n = 0; n < 3; n++) await worker.tick();
  const blocked = c.getTask(stale.task.id), completed = c.getTask(healthy.task.id);
  assert.equal(blocked.status, 'blocked'); assert.match(blocked.reason, /approved.*binding|provider.*configuration/i);
  assert.deepEqual(blocked.providerBinding, stale.task.providerBinding); assert.equal(blocked.spent.model, 0);
  assert.equal(blocked.startedAt, stale.task.startedAt); assert.equal(blocked.deadline, stale.task.deadline); assert.equal(blocked.owner, null);
  assert.equal(c.getGoal(stale.goal.id).deadline, stale.goal.deadline);
  assert.equal(a.calls.length, 0); assert.equal(b.posts().length, 1); assert.equal(completed.status, 'awaiting_review'); assert.equal(completed.result.content, 'answer-b');
  assert.deepEqual(completed.providerBinding, healthy.task.providerBinding); assert.equal(completed.spent.model, 1);
  assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 1);
  const events = c.store.events(0, 1000);
  assert.equal(events.filter(e => e.type === 'task.blocked' && e.task_id === stale.task.id).length, 1);
  assert.equal(events.filter(e => e.type === 'service.error').length, 0); assertPrivate(c);
});

test('actual uncertain in-flight old binding keeps the slot when a healthy revised goal is queued', async t => {
  const a = await endpoint(t, 'a', {holdPost: true}), b = await endpoint(t, 'b');
  const f = await fixture(t, [profile('a', a.baseUrl)]), stale = await f.prepare(); f.c.close();
  const child = spawn(process.execPath, [childDriver, JSON.stringify({root: path.join(f.root, 'state'), now: clock, profiles: f.profiles, point: 'request-inflight'})],
    {env: {PATH: process.env.PATH, TMPDIR: f.root}, stdio: ['ignore', 'ignore', 'pipe', 'pipe']});
  const closed = once(child, 'close'); f.children.push({child, closed});
  const marker = await childMarker(child); assert.equal(marker.pid, child.pid);
  await Promise.race([a.posted.promise, closed.then(() => assert.fail('Owned child exited before the in-flight POST'))]);
  child.kill('SIGKILL'); assert.deepEqual(await closed, [null, 'SIGKILL']);
  const revised = profile('a', b.baseUrl, {revision: 'revision-2', model: 'alias-b', credentialRef: 'credential-b'});
  const c = f.open(registryFor([revised])), owner = 'uncertain-slot-after-restart'; c.acquireWorker(owner);
  const original = c.getTask(stale.task.id), request = c.store.request(stale.task.id, 'consult-1');
  assert.equal(original.status, 'uncertain'); assert.equal(request.status, 'reserved'); assert.equal(original.spent.model, 1);
  assert.throws(() => c.recoverSaved(original.id, owner), /ambiguous|pending/i);
  const healthy = prepareCurrentConsult(c, [revised], 'healthy-after-uncertain'), worker = new Worker({c, owner, config});
  for (let n = 0; n < 3; n++) await worker.tick();
  const held = c.getTask(original.id); assert.equal(held.status, 'uncertain'); assert.deepEqual(held.providerBinding, original.providerBinding);
  assert.equal(held.deadline, original.deadline); assert.equal(held.spent.model, 1); assert.equal(c.getGoal(stale.goal.id).deadline, stale.goal.deadline);
  assert.deepEqual(c.store.request(original.id, 'consult-1'), request); assert.equal(c.getTask(healthy.task.id).status, 'queued');
  assert.equal(c.getTask(healthy.task.id).spent.model, 0); assert.equal(a.posts().length, 1); assert.equal(b.calls.length, 0);
  assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 1);
  assert.equal(c.store.events(0, 1000).filter(e => ['task.blocked', 'service.error'].includes(e.type)).length, 0); assertPrivate(c);
});
