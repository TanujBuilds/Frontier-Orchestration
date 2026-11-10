import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../src/harness/contracts.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {command, git} from '../src/project/process.mjs';
import {CheckRunner} from '../src/project/sandbox.mjs';

const requestedModel = 'fixture-coder';
const reportedModel = 'fixture-coder-2026-01';
const workerApiKey = 'mosaic-overnight-dummy-key';
const checks = ['starter', 'unit', 'final'].map(id => ({
  id, argv: [process.execPath, `checks/${id}.mjs`],
}));
const initialSource = 'export const value = 1;\n';
const correctedSource = 'export const value = 42;\n';

async function repository(repo) {
  await mkdir(path.join(repo, 'src'), {recursive: true});
  await mkdir(path.join(repo, 'checks'));
  await writeFile(path.join(repo, 'src/value.mjs'), initialSource);
  await writeFile(path.join(repo, 'checks/starter.mjs'), `
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
if (!readFileSync(join(process.env.MOSAIC_APPROVED_INPUTS, 'src/value.mjs'), 'utf8').includes('export const value')) process.exit(1);
console.log('approved input staged');
`);
  await writeFile(path.join(repo, 'checks/unit.mjs'), `
import {value} from '../src/value.mjs';
if (value !== 42) {
  console.error('expected 42, got ' + value);
  process.exit(1);
}
console.log('unit passed');
`);
  await writeFile(path.join(repo, 'checks/final.mjs'), `
import {value} from '../src/value.mjs';
if (value !== 42) process.exit(1);
console.log('final passed');
`);
  await git(repo, 'init', '--quiet');
  await git(repo, 'config', 'user.name', 'Mosaic Fixture');
  await git(repo, 'config', 'user.email', 'mosaic-fixture@invalid');
  await git(repo, 'add', '--', 'src', 'checks');
  await git(repo, 'commit', '-m', 'Fixture baseline');
  return {repo, baseCommit: await git(repo, 'rev-parse', 'HEAD'), readPaths: ['src/', 'checks/'], writePaths: ['src/'], checks};
}

// Keep real check staging, execution results and snapshot validation. Replace
// the platform sandbox boundary with execution of these exact fixture scripts.
class FixtureCheckRunner extends CheckRunner {
  async verify() { return {fixture: true}; }

  async execute(argv, timeoutMs, signal) {
    assert.ok(checks.some(check => argv.length === 2 && argv.every((arg, index) => arg === check.argv[index])));
    return command(argv, {
      cwd: this.workspace.root,
      env: {MOSAIC_APPROVED_INPUTS: this.stagedInputRoot},
      timeoutMs: Math.min(timeoutMs, 10_000),
      signal,
    });
  }
}

async function apiFixture(t, reply) {
  const calls = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    const {method, url} = req;
    const authenticated = req.headers.authorization === `Bearer ${workerApiKey}`;
    const call = {method, url, authenticated};
    calls.push(call);
    res.setHeader('Content-Type', 'application/json');
    if (!authenticated) return res.writeHead(401).end('{}');
    if (method === 'GET' && url === '/v1/models') {
      return res.end(JSON.stringify({data: [{id: requestedModel}]}));
    }
    if (method !== 'POST' || url !== '/v1/chat/completions') return res.writeHead(404).end('{}');
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      call.body = JSON.parse(Buffer.concat(chunks));
      const input = JSON.parse(call.body.messages.at(-1).content);
      const content = JSON.stringify(reply(input));
      res.end(JSON.stringify({model: reportedModel, choices: [{message: {content}, finish_reason: 'stop'}]}));
    } catch (error) {
      errors.push(error);
      res.writeHead(422).end('{}');
    }
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {baseUrl: `http://127.0.0.1:${server.address().port}/v1`, calls, errors};
}

