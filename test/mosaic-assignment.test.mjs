import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { coordinator } from './fixtures/mosaic-assignment/coordinator.mjs';
import { assignment, checkOutput, repoInstruction, repository, repositoryBytes } from './fixtures/mosaic-assignment/repository.mjs';

const execFileAsync = promisify(execFile);

test('assignment_prepare returns grouped prerequisites over authenticated CLI transport', async t => {
  const service = await coordinator(t);
  const input = {
    idempotencyKey: 'missing-details',
    manifest: {
      submissionId: 'add-csv',
      objective: 'Add CSV export',
      acceptance: ['Export includes every row'],
      project: { repo: path.join(service.root, 'unresolved') },
    },
  };
  assert.equal((await service.request('assignment_prepare', input, 'wrong-token')).status, 401);
  const result = await service.call('assignment_prepare', input);
  assert.equal(result.status, 'needs_input');
  const fields = result.issues.map(issue => {
    assert.ok(issue.code && issue.message, JSON.stringify(issue));
    return issue.field;
  });
  for (const field of [
    'mode', 'project.repo', 'project.readPaths', 'project.writePaths', 'project.checks',
    'limits.hours', 'limits.maxTasks', 'limits.reviewAgentRuns',
  ]) assert.ok(fields.includes(field), `missing issue for ${field}: ${fields}`);
  await assertNoExecution(service);
});

async function assertNoExecution(service, expectedGoalIds = []) {
  const snapshot = await service.call('goal_get');
  assert.deepEqual(snapshot.goals.map(goal => goal.id), expectedGoalIds);
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
  assert.equal(service.savedRequestCount(), 0);
  assert.deepEqual(service.providerRequests, []);
  await assert.rejects(access(service.codexMarker), { code: 'ENOENT' });
  return snapshot;
}

function manifestHash(manifest) {
  const canonical = JSON.stringify(manifest, (_, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    }
    return value;
  });
  return createHash('sha256').update(canonical).digest('hex');
}

test('CLI prepares and fetches one exact draft through existing goal controls', async t => {
  const service = await coordinator(t);
  const repo = await repository(service);
  const manifest = assignment(repo);
  const alias = path.join(service.root, 'project-alias');
  await symlink(repo.root, alias);
  const before = await repositoryBytes(repo.root);
  const input = { manifest: { ...manifest, project: { ...manifest.project, repo: alias } }, idempotencyKey: 'prepare-csv' };
  const invoke = async (name, value) => {
    const { stdout } = await execFileAsync(process.execPath, [
      service.cli, 'call', '--root', service.state, '--tool', name, '--input-json', JSON.stringify(value),
    ], { cwd: service.root, env: service.env, timeout: 5000 });
    return JSON.parse(stdout);
  };
  const prepared = await invoke('assignment_prepare', input);
  assert.equal(prepared.status, 'prepared');
  const goal = await invoke('goal_get', { goalId: prepared.goalId });
  assert.equal(goal.hash, prepared.hash);
  assert.equal(goal.hash, manifestHash(goal.manifest));
  assert.equal(goal.manifest.objective, manifest.objective);
  assert.deepEqual(goal.manifest.acceptance, manifest.acceptance);
  assert.deepEqual(goal.manifest.project, { ...manifest.project, baseCommit: repo.baseCommit });
  assert.deepEqual(goal.manifest.limits, manifest.limits);
  assert.equal(goal.manifest.mode.id, manifest.mode);
  assert.equal(goal.manifest.mode.version, 1);

  assert.deepEqual(await invoke('assignment_prepare', input), prepared);
  const snapshot = await assertNoExecution(service, [goal.id]);
  assert.deepEqual(snapshot.events.filter(event => event.type === 'goal.prepared').map(event => event.goal_id), [goal.id]);
  assert.deepEqual(await repositoryBytes(repo.root), before);
  await assert.rejects(access(repo.marker), { code: 'ENOENT' });
});

