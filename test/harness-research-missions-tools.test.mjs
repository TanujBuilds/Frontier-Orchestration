import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appendFile, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {Dispatcher} from '../src/harness/tools.mjs';
import {digest} from '../src/harness/contracts.mjs';
import {fixture, policy} from '../test-support/research-review-binding.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function missionFixture(t, changeReport = () => {}) {
  const f = await fixture(t, {environment: 'fixture', researchPolicy: {
    ...policy, repairContextVersion: 1, correctionStrategy: 'targeted_v1'
  }});
  const {canonical, descriptor} = f.packet;
  const report = JSON.parse(canonical.report);
  const sources = JSON.parse(canonical.sources);
  const passage = 'The fixture retains a queued record across restart.';
  const selection = {start: 0, end: passage.length, text_sha256: sha(passage)};
  sources.S001 = {...sources.S001, text: passage, text_sha256: selection.text_sha256};
  report.claims[0].text = passage;
  report.claims[0].evidence[0] = {source_id: 'S001', quote: passage, selection};
  changeReport(report);
  canonical.report = JSON.stringify(report);
  canonical.sources = JSON.stringify(sources);
  descriptor.reportSha256 = sha(canonical.report);
  descriptor.sourcesSha256 = sha(canonical.sources);
  descriptor.units = ['title', ...report.claims.map(claim => 'claims:' + claim.id),
    ...['summary','comparisons','recommendations','contradictions','unanswered']
      .flatMap(section => Array.isArray(report[section]) ? report[section].map((_, i) => section + ':' + i) : [])];
  delete descriptor.candidateHash;
  descriptor.candidateHash = digest(descriptor);
  f.c.store.tx(() => {
    const task = f.c.store.get('task', f.task.id);
    task.status = 'queued';
    f.c.store.put('task', task);
  });
  f.c.claimNext('owner');
  await f.a.step(f.c.getTask(f.task.id), 'owner');
  return f;
}

const inspect = (d, f, fields = {}) => d.invoke('research_mission_inspect', {taskId: f.task.id, ...fields});

test('public mission preparation is metadata only and checks exact goal authority and replay', async t => {
  const f = await missionFixture(t);
  const d = new Dispatcher({c: f.c, worker: f.w});
  const brief = {question: 'Fixture', scope: 'Two local examples', outputShape: 'Comparison', asOf: '2026-11-10'};
  const input = {goalId: f.g.id, expectedGoalHash: f.g.hash, brief, idempotencyKey: 'mission-draft'};
  const before = f.c.store.all('task'), calls = f.calls.length;
  const draft = await d.invoke('research_mission_prepare', input);
  assert.equal(draft.status, 'drafted');
  assert.equal(draft.taskId, null);
  assert.deepEqual(await d.invoke('research_mission_prepare', input), draft);
  assert.deepEqual(f.c.store.all('task'), before);
  const view = await inspect(d, f);
  assert.equal(view.missionId, f.task.id);
  assert.deepEqual(view.requestedBrief, {draftId:draft.missionId, ...brief});
  await assert.rejects(d.invoke('research_mission_prepare', {...input, brief: {...brief, scope: 'Other'}}), /conflict/i);
  await assert.rejects(d.invoke('research_mission_prepare', {...input, expectedGoalHash: 'a'.repeat(64), idempotencyKey: 'other'}), /goal hash/i);
  assert.equal(f.calls.length, calls);
});

test('the beta catalog omits all research tools, including mission presentation', async t => {
  const f = await missionFixture(t);
  const d = new Dispatcher({c:f.c, worker:f.w, config:{beta:true}});
  assert.deepEqual(d.tools().filter(tool => tool.name.startsWith('research_')), []);
});

