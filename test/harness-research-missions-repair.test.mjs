import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {startApi} from '../src/harness/api.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/mosaic-research-mission.mjs', import.meta.url));
const invoke = (...args) => exec(process.execPath, [script, ...args], {timeout: 45_000});
const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'research-mission-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

test('offline demo persists a genuine targeted repair, fresh review, and unrepairable partial', async t => {
  const output = path.join(await temporary(t), 'mission');
  const {stdout} = await invoke('demo', '--output', output);
  assert.equal(JSON.parse(stdout).fixture, true);

  const transcript = await json(path.join(output, 'transcript.json'));
  assert.equal(transcript.schemaVersion, 1);
  assert.equal(transcript.fixture.reviewer, 'simulated_independent_reviewer');
  assert.equal(transcript.fixture.liveValidation, 'not_run');
  const [initial, revised, pending, accepted, partial] = transcript.stages;
  assert.deepEqual(transcript.stages.map(row => row.status),
    ['awaiting_review', 'revision_needed', 'awaiting_review', 'accepted', 'partial']);
  assert.equal(initial.candidateHash, revised.candidateHash);
  assert.notEqual(revised.candidateHash, pending.candidateHash);
  assert.equal(pending.candidateHash, accepted.candidateHash);
  for (const stage of [revised, pending, accepted]) {
    for (const field of ['goalId', 'taskId', 'remoteJobId', 'deadline', 'goalDeadline']) {
      assert.equal(stage[field], initial[field]);
    }
  }
  assert.notEqual(partial.taskId, accepted.taskId);

  const [negative, fresh, complete, declined] = await Promise.all(
    ['revision-needed', 'fresh-pending', 'accepted', 'partial'].map(async name => {
      const [view, markdown] = await Promise.all([
        json(path.join(output, name + '.json')), readFile(path.join(output, name + '.md'), 'utf8'),
      ]);
      assert.match(markdown, /simulated independent reviewer/i);
      if (name === 'partial') assert.match(markdown, /cannot repair/i);
      assert.equal(view.fixture.reviewer, 'simulated_independent_reviewer');
      return view;
    }),
  );
  assert.equal(negative.status, 'revision_needed');
  assert.equal(negative.claims.find(claim => claim.id === 'C1').support, 'disputed');
  assert.equal(fresh.status, 'awaiting_review');
  assert.equal(fresh.claims.some(claim => claim.support === 'reviewed_supported'), false);
  assert.equal(complete.status, 'accepted');
  assert.equal(complete.claims.find(claim => claim.id === 'C1').support, 'reviewed_supported');
  assert.equal(complete.asOf, null);
  assert.equal(complete.requestedBrief.asOf, '2026-11-10');
  assert.match(complete.comparisons[0].text, /valid leases.*intact journal/);
  assert.deepEqual(complete.contradictions[0].claimIds, ['C1', 'C3']);
  assert.match(complete.unanswered[0].text, /power loss/);
  assert.equal(complete.sources.find(source => source.id === 'S001').retrievedAt, '2026-11-10T00:00:00Z');
  assert.equal(complete.sources.find(source => source.id === 'S003').retrievedAt, null);
  assert.equal(negative.sourcesHash, complete.sourcesHash);
  assert.notEqual(negative.reportHash, complete.reportHash);
  assert.equal(declined.status, 'partial');
  assert.match(declined.collectionReason, /cannot repair/i);
  assert.equal(declined.claims.some(claim => claim.support === 'reviewed_supported'), false);

  const state = path.join(output, 'coordinator');
  const c = new Coordinator({root: state});
  let api;
  try {
    const task = c.getTask(accepted.taskId);
    const originalFile = path.join(state, 'research-proposals', task.id, initial.candidateHash + '.json');
    const original = await json(originalFile);
    const retained = await json(path.join(task.result.directory, 'receipt.json'));
    const repaired = await json(path.join(task.result.directory, 'claims.json'));
    assert.equal(original.descriptor.candidateHash, initial.candidateHash);
    assert.equal(retained.deadline, Math.floor(initial.deadline / 1000));
    assert.equal(retained.targetedRepair.base.report, original.canonical.report);
    assert.equal(retained.quality.accepted_candidate_hash, pending.candidateHash);
    assert.deepEqual(retained.targetedRepair.receipt.changed.map(row => row.unit), ['claims:C1']);
    const before = JSON.parse(original.canonical.report);
    assert.notEqual(repaired.claims[0].text, before.claims[0].text);
    assert.deepEqual({...repaired, claims: repaired.claims.slice(1)},
      {...before, claims: before.claims.slice(1)});
    assert.deepEqual(task.researchReviewTickets.map(row => row.submissionIntent.input.decision), ['revise', 'accept']);
    assert.deepEqual(task.researchReviewAcceptance.input.coverage, task.checkpoint.reviewCandidate.units);
    assert.deepEqual(task.remoteSpent, {model: 2, search: 1, download: 0});
    assert.equal(task.reviews, 2);
    assert.equal(transcript.checks.reservationReplay, true);
    assert.equal(transcript.checks.staleCandidateRejected, true);
    assert.equal(transcript.checks.incompleteCoverageRejected, true);
    assert.equal(transcript.checks.changedReplayRejected, true);
    assert.equal(transcript.checks.fullReviewReplay, true);

    const incompleteTask = c.getTask(partial.taskId);
    const partialReceipt = await json(path.join(incompleteTask.result.directory, 'receipt.json'));
    assert.match(partialReceipt.reason, /cannot repair/i);
    assert.equal(partialReceipt.quality.accepted_candidate_hash, null);
    assert.equal(incompleteTask.reviews, 1);
    assert.equal(incompleteTask.researchReviewAcceptance, undefined);
    assert.equal((await readdir(path.join(state, 'research-proposals', incompleteTask.id))).length, 1);

    const token = randomBytes(32).toString('hex');
    api = await startApi({dispatcher: new Dispatcher({c}), token, headless: true});
    await writeFile(path.join(state, 'connection.json'), JSON.stringify({token, url: api.url}));
    const readArgs = ['--root', state, '--task', task.id];
    const history = JSON.parse((await invoke('inspect', ...readArgs, '--candidate', initial.candidateHash)).stdout);
    assert.equal(history.status, 'revision_needed');
    const page = JSON.parse((await invoke('export', ...readArgs, '--format', 'json', '--offset', '0', '--limit', '1')).stdout);
    assert.equal(page.status, 'accepted');
    assert.equal(page.pagination.limit, 1);
    const markdown = (await invoke('export', ...readArgs, '--format', 'markdown')).stdout;
    assert.match(markdown, /lease/i);
    await appendFile(path.join(task.result.directory, 'claims.json'), ' ');
    const tampered = JSON.parse((await invoke('inspect', ...readArgs)).stdout);
    assert.notEqual(tampered.status, 'accepted');
    assert.match(JSON.stringify(tampered), /stale.review|stale_review/i);
  } finally {
    await api?.close();
    c.close();
  }
});

