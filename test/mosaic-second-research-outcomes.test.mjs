import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {runFixtureMission} from '../src/harness/research-missions/fixture.mjs';
import {readOutcomeSnapshot} from '../src/harness/outcomes/snapshot.mjs';
import {summarizeOutcomes} from '../src/harness/outcomes/aggregate.mjs';

const json = async file => JSON.parse(await readFile(file, 'utf8'));

// A regression that counts a superseded candidate, loses targeted-review
// authority, turns unknown usage into zero, or exposes beta research fails here.
test('research mission repair and outcomes share one exact accepted result', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mosaic-second-research-outcomes-'));
  t.after(() => rm(temporary, {recursive: true, force: true}));
  const fixture = await runFixtureMission(path.join(temporary, 'mission'));
  const stateRoot = path.join(fixture.output, 'coordinator');
  const transcript = await json(path.join(fixture.output, 'transcript.json'));
  const [initial, rejected, pending, accepted, partial] = transcript.stages;
  const exports = await Promise.all(['revision-needed', 'fresh-pending', 'accepted', 'partial']
    .map(name => json(path.join(fixture.output, name + '.json'))));

  await t.test('public fixture keeps the rejected original and requires a fresh full review', () => {
    assert.deepEqual(fixture.statuses,
      ['awaiting_review', 'revision_needed', 'awaiting_review', 'accepted', 'partial']);
    assert.equal(rejected.candidateHash, initial.candidateHash);
    assert.notEqual(pending.candidateHash, rejected.candidateHash);
    assert.equal(accepted.candidateHash, pending.candidateHash);
    for (const stage of [rejected, pending, accepted]) {
      for (const field of ['taskId', 'goalId', 'remoteJobId', 'deadline', 'goalDeadline']) {
        assert.equal(stage[field], initial[field], field);
      }
    }
    assert.equal(exports[0].claims.find(claim => claim.id === 'C1').support, 'disputed');
    assert.equal(exports[1].claims.some(claim => claim.support === 'reviewed_supported'), false);
    assert.equal(exports[2].claims.find(claim => claim.id === 'C1').support, 'reviewed_supported');
    assert.equal(exports[0].sourcesHash, exports[2].sourcesHash);
    assert.notEqual(exports[0].reportHash, exports[2].reportHash);
    assert.equal(exports[3].claims.some(claim => claim.support === 'reviewed_supported'), false);
    assert.match(exports[3].collectionReason, /cannot repair/i);
    for (const check of ['reservationReplay', 'staleCandidateRejected', 'incompleteCoverageRejected',
      'fullReviewReplay', 'changedReplayRejected']) assert.equal(transcript.checks[check], true, check);
  });

  // Read the same closed database with the standalone immutable reader first.
  const standalone = summarizeOutcomes(readOutcomeSnapshot({stateRoot}));
  const c = new Coordinator({root: stateRoot});
  try {
    const dispatcher = new Dispatcher({c, config: {environment: 'fixture'}});
    await t.test('public outcome report counts the exact final report once and preserves partial', async () => {
      const revision = c.store.revision();
      const report = await dispatcher.invoke('outcomes_report', {});
      assert.equal(c.store.revision(), revision);
      assert.deepEqual(report.counts, standalone.counts);
      assert.equal(report.coverage.complete, true);
      assert.equal(report.counts.tasks, 2);
      assert.equal(report.counts.attempted, 2);
      assert.equal(report.counts.acceptedResearch, 1);
      assert.equal(report.counts.usefulAccepted, 1);
      assert.equal(report.counts.acceptanceRate.value, 0.5);
      const successful = report.tasks.filter(row => row.usefulAccepted === true);
      assert.equal(successful.length, 1);
      assert.equal(successful[0].id, accepted.taskId);
      const binding = successful[0].evidenceRefs.find(ref => ref.kind === 'research_review');
      assert.equal(binding.candidateHash, accepted.candidateHash);
      assert.equal(binding.reportSha256, exports[2].reportHash);
      assert.equal(binding.sourcesSha256, exports[2].sourcesHash);
      assert.equal(successful[0].evidenceRefs.filter(ref => ref.kind === 'reviewer').length, 2);
      assert.equal(report.tasks.find(row => row.id === partial.taskId).disposition, 'partial');
      assert.equal(report.tasks.find(row => row.id === partial.taskId).usefulAccepted, false);
      assert.equal(report.interactions.reviews, 3);
      assert.equal(report.interactions.revisionRequests, 2);
      assert.equal(report.usage.eligibleCompletedRequests, 0);
      assert.equal(report.usage.input.knownTokens, null);
      assert.equal(report.usage.output.knownTokens, null);
      assert.equal(report.usage.nativeHost.tokens, null);
      assert.equal(report.usage.remoteResearch.tokens, null);
      assert.equal(report.usage.remoteResearch.byKind.model.knownReservations, 4);
      assert.equal(report.usage.remoteResearch.byKind.search.knownReservations, 2);
      assert.equal(report.usage.remoteResearch.byKind.download.knownReservations, 0);
      assert.deepEqual(report.usage, standalone.usage);
      const repeated = await dispatcher.invoke('outcomes_report', {});
      assert.deepEqual(repeated.counts, report.counts);
      assert.deepEqual(repeated.usage, report.usage);
    });

    await t.test('paged public mission inspection retains historical and current evidence', async () => {
      for (const stage of [rejected, accepted, partial]) {
        let offset = 0, total;
        const ids = [];
        do {
          const page = await dispatcher.invoke('research_mission_inspect', {
            taskId: stage.taskId, ...(stage.candidateHash ? {candidateHash: stage.candidateHash} : {}),
            offset, limit: 1,
          });
          assert.equal(page.status, stage.status);
          total = page.pagination.total;
          const entries = ['claims', 'summary', 'comparisons', 'recommendations', 'contradictions', 'unanswered', 'sources']
            .flatMap(section => page[section].map(unit => section + '/' + (unit.unitId ?? unit.id)));
          assert.equal(entries.length, page.pagination.returned);
          ids.push(...entries);
          offset = page.pagination.nextOffset;
        } while (offset !== null);
        assert.equal(ids.length, total);
        assert.equal(new Set(ids).size, total);
      }
    });

    await t.test('beta cannot invoke parked research mission or review tools', async () => {
      const beta = new Dispatcher({c, config: {beta: true, environment: 'fixture'}});
      assert.deepEqual(beta.tools().filter(tool => tool.name.startsWith('research_')), []);
      for (const name of ['research_mission_inspect', 'research_mission_prepare', 'research_mission_export', 'research_review']) {
        await assert.rejects(beta.invoke(name, {taskId: accepted.taskId}), /unknown|unavailable|disabled/i);
      }
    });
  } finally {
    c.close();
  }
});
