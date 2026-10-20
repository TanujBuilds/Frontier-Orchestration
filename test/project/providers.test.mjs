import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectLocal, ProjectFrontier } from '../../src/project/providers.mjs';
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
