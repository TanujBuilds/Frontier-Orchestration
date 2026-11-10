import assert from 'node:assert/strict';
import test from 'node:test';
import { focusRepair, summarizeChecks, summarizeCorrection } from '../src/harness/repair-feedback.mjs';
import { recordFailedGate } from '../src/harness/repair-progress.mjs';

const failed = (id, stdout, stderr = '', code = 1) => ({id, stdout, stderr, code, passed: false});

test('failed-check summaries preserve diagnostics and bound noisy output and sensitive values', () => {
  const stdout = 'normal output\n'.repeat(300) +
    'AssertionError: CSV cell must escape a double quote\n' +
    '    expected: a quoted field\n' + 'unrelated tail\n'.repeat(400);
  const stderr = 'Authorization: Bearer fake-secret-value\n' + '🙂'.repeat(1500);
  const results = [{id: 'lint', passed: true}, failed('csv', stdout, stderr, 7),
    ...Array.from({length: 30}, (_, i) => failed(`other-${i}`, '🙂'.repeat(2000), 'x'.repeat(2000)))];
  const summary = summarizeChecks(results, {
    attempt: 2, evidenceKey: 'harness-attempt-2/checks',
    changedPaths: ['csv.mjs'], comparedToAttempt: 1,
  });
  assert.deepEqual(summary, summarizeChecks(results, {
    attempt: 2, evidenceKey: 'harness-attempt-2/checks',
    changedPaths: ['csv.mjs'], comparedToAttempt: 1,
  }));
  assert.equal(summary.category, 'functional_check');
  assert.equal(summary.evidenceKey, 'harness-attempt-2/checks');
  assert.equal(summary.checks[0].id, 'csv');
  assert.equal(summary.checks[0].exitCode, 7);
  assert.match(summary.checks[0].stdout, /AssertionError: CSV cell/);
  assert.match(summary.checks[0].stdout, /expected: a quoted field/);
  assert.match(summary.checks[0].stdout, /truncated/i);
  assert.doesNotMatch(summary.checks[0].stderr, /fake-secret-value/);
  assert.equal(summary.checks[0].truncated, true);
  assert.equal(summary.checks.length + summary.omittedChecks, 31);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 16 * 1024);
  assert.equal(results[1].stdout, stdout);
  assert.equal(results[1].stderr, stderr);
});

test('repair input identifies checks, allowed actions, remaining limits, and exact stale paths', () => {
  const failure = summarizeCorrection({
    attempt: 2, reason: 'Stale edit hash for csv.mjs; request current file',
    stalePaths: ['csv.mjs'], evidenceKey: 'code-2-1',
  });
  const limits = {attemptsRemaining: 2, exchangesRemaining: 8};
  const repair = focusRepair({
    failure, files: [{path: 'csv.mjs', content: 'source data', hash: 'hash'}],
    checks: [{id: 'csv'}], limits, v2: true, stalePaths: ['csv.mjs'],
    previousAction: {type: 'apply_changes', fulfilled: true},
  });
  assert.equal(repair.failure.category, 'stale_context');
  assert.deepEqual(repair.contextPaths, ['csv.mjs']);
  assert.deepEqual(repair.requiredCheckIds, ['csv']);
  assert.deepEqual(repair.limits, limits);
  assert.deepEqual(repair.allowedActions, ['read_files', 'finish_stage', 'ask_supervisor']);
  assert.match(repair.instruction, /read_files/);
  assert.match(repair.instruction, /already applied/i);
  assert.equal(summarizeCorrection({attempt: 1, reason: 'Invalid JSON'}).category, 'protocol');
});

test('failed gate convergence requires the same candidate and normalized failure in distinct attempts', () => {
  const error = (time, folder, elapsed, expected = 'quoted') =>
    `[${time}] AssertionError: expected ${expected} at /private/var/folders/p1/r2/T/${folder}/csv.mjs:12:9\n  duration_ms: ${elapsed}\n`;
  const snapshot = {'csv.mjs': 'hash1', 'gone.mjs': 'hash2'};
  const results = [
    failed('csv', error('2026-11-10T11:12:13.047Z', 'check-abc', '12.441')),
    failed('escape', '', 'Error: unexpected output'),
  ];
  const first = recordFailedGate({attempt: 1, snapshot, results});
  const retry = [
    failed('escape', '', 'Error: unexpected output'),
    failed('csv', error('2026-11-10T11:12:29.002Z', 'check-def', '35.312')),
  ];
  const previous = first.gate;
  const repeated = recordFailedGate({attempt: 2, snapshot, results: retry, previous, previousSnapshot: snapshot});
  assert.equal(repeated.repeated, true);
  assert.deepEqual(repeated.changedPaths, []);
  assert.equal(recordFailedGate({attempt: 1, snapshot, results, previous}).repeated, false);

  const changed = recordFailedGate({attempt: 2, snapshot: {'csv.mjs': 'hash3', 'new.mjs': 'hash4'},
    results: retry, previous, previousSnapshot: snapshot});
  assert.equal(changed.repeated, false);
  assert.deepEqual(changed.changedPaths, ['csv.mjs', 'gone.mjs', 'new.mjs']);
  assert.notEqual(changed.gate.candidateId, previous.candidateId);
  assert.equal(changed.gate.failureId, previous.failureId);
  for (const result of [
    failed('csv', error('2026-11-10T11:12:13.047Z', 'check-abc', '12.441', 'escaped')),
    failed('csv', results[0].stdout, '', 2),
    failed('other-csv', results[0].stdout),
  ]) {
    assert.equal(recordFailedGate({attempt: 2, snapshot, results: [result, results[1]], previous}).repeated, false);
  }
});