test('equivalent assignment retries share a draft and changed authority conflicts', async t => {
  const service = await coordinator(t);
  const repo = await repository(service);
  const manifest = assignment(repo);
  const input = { manifest, idempotencyKey: 'prepare-once' };
  const prepared = await service.call('assignment_prepare', input);
  assert.equal(prepared.status, 'prepared');
  const equivalent = {
    idempotencyKey: input.idempotencyKey,
    manifest: Object.fromEntries(Object.entries(manifest).reverse()),
  };
  assert.deepEqual(await service.call('assignment_prepare', equivalent), prepared);
  const changes = [
    { project: { ...manifest.project, writePaths: ['src/export.mjs'] } },
    { project: { ...manifest.project, checks: [{ id: 'verify', argv: ['node', '--check', 'checks/verify.mjs'] }] } },
    { limits: { ...manifest.limits, hours: 2 } },
    { limits: { ...manifest.limits, taskLimits: { coding: { modelCalls: 2 } } } },
    { mode: 'codex_only' },
  ];
  for (const change of changes) {
    const response = await service.request('assignment_prepare', { ...input, manifest: { ...manifest, ...change } });
    assert.equal(response.status, 400, JSON.stringify(change));
    assert.match(response.body.error, /idempotency key conflict/i);
  }
  await assertNoExecution(service, [prepared.goalId]);
  const changed = await service.call('assignment_prepare', {
    idempotencyKey: 'prepare-narrowed-csv',
    manifest: { ...manifest, submissionId: 'add-csv-narrowed', ...changes[0] },
  });
  assert.equal(changed.status, 'prepared');
  assert.notEqual(changed.hash, prepared.hash);
  const revisedGoal = await service.call('goal_get', { goalId: changed.goalId });
  assert.deepEqual(revisedGoal.manifest.project.writePaths, ['src/export.mjs']);
  assert.equal(changed.hash, manifestHash(revisedGoal.manifest));
  const advanced = path.join(repo.root, 'src', 'later.mjs');
  await writeFile(advanced, 'export const next = true;\n');
  await repo.git('add', 'src/later.mjs');
  await repo.git('commit', '-m', 'Advance fixture head');
  assert.notEqual(await repo.git('rev-parse', 'HEAD'), repo.baseCommit);
  assert.deepEqual(await service.call('assignment_prepare', input), prepared);
  await assertNoExecution(service, [prepared.goalId, changed.goalId]);
});

test('dirty and unborn repositories retain their entire source tree and Git index bytes', async t => {
  const service = await coordinator(t);
  const dirty = await repository(service, { name: 'dirty' });
  const unborn = await repository(service, { name: 'unborn', committed: false });
  const tracked = path.join(dirty.root, 'src', 'export.mjs');
  await writeFile(tracked, 'staged data\n');
  await dirty.git('add', 'src/export.mjs');
  await writeFile(tracked, 'unstaged data\n');
  await writeFile(path.join(dirty.root, 'untracked.bin'), Buffer.from([0, 255, 45]));
  for (const [name, repo] of [['dirty', dirty], ['unborn', unborn]]) {
    const before = await repositoryBytes(repo.root);
    assert.ok(before.some(([name]) => name === path.join('.git', 'index')));
    const result = await service.call('assignment_prepare', {
      idempotencyKey: `${name}-repo`, manifest: assignment(repo, { submissionId: `${name}-repo` }),
    });
    assert.equal(result.status, 'needs_input');
    assert.ok(result.issues.some(issue => issue.field === 'project.repo' && issue.message), JSON.stringify(result));
    assert.deepEqual(await repositoryBytes(repo.root), before);
  }
  await assertNoExecution(service);
});