test('a later prepared draft cannot reidentify or rescope a collected accepted task', async t => {
  const f = await missionFixture(t);
  const d = new Dispatcher({c:f.c, worker:f.w});
  await f.accept();
  await f.collect();
  const before = await inspect(d, f);
  const brief = {question:'Fixture', scope:'Outside the approved source scope', outputShape:'New format', asOf:'2099-01-01'};
  const draft = await d.invoke('research_mission_prepare',
    {goalId:f.g.id, expectedGoalHash:f.g.hash, brief, idempotencyKey:'later-draft'});
  const after = await inspect(d, f);
  for (const field of ['missionId','question','status','reportHash','asOf','approvedSourceScope']) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.equal(after.missionId, f.task.id);
  assert.equal(after.asOf, null);
  assert.match(after.asOfReason, /canonical report/i);
  assert.deepEqual(after.requestedBrief, {draftId:draft.missionId, ...brief});

  const second = f.c.submitTask({goalId:f.g.id, submissionId:'same-question', kind:'research', objective:brief.question,
    acceptance:['Reviewed']}, 'same-question');
  assert.equal((await inspect(d, {task:second})).missionId, second.id);

  const markdown = (await d.invoke('research_mission_export', {taskId:f.task.id, format:'markdown'})).content;
  assert.match(markdown, /Requested brief metadata/);
  assert.match(markdown, /Requested as of · 2099-01-01/);
});

test('an exact accepted review acknowledgment awaits collection without granting reviewed support', async t => {
  const f = await missionFixture(t);
  const d = new Dispatcher({c:f.c, worker:f.w});
  await f.accept();
  const queued = await inspect(d, f);
  assert.equal(queued.sourceStatus, 'queued');
  assert.equal(queued.status, 'awaiting_review');
  assert.equal(queued.reasonCode, 'awaiting_finalization');
  assert.equal(queued.review.state, 'acknowledged');
  assert.equal(queued.review.decision, 'accept');
  assert.equal(queued.review.candidateHash, f.packet.descriptor.candidateHash);
  assert.equal(queued.claims[0].support, 'mechanically_linked');

  await f.collect();
  const collected = await inspect(d, f);
  assert.equal(collected.status, 'accepted');
  assert.equal(collected.claims[0].support, 'reviewed_supported');
});

test('an accepted acknowledgment is hidden when its local reviewer reservation disappears', async t => {
  const f = await missionFixture(t);
  const d = new Dispatcher({c:f.c, worker:f.w});
  await f.accept();
  assert.equal((await inspect(d, f)).review.state, 'acknowledged');
  f.c.store.db.prepare("DELETE FROM records WHERE kind = 'reviewer'").run();
  const view = await inspect(d, f);
  assert.notEqual(view.review.state, 'acknowledged');
  assert.equal(view.review.decision, null);
  assert.equal(view.claims[0].support, 'mechanically_linked');
});

test('public inspection and exports reject paths, extra fields and oversized pages', async t => {
  const f = await missionFixture(t);
  const d = new Dispatcher({c: f.c, worker: f.w});
  const view = await inspect(d, f, {limit: 1});
  assert.equal(view.status, 'awaiting_review');
  assert.ok(view.pagination.nextOffset > 0);
  assert.ok(view.artifacts.some(a => a.name === 'proposal.json' && /^[a-f0-9]{64}$/.test(a.id)));
  for (const input of [{path: '/etc/passwd'}, {taskId: '../x'}, {candidateHash: '/etc/passwd'}, {limit: 21}, {authority: {decision: 'accept'}}]) {
    await assert.rejects(inspect(d, f, input));
  }
  await assert.rejects(inspect(d, f, {candidateHash: 'a'.repeat(64)}), /unknown candidate/i);
  const page = await inspect(d, f, {offset: view.pagination.nextOffset, limit: 1});
  assert.ok(page.pagination.offset > 0);
  const json = await d.invoke('research_mission_export', {taskId: f.task.id, format: 'json'});
  const md = await d.invoke('research_mission_export', {taskId: f.task.id, format: 'markdown'});
  assert.equal(json.taskId, f.task.id);
  assert.match(md.content, /Fixture/);
});

