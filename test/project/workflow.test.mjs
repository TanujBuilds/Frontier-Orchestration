import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject, approveProject, reviseProject, prepareResume, stopProject } from '../../src/project/service.mjs';
import { Journal } from '../../src/project/journal.mjs';
import { runProject } from '../../src/project/runner.mjs';
import { Workspace } from '../../src/project/workspace.mjs';
import { FakeProjectFrontier, FakeProjectLocal } from '../../src/project/fake.mjs';
import { git } from '../../src/project/process.mjs';
import { digest, Pause, AttemptError } from '../../src/project/contracts.mjs';

const permissions = { readPaths: ['src/', 'checks/'], writePaths: ['src/'], checks: [{ id: 'test', argv: ['node', 'checks/check.mjs'] }] };
const passing = { verify: async () => ({ simulated: true }), run: async checks => checks.map(({ id }) => ({ id, passed: true, code: 0, stdout: 'ok', stderr: '', screenshots: [] })) };
async function setup(t, frontier = new FakeProjectFrontier()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'overnight-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await mkdir(path.join(repo, 'checks'));
  await writeFile(path.join(repo, 'src/start.txt'), 'start\n');
  await writeFile(path.join(repo, 'checks/check.mjs'), "console.log('ok')\n");
  await writeFile(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n.overnight-output/\n');
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.name', 'Workflow Test');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'baseline');
  const created = await createProject({ root: path.join(root, 'data'), repo, permissions, brief: 'Exercise staged coding', frontier, mode: 'fake' });
  const journal = await new Journal(path.join(root, 'data'), created.jobId).load();
  await approveProject(journal, created.planHash);
  const workspace = new Workspace(created.manifest, journal);
  const run = options => runProject(journal, { frontier, local: new FakeProjectLocal(), checks: passing, keepAwake: false, ...options });
  return { root, repo, journal, workspace, run, created };
}

test('stages run in order, commit accepted results, and completed jobs do not repeat', async t => {
  const { run, journal, repo } = await setup(t);
  const result = await run();
  assert.equal(result.status, 'accepted');
  assert.deepEqual(journal.events.filter(e => e.type === 'stage.accepted').map(e => e.data.stageId), ['implementation', 'verification']);
  assert.ok(result.stages.every(stage => stage.checkpoint && stage.localAttempts === 1));
  assert.equal(await git(repo, 'status', '--porcelain'), '');
  assert.match(await readFile(path.join(result.worktree, 'src/fake-marker.txt'), 'utf8'), /FAKE/);
  const count = journal.events.filter(e => e.type === 'attempt.started').length;
  await run();
  assert.equal(journal.events.filter(e => e.type === 'attempt.started').length, count);
});

test('failed required checks prevent accept and enforce five local attempts plus one rescue', async t => {
  const frontier = new FakeProjectFrontier();
  frontier.reviewCode = async () => ({ decision: 'accept', feedback: 'Looks fine', unverified: [] });
  const { run, journal } = await setup(t, frontier);
  const checks = { ...passing, run: async () => [{ id: 'test', passed: false, code: 1, stdout: '', stderr: 'broken' }] };
  const result = await run({ checks });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.stages[0].localAttempts, 5);
  assert.equal(result.stages[0].codexRescues, 1);
  assert.equal(result.stages[1].localAttempts, 0);
  assert.equal(journal.events.filter(e => e.type === 'stage.accepted').length, 0);
});

test('Codex rescues only exhausted stages; subsequent stages return to local', async t => {
  const frontier = new FakeProjectFrontier();
  const order = [];
  const originalRescue = frontier.rescue.bind(frontier);
  frontier.rescue = async input => { order.push(`rescue:${input.stage.id}`); return originalRescue(input); };
  const { run } = await setup(t, frontier);
  const local = { reply: async input => {
    order.push(`local:${input.stage.id}`);
    if (input.stage.id === 'implementation') throw new AttemptError('malformed reply');
    return new FakeProjectLocal().reply(input);
  } };
  const result = await run({ local });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(order, [...Array(5).fill('local:implementation'), 'rescue:implementation', 'local:verification']);
});

test('two rescues per job is an independent hard limit', async t => {
  const frontier = new FakeProjectFrontier();
  const original = frontier.planProject.bind(frontier);
  frontier.planProject = async input => {
    const plan = await original(input);
    plan.stages.splice(1, 0, { ...plan.stages[0], id: 'second' });
    return plan;
  };
  const { run } = await setup(t, frontier);
  const result = await run({ local: { reply: async () => { throw new AttemptError('invalid'); } } });
  assert.equal(result.status, 'needs_review');
  assert.deepEqual(result.stages.map(s => s.codexRescues), [1, 1, 0]);
  assert.deepEqual(result.stages.map(s => s.localAttempts), [5, 5, 5]);
});