test('offline demo claims a fresh temp output directory and rejects symlink ancestors', async t => {
  const root = await temporary(t);
  const existing = path.join(root, 'existing');
  await mkdir(existing);
  await writeFile(path.join(existing, 'keep'), 'existing state');
  await assert.rejects(invoke('demo', '--output', existing), /fresh|already exists/i);
  const link = path.join(root, 'link');
  await symlink(existing, link);
  await assert.rejects(invoke('demo', '--output', path.join(link, 'mission')), /symlink|unsafe/i);
  assert.deepEqual(await readdir(existing), ['keep']);
  await assert.rejects(invoke('demo', '--output', path.join(root, 'unused'), '--root', existing), /option/i);
});

test('offline demo isolates every Python subprocess from inherited Python startup hooks', async t => {
  const root = await temporary(t);
  const marker = path.join(root, 'unexpected-python-startup');
  await writeFile(path.join(root, 'sitecustomize.py'),
    'from pathlib import Path\nPath(' + JSON.stringify(marker) + ').touch()\n');
  await exec(process.execPath, [script, 'demo', '--output', path.join(root, 'mission')], {
    env: {...process.env, PYTHONPATH: root}, timeout: 45_000,
  });
  await assert.rejects(readFile(marker), {code: 'ENOENT'});
});
