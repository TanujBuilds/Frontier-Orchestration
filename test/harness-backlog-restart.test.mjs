import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {Backlog} from '../src/harness/backlog/service.mjs';

const childScript = fileURLToPath(new URL('./harness-backlog-restart-fixture.mjs', import.meta.url));
const start = 1_700_000_000_000;
const hour = 3_600_000;
const options = {timeout: 15_000};

function consult(key, dependsOnKeys = [], extra = {}) {
  return {
    key, dependsOnKeys,
    task: {kind: 'consult', objective: 'Explain ' + key, acceptance: ['Bounded answer'], ...extra},
  };
}

function taskIds(group) {
  return Object.fromEntries(group.items.map(({key, taskId}) => [key, taskId]));
}

async function fixture(t, mode = 'collaborative') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-backlog-'));
  const children = [];
  const connections = [];
  const calls = [];
  let clock = start;
  function open() {
    const c = new Coordinator({root, now: () => clock});
    connections.push(c);
    return c;
  }
  t.after(async () => {
    try {
      await Promise.all(children.map(child => child.kill()));
    } finally {
      for (const c of connections) c.close();
      await rm(root, {recursive: true, force: true});
    }
  });
  const c = open();
  const draft = c.prepareGoal({
    submissionId: 'backlog-goal', objective: 'Explain bounded examples', acceptance: ['Saved answers'],
    environment: 'fixture', mode, limits: {hours: 1},
  }, 'prepare');
  const goal = c.activateGoal({goalId: draft.id, hash: draft.hash}, 'approve');

  function makeWorker(coordinator, owner) {
    return new Worker({
      c: coordinator, owner, config: {environment: 'fixture'},
      provider: {async complete(messages) {
        const {task} = JSON.parse(messages.at(-1).content);
        calls.push(task.objective);
        return {model: 'fixture', content: 'Fixture answer for ' + task.objective};
      }},
    });
  }

  const worker = makeWorker(c, 'backlog-worker');
  return {
    c, goal, calls, worker, open, makeWorker, backlog: new Backlog({c, worker}),
    input: (items, submissionId = 'explanations') => ({goalId: goal.id, expectedGoalHash: goal.hash, submissionId, items}),
    advance: ms => { clock += ms; },
    child: scenario => {
      const owned = ownedChild(root, clock, scenario);
      children.push(owned);
      return owned;
    },
  };
}

