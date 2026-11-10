import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {createOutcomeDemo} from '../src/harness/outcomes/demo.mjs';

const script = fileURLToPath(new URL('../scripts/mosaic-outcomes.mjs', import.meta.url));
const run = (...args) => execFileSync(process.execPath, [script, ...args], {
  encoding: 'utf8',
  env: {...process.env, NODE_NO_WARNINGS: '1'},
});

function temp(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'mosaic-outcomes-public-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

test('CLI requires explicit state and leaves a missing state root absent', t => {
  const root = temp(t);
  const missing = spawnSync(process.execPath, [script, 'report', '--state-root', path.join(root, 'absent')], {encoding: 'utf8'});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /state|database/i);
  assert.deepEqual(readdirSync(root), []);
  const implicit = spawnSync(process.execPath, [script, 'report'], {encoding: 'utf8'});
  assert.equal(implicit.status, 1);
  assert.match(implicit.stderr, /--state-root/);
});

test('CLI demo exports mixed outcomes and deduplicated coverage and refuses overwrite', t => {
  const output = temp(t);
  const result = JSON.parse(run('demo', '--output', output));
  const report = JSON.parse(readFileSync(path.join(output, 'outcomes.json'), 'utf8'));
  const markdown = readFileSync(path.join(output, 'outcomes.md'), 'utf8');
  assert.equal(result.fixture, true);
  assert.equal(report.counts.attempted, 2);
  assert.equal(report.counts.queued, 1);
  assert.equal(report.counts.acceptedCoding, 1);
  assert.equal(report.counts.byDisposition.blocked, 1);
  assert.equal(report.usage.eligibleCompletedRequests, 2);
  assert.equal(report.usage.knownUsageRequests, 1);
  assert.equal(report.usage.input.knownTokens, 10);
  assert.equal(report.usage.output.knownTokens, 5);
  assert.match(markdown, /unknown|unavailable/i);
  assert.deepEqual(readdirSync(output).sort(), ['outcomes.json', 'outcomes.md']);
  const repeated = spawnSync(process.execPath, [script, 'demo', '--output', output], {encoding: 'utf8'});
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /exists|overwrite/i);
  assert.equal(readFileSync(path.join(output, 'outcomes.md'), 'utf8'), markdown);
});

test('CLI report reads a closed fixture and the Dispatcher agrees over its live SQLite connection', async t => {
  const fixture = await createOutcomeDemo(temp(t));
  const {stateRoot, goalId} = fixture;
  const args = ['report', '--state-root', stateRoot, '--goal', goalId];
  const report = JSON.parse(run(...args));
  assert.equal(report.counts.acceptedCoding, 1);
  assert.equal(report.counts.attempted, 2);
  assert.match(run(...args, '--format', 'markdown'), /outcomes/i);
  const c = new Coordinator({root: stateRoot});
  t.after(() => c.close());
  assert.ok(c.store.all('outcome').filter(record => record.reportedUsage.length > 0).length > 1);
  const dispatcher = new Dispatcher({c});
  const toolReport = await dispatcher.invoke('outcomes_report', {goalId});
  assert.deepEqual(toolReport.counts, report.counts);
  assert.deepEqual(toolReport.usage, report.usage);
  const page = await dispatcher.invoke('outcomes_report', {goalId, limit: 1});
  assert.equal(page.counts.tasks, 1);
  assert.equal(page.coverage.complete, false);
  assert.ok(page.coverage.nextCursor);
  const continuation = await dispatcher.invoke('outcomes_report', {goalId, limit: 2, cursor: page.coverage.nextCursor});
  assert.equal(continuation.counts.tasks, 2);
  assert.equal(continuation.coverage.complete, false);
  assert.equal(continuation.coverage.nextCursor, null);
});

for (const beta of [false, true]) {
  test(`Dispatcher exposes a read-only outcomes report in ${beta ? 'beta' : 'core'}`, async t => {
    const root = temp(t);
    const c = new Coordinator({root, beta});
    t.after(() => c.close());
    const dispatcher = new Dispatcher({c, config: {beta}});
    const definition = dispatcher.tools().find(tool => tool.name === 'outcomes_report');
    assert.equal(definition?.annotations.readOnlyHint, true);
    const before = c.store.revision();
    const result = await dispatcher.invoke('outcomes_report', {format: 'json'});
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.counts.tasks, 0);
    assert.equal(result.counts.acceptanceRate.value, null);
    assert.equal(c.store.revision(), before);
    const markdown = await dispatcher.invoke('outcomes_report', {format: 'markdown'});
    assert.match(markdown.markdown, /outcomes/i);
    await assert.rejects(dispatcher.invoke('outcomes_report', {stateRoot: root}), /stateRoot/i);
    await assert.rejects(dispatcher.invoke('outcomes_report', {idempotencyKey: 'test'}), /idempotencyKey/i);
  });
}