test('assignment rejects unsafe path scopes, symlinks, nonmatching bases, and malformed inputs', async t => {
  const service = await coordinator(t);
  const repo = await repository(service);
  const outside = path.join(service.root, 'outside.txt');
  const outsideData = 'OUTSIDE_CONTENT_SENTINEL';
  const secretData = 'SECRET_FILE_CONTENT_SENTINEL';
  await writeFile(outside, outsideData);
  await writeFile(path.join(repo.root, '.env'), secretData);
  await mkdir(path.join(repo.root, 'links'));
  await symlink(outside, path.join(repo.root, 'links', 'external-link'));
  await mkdir(path.join(repo.root, 'unapproved'));
  await writeFile(path.join(repo.root, 'unapproved', 'outside-scope.txt'), 'Outside editable scope');
  await repo.git('add', '.');
  await repo.git('commit', '-m', 'Add unsafe scope fixtures');
  const manifest = assignment(repo);
  const variants = [
    { project: { ...manifest.project, readPaths: ['src/', '../outside.txt'] } },
    { project: { ...manifest.project, readPaths: ['src/', outside] } },
    { project: { ...manifest.project, readPaths: ['.env', 'src/export.mjs'], writePaths: ['src/export.mjs'] } },
    { project: { ...manifest.project, readPaths: [...manifest.project.readPaths, 'links/external-link'] } },
    { project: { ...manifest.project, readPaths: [...manifest.project.readPaths, 'links/'] } },
    { project: { ...manifest.project, writePaths: ['unapproved/'] } },
    { project: { ...manifest.project, repo: path.join(repo.root, 'src') } },
    { project: { ...manifest.project, baseCommit: repo.baseCommit } },
    { project: { ...manifest.project, checks: [{ id: 'verify', argv: ['node', null] }] } },
    { limits: { ...manifest.limits, hours: '1' } },
    { activation: true },
  ];
  const before = await repositoryBytes(repo.root);
  for (const [index, change] of variants.entries()) {
    const response = await service.request('assignment_prepare', {
      idempotencyKey: `unsafe-${index}`, manifest: { ...manifest, ...change },
    });
    assert.ok(
      (response.status === 200 && response.body.status === 'needs_input' && response.body.issues.length > 0)
      || (response.status === 400 && response.body.error && response.body.error !== 'Unknown harness tool'),
      `accepted ${JSON.stringify(change)}: ${JSON.stringify(response)}`,
    );
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(`${outsideData}|${secretData}`));
  }
  assert.equal(await readFile(outside, 'utf8'), outsideData);
  assert.deepEqual(await repositoryBytes(repo.root), before);
  await assertNoExecution(service);
});

test('dirty repository probing never runs its Git clean filter or filesystem monitor', async t => {
  const service = await coordinator(t);
  const cleanFilter = await repository(service, { name: 'filter-repo' });
  const fsmonitor = await repository(service, { name: 'fsmonitor-repo' });
  await writeFile(path.join(cleanFilter.root, '.gitattributes'), 'src/export.mjs filter=assignment\n');
  await cleanFilter.git('add', '.gitattributes');
  await cleanFilter.git('commit', '-m', 'Add fixture attributes');
  const fixtures = [
    [cleanFilter, 'filter', 'filter.assignment.clean', 'cat'],
    [fsmonitor, 'fsmonitor', 'core.fsmonitor', 'exit 1'],
  ];
  for (const [repo, name, key, command] of fixtures) {
    const script = path.join(service.root, name);
    const marker = path.join(service.root, `git-${name}-ran`);
    await writeFile(script, `#!/bin/sh\nprintf attempted > '${marker}'\n${command}\n`, { mode: 0o700 });
    await repo.git('config', key, script);
    const source = path.join(repo.root, 'src', 'export.mjs');
    const sameSizeEdit = (await readFile(source, 'utf8')).replace('export const', 'export let  ');
    await writeFile(source, sameSizeEdit);
    const changedTime = new Date(Date.now() - 60_000);
    await utimes(source, changedTime, changedTime);
    const before = await repositoryBytes(repo.root);
    const result = await service.call('assignment_prepare', {
      idempotencyKey: `git-probe-${name}`, manifest: assignment(repo, { submissionId: `git-probe-${name}` }),
    });
    assert.equal(result.status, 'needs_input');
    await assert.rejects(access(marker), { code: 'ENOENT' });
    assert.deepEqual(await repositoryBytes(repo.root), before);
    // Verify that an ordinary Git status really would exercise the fixture's hook.
    await repo.git('status', '--porcelain');
    assert.equal(await readFile(marker, 'utf8'), 'attempted');
  }
  await assertNoExecution(service);
});

