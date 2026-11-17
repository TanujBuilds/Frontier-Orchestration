import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assignment, repository, repositoryBytes } from './fixtures/mosaic-assignment/repository.mjs';

const fixture = fileURLToPath(new URL('./fixtures/mosaic-assignment-review-summary/mcp.mjs', import.meta.url));
const legacy = {
  collaborative: ['codex', ['codex', 'deepseek'], 'codex', 'operator', 'Main Codex plans and supervises. Codex and DeepSeek may implement, and Main Codex reviews the evidence before integration.'],
  deepseek_only: ['deepseek', ['deepseek'], null, 'checks', 'DeepSeek plans and implements. Protected checks govern acceptance.'],
  codex_only: ['codex', ['codex'], 'codex', 'operator', 'Codex plans and implements. Main Codex reviews the protected check evidence before integration.'],
  overnight_review: ['deepseek', ['deepseek'], 'codex', 'legacy', 'DeepSeek plans and implements. The coordinator calls Codex for bounded independent review after the protected checks pass.'],
};
const profile = (transport = 'openai-chat', extra = {}) => ({
  schema: 1, id: 'approved-reviewer', revision: 'owner-r7', displayName: 'Owner reviewer',
  transport, baseUrl: 'http://127.0.0.1:1/v1', model: 'REQUESTED_MODEL_NOT_VERIFIED',
  roles: ['reviewer'], capabilities: { workerProtocol: null, transports: ['json'], modelDiscovery: 'manual', taskKinds: [] },
  maxContextTokens: null, maxOutputTokens: 1024, concurrency: 1,
  capacityGroup: 'owned-fixture', credentialRef: 'PRIVATE_CREDENTIAL_REFERENCE', streaming: false, ...extra,
});
function hash(value) {
  return createHash('sha256').update(JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
}

async function setup(t, { host = 'codex', reviewer = profile() } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-review-summary-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  await writeFile(path.join(root, 'profiles.json'), JSON.stringify([reviewer]));
  await writeFile(path.join(root, 'no-native-call'), '#!/bin/sh\nprintf attempted > "$MOSAIC_NATIVE_MARKER"\nexit 1\n', { mode: 0o700 });
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
    CODEX_HOME: path.join(home, 'codex'), TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', MOSAIC_NATIVE_MARKER: path.join(root, 'native-called') };
  const client = new Client({ name: 'assignment-review-summary-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fixture, root, host], cwd: root, env, stderr: 'pipe' });
  let stderr = '';
  let verify = async () => {};
  t.after(async () => {
    try { await verify(); }
    finally { await client.close(); await rm(root, { recursive: true, force: true }); }
  });
  await client.connect(transport, { timeout: 5000 });
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  async function call(name, input = {}, { error = false } = {}) {
    const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 5000 });
    assert.equal(result.isError ?? false, error, `${name}: ${JSON.stringify(result.content)} ${stderr}`);
    return JSON.parse(result.content[0].text);
  }
  const repo = await repository({ root, env });
  const before = await repositoryBytes(repo.root);
  verify = async () => {
    const snapshot = await call('goal_get');
    for (const goal of snapshot.goals) {
      assert.equal(goal.status, 'draft');
      assert.equal(goal.activatedAt, null);
      assert.equal(goal.deadline, null);
      assert.equal(goal.planning, null);
      assert.deepEqual(goal.tasks, []);
      assert.deepEqual(goal.reviewerRuns, []);
    }
    assert.deepEqual(snapshot.operations, []);
    assert.equal(snapshot.events.some(event => event.type === 'goal.activated'), false);
    const db = new DatabaseSync(path.join(root, 'state', 'harness.sqlite3'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0); }
    finally { db.close(); }
    await assert.rejects(access(path.join(root, 'native-called')), { code: 'ENOENT' });
    await assert.rejects(access(repo.marker), { code: 'ENOENT' });
    assert.deepEqual(await repositoryBytes(repo.root), before);
  };
  async function prepare(mode, reviewPolicy, { legacy: historic = false, objective } = {}) {
    const manifest = { ...assignment(repo, { mode, submissionId: `summary-${mode}` }), environment: 'fixture' };
    if (objective) manifest.objective = objective;
    if (reviewPolicy) manifest.reviewPolicy = reviewPolicy;
    if (mode === 'overnight_review') manifest.overnightPolicy = { preflightCheckIds: ['verify'], finalOnlyCheckIds: [] };
    const name = historic ? 'legacy_assignment_prepare' : 'assignment_prepare';
    const input = { manifest, idempotencyKey: `summary-${mode}` };
    const result = await call(name, input);
    if (result.status === 'prepared') {
      const goal = await call('goal_get', { goalId: result.goalId });
      if (process.env.MOSAIC_ASSIGNMENT_REVIEW_EVIDENCE) {
        await mkdir(process.env.MOSAIC_ASSIGNMENT_REVIEW_EVIDENCE, { recursive: true });
        const filename = t.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        await writeFile(path.join(process.env.MOSAIC_ASSIGNMENT_REVIEW_EVIDENCE, `${filename}.json`), JSON.stringify({ input, result, goal }, null, 2));
      }
      assert.equal(result.hash, goal.hash);
      assert.equal(goal.hash, hash(goal.manifest));
      assert.deepEqual(goal.manifest.project.checks, manifest.project.checks);
      assert.deepEqual(result.summary.checks, ['verify']);
      assert.equal(result.summary.limits.hours, 1);
      assert.equal(result.summary.limits.maxTasks, 2);
      assert.equal(result.summary.limits.reviewAgentRuns, 0);
      assert.deepEqual(goal.manifest.limits, mode === 'overnight_review'
        ? { ...manifest.limits, taskLimits: { coding: { seconds: 7200 } } } : manifest.limits);
      assert.equal(result.summary.providerVerification, 'unverified');
      assert.match(result.summary.next, /explicit authorization/);
      assert.deepEqual(await call(name, input), result);
      assert.deepEqual(await call('goal_get', { goalId: goal.id }), goal);
      return { result, goal };
    }
    return { result };
  }
  const { credentialRef, ...publicReviewer } = reviewer;
  return { prepare, publicReviewer };
}

// Removing policy selection must expose the original host mismatch through MCP.
for (const host of ['codex', 'claude-code', 'cursor', 'antigravity']) {
  for (const mode of ['collaborative', 'codex_only', 'overnight_review']) {
    test(`MCP preparation identifies approved ${host} reviewer in ${mode}`, async t => {
      const f = await setup(t, { host });
      const { result, goal } = await f.prepare(mode, { version: 1, source: 'host', hostId: host, fallback: 'wait' });
      assert.equal(result.status, 'prepared');
      assert.equal(goal.manifest.reviewPolicy.hostId, host);
      assert.equal(result.summary.roles.reviewer, host);
      assert.equal(result.summary.roles.reviewSource, 'host');
      assert.ok(result.summary.roles.description.includes(host));
      if (host !== 'codex') assert.doesNotMatch(result.summary.roles.description, /Main Codex reviews|calls Codex|Codex for bounded independent review/);
      assert.deepEqual([result.summary.roles.planner, result.summary.roles.workers, result.summary.roles.review],
        [legacy[mode][0], legacy[mode][1], legacy[mode][3]]);
    });
  }
}

// API references must not inherit Codex review claims from the mode preset.
for (const transport of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
  for (const mode of ['collaborative', 'overnight_review']) {
    test(`MCP preparation identifies API reference for ${transport} in ${mode}`, async t => {
      const f = await setup(t, { reviewer: profile(transport) });
      const { result, goal } = await f.prepare(mode, { version: 1, source: 'api', reviewer: f.publicReviewer, fallback: 'wait' });
      assert.equal(result.status, 'prepared');
      assert.equal(goal.manifest.reviewPolicy.reviewer.transport, transport);
      assert.equal(result.summary.roles.reviewer, 'api');
      assert.equal(result.summary.roles.reviewSource, 'api');
      assert.deepEqual(result.summary.roles.reviewerReference, { id: 'approved-reviewer', revision: 'owner-r7' });
      assert.match(result.summary.roles.description, /API reviewer/);
      assert.match(result.summary.roles.description, /approved-reviewer/);
      assert.match(result.summary.roles.description, /owner-r7/);
      assert.doesNotMatch(result.summary.roles.description, /Main Codex reviews|calls Codex|Codex for bounded independent review/);
      assert.doesNotMatch(JSON.stringify(result.summary), /REQUESTED_MODEL_NOT_VERIFIED|PRIVATE_CREDENTIAL_REFERENCE|127\.0\.0\.1:1/);
    });
  }
}

for (const mode of Object.keys(legacy)) test(`legacy MCP preparation retains ${mode} roles without policy`, async t => {
  const f = await setup(t);
  const { result, goal } = await f.prepare(mode, undefined, { legacy: true });
  assert.equal(result.status, 'prepared');
  assert.equal(Object.hasOwn(goal.manifest, 'reviewPolicy'), false);
  const [planner, workers, reviewer, review, description] = legacy[mode];
  assert.deepEqual(result.summary.roles, { planner, workers, reviewer, review, description });
});

test('DeepSeek-only stays checks-only through portable MCP preparation', async t => {
  const f = await setup(t);
  const { result, goal } = await f.prepare('deepseek_only');
  assert.equal(result.status, 'prepared');
  assert.equal(Object.hasOwn(goal.manifest, 'reviewPolicy'), false);
  assert.equal(result.summary.roles.reviewer, null);
  assert.equal(result.summary.roles.review, 'checks');
});

for (const [mode, source] of [['deepseek_only', 'host'], ['deepseek_only', 'api'], ['codex_only', 'api']]) {
  test(`MCP preparation keeps ${source} review prohibited in ${mode}`, async t => {
    const f = await setup(t);
    const policy = source === 'host' ? { version: 1, source, hostId: 'codex', fallback: 'wait' }
      : { version: 1, source, reviewer: f.publicReviewer, fallback: 'wait' };
    const { result } = await f.prepare(mode, policy);
    assert.equal(result.status, 'needs_input');
    assert.ok(result.issues.some(issue => issue.code === 'invalid_manifest'));
  });
}

test('MCP reviewer summary sanitizes bounded references without exposing provider context', async t => {
  const token = 'sk-' + 'x'.repeat(30);
  const reviewer = profile('openai-chat', { revision: `token=${token}\u202e`, displayName: `password=${token}` });
  const f = await setup(t, { reviewer });
  const { result, goal } = await f.prepare('collaborative', { version: 1, source: 'api', reviewer: f.publicReviewer, fallback: 'wait' },
    { objective: `Owner request\npassword=${token} ` + 'a'.repeat(1000) });
  assert.equal(result.status, 'prepared');
  assert.ok(goal.manifest.reviewPolicy.reviewer.revision.includes(token));
  assert.ok(result.summary.objective.length <= 400);
  assert.equal(result.summary.roles.reviewerReference.id, 'approved-reviewer');
  assert.ok(result.summary.roles.reviewerReference.revision.length <= 80);
  assert.doesNotMatch(JSON.stringify(result.summary), new RegExp(`${token}|PRIVATE_CREDENTIAL_REFERENCE|REQUESTED_MODEL_NOT_VERIFIED|127\\.0\\.0\\.1:1`));
  assert.doesNotMatch(result.summary.roles.description, /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/);
});
