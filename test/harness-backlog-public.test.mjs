import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Coordinator } from '../src/harness/coordinator.mjs';
import { Dispatcher } from '../src/harness/tools.mjs';
import { startApi } from '../src/harness/api.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/mosaic-backlog.mjs', import.meta.url));
const mcp = fileURLToPath(new URL('../src/harness/mcp.mjs', import.meta.url));

async function cli(...args) {
  const { stdout } = await exec(process.execPath, [script, ...args], { timeout: 10000 });
  return JSON.parse(stdout);
}

async function fixture(t, { beta = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backlog-public-'));
  const c = new Coordinator({ root, beta });
  const dispatcher = new Dispatcher({ c, config: { beta, environment: 'fixture' } });
  const token = 'backlog-fixture-operator-token-123456';
  const viewerToken = 'backlog-fixture-viewer-token-987654';
  const api = await startApi({ dispatcher, token, viewerToken });
  t.after(async () => {
    await api.close();
    c.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ url: api.url, token }), { mode: 0o600 });
  const goal = c.prepareGoal({
    submissionId: 'public-fixture',
    objective: 'Check the local backlog transport',
    acceptance: ['Verify the saved task group'],
    environment: 'fixture',
    mode: 'codex_only',
  }, 'prepare-fixture');
  const { deadline } = c.activateGoal({ goalId: goal.id, hash: goal.hash }, 'activate-fixture');
  const consult = (key, dependsOnKeys = []) => ({
    key, dependsOnKeys,
    task: { kind: 'consult', objective: 'Inspect ' + key, acceptance: ['Saved response'] },
  });
  const input = {
    goalId: goal.id, expectedGoalHash: goal.hash, expectedGoalVersion: goal.version, submissionId: 'example',
    items: [consult('first'), consult('second', ['first'])],
  };
  const file = path.join(root, 'group.json');
  await writeFile(file, JSON.stringify(input));
  return { api, c, dispatcher, goal, input, file, root, deadline, viewerToken };
}

test('authenticated CLI previews, submits, replays and inspects one approved backlog', async t => {
  const { c, goal, file, root } = await fixture(t);
  const preview = await cli('preview', '--root', root, '--input', file);
  assert.equal(preview.valid, true);
  assert.equal(c.store.all('task').length, 0);
  await assert.rejects(cli('submit', '--root', root, '--input', file), /idempotency-key/i);
  const command = ['submit', '--root', root, '--input', file, '--idempotency-key', 'submit-example'];
  const submitted = await cli(...command);
  assert.deepEqual(await cli(...command), submitted);
  assert.equal(c.store.all('task').length, 2);
  const view = await cli('inspect', '--root', root, '--goal', goal.id, '--group', submitted.id);
  assert.equal(view.groups[0].id, submitted.id);
  assert.deepEqual(Object.fromEntries(view.groups[0].items.map(item => [item.key, item.status])), {
    first: 'waiting_host', second: 'waiting_dependency',
  });
});

test('public backlog tools require an exact positive approval version before submission', async t => {
  const {c,dispatcher,input} = await fixture(t);
  const {expectedGoalVersion,...unbound} = input;
  for (const tool of ['backlog_preview','backlog_submit']) {
    const payload = tool === 'backlog_submit' ? {...unbound,idempotencyKey:'invalid-version'} : unbound;
    await assert.rejects(dispatcher.invoke(tool,payload),/expectedGoalVersion/);
    for (const version of [0,1.5,Number.MAX_SAFE_INTEGER+1]) {
      await assert.rejects(dispatcher.invoke(tool,{...payload,expectedGoalVersion:version}),/expectedGoalVersion/);
    }
  }
  const stale = await dispatcher.invoke('backlog_preview',{...input,expectedGoalVersion:expectedGoalVersion+1});
  assert.equal(stale.valid,false);
  assert.equal(stale.errors[0].code,'goal_version_mismatch');
  await assert.rejects(dispatcher.invoke('backlog_submit',{
    ...input,expectedGoalVersion:expectedGoalVersion+1,idempotencyKey:'stale-version',
  }),/version/);
  assert.equal(c.store.all('task').length,0);
});