test('repository instructions and potential check output cannot change or start an assignment', async t => {
  const service = await coordinator(t);
  const repo = await repository(service);
  const manifest = assignment(repo);
  const missing = await service.call('assignment_prepare', {
    idempotencyKey: 'needs-explicit-check', manifest: { ...manifest, project: { ...manifest.project, checks: [] } },
  });
  assert.equal(missing.status, 'needs_input');
  assert.ok(missing.issues.some(issue => issue.field === 'project.checks'));
  await assertNoExecution(service);
  const prepared = await service.call('assignment_prepare', { idempotencyKey: 'approved-check', manifest });
  assert.equal(prepared.status, 'prepared');
  const goal = await service.call('goal_get', { goalId: prepared.goalId });
  assert.equal(goal.manifest.mode.id, 'deepseek_only');
  assert.deepEqual(goal.manifest.project.readPaths, manifest.project.readPaths);
  assert.deepEqual(goal.manifest.project.writePaths, ['src/']);
  assert.deepEqual(goal.manifest.project.checks, manifest.project.checks);
  for (const value of [missing, prepared, goal]) {
    assert.ok(!JSON.stringify(value).includes(repoInstruction));
    assert.ok(!JSON.stringify(value).includes(checkOutput));
  }
  await assert.rejects(access(repo.marker), { code: 'ENOENT' });
  await assertNoExecution(service, [goal.id]);
});

test('MCP discovers preparation alongside existing tools and returns the pinned roles for all four modes', async t => {
  const service = await coordinator(t);
  const repo = await repository(service);
  const client = new Client({ name: 'mosaic-assignment-transport-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [service.cli, 'mcp', '--root', service.state],
    cwd: service.root, env: service.env, stderr: 'pipe',
  });
  const expectedGoalIds = [];
  try {
    await client.connect(transport, { timeout: 5000 });
    const { tools } = await client.listTools({}, { timeout: 5000 });
    const names = new Set(tools.map(tool => tool.name));
    for (const name of ['assignment_prepare', 'goal_prepare', 'goal_get', 'goal_activate', 'overnight_preflight', 'registry_list']) {
      assert.ok(names.has(name), `missing MCP tool ${name}`);
    }
    const cases = [
      ['collaborative', 1, 'codex', ['codex', 'deepseek'], 'codex', 'operator'],
      ['deepseek_only', 1, 'deepseek', ['deepseek'], null, 'checks'],
      ['codex_only', 1, 'codex', ['codex'], 'codex', 'operator'],
      ['overnight_review', 2, 'deepseek', ['deepseek'], 'codex', 'legacy'],
    ];
    for (const [mode, version, planner, workers, reviewer, review] of cases) {
      const manifest = assignment(repo, { mode, submissionId: `roles-${mode}` });
      if (mode === 'overnight_review') {
        manifest.overnightPolicy = { preflightCheckIds: ['verify'], finalOnlyCheckIds: [] };
      }
      const response = await client.callTool({
        name: 'assignment_prepare', arguments: { manifest, idempotencyKey: `roles-${mode}` },
      }, undefined, { timeout: 5000 });
      assert.equal(response.isError ?? false, false, JSON.stringify(response.content));
      const result = JSON.parse(response.content[0].text);
      assert.equal(result.status, 'prepared');
      const goal = await service.call('goal_get', { goalId: result.goalId });
      expectedGoalIds.push(goal.id);
      const summary = result.summary;
      assert.deepEqual(summary.mode, { id: mode, version });
      const { roles } = summary;
      assert.deepEqual({ planner: roles.planner, workers: roles.workers, reviewer: roles.reviewer, review: roles.review }, {
        planner, workers, reviewer, review,
      });
      assert.equal(goal.manifest.mode.planner, planner);
      assert.equal(summary.objective, manifest.objective);
      assert.deepEqual(summary.project, { repo: repo.root, baseCommit: repo.baseCommit });
      assert.deepEqual(summary.editablePaths, manifest.project.writePaths);
      assert.deepEqual(summary.checks, ['verify']);
      assert.equal(summary.limits.hours, 1);
      assert.equal(summary.limits.maxTasks, 2);
      assert.equal(summary.limits.reviewAgentRuns, 0);
      assert.equal(summary.providerVerification, 'unverified');
      assert.ok(summary.next);
      if (mode === 'overnight_review') {
        assert.equal(goal.manifest.mode.version, 2);
        assert.deepEqual(goal.manifest.overnightPolicy.preflightCheckIds, ['verify']);
      }
    }
  } finally {
    await client.close();
  }
  const legacyManifest = assignment(repo, { submissionId: 'legacy-goal' });
  const legacy = await service.call('goal_prepare', {
    idempotencyKey: 'legacy-goal',
    manifest: { ...legacyManifest, project: { ...legacyManifest.project, baseCommit: repo.baseCommit } },
  });
  assert.equal(legacy.hash, manifestHash(legacy.manifest));
  await assertNoExecution(service, [...expectedGoalIds, legacy.id]);
});

