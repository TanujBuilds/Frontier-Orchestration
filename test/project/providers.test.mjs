import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectLocal, ProjectFrontier } from '../../src/project/providers.mjs';
import { templatePlanner } from '../../src/project/service.mjs';
import { validateReply, AttemptError } from '../../src/project/contracts.mjs';

test('coding adapter preserves exact HTTP handoff, model, usage and malformed answer', async () => {
  const calls = [];
  const local = new ProjectLocal({ baseUrl: 'http://example.invalid/v1', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options });
    return { ok: true, json: async () => String(url).endsWith('/models') ? { data: [{ id: 'stub-model' }] } : { model: 'stub-model', usage: { total_tokens: 10 }, choices: [{ message: { content: 'bad json' }, finish_reason: 'stop' }] } };
  } });
  const input = { stage: { id: 'one' }, inventory: [], context: [] };
  const result = await local.reply(input);
  assert.equal(result.rawAnswer, 'bad json');
  assert.match(result.protocolError, /invalid JSON/);
  assert.equal(result.usage.total_tokens, 10);
  assert.deepEqual(JSON.parse(JSON.parse(calls[1].body).messages[1].content), input);
  assert.equal(JSON.parse(calls[1].body).model, 'stub-model');
  assert.equal(JSON.parse(calls[1].body).max_tokens, 12_000);
  assert.deepEqual(JSON.parse(calls[1].body).chat_template_kwargs, { enable_thinking: false });
  assert.match(JSON.parse(calls[1].body).messages[0].content, /at most two files/);
});

test('structured worker replies reject missing hashes and malformed edit objects', () => {
  for (const edits of [[null], [{ path: 'src/file', action: 'write' }]]) {
    assert.throws(() => validateReply({ type: 'submit_changes', edits, summary: 'bad' }), AttemptError);
  }
});

test('frontier review gets actual evidence and attaches screenshot artifacts', async () => {
  let seen;
  const frontier = new ProjectFrontier({ invoke: async input => { seen = input; return JSON.stringify({ decision: 'accept', feedback: 'reviewed', unverified: [] }); } });
  const input = { brief: 'build', stage: { id: 'stage' }, evidence: { diff: '+code', checks: [{ id: 'ui', passed: true, screenshots: ['/tmp/desktop.png'] }] } };
  await frontier.reviewCode(input);
  assert.ok(seen.input.includes(JSON.stringify(input)));
  assert.ok(seen.args.includes('/tmp/desktop.png'));
  assert.ok(seen.args.includes('shell_tool'));
});

test('DeepSeek plans with the disabled-thinking structured call and no Codex involvement', async () => {
  const calls = [];
  const local = new ProjectLocal({ baseUrl: 'http://example.invalid/v1', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options });
    const body = String(url).endsWith('/models') ? { data: [{ id: 'stub-model' }] }
      : { model: 'stub-model', usage: { total_tokens: 25 }, choices: [{ message: { content: JSON.stringify({
        summary: 'Plan', stages: [{ id: 'a', kind: 'implementation', objective: 'o', deliverable: 'd', writePaths: ['src/'], acceptance: ['x'], checks: ['ui'] }],
      }) }, finish_reason: 'stop' }] };
    return { ok: true, json: async () => body };
  } });
  const result = await local.planProject({ brief: 'build a page', permissions: { writePaths: ['src/'] } });
  assert.equal(result.protocolError, null);
  assert.equal(result.plan.stages[0].id, 'a');
  assert.equal(result.usage.total_tokens, 25);
  const request = JSON.parse(calls[1].body);
  assert.equal(request.max_tokens, 6000);
  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false });
  assert.match(request.messages[0].content, /writePaths/);
});

test('template planner makes no model call', async () => {
  const plan = await templatePlanner.planProject({ permissions: { writePaths: ['src/'], checks: [{ id: 'ui', argv: ['node', 'x.mjs'] }] } });
  assert.deepEqual(plan.stages.map(stage => stage.kind), ['implementation', 'verification']);
  assert.deepEqual(plan.stages[1].checks, ['ui']);
});