function ownedChild(root, clock, scenario) {
  const child = spawn(process.execPath, [childScript, root, String(clock), scenario], {stdio: ['pipe', 'pipe', 'pipe']});
  const output = createInterface({input: child.stdout})[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', error => { stderr += error.message; });
  const exited = new Promise(resolve => {
    child.once('error', error => { stderr += error.message; });
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  return {
    send: (submission, commandKey) => child.stdin.end(JSON.stringify({submission, commandKey}) + '\n'),
    async receive() {
      const {done, value} = await output.next();
      if (done) throw Error('Owned child exited before its checkpoint: ' + stderr);
      return JSON.parse(value);
    },
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      return exited;
    },
    exited,
  };
}

function approve(c, taskId, key) {
  return c.review({taskId, decision: 'accept', feedback: 'Fixture answer matches approved scope'}, key);
}

test('the existing worker advances independent and accepted dependencies while a blocked dependency stays held', options, async t => {
  const {c, backlog, worker, calls, input} = await fixture(t);
  const group = await backlog.submit(input([
    consult('waiting', ['revision']),
    consult('revision'),
    consult('independent'),
    consult('after-acceptance', ['independent']),
  ]), 'submit');
  const ids = taskIds(group);
  assert.deepEqual(calls, []);

  await worker.drain();
  assert.deepEqual(calls.toSorted(), ['Explain independent', 'Explain revision']);
  assert.equal(c.getTask(ids.revision).status, 'awaiting_review');
  assert.equal(c.getTask(ids.independent).status, 'awaiting_review');
  assert.equal(c.getTask(ids.waiting).startedAt, null);
  assert.equal(c.getTask(ids['after-acceptance']).startedAt, null);

  const revised = c.review({taskId: ids.revision, decision: 'revise', feedback: 'Requires a second response'}, 'revision');
  assert.equal(revised.status, 'blocked');
  assert.match(revised.reason, /original .*budget exhausted/i);
  assert.equal(revised.spent.model, 1);
  assert.equal(approve(c, ids.independent, 'accept-independent').status, 'accepted');
  await worker.drain();

  assert.deepEqual(calls.toSorted(), ['Explain after-acceptance', 'Explain independent', 'Explain revision']);
  assert.equal(calls.at(-1), 'Explain after-acceptance');
  assert.equal(c.getTask(ids['after-acceptance']).status, 'awaiting_review');
  assert.equal(c.getTask(ids.waiting).status, 'queued');
  assert.equal(c.getTask(ids.waiting).startedAt, null);
  assert.equal(c.getTask(ids.waiting).spent.model, 0);
});

test('Codex-only backlog waits for native ownership and never invokes the provider', options, async t => {
  const {c, goal, backlog, worker, calls, input} = await fixture(t, 'codex_only');
  await assert.rejects(
    async () => backlog.submit(input([consult('allowed'), consult('forbidden', [], {actor: 'deepseek'})], 'invalid-mode'), 'invalid-mode'),
    /mode.*actor|actor.*mode/i,
  );
  assert.equal(c.getGoal(goal.id).tasks.length, 0);

  const ids = taskIds(await backlog.submit(input([consult('native'), consult('after-native', ['native'])]), 'submit'));
  await worker.drain();
  assert.deepEqual(calls, []);
  assert.equal(c.getTask(ids.native).status, 'codex_ready');
  assert.throws(() => c.startNativeText({taskId: ids['after-native']}, 'too-early'), /dependencies/i);

  // Explicit calls represent a supported host reporting its own work.
  c.startNativeText({taskId: ids.native}, 'native-start');
  assert.equal(c.finishNativeText({taskId: ids.native, content: 'Native fixture answer'}, 'native-finish').status, 'accepted');
  await worker.drain();
  assert.deepEqual(calls, []);
  assert.equal(c.getTask(ids['after-native']).status, 'codex_ready');
  assert.equal(c.getTask(ids['after-native']).startedAt, null);
  assert.equal(c.startNativeText({taskId: ids['after-native']}, 'native-dependent-start').executionActor, 'codex');
});

test('SIGKILL after durable submission and response save preserves the group and spends the response once', options, async t => {
  const f = await fixture(t);
  const submission = f.input([consult('first'), consult('second', ['first'])]);
  const child = f.child('crash');
  assert.deepEqual(await child.receive(), {ready: true});
  child.send(submission, 'submit');
  const before = await child.receive();
  const ids = taskIds(before.group);
  const savedTask = f.c.getTask(ids.first);
  assert.deepEqual(before.calls, ['Explain first']);
  assert.equal(savedTask.status, 'running');
  assert.equal(savedTask.spent.model, 1);
  assert.equal(f.c.store.request(ids.first, 'consult-1').id, before.requestId);
  assert.equal(f.c.store.request(ids.first, 'consult-1').status, 'completed');
  assert.throws(() => f.c.acquireWorker('replacement'), /another worker owns/i);

  assert.deepEqual(await child.kill(), {code: null, signal: 'SIGKILL'});
  f.c.close();
  f.advance(5_000);
  const c = f.open();
  c.acquireWorker('replacement');
  const worker = f.makeWorker(c, 'replacement');
  const backlog = new Backlog({c, worker});

  assert.equal(c.getTask(ids.first).status, 'uncertain');
  assert.equal(c.getTask(ids.first).deadline, savedTask.deadline);
  assert.equal(c.getTask(ids.first).spent.model, 1);
  const inspected = await backlog.inspect({goalId: f.goal.id, groupId: before.group.id});
  assert.equal(inspected.groups.length, 1);
  assert.equal(inspected.groups[0].id, before.group.id);
  assert.deepEqual(taskIds(inspected.groups[0]), ids);
  const held = inspected.groups[0].items.find(item => item.key === 'first');
  assert.equal(held.sourceStatus, 'uncertain');
  assert.equal(held.status, 'uncertain');
  assert.deepEqual(await backlog.submit(submission, 'submit'), before.group);
  assert.deepEqual(await backlog.submit(submission, 'different-replay-key'), before.group);
  assert.deepEqual(c.getGoal(f.goal.id).tasks.map(task => task.id).sort(), [ids.first, ids.second].sort());
  assert.deepEqual(c.store.all('backlog_group').map(group => group.id), [before.group.id]);
  assert.equal(c.getGoal(f.goal.id).activatedAt, f.goal.activatedAt);
  assert.equal(c.getGoal(f.goal.id).deadline, f.goal.deadline);
  assert.equal(c.store.events().filter(event => event.type === 'task.submitted').length, 2);
  assert.equal(c.store.events().filter(event => event.type === 'backlog.submitted').length, 1);
  assert.deepEqual(f.calls, []);

  c.recoverSaved(ids.first, 'replacement');
  await worker.drain();
  const recovered = c.getTask(ids.first);
  assert.equal(recovered.status, 'awaiting_review');
  assert.equal(recovered.result.content, 'Durable fixture response');
  assert.equal(recovered.deadline, savedTask.deadline);
  assert.equal(recovered.spent.model, 1);
  assert.deepEqual(f.calls, []);

  approve(c, ids.first, 'accept-recovered');
  await worker.drain();
  assert.deepEqual(f.calls, ['Explain second']);
  assert.equal(c.getTask(ids.second).status, 'awaiting_review');
  assert.equal(c.getTask(ids.second).spent.model, 1);
});

test('backlog retry and dependency waiting consume the original clock and spending', options, async t => {
  const f = await fixture(t);
  f.advance(hour - 60_000);
  const submission = f.input([consult('parent'), consult('dependent', ['parent'])]);
  const group = await f.backlog.submit(submission, 'submit');
  const ids = taskIds(group);
  await f.worker.drain();
  const candidate = f.c.getTask(ids.parent);
  assert.equal(candidate.startedAt, start + hour - 60_000);
  assert.equal(candidate.deadline, start + hour);
  assert.equal(candidate.spent.model, 1);

  f.advance(30_000);
  assert.deepEqual(await f.backlog.submit(submission, 'retry'), group);
  await f.worker.drain();
  assert.equal(f.c.getTask(ids.parent).deadline, candidate.deadline);
  assert.equal(f.c.getTask(ids.parent).spent.model, 1);
  assert.equal(f.c.getTask(ids.dependent).startedAt, null);
  assert.deepEqual(f.calls, ['Explain parent']);

  f.advance(30_000);
  assert.throws(() => approve(f.c, ids.parent, 'late-acceptance'), /deadline/i);
  await f.worker.drain();
  const waiting = f.c.getTask(ids.dependent);
  assert.equal(waiting.status, 'partial');
  assert.match(waiting.reason, /original deadline/i);
  assert.equal(waiting.startedAt, null);
  assert.equal(waiting.spent.model, 0);
  assert.equal(f.c.getTask(ids.parent).deadline, candidate.deadline);
  assert.equal(f.c.getTask(ids.parent).spent.model, 1);
  assert.deepEqual(f.calls, ['Explain parent']);
  const inspected = await f.backlog.inspect({goalId: f.goal.id, groupId: group.id});
  const expired = inspected.groups[0].items.find(item => item.key === 'dependent');
  assert.equal(expired.sourceStatus, 'partial');
  assert.equal(expired.status, 'expired');

  await assert.rejects(async () => f.backlog.submit(f.input([consult('late')], 'late'), 'late'), /deadline/i);
  assert.throws(() => f.c.control({goalId: f.goal.id, action: 'resume'}, 'late-resume'), /deadline/i);
  const goals = f.c.store.all('goal');
  assert.equal(goals.length, 1);
  const [goal] = goals;
  assert.equal(goal.activatedAt, start);
  assert.equal(goal.deadline, start + hour);
  assert.equal(f.c.store.events().filter(event => event.type === 'goal.activated').length, 1);
});

for (const race of ['identical', 'same command with changed content', 'same submission with changed content']) {
  test('concurrent backlog submissions through separate SQLite connections: ' + race, options, async t => {
    const f = await fixture(t);
    const identical = race === 'identical';
    const sameCommand = race !== 'same submission with changed content';
    const submission = f.input([consult('first'), consult('second', ['first'])]);
    const other = identical ? submission : f.input([consult('first'), consult('second', ['first'], {objective: 'Changed answer'})]);
    f.c.acquireWorker(f.worker.owner);
    const clients = [f.child('submit'), f.child('submit')];
    assert.deepEqual(await Promise.all(clients.map(client => client.receive())), [{ready: true}, {ready: true}]);
    clients[0].send(submission, 'submit');
    clients[1].send(other, sameCommand ? 'submit' : 'other-submit');

    const responses = await Promise.all(clients.map(client => client.receive()));
    assert.deepEqual(await Promise.all(clients.map(client => client.exited)), [{code: 0, signal: null}, {code: 0, signal: null}]);
    for (const response of responses) assert.match(response.leaseError ?? '', /another worker owns/i);

    const winners = responses.filter(response => response.group);
    assert.equal(winners.length, identical ? 2 : 1);
    const group = winners[0].group;
    if (identical) assert.deepEqual(winners[1].group, group);
    else {
      const expectedConflict = sameCommand ? /idempotency key conflict/i : /submission conflict/i;
      assert.match(responses.find(response => response.error)?.error ?? '', expectedConflict);
    }
    const ids = taskIds(group);
    assert.deepEqual(f.c.store.all('backlog_group').map(saved => saved.id), [group.id]);
    assert.deepEqual(f.c.getGoal(f.goal.id).tasks.map(task => task.id).sort(), [ids.first, ids.second].sort());
    assert.equal(f.c.store.events().filter(event => event.type === 'task.submitted').length, 2);
    assert.equal(f.c.store.events().filter(event => event.type === 'backlog.submitted').length, 1);
    assert.deepEqual(f.calls, []);

    await f.worker.drain();
    assert.deepEqual(f.calls, ['Explain first']);
    assert.equal(f.c.getTask(ids.first).status, 'awaiting_review');
    assert.equal(f.c.getTask(ids.second).startedAt, null);
    const winnerInput = winners[0] === responses[0] ? submission : other;
    assert.equal(f.c.getTask(ids.second).spec.objective, winnerInput.items[1].task.objective);
  });
}