test('a staged gitlink deletion cannot look like a clean checkout', async t => {
  const service = await coordinator(t);
  const repo = await repository(service);
  await repo.git('update-index', '--add', '--cacheinfo', `160000,${repo.baseCommit},vendor/fixture`);
  await repo.git('commit', '-m', 'Add fixture gitlink');
  await repo.git('update-index', '--force-remove', 'vendor/fixture');
  assert.equal(await repo.git('diff', '--cached', '--name-status'), 'D\tvendor/fixture');
  const before = await repositoryBytes(repo.root);
  const result = await service.call('assignment_prepare', {
    idempotencyKey: 'removed-gitlink', manifest: assignment(repo),
  });
  assert.equal(result.status, 'needs_input');
  assert.ok(result.issues.some(issue => issue.field === 'project.repo'), JSON.stringify(result));
  assert.deepEqual(await repositoryBytes(repo.root), before);
  await assertNoExecution(service);
});

test('registered mode versions cannot redefine an assignment preset', async t => {
  const service = await coordinator(t);
  const repo = await repository(service);
  const registered = await service.call('mode_register', {
    idempotencyKey: 'registered-mode',
    definition: {
      id: 'codex_only', version: 9, planner: 'deepseek', actors: ['deepseek', 'codex'],
      review: 'operator', capabilities: ['coding'],
    },
  });
  assert.equal(registered.version, 9);
  const prepared = await service.call('assignment_prepare', {
    idempotencyKey: 'pinned-mode', manifest: assignment(repo, { mode: 'codex_only' }),
  });
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.summary.mode, { id: 'codex_only', version: 1 });
  assert.deepEqual(prepared.summary.roles.workers, ['codex']);
  const draft = await service.call('goal_get', { goalId: prepared.goalId });
  assert.equal(draft.manifest.mode.version, 1);
  assert.equal(draft.manifest.mode.planner, 'codex');

  const custom = await service.call('assignment_prepare', {
    idempotencyKey: 'custom-mode', manifest: { ...assignment(repo, { mode: 'codex_only', submissionId: 'custom-mode' }), modeVersion: 9 },
  });
  assert.equal(custom.status, 'needs_input');
  assert.ok(custom.issues.some(issue => issue.field === 'modeVersion'), JSON.stringify(custom));
  await assertNoExecution(service, [prepared.goalId]);
});

test('an ambiguous Git clean-filter name fails closed without executing the filter', async t => {
  const service = await coordinator(t);
  const repo = await repository(service);
  await writeFile(path.join(repo.root, '.gitattributes'), 'src/export.mjs filter=a=b\n');
  await repo.git('add', '.gitattributes');
  await repo.git('commit', '-m', 'Add ambiguous fixture attributes');
  const script = path.join(service.root, 'ambiguous-filter');
  const marker = path.join(service.root, 'ambiguous-filter-ran');
  await writeFile(script, `#!/bin/sh\nprintf attempted > '${marker}'\ncat\n`, { mode: 0o700 });
  await repo.git('config', 'filter.a=b.clean', script);
  assert.equal(await repo.git('check-attr', 'filter', '--', 'src/export.mjs'), 'src/export.mjs: filter: a=b');
  const source = path.join(repo.root, 'src', 'export.mjs');
  await writeFile(source, (await readFile(source, 'utf8')).replace('export const', 'export let  '));
  const changedTime = new Date(Date.now() - 60_000);
  await utimes(source, changedTime, changedTime);
  const before = await repositoryBytes(repo.root);
  const result = await service.call('assignment_prepare', {
    idempotencyKey: 'ambiguous-filter', manifest: assignment(repo),
  });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.equal(result.status, 'needs_input');
  assert.ok(result.issues.some(issue => issue.field === 'project.repo'), JSON.stringify(result));
  assert.deepEqual(await repositoryBytes(repo.root), before);
  await repo.git('status', '--porcelain');
  assert.equal(await readFile(marker, 'utf8'), 'attempted');
  await assertNoExecution(service);
});