test('resume reuses saved answer and skips accepted stages after review connection loss', async t => {
  const frontier = new FakeProjectFrontier();
  const original = frontier.reviewCode.bind(frontier);
  let unavailable = true, calls = 0;
  frontier.reviewCode = async input => {
    if (input.stage.id === 'verification' && unavailable) throw new Error('HTTP 401');
    return original(input);
  };
  const { run, journal } = await setup(t, frontier);
  const local = { reply: async input => { calls++; return new FakeProjectLocal().reply(input); } };
  const first = await run({ local });
  assert.equal(first.status, 'paused');
  assert.equal(first.stages[0].status, 'accepted');
  assert.equal(calls, 2);
  unavailable = false;
  await prepareResume(journal);
  const second = await run({ local });
  assert.equal(second.status, 'accepted');
  assert.equal(calls, 2);
  assert.equal(journal.events.filter(e => e.type === 'stage.accepted').length, 2);
});

test('transient connection failures retry without consuming an additional attempt or rescue', async t => {
  const { run } = await setup(t);
  let calls = 0, clock = Date.now();
  const result = await run({ now: () => clock, sleep: async ms => { clock += ms; }, local: {
    reply: async input => { if (++calls < 3) throw new Error('ECONNREFUSED'); return new FakeProjectLocal().reply(input); },
  } });
  assert.equal(result.status, 'accepted');
  assert.equal(result.stages[0].localAttempts, 1);
  assert.equal(result.stages[0].codexRescues, 0);
});

test('connection window expires and budget includes waiting across restarts', async t => {
  const { run, journal } = await setup(t);
  let clock = Date.now();
  const offline = { reply: async () => { throw new Error('ECONNREFUSED'); } };
  const result = await run({ now: () => clock, sleep: async ms => { clock += ms; }, local: offline });
  assert.equal(result.status, 'paused');
  assert.equal(journal.last('run.finished').code, 'connection');
  assert.equal(result.stages[0].localAttempts, 1);
  clock = result.deadline + 1;
  const expired = await run({ now: () => clock });
  assert.equal(expired.status, 'paused');
  assert.equal(journal.last('run.finished').code, 'budget');
  await prepareResume(journal, 1);
  assert.ok(journal.last('budget.extended').deadline > result.deadline);
});

test('approval binds exact plan, duplicate runners are refused, and partial log tails recover', async t => {
  const { journal, created } = await setup(t);
  await assert.rejects(approveProject(journal, 'wrong'), /does not match/);
  const release = await journal.lock();
  await assert.rejects(journal.lock(), /already owns/);
  await release();
  await appendFile(journal.file, '{"partial":');
  const loaded = await new Journal(journal.root, journal.id).load();
  assert.ok(loaded.tail);
  const unlock = await loaded.lock();
  assert.equal(loaded.tail, '');
  assert.ok(loaded.last('log.recovered'));
  assert.equal(digest(loaded.last('project.created')), created.planHash);
  await unlock();
});

test('scope violations pause before mutation; stale hash consumes an attempt', async t => {
  const { workspace, journal, created } = await setup(t);
  await workspace.initialize();
  const stage = created.manifest.plan.stages[0];
  await assert.rejects(workspace.apply('bad', stage, [{ path: 'checks/check.mjs', action: 'write', baseHash: null, content: 'bad' }]), Pause);
  await assert.rejects(workspace.apply('stale', stage, [{ path: 'src/start.txt', action: 'write', baseHash: null, content: 'bad' }]), AttemptError);
  assert.equal(journal.events.filter(e => e.type === 'edits.intent').length, 0);
  await symlink('/tmp', path.join(workspace.root, 'src/link'));
  await assert.rejects(workspace.readFiles(['src/link/anything']), /Symlink/);
});

