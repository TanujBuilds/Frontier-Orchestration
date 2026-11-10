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

test('check excerpts mask Basic authorization, AWS credentials, and connection URI userinfo', () => {
  const stderr = [
    'AssertionError: the requested record was missing',
    'Authorization: Basic ZHVtbXk6Zml4dHVyZQ==',
    'AWS_SECRET_ACCESS_KEY="dummy-aws-fixture-value"',
    'DATABASE_URL=postgres://fixture-user:dummy-database-password@fixture.invalid/db',
  ].join('\n');
  const result = failed('load-record', '', stderr);
  const summary = summarizeChecks([result], {attempt: 1, evidenceKey: 'harness-attempt-1/checks'});
  const excerpt = summary.checks[0].stderr;
  assert.match(excerpt, /AssertionError: the requested record was missing/);
  assert.match(excerpt, /Authorization: Basic \[redacted\]/);
  assert.match(excerpt, /AWS_SECRET_ACCESS_KEY=\[redacted\]/);
  assert.match(excerpt, /DATABASE_URL=postgres:\/\/\[redacted\]@fixture\.invalid\/db/);
  assert.doesNotMatch(excerpt, /ZHVtbXk6Zml4dHVyZQ==|dummy-aws-fixture-value|fixture-user|dummy-database-password/);
  assert.equal(result.stderr, stderr);
});

test('a late assertion takes priority over earlier lines with generic diagnostic words', () => {
  const stdout = `expected progress ${'x'.repeat(500)}\nactual progress ${'y'.repeat(500)}\n` +
    'AssertionError [ERR_ASSERTION]: CSV cells must escape a double quote\n';
  const summary = summarizeChecks([failed('csv', stdout)], {attempt: 1, evidenceKey: 'harness-attempt-1/checks'});
  assert.match(summary.checks[0].stdout, /AssertionError \[ERR_ASSERTION\]: CSV cells must escape a double quote/);
  assert.equal(summary.checks[0].truncated, true);
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

test('Node spec and TAP duration footers do not make the same failure look different', () => {
  const snapshot = {'csv.mjs': 'same-content'};
  for (const reporter of ['ℹ', '#']) {
    const results = (duration, actual = '41') => [
      failed('csv', `AssertionError: expected 42, received ${actual}\n${reporter} duration_ms ${duration}\n`),
    ];
    const previous = recordFailedGate({attempt: 1, snapshot, results: results('43464.875208')}).gate;
    const retry = recordFailedGate({attempt: 2, snapshot, results: results('123'), previous});
    assert.equal(retry.repeated, true, `${reporter} reporter timing should be ignored`);
    assert.equal(retry.gate.failureId, previous.failureId);
    const changedAssertion = recordFailedGate({attempt: 2, snapshot, results: results('123', '40'), previous});
    assert.equal(changedAssertion.repeated, false);
  }
});

test('tracked filenames under a tmp directory remain significant failure details', () => {
  const snapshot = {'src/tmp/one.mjs': 'one', 'src/tmp/two.mjs': 'two'};
  const results = name => [failed('csv', '', `AssertionError: expected quotes\n    at file:///repo/src/tmp/${name}.mjs:7:1`)];
  const previous = recordFailedGate({attempt: 1, snapshot, results: results('one')}).gate;
  const retry = recordFailedGate({attempt: 2, snapshot, results: results('two'), previous});
  assert.equal(retry.repeated, false);
  assert.notEqual(retry.gate.failureId, previous.failureId);
});

test('the generated protected-check scratch directory does not distinguish identical failures', () => {
  const snapshot = {'csv.mjs': 'same-content'};
  const results = folder => [failed('csv', '', `AssertionError: expected quotes\n    at /repo/worktree/.overnight-output/tmp/${folder}/csv.mjs:7:1`)];
  const previous = recordFailedGate({attempt: 1, snapshot, results: results('check-a')}).gate;
  const retry = recordFailedGate({attempt: 2, snapshot, results: results('check-b'), previous});
  assert.equal(retry.repeated, true);
  assert.equal(retry.gate.failureId, previous.failureId);
});