test('combined assignment, behavioral repair, restart and pinned API worker complete Overnight v2', {timeout: 45_000}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-flexibility-overnight-'));
  let c;
  t.after(async () => {
    c?.close();
    await rm(root, {recursive: true, force: true});
  });
  const project = await repository(path.join(root, 'source'));
  project.behavioralChecks = [{criterionId: 'value', description: 'The integrated value is 42', checkIds: ['unit']}];
  const stage = (key, role, dependsOn, checkIds) => ({
    key, kind: 'coding', role, objective: `Fixture ${role}`, acceptance: ['Protected checks pass'], dependsOn,
    permissions: {readPaths: project.readPaths, writePaths: project.writePaths, checks: checkIds},
  });
  const implementation = stage('change', 'implementation', [], ['unit']);
  const plan = {tasks: [implementation, stage('verify', 'final', ['change'], ['starter', 'unit', 'final'])]};
  const {baseUrl, calls, errors} = await apiFixture(t, input => {
    if (input.goal) return plan;
    if (input.task.role === 'implementation' && input.attempt === 2 && input.exchange === 0) {
      assert.equal(input.repair?.failure.category, 'functional_check');
      assert.match(input.repair.failure.checks.find(check => check.id === 'unit')?.stderr ?? '', /expected 42, got 1/);
      const file = input.inventory.find(file => file.path === 'src/value.mjs');
      assert.match(file?.hash ?? '', /^[a-f0-9]{64}$/);
      return {type: 'apply_changes', summary: 'Correct the value', edits: [
        {path: file.path, action: 'write', baseHash: file.hash, content: correctedSource},
      ]};
    }
    assert.ok(['implementation', 'final'].includes(input.task.role));
    return {type: 'finish_stage', summary: 'Run the protected checks'};
  });
  const workerProfile = {
    baseUrl, model: requestedModel, displayName: 'Fixture API worker', revision: 'fixture-r1', streaming: false,
    capabilities: {protocol: 'mosaic-structured-v1', transports: ['json'], modelDiscovery: 'advertised'},
  };
  let now = Date.UTC(2026, 0, 1);
  c = new Coordinator({root: path.join(root, 'state'), now: () => now, beta: true, workerProfile});
  const config = {beta: true, environment: 'fixture', workerApiKey, codexPath: process.execPath};
  const reviews = [];
  const makeWorker = () => new Worker({c, config, checksFactory: workspace => new FixtureCheckRunner(workspace, {codex: process.execPath}),
    reviewer: {reviewCode: async packet => {
      reviews.push(packet);
      return {decision: 'accept', feedback: 'Fixture reviewer accepts the protected check evidence', unverified: []};
    }},
  });
  let worker = makeWorker();
  c.acquireWorker(worker.owner);
  let dispatcher = new Dispatcher({c, worker, config});
  const invoke = (name, input) => dispatcher.invoke(name, input);
  const mutate = (name, idempotencyKey, input) => invoke(name, {...input, idempotencyKey});
  const manifest = {
    objective: 'Correct and verify a value', acceptance: ['The integrated value is 42'], project,
    mode: 'overnight_review', environment: 'fixture',
    limits: {hours: 1, maxTasks: 2, reviewAgentRuns: 0, taskLimits: {coding: {seconds: 600}}},
  };
  const legacy = await mutate('goal_prepare', 'legacy-prepare', {manifest: {...manifest, submissionId: 'legacy'}});
  assert.equal(legacy.manifest.mode.version, 1);
  assert.equal(Object.hasOwn(legacy.manifest, 'overnightPolicy'), false);
  assert.deepEqual(legacy.manifest.workerProfile, workerProfile);
  const prepared = await mutate('assignment_prepare', 'v2-prepare', {manifest: {
    ...manifest, submissionId: 'v2', modeVersion: 2,
    overnightPolicy: {preflightCheckIds: ['starter'], finalOnlyCheckIds: ['final']},
  }});
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  const goal = await invoke('goal_get', {goalId: prepared.goalId});
  assert.equal(goal.hash, prepared.hash);
  assert.equal(goal.manifest.mode.version, 2);
  assert.deepEqual(goal.manifest.workerProfile, workerProfile);
  assert.equal(goal.hash, digest(goal.manifest));
  const approval = {goalId: goal.id, hash: goal.hash};
  await assert.rejects(mutate('goal_activate', 'activate-too-early', approval), /preflight/i);
  const otherHash = (goal.hash.startsWith('0') ? '1' : '0') + goal.hash.slice(1);
  const badPreflight = await mutate('overnight_preflight', 'wrong-preflight', {...approval, hash: otherHash});
  await dispatcher.whenIdle();
  const badOperation = await invoke('operation_get', {operationId: badPreflight.id});
  assert.equal(badOperation.status, 'failed');
  assert.match(badOperation.error, /exact approval hash/);
  const preflight = await mutate('overnight_preflight', 'exact-preflight', approval);
  await dispatcher.whenIdle();
  const operation = await invoke('operation_get', {operationId: preflight.id});
  assert.equal(operation.status, 'completed', operation.error);
  assert.equal(operation.result.passed, true, JSON.stringify(operation.result));
  assert.equal(operation.result.approvalHash, goal.hash);
  assert.deepEqual(operation.result.checks.map(({id, code, stdout}) => [id, code, stdout.trim()]), [
    ['starter', 0, 'approved input staged'],
  ]);
  assert.deepEqual(c.store.spent(goal.id), {});
  assert.deepEqual(calls, []);
  await assert.rejects(mutate('goal_activate', 'activate-wrong-hash', {...approval, hash: otherHash}), /exact goal approval hash/i);
  assert.equal((await invoke('goal_get', {goalId: goal.id})).status, 'draft');
  const active = await mutate('goal_activate', 'activate-v2', approval);
  assert.equal(active.deadline, now + 3_600_000);
  const {key, ...task} = implementation;
  await assert.rejects(mutate('task_submit', 'unplanned-stage', {
    goalId: goal.id, task: {...task, submissionId: key},
  }), /atomically validated planner graph/);
  assert.deepEqual((await invoke('goal_get', {goalId: goal.id})).tasks, []);

  await worker.tick();
  const planned = await invoke('goal_get', {goalId: goal.id});
  assert.equal(planned.planning?.status, 'completed', JSON.stringify(planned.planning));
  const [change, final] = planned.tasks;
  assert.equal(planned.tasks.length, 2);
  assert.deepEqual(final.spec.dependsOn, [change.id]);
  assert.deepEqual(c.store.get('overnight_plan', goal.id).specHashes, [change.hash, final.hash]);
  const getTask = taskId => invoke('task_get', {taskId});
  let failed;
  for (let step = 0; step < 6; step++) {
    await worker.tick();
    failed = await getTask(change.id);
    if (failed.feedback.some(entry => entry.kind === 'check')) break;
  }
  assert.equal(failed.checkpoint.repairFailure.category, 'functional_check');
  assert.match(failed.checkpoint.repairFailure.checks.find(check => check.id === 'unit')?.stderr ?? '', /expected 42, got 1/);
  assert.equal(failed.attempts, 1);
  assert.equal(failed.spent.model, 1);
  assert.equal(failed.spent.codexReview, 0);
  assert.equal(failed.deadline, now + 600_000);
  assert.deepEqual(reviews, []);

  const originalRequests = c.store.requestOutcomes(change.id);
  const originalCheckpoint = structuredClone(failed.checkpoint);
  c.releaseWorker(worker.owner);
  c.close();
  c = new Coordinator({root: path.join(root, 'state'), now: () => now, beta: true, workerProfile});
  worker = makeWorker();
  c.acquireWorker(worker.owner);
  assert.equal(c.getTask(change.id).status, 'uncertain');
  const recovered = c.recoverSaved(change.id, worker.owner);
  assert.deepEqual(recovered.checkpoint, originalCheckpoint);
  assert.deepEqual(recovered.spent, failed.spent);
  assert.deepEqual(c.store.requestOutcomes(change.id), originalRequests);
  dispatcher = new Dispatcher({c, worker, config});
  now += 60_000;
  await worker.drain({maxSteps: 20});
  assert.deepEqual(errors, []);
  const completed = await invoke('goal_get', {goalId: goal.id});
  assert.equal(completed.status, 'completed', JSON.stringify(completed.tasks.map(({status, reason}) => ({status, reason}))));
  assert.equal(completed.deadline, active.deadline);
  assert.deepEqual(completed.tasks.map(task => task.status), ['accepted', 'accepted']);
  assert.equal(completed.tasks[0].attempts, 2);
  assert.equal(completed.tasks[0].deadline, failed.deadline);
  assert.equal(completed.tasks[1].checkpoint.executionBase, completed.tasks[0].integration.commit);
  assert.deepEqual(reviews.map(({stage}) => stage.role), ['implementation', 'final']);
  assert.ok(reviews.every(({evidence}) => evidence.behavioralEvidence.criteria.every(criterion => criterion.checks.every(check => check.status === 'passed'))));
  const gateEvidence = ({checks: results}) => results.map(({id, passed, code, stdout}) => [id, passed, code, stdout.trim()]);
  const implementationGates = [['starter', true, 0, 'approved input staged'], ['unit', true, 0, 'unit passed']];
  const finalGates = [...implementationGates, ['final', true, 0, 'final passed']];
  assert.deepEqual(reviews.map(({evidence}) => gateEvidence(evidence)), [implementationGates, finalGates]);
  assert.deepEqual(completed.tasks.map(({integration}) => gateEvidence(integration)), [implementationGates, finalGates]);
  assert.ok(completed.tasks.every(task => task.integration.review === 'codex_legacy'));
  const integrated = completed.integration.worktree;
  assert.equal(await git(integrated, 'rev-parse', 'HEAD'), completed.tasks[1].integration.commit);
  assert.equal(await git(integrated, 'show', 'HEAD:src/value.mjs'), correctedSource.trim());
  assert.equal(await git(project.repo, 'rev-parse', 'HEAD'), project.baseCommit);
  assert.equal(await git(project.repo, 'status', '--porcelain'), '');
  assert.equal(await readFile(path.join(project.repo, 'src/value.mjs'), 'utf8'), initialSource);

  assert.equal(completed.receiptHash, digest(completed.receipt));
  assert.equal(completed.receipt.approvalHash, goal.hash);
  assert.equal(completed.receipt.deadline, active.deadline);
  assert.deepEqual(completed.receipt.spending, {model: 5, codexReview: 2, search: 0, download: 0});
  const report = JSON.parse(await readFile(completed.overnightRun.reportPath, 'utf8'));
  assert.equal(report.receiptHash, completed.receiptHash);
  assert.equal(report.planning.spent, 1);
  assert.deepEqual(report.tasks.map(({spent}) => [spent.model, spent.codexReview]), [[3, 1], [1, 1]]);

  assert.ok(calls.every(call => call.authenticated));
  assert.equal(calls[0]?.url, '/v1/models', 'Advertised discovery must precede completion');
  assert.ok(!JSON.stringify({completed, report, reviews}).includes(workerApiKey), 'Fixture key must stay outside job evidence');
  const completions = calls.filter(call => call.method === 'POST');
  assert.equal(completions.length, completed.receipt.spending.model);
  for (const {body} of completions) {
    assert.equal(body.model, requestedModel);
    assert.equal(body.stream, false);
    assert.equal(Object.hasOwn(body, 'chat_template_kwargs'), false);
    assert.ok(!JSON.stringify(body).includes(workerApiKey), 'Fixture key must stay outside request bodies');
  }
  const rows = c.store.db.prepare("SELECT status,data FROM requests WHERE kind='model'").all();
  assert.equal(rows.length, completions.length);
  for (const row of rows) {
    assert.equal(row.status, 'completed');
    assert.ok(!row.data.includes(workerApiKey), 'Fixture key must stay outside persisted requests');
    const {result, workerProfile: savedProfile} = JSON.parse(row.data);
    assert.deepEqual(savedProfile, workerProfile);
    assert.equal(result.requestedModel, requestedModel);
    assert.equal(result.model, reportedModel);
  }
});
