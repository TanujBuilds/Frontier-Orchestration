import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Worker} from '../src/harness/worker.mjs';
import {Journal} from '../src/project/journal.mjs';
import {adapters, calls, fileContents, files, fixture, open, startTime} from './fixtures/mosaic-recovery/fixture.mjs';

async function failedGate(t, {alwaysBroken = false} = {}) {
  const cleanup = [];
  const f = await fixture({after: callback => cleanup.push(callback)});
  let c = open(f, startTime + 1000), owner = 'repair-original';
  c.acquireWorker(owner);
  t.after(async () => {
    const lease = c.store.maybe('lease', 'coordinator');
    if (lease) c.releaseWorker(lease.token);
    c.close();
    for (const callback of cleanup.reverse()) await callback();
  });
  const fake = adapters(f.root);
  const complete = fake.provider.complete.bind(fake.provider);
  fake.provider.complete = async (...args) => {
    const input = JSON.parse(args[0].at(-1).content);
    const result = await complete(...args);
    const action = JSON.parse(result.content);
    if (action.type === 'apply_changes') {
      const edit = action.edits[0];
      edit.baseHash = input.inventory.find(file => file.path === edit.path)?.hash ?? null;
      if (input.task.objective === 'schema' && (input.attempt === 1 || alwaysBroken)) {
        edit.content = "export const value = 'broken';\n";
      }
    }
    return {...result, content: JSON.stringify(action)};
  };
  let worker = new Worker({c, owner, ...fake});
  const id = f.goal.tasks[0].id;
  for (let n = 0; n < 12; n++) {
    await worker.tick();
    const saved = c.getTask(id);
    if (saved.checkpoint.phase === 'attempt' && saved.checkpoint.failedGate) break;
  }
  const before = c.getTask(id);
  assert.equal(before.status, 'running');
  assert.equal(before.checkpoint.phase, 'attempt');
  assert.equal(before.checkpoint.repairFailure.category, 'functional_check');
  assert.equal(before.attempts, 1);
  assert.equal(before.spent.model, 2);
  assert.equal(before.spent.codexReview, 0);
  const journal = await new Journal(path.join(f.stateRoot, 'coding'), id).load();
  const receipt = journal.completed('harness-attempt-1/checks');
  assert.equal(receipt.value.find(check => check.id === 'schema').passed, false);
  assert.match(receipt.value.find(check => check.id === 'schema').stderr, /AssertionError/);
  assert.deepEqual(await calls(f.root, 'review'), []);
  return {
    f, id, before, journal,
    get c() { return c; },
    get worker() { return worker; },
    restart() {
      c.releaseWorker(owner);
      c.close();
      c = open(f, startTime + 2000);
      owner = 'repair-replacement';
      c.acquireWorker(owner);
      worker = new Worker({c, owner, ...fake});
      return owner;
    },
  };
}

test('combined repair survives ownership restart after a durable failed gate and integrates a corrected candidate', async t => {
  const f = await failedGate(t);
  const originalRequests = f.c.store.requestOutcomes(f.id);
  const owner = f.restart();
  assert.equal(f.c.getTask(f.id).status, 'uncertain');
  const recovered = f.c.recoverSaved(f.id, owner);
  assert.equal(recovered.status, 'queued');
  assert.deepEqual(recovered.checkpoint, f.before.checkpoint);
  assert.deepEqual(recovered.spent, f.before.spent);
  assert.equal(recovered.deadline, f.before.deadline);
  assert.equal(recovered.attempts, f.before.attempts);
  assert.deepEqual(f.c.store.requestOutcomes(f.id), originalRequests);
  assert.deepEqual(await calls(f.f.root, 'review'), []);

  for (let n = 0; n < 12 && f.c.getTask(f.id).status !== 'accepted'; n++) await f.worker.tick();
  const accepted = f.c.getTask(f.id);
  assert.equal(accepted.status, 'accepted', accepted.reason);
  assert.equal(accepted.attempts, 2);
  assert.equal(accepted.spent.model, 4);
  assert.equal(accepted.spent.codexReview, 1);
  assert.equal(accepted.deadline, f.before.deadline);
  assert.equal(accepted.hash, f.before.hash);
  assert.equal(accepted.goalVersion, f.before.goalVersion);
  assert.ok(accepted.integration.checks.every(check => check.passed));
  assert.equal(await readFile(path.join(accepted.integration.worktree, files.schema), 'utf8'), fileContents('schema'));
  assert.deepEqual((await calls(f.f.root, 'model')).map(({attempt, exchange}) => ({attempt, exchange})), [
    {attempt: 1, exchange: 0}, {attempt: 1, exchange: 1},
    {attempt: 2, exchange: 0}, {attempt: 2, exchange: 1},
  ]);
  const latest = await new Journal(path.join(f.f.stateRoot, 'coding'), f.id).load();
  assert.deepEqual(latest.completed('harness-attempt-1/checks'), f.journal.completed('harness-attempt-1/checks'));
  assert.equal(latest.events.filter(event => event.type === 'operation.started' && event.data.key === 'harness-attempt-1/checks').length, 1);
});

for (const damage of ['missing receipt', 'changed receipt', 'unapplied intent']) {
  test(`post-failure recovery refuses ${damage} without spending or changing the candidate`, async t => {
    const f = await failedGate(t);
    const beforeBytes = await readFile(path.join(f.journal.last('workspace.created').root, files.schema));
    if (damage === 'unapplied intent') {
      await f.journal.append('edits.intent', {
        key: 'interrupted-fixture-edit', snapshotBefore: f.journal.events.findLast(event => event.data.snapshot).data.snapshot,
        changes: [],
      });
    } else {
      const events = structuredClone(f.journal.events);
      const event = events.find(event => event.type === 'operation.completed' && event.data.key === 'harness-attempt-1/checks');
      if (damage === 'missing receipt') event.type = 'fixture.missing_receipt';
      else event.data.value.find(check => check.id === 'schema').stderr = 'A different failed assertion';
      await writeFile(f.journal.file, events.map(event => JSON.stringify(event)).join('\n') + '\n');
    }
    const owner = f.restart();
    assert.throws(() => f.c.recoverSaved(f.id, owner), /quiescence|receipt|evidence|intent|gate/i);
    const held = f.c.getTask(f.id);
    assert.equal(held.status, 'uncertain');
    assert.deepEqual(held.checkpoint, f.before.checkpoint);
    assert.deepEqual(held.spent, f.before.spent);
    assert.equal(held.deadline, f.before.deadline);
    assert.deepEqual(await readFile(path.join(f.journal.last('workspace.created').root, files.schema)), beforeBytes);
    assert.deepEqual(await calls(f.f.root, 'review'), []);
  });
}

test('a saved no-progress stop remains blocked across ownership restart without another repair request', async t => {
  const f = await failedGate(t, {alwaysBroken: true});
  for (let n = 0; n < 8 && f.c.getTask(f.id).status !== 'blocked'; n++) await f.worker.tick();
  const stopped = f.c.getTask(f.id);
  assert.equal(stopped.checkpoint.phase, 'no_progress');
  assert.match(stopped.reason, /No progress/);
  const requests = await calls(f.f.root, 'model');
  f.restart();
  await f.worker.tick();
  assert.equal(f.c.getTask(f.id).status, 'blocked');
  assert.deepEqual(f.c.getTask(f.id).checkpoint, stopped.checkpoint);
  assert.deepEqual(f.c.getTask(f.id).spent, stopped.spent);
  assert.deepEqual(await calls(f.f.root, 'model'), requests);
  assert.deepEqual(await calls(f.f.root, 'review'), []);
});
