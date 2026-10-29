import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeepSeekHttpAdapter } from '../src/adapters/deepseek-http.mjs';

const step = { objective: 'Design a storage layer', context: 'Single user', expectedResult: 'Schema and tradeoffs' };
function response(body, status = 200) { return Response.json(body, { status }); }

test('discovers one model and sends a bounded text assignment', async () => {
  const calls = [];
  const adapter = new DeepSeekHttpAdapter({ baseUrl: 'http://example.test/v1', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return response({ data: [{ id: 'local-model' }] });
    return response({ model: 'local-model', choices: [{ message: { content: 'Complete answer' }, finish_reason: 'stop' }], usage: { completion_tokens: 20 } });
  } });
  const result = await adapter.execute({ step, attempt: 1, feedback: null, priorResult: null });
  assert.equal(result.answer, 'Complete answer');
  assert.equal(result.model, 'local-model');
  assert.equal(adapter.identity, 'deepseek-http/local-model');
  assert.equal(calls[0].url, 'http://example.test/v1/models');
  const request = JSON.parse(calls[1].options.body);
  assert.equal(request.model, 'local-model');
  assert.match(request.messages[1].content, /Design a storage layer/);
  assert.equal(request.stream, false);
});

test('revision includes full previous answer and focused feedback', async () => {
  const calls = [];
  const adapter = new DeepSeekHttpAdapter({ baseUrl: 'http://example.test/v1', model: 'local-model', fetchImpl: async (_url, options) => {
    calls.push(options);
    return calls.length === 1 ? response({ data: [{ id: 'local-model' }] }) : response({ choices: [{ message: { content: 'Revised answer' }, finish_reason: 'stop' }] });
  } });
  await adapter.execute({ step, attempt: 2, feedback: 'Clarify the tradeoff', priorResult: { answer: 'First answer in full' } });
  const request = JSON.parse(calls[1].body);
  assert.match(request.messages[1].content, /First answer in full/);
  assert.match(request.messages[1].content, /Clarify the tradeoff/);
});

test('multiple models need an explicit ID', async () => {
  const adapter = new DeepSeekHttpAdapter({ baseUrl: 'http://localhost/v1', fetchImpl: async () => response({ data: [{ id: 'a' }, { id: 'b' }] }) });
  await assert.rejects(adapter.execute({ step, attempt: 1 }), /set DEEPSEEK_MODEL_ID/);
});

test('unavailable endpoint and empty answer fail clearly', async () => {
  const offline = new DeepSeekHttpAdapter({ baseUrl: 'http://localhost/v1', fetchImpl: async () => { throw new Error('Connection refused'); } });
  await assert.rejects(offline.execute({ step, attempt: 1 }), /Connection refused/);
  let calls = 0;
  const empty = new DeepSeekHttpAdapter({ baseUrl: 'http://localhost/v1', fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? response({ data: [{ id: 'a' }] }) : response({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
  } });
  await assert.rejects(empty.execute({ step, attempt: 1 }), /empty or unsupported answer/);
});

test('truncated answer is retained but marked failed', async () => {
  let calls = 0;
  const adapter = new DeepSeekHttpAdapter({ baseUrl: 'http://localhost/v1', fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? response({ data: [{ id: 'a' }] }) : response({ choices: [{ message: { content: 'Partial answer' }, finish_reason: 'length' }] });
  } });
  const result = await adapter.execute({ step, attempt: 1 });
  assert.equal(result.status, 'failed');
  assert.equal(result.answer, 'Partial answer');
});

test('request errors distinguish an uncertain dispatched completion from model discovery failure',async()=>{
 const discovery=new DeepSeekHttpAdapter({baseUrl:'http://example.test/v1',fetchImpl:async()=>response({},504)});
 await assert.rejects(discovery.resolveModel(),error=>error.httpStatus===504&&error.requestOutcome==='not_dispatched');
 const completion=new DeepSeekHttpAdapter({baseUrl:'http://example.test/v1',fetchImpl:async()=>response({},504)});
 await assert.rejects(completion.request(completion.chatUrl,{method:'POST',body:'{}'}),error=>error.httpStatus===504&&error.requestOutcome==='unknown');
});
