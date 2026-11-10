import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../src/harness/contracts.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {LocalProvider} from '../src/harness/provider.mjs';
import {Worker} from '../src/harness/worker.mjs';

const goalSpec = {
  submissionId: 'approved-a',
  objective: 'Explain queue behavior',
  acceptance: ['Give a concrete example'],
  environment: 'fixture',
};
const advertisedJson = {protocol: 'mosaic-structured-v1', transports: ['json'], modelDiscovery: 'advertised'};
const consultSpec = {
  kind: 'consult',
  objective: 'Explain ownership',
  acceptance: ['Include the release condition'],
};

async function endpoint(t, name) {
  const key = 'fixture-credential-' + name;
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({method: req.method, path: req.url, body, authenticated: req.headers.authorization === 'Bearer ' + key});
    if (!calls.at(-1).authenticated) return res.writeHead(401).end(key);
    if (req.method === 'GET') {
      return res.end(JSON.stringify({data: [{id: 'alias-' + name}]}));
    }
    res.end(JSON.stringify({
      model: name + '-dated-model',
      choices: [{message: {content: 'Answer from ' + name}, finish_reason: 'stop'}],
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {
    calls,
    key,
    profile: {
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
      model: 'alias-' + name,
      displayName: name + ' fixture',
      revision: 'revision-' + name,
      streaming: false,
    },
  };
}

function state(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mosaic-flexibility-pinning-'));
  let coordinator;
  const open = profile => {
    coordinator?.close();
    coordinator = new Coordinator({root, beta: true, workerProfile: profile, now: () => 10000});
    return coordinator;
  };
  t.after(() => {
    coordinator?.close();
    rmSync(root, {recursive: true, force: true});
  });
  return open;
}

function approve(c, spec) {
  const g = c.prepareGoal(spec, 'prepare-' + spec.submissionId);
  assert.throws(() => c.activateGoal({goalId: g.id, hash: 'wrong-hash'}, 'wrong-' + spec.submissionId), /exact/i);
  return c.activateGoal({goalId: g.id, hash: g.hash}, 'activate-' + spec.submissionId);
}

function submit(c, goalId, submissionId) {
  return c.submitTask({goalId, submissionId, ...consultSpec}, 'submit-' + submissionId);
}

test('only a newly approved goal can use the reconfigured worker', async t => {
  const a = await endpoint(t, 'local');
  const b = await endpoint(t, 'hosted');
  const open = state(t);
  let c = open(a.profile);
  const original = approve(c, goalSpec);
  const done = submit(c, original.id, 'first');
  const queued = submit(c, original.id, 'second');
  const oldWorker = new Worker({c, config: {environment: 'fixture', workerApiKey: a.key}});
  await oldWorker.tick();
  const completed = c.getTask(done.id);
  assert.equal(completed.status, 'awaiting_review');
  assert.equal(completed.spec.actor, 'deepseek');
  assert.equal(completed.result.requestedModel, a.profile.model);
  assert.equal(completed.result.model, 'local-dated-model');

  const currentProfile = {...b.profile, capabilities: advertisedJson};
  c = open(currentProfile);
  const worker = new Worker({c, config: {environment: 'fixture', workerApiKey: b.key}});
  await worker.tick();
  assert.equal(c.getTask(queued.id).status, 'blocked');
  assert.equal(c.getTask(queued.id).spent.model, 0);
  assert.deepEqual(c.getGoal(original.id).manifest.workerProfile, a.profile);
  assert.equal(c.getGoal(original.id).deadline, original.deadline);
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 0);
  assert.throws(() => new Goals(c).prepareRevision({
    goalId: original.id, expectedHash: original.hash, manifest: goalSpec,
  }, 'redirect-existing'), /worker.*new goal/i);

  const next = approve(c, {...goalSpec, submissionId: 'approved-b'});
  assert.deepEqual(next.manifest.workerProfile, currentProfile);
  const assigned = submit(c, next.id, 'third');
  await worker.tick();
  const saved = c.getTask(assigned.id);
  assert.equal(saved.status, 'awaiting_review');
  assert.equal(saved.result.model, 'hosted-dated-model');
  assert.equal(saved.result.requestedModel, b.profile.model);
  assert.equal(saved.spent.model, 1);
  assert.equal(a.calls.length, 1);
  assert.deepEqual(b.calls.map(call => [call.method, call.path]), [
    ['GET', '/v1/models'], ['POST', '/v1/chat/completions'],
  ]);
  assert.ok(b.calls.every(call => call.authenticated));
  const {body} = b.calls[1];
  assert.equal(body.model, b.profile.model);
  assert.equal(Object.hasOwn(body, 'chat_template_kwargs'), false);
  assert.doesNotMatch(JSON.stringify({saved, request: c.store.request(saved.id, 'consult-1'), body}), new RegExp(b.key));
});

test('an alternate worker revision prepared by older software cannot activate', t => {
  const open = state(t);
  const originalProfile = {baseUrl: 'http://127.0.0.1:1/v1', model: 'alias', displayName: 'Fixture', revision: 'a', streaming: false};
  const changedProfile = {...originalProfile, revision: 'b'};
  let c = open(originalProfile);
  const original = approve(c, goalSpec);
  const manifest = {...original.manifest, workerProfile: changedProfile};
  const revision = {
    id: 'previously-prepared', goalId: original.id, previousHash: original.hash,
    version: 2, manifest, hash: digest(manifest), status: 'draft', createdAt: c.now(),
  };
  c.store.put('goal_revision', revision);
  c = open(changedProfile);
  assert.throws(() => new Goals(c).activateRevision({revisionId: revision.id, hash: revision.hash}, 'old-alternate'), /worker.*new goal/i);
  assert.equal(c.getGoal(original.id).hash, original.hash);
  assert.equal(c.store.get('goal_revision', revision.id).status, 'draft');
});

test('a capability-only change refuses dispatch and preserves the original approval', async t => {
  const backend = await endpoint(t, 'capability');
  const open = state(t);
  const oldProfile = {...backend.profile, capabilities: {...advertisedJson, modelDiscovery: 'manual'}};
  let c = open(oldProfile);
  const original = approve(c, goalSpec);
  const task = submit(c, original.id, 'pending');
  c = open({...backend.profile, capabilities: advertisedJson});
  await new Worker({c, config: {environment: 'fixture', workerApiKey: backend.key}}).tick();
  assert.equal(c.getTask(task.id).status, 'blocked');
  assert.equal(c.getTask(task.id).spent.model, 0);
  assert.deepEqual(c.getGoal(original.id).manifest.workerProfile, oldProfile);
  assert.equal(c.getGoal(original.id).hash, original.hash);
  assert.deepEqual(backend.calls, []);
});

test('a planner uses the approved model pin and saves the refused reservation', async t => {
  const backend = await endpoint(t, 'planner');
  const c = state(t)(backend.profile);
  const g = approve(c, {...goalSpec, mode: 'deepseek_only'});
  const provider = new LocalProvider({
    baseUrl: backend.profile.baseUrl, model: 'wrong-model', apiKey: backend.key, openAICompatible: true,
  });
  const worker = new Worker({c, provider, config: {environment: 'fixture'}});
  await worker.planner.tick();
  assert.equal(backend.calls.filter(call => call.method === 'POST').length, 0);
  const saved = c.getGoal(g.id);
  assert.equal(saved.planning.status, 'blocked');
  assert.equal(saved.planning.spent, 1);
  assert.equal(saved.deadline, g.deadline);
  const request = c.store.request(g.id, 'plan-1');
  assert.equal(request.status, 'failed');
  assert.equal(request.requestOutcome, 'not_dispatched');
  assert.deepEqual(request.workerProfile, backend.profile);
});