test('interrupted batch reconciles applied files and applies remaining edits exactly once', async t => {
  const { workspace, journal } = await setup(t);
  await workspace.initialize();
  const before = await workspace.snapshot();
  await journal.append('edits.intent', { key: 'interrupted', snapshotBefore: before, changes: [
    { path: 'src/start.txt', before: before['src/start.txt'], after: digest('changed'), content: 'changed' },
    { path: 'src/new.txt', before: null, after: digest('new'), content: 'new' },
  ] });
  await writeFile(path.join(workspace.root, 'src/start.txt'), 'changed');
  await workspace.recover();
  assert.equal(await readFile(path.join(workspace.root, 'src/new.txt'), 'utf8'), 'new');
  await workspace.recover();
  assert.equal(journal.events.filter(e => e.type === 'edits.applied').length, 1);
});

test('external file or HEAD changes pause rather than overwriting', async t => {
  const { workspace, repo } = await setup(t);
  await workspace.initialize();
  await writeFile(path.join(workspace.root, 'src/start.txt'), 'external');
  await assert.rejects(workspace.recover(), /Workspace changed/);
  await git(workspace.root, 'add', '.');
  await git(workspace.root, 'commit', '-qm', 'external');
  await assert.rejects(workspace.recover(), /HEAD changed/);
  assert.equal(await git(repo, 'status', '--porcelain'), '');
});

test('missing check evidence cannot be accepted', async t => {
  const { run } = await setup(t);
  const result = await run({ checks: { ...passing, run: async () => [] } });
  assert.equal(result.status, 'paused');
  assert.match(result.reason, /evidence is missing/);
});

test('revised plan requires a new approval, preserves accepted stages, and retains attempt count', async t => {
  const frontier = new FakeProjectFrontier();
  const original = frontier.reviewCode.bind(frontier);
  frontier.reviewCode = async input => {
    if (input.stage.id === 'verification') throw new Error('HTTP 401');
    return original(input);
  };
  const { run, journal } = await setup(t, frontier);
  await run();
  const prior = journal.last('project.created');
  frontier.planProject = async () => ({ ...prior.plan, summary: 'Revised scope description' });
  const revised = await reviseProject({ journal, brief: prior.brief, permissions, frontier });
  assert.equal(revised.manifest.planVersion, 2);
  assert.equal(revised.status, 'awaiting_approval');
  await run();
  assert.equal(journal.last('run.finished').code, 'approval');
  await approveProject(journal, revised.planHash);
  frontier.reviewCode = original;
  const result = await run();
  assert.equal(result.status, 'accepted');
  assert.equal(result.stages[0].localAttempts, 1);
  assert.equal(result.stages[1].localAttempts, 1);
  assert.equal(journal.events.filter(e => e.type === 'project.approved').length, 2);
});

test('stop request pauses before provider dispatch and resume clears it', async t => {
  const { run, journal } = await setup(t);
  await stopProject(journal);
  const stopped = await run({ local: { reply: () => { throw new Error('Must not dispatch'); } } });
  assert.equal(stopped.status, 'paused');
  assert.equal(journal.last('run.finished').code, 'stopped');
  await prepareResume(journal);
  assert.equal((await run()).status, 'accepted');
});

test('ten context requests is a hard per-attempt limit', async t => {
  const { run } = await setup(t);
  let calls = 0;
  const result = await run({ local: { reply: async () => { calls++; return { reply: { type: 'read_files', paths: ['src/start.txt'] } }; } } });
  assert.equal(result.status, 'accepted'); // Each stage is eventually rescued by the fake frontier.
  assert.equal(calls, 2 * 5 * 11);
  assert.equal(result.stages[0].localAttempts, 5);
  assert.equal(result.stages[0].codexRescues, 1);
});

test('planning provider failure preserves the requested handoff and returns its job ID', async t => {
  const { root, repo } = await setup(t);
  let failed;
  try {
    await createProject({ root: path.join(root, 'data'), repo, brief: 'Fail this probe', permissions, frontier: { planProject: async () => { throw new Error('invalid structured output'); } } });
  } catch (error) { failed = error; }
  assert.ok(failed.jobId);
  const journal = await new Journal(path.join(root, 'data'), failed.jobId).load();
  assert.equal(journal.last('project.plan.requested').input.brief, 'Fail this probe');
  assert.equal(journal.last('project.plan.failed').reason, 'invalid structured output');
});

test('unavailable sandbox pauses before any worker dispatch', async t => {
  const { run } = await setup(t);
  const result = await run({ checks: { verify: async () => { throw new Pause('Sandbox unavailable', 'isolation'); } }, local: { reply: async () => { throw new Error('Must not dispatch'); } } });
  assert.equal(result.status, 'paused');
  assert.equal(result.stages[0].localAttempts, 0);
  assert.match(result.reason, /Sandbox unavailable/);
});