test('MCP advertises the beta-safe schemas and existing task controls preserve the same group', async t => {
  const { api, c, dispatcher, goal, input, root, deadline, viewerToken } = await fixture(t, { beta: true });
  const viewer = await fetch(api.url + '/api/invoke', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + viewerToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'backlog_inspect', input: { goalId: goal.id } }),
  });
  assert.equal(viewer.status, 403);
  const client = new Client({ name: 'backlog-fixture', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcp, '--connection', path.join(root, 'connection.json')],
    stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const preview = tools.find(tool => tool.name === 'backlog_preview');
  const submit = tools.find(tool => tool.name === 'backlog_submit');
  assert.equal(preview.annotations.readOnlyHint, true);
  assert.equal(submit.annotations.readOnlyHint, false);
  assert.ok(submit.inputSchema.required.includes('idempotencyKey'));
  assert.deepEqual(submit.inputSchema.properties.items.items.properties.task.properties.kind.enum, ['coding', 'consult', 'learning']);

  const invoke = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    return { isError: !!response.isError, ...JSON.parse(response.content[0].text) };
  };
  const invalid = await invoke('backlog_preview', {
    ...input, items: [{ ...input.items[0], task: { ...input.items[0].task, goalId: goal.id } }],
  });
  assert.equal(invalid.isError, true);
  assert.equal((await invoke('backlog_submit', input)).isError, true);
  const result = await invoke('backlog_submit', { ...input, idempotencyKey: 'mcp-submit' });
  assert.equal(result.isError, false, JSON.stringify(result));
  const taskId = result.items.find(item => item.key === 'first').taskId;
  const secondId = result.items.find(item => item.key === 'second').taskId;
  await dispatcher.invoke('task_priority', { taskId: secondId, priority: 'blocking', reason: 'Needed first', idempotencyKey: 'priority' });
  await dispatcher.invoke('work_control', { taskId, action: 'stop', idempotencyKey: 'stop' });
  const stopped = await invoke('backlog_inspect', { goalId: goal.id });
  const byKey = Object.fromEntries(stopped.groups[0].items.map(item => [item.key, item]));
  assert.equal(byKey.first.sourceStatus, 'stopped');
  assert.equal(byKey.first.effectivePriority, 'blocking');
  assert.equal(byKey.second.status, 'waiting_dependency');
  assert.equal(byKey.second.reasonCode, 'dependency_stopped');
  await dispatcher.invoke('work_control', { taskId, action: 'resume', idempotencyKey: 'resume' });
  assert.equal(c.getTask(taskId).status, 'codex_ready');
  assert.equal(c.getTask(taskId).spec.priority, 'normal');
  assert.equal(c.getGoal(goal.id).deadline, deadline);
});

test('normal CLI commands require an existing connection and create no state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backlog-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(cli('inspect', '--root', root, '--goal', 'missing'), /connection\.json/i);
  assert.deepEqual(await readdir(root), []);
});

test('demo persists before, review-wait, reopen and accepted views of the same disposable group', async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'backlog-demo-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const summary = await cli('demo', '--output', output);
  const transcript = JSON.parse(await readFile(summary.transcript, 'utf8'));
  assert.deepEqual(transcript.providerInvocations, { before: 0, reviewWait: 1, reopened: 1, completed: 3 });
  const views = ['before', 'reviewWait', 'reopened', 'completed'].map(phase => transcript[phase].groups[0]);
  assert.ok(views.every(group => group.id === summary.groupId));
  assert.ok(views[1].items.some(item => item.status === 'waiting_review'));
  assert.ok(views[2].items.some(item => item.status === 'waiting_dependency'));
  assert.ok(views[3].items.every(item => item.status === 'accepted'));
});