test('accepted projection is invalidated by changed report bytes and missing local reviewer', async t => {
  const f = await missionFixture(t);
  const d = new Dispatcher({c: f.c, worker: f.w});
  await f.accept();
  assert.notEqual((await inspect(d, f)).status, 'accepted', 'review acknowledgement alone is not a collected result');
  await f.collect();
  const task = f.c.getTask(f.task.id);
  assert.equal(task.status, 'accepted');
  assert.equal((await inspect(d, f)).status, 'accepted');
  const report = path.join(task.result.directory, 'claims.json');
  const original = await readFile(report);
  await appendFile(report, ' ');
  const stale = await inspect(d, f);
  assert.notEqual(stale.status, 'accepted');
  assert.ok(stale.diagnostics.some(diagnostic => diagnostic.code === 'stale_review'));
  await writeFile(report, original);
  f.c.store.db.prepare("DELETE FROM records WHERE kind = 'reviewer'").run();
  assert.notEqual((await inspect(d, f)).status, 'accepted');
});

test('an acknowledged revision keeps the original candidate visibly disputed', async t => {
  const f = await missionFixture(t, report => {
    report.comparisons.push({text: 'A restart retains all jobs.', claim_ids: ['C1']});
  });
  const d = new Dispatcher({c: f.c, worker: f.w});
  const ticket = await f.reserve();
  const input = {...f.input(), action: 'submit', ticketId: ticket.id, decision: 'revise', coverage: ['comparisons:0'],
    findings: [{unit: 'comparisons:0', code: 'lost_condition', message: 'Only persisted entries are retained.', evidence: []}]};
  await f.a.review(input, 'revise');
  const view = await inspect(d, f);
  assert.equal(view.status, 'revision_needed');
  assert.equal(view.comparisons[0].support, 'disputed');
  assert.equal(view.review.history[0].candidateHash, f.packet.descriptor.candidateHash);
});

test('a malformed contradiction section leaves readable sections and the original artifact available', async t => {
  const f = await missionFixture(t, report => {
    report.contradictions = {text: 'Unresolved disagreement about restart timing.', claim_ids: ['C1']};
  });
  // The adapter already refuses this malformed proposal; exercise a collected partial original.
  const task = f.c.getTask(f.task.id);
  assert.equal(task.status, 'uncertain');
  const collect = f.a.collect;
  f.a.collect = async (...args) => {
    const result = await collect(...args);
    return {...result, status: 'partial'};
  };
  f.remote.status = 'partial';
  f.c.store.tx(() => {
    const saved = f.c.store.get('task', task.id);
    saved.owner = null;
    saved.status = 'queued';
    f.c.store.put('task', saved);
  });
  f.c.claimNext('owner');
  await f.a.step(f.c.getTask(task.id), 'owner');
  const view = await inspect(new Dispatcher({c: f.c, worker: f.w}), f);
  assert.equal(view.status, 'partial');
  assert.match(view.contradictions[0].text, /Unresolved disagreement/);
  assert.ok(view.claims[0].text);
  assert.ok(view.artifacts.some(a => a.name === 'claims.json'));
  assert.ok(view.diagnostics.some(diagnostic => diagnostic.code === 'malformed_section'));
});

test('repeated mission reads leave saved artifact catalog rows and the store revision unchanged', async t => {
  const f = await missionFixture(t);
  const d = new Dispatcher({c:f.c, worker:f.w});

  const proposal = await inspect(d, f);
  assert.ok(proposal.artifacts.some(artifact => artifact.name === 'proposal.json'));
  const proposalRevision = f.c.store.revision();
  await inspect(d, f);
  await d.invoke('research_mission_export', {taskId:f.task.id, format:'markdown'});
  assert.equal(f.c.store.revision(), proposalRevision, 'registered proposal reads are read-only');

  await f.accept();
  await f.collect();
  const collection = await inspect(d, f);
  assert.ok(collection.artifacts.some(artifact => artifact.name === 'claims.json'));
  const collectionRevision = f.c.store.revision();
  await inspect(d, f);
  await d.invoke('research_mission_export', {taskId:f.task.id, format:'json'});
  assert.equal(f.c.store.revision(), collectionRevision, 'registered collection reads are read-only');
});
