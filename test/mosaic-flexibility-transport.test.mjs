import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LocalProvider } from '../src/harness/provider.mjs';

const advertised = transports => ({ protocol: 'mosaic-structured-v1', transports, modelDiscovery: 'advertised' });
const manual = transports => ({ ...advertised(transports), modelDiscovery: 'manual' });
const frame = item => 'data: ' + JSON.stringify(item) + '\n\n';
const done = 'data: [DONE]\n\n';
const notDispatched = error => error.requestOutcome === 'not_dispatched';
const unknown = error => error.requestOutcome === 'unknown';

async function loopback(t, respond) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const call = {
      route: request.method + ' ' + request.url,
      authorization: request.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null,
    };
    calls.push(call);
    respond(call, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', calls };
}

function json(response, body) {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function completed(response, model, content = 'complete', metadata = {}) {
  json(response, { model, choices: [{ message: { content }, finish_reason: 'stop' }], ...metadata });
}

function models(response, ...ids) {
  json(response, { data: ids.map(id => ({ id })) });
}

function sse(response, wire) {
  response.writeHead(200, { 'content-type': 'text/event-stream' }).end(wire);
}

function delta(content, metadata = {}, finishReason = null) {
  return frame({ choices: [{ delta: { content }, finish_reason: finishReason }], ...metadata });
}

test('DeepSeek and generic endpoints honor their selected protocol, transport and requested alias', async t => {
  const sparkKey = 'fixture-spark-2vD';
  const hostedKey = 'fixture-hosted-7xR';
  const spark = await loopback(t, (call, response) => {
    if (call.route.endsWith('/models')) return models(response, 'spark-fixture');
    completed(response, 'spark-fixture', 'local JSON');
  });
  const hosted = await loopback(t, (call, response) => {
    if (call.route.endsWith('/models')) return models(response, 'hosted-alias', 'another-model');
    if (!call.body.stream) return completed(response, 'hosted-version-2026-11-10', 'hosted JSON');
    sse(response, delta('hosted SSE', { model: 'hosted-version-2026-11-10' }, 'stop') + done);
  });
  assert.notEqual(spark.baseUrl, hosted.baseUrl);
  const deepSeek = new LocalProvider({
    baseUrl: spark.baseUrl, model: 'spark-fixture', apiKey: sparkKey, capabilities: advertised(['json']),
  });
  const generic = new LocalProvider({
    baseUrl: hosted.baseUrl, model: 'hosted-alias', apiKey: hostedKey, openAICompatible: true,
    streaming: true, capabilities: advertised(['json', 'sse']),
  });
  assert.equal((await deepSeek.complete([])).content, 'local JSON');
  const chunks = [];
  const selected = [];
  const streamed = await generic.complete([], {
    expectedModel: 'hosted-alias',
    onModel: model => selected.push(model),
    onContent: chunk => chunks.push(chunk),
  });
  const whole = await generic.complete([], { streaming: false, expectedModel: 'hosted-alias' });
  assert.deepEqual(selected, ['hosted-alias']);
  assert.equal(chunks.join(''), 'hosted SSE');
  for (const [result, content] of [[streamed, 'hosted SSE'], [whole, 'hosted JSON']]) {
    assert.equal(result.content, content);
    assert.equal(result.requestedModel, 'hosted-alias');
    assert.equal(result.model, 'hosted-version-2026-11-10');
  }
  assert.deepEqual(spark.calls.map(call => call.route), ['GET /v1/models', 'POST /v1/chat/completions']);
  assert.deepEqual(hosted.calls.map(call => call.route), [
    'GET /v1/models', 'POST /v1/chat/completions', 'GET /v1/models', 'POST /v1/chat/completions',
  ]);
  assert.ok(spark.calls.every(call => call.authorization === 'Bearer ' + sparkKey));
  assert.ok(hosted.calls.every(call => call.authorization === 'Bearer ' + hostedKey));
  assert.equal(spark.calls[1].body.model, 'spark-fixture');
  assert.deepEqual(spark.calls[1].body.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(hosted.calls.filter(call => call.body).map(call => [
    call.body.model, call.body.stream, Object.hasOwn(call.body, 'chat_template_kwargs'),
  ]), [['hosted-alias', true, false], ['hosted-alias', false, false]]);
});

test('legacy and explicit manual profiles can complete when model discovery is unavailable', async t => {
  const service = await loopback(t, (call, response) => {
    if (call.route.endsWith('/models')) return response.writeHead(404).end();
    completed(response, 'versioned');
  });
  for (const capabilities of [undefined, manual(['json'])]) {
    const provider = new LocalProvider({
      baseUrl: service.baseUrl, model: 'alias', openAICompatible: true, capabilities,
    });
    assert.equal((await provider.complete([])).requestedModel, 'alias');
  }
  assert.deepEqual(service.calls.map(call => call.route), [
    'POST /v1/chat/completions', 'POST /v1/chat/completions',
  ]);
});

test('advertised discovery revalidates the selected model after a successful completion', async t => {
  let advertisedModel = 'chosen';
  const service = await loopback(t, (call, response) => {
    if (call.route.endsWith('/models')) return models(response, advertisedModel);
    completed(response, 'chosen');
  });
  const provider = new LocalProvider({
    baseUrl: service.baseUrl, model: 'chosen', openAICompatible: true, capabilities: advertised(['json']),
  });
  await provider.complete([]);
  advertisedModel = 'replacement';
  await assert.rejects(provider.complete([], { expectedModel: 'chosen' }),
    error => notDispatched(error) && /not advertised/.test(error.message) && !/unavailable/.test(error.message));
  assert.deepEqual(service.calls.map(call => call.route), [
    'GET /v1/models', 'POST /v1/chat/completions', 'GET /v1/models',
  ]);
});

test('malformed discovery and HTTP failures cannot dispatch a completion', async t => {
  for (const [name, respond, status] of [
    ['missing model list', response => json(response, { items: [] })],
    ['malformed entry alongside valid model', response => json(response, { data: [{ id: 'chosen' }, { id: 17 }] })],
    ['discovery auth failure', response => response.writeHead(401).end(), 401],
    ['discovery unavailable', response => response.writeHead(503).end(), 503],
  ]) {
    await t.test(name, async t => {
      const service = await loopback(t, (_call, response) => respond(response));
      const provider = new LocalProvider({
        baseUrl: service.baseUrl, model: 'chosen', openAICompatible: true, capabilities: advertised(['json']),
      });
      await assert.rejects(provider.complete([]), error => notDispatched(error) && error.httpStatus === status);
      assert.deepEqual(service.calls.map(call => call.route), ['GET /v1/models']);
    });
  }
});

test('malformed capability, unsupported transport and mismatched pin stop before completion', async t => {
  const service = await loopback(t, (_call, response) => completed(response, 'chosen'));
  const options = { baseUrl: service.baseUrl, model: 'chosen', openAICompatible: true };
  for (const [name, capabilities] of [
    ['null declaration', null],
    ['unknown protocol', { ...manual(['json']), protocol: 'other-protocol' }],
    ['unsupported transports', manual(['websocket'])],
    ['empty transports', manual([])],
    ['incompatible configured transport', manual(['sse'])],
  ]) {
    await t.test(name, () => assert.throws(() => new LocalProvider({ ...options, capabilities }), notDispatched));
  }
  const provider = new LocalProvider({ ...options, capabilities: manual(['json']) });
  await t.test('unsupported per-request override', async () => {
    await assert.rejects(provider.complete([], { streaming: true }), notDispatched);
  });
  await t.test('different pinned model', async () => {
    await assert.rejects(provider.complete([], { expectedModel: 'previous' }), notDispatched);
  });
  assert.deepEqual(service.calls.map(call => call.route), []);
});

test('bearer material stays in authorization and is removed from prompts, results and streaming capture', async t => {
  const apiKey = 'fixture-credential-3Qw';
  const reported = 'provider-model-' + apiKey;
  const usage = { total_tokens: 5, fixture: { [apiKey]: 'echo ' + apiKey } };
  const service = await loopback(t, (call, response) => {
    if (!call.body.stream) return completed(response, reported, 'echo ' + apiKey, { usage });
    sse(response,
      delta('echo ' + apiKey.slice(0, 9), { model: reported }) +
      delta(apiKey.slice(9), { model: reported, usage }, 'stop') + done);
  });
  const provider = new LocalProvider({
    baseUrl: service.baseUrl, model: 'chosen', apiKey, openAICompatible: true, capabilities: manual(['json', 'sse']),
  });
  for (const streaming of [false, true]) {
    const capture = [];
    const resolved = [];
    const result = await provider.complete([{ role: 'user', content: 'visible ' + apiKey }], {
      streaming, onContent: chunk => capture.push(chunk), onModel: model => resolved.push(model),
    });
    assert.deepEqual(resolved, ['chosen']);
    assert.ok(!JSON.stringify(result).includes(apiKey));
    assert.equal(result.content, 'echo [redacted]');
    assert.equal(result.model, 'provider-model-[redacted]');
    assert.equal(result.requestedModel, 'chosen');
    assert.equal(result.usage.fixture['[redacted]'], 'echo [redacted]');
    assert.equal(capture.join(''), streaming ? 'echo [redacted]' : '');
  }
  for (const call of service.calls) {
    assert.ok(call.authorization === 'Bearer ' + apiKey);
    assert.ok(!JSON.stringify(call.body).includes(apiKey));
    assert.equal(call.body.messages[0].content, 'visible [redacted]');
  }
  assert.equal(service.calls.length, 2);
});

test('direct provider configuration rejects bearer material in model IDs and endpoint paths', async t => {
  const apiKey = 'fixture-credential-3Qw';
  const service = await loopback(t, (_call, response) => completed(response, 'chosen'));
  const options = { baseUrl: service.baseUrl, model: 'chosen', apiKey, openAICompatible: true };
  for (const change of [
    { model: 'alias-' + apiKey },
    { baseUrl: service.baseUrl + '/' + apiKey },
    { baseUrl: service.baseUrl + '/%66' + apiKey.slice(1) },
  ]) {
    assert.throws(() => new LocalProvider({ ...options, ...change }),
      error => notDispatched(error) && !error.message.includes(apiKey));
  }
  assert.deepEqual(service.calls, []);
});

test('generic URL validation rejects malformed URLs without exposing raw input', async t => {
  for (const [name, baseUrl] of [
    ['userinfo', 'http://fixture-user:fixture-password@127.0.0.1:1/v1'],
    ['query', 'http://127.0.0.1:1/v1?token=fixture-query'],
    ['fragment', 'http://127.0.0.1:1/v1#fixture-fragment'],
    ['invalid port', 'http://127.0.0.1:fixture-port/v1'],
  ]) {
    await t.test(name, () => {
      assert.throws(() => new LocalProvider({ baseUrl, model: 'chosen', openAICompatible: true }),
        error => notDispatched(error) && !Object.hasOwn(error, 'input') && !error.message.includes('fixture-'));
    });
  }
});

test('bearer material is removed from JSON embedded in a prompt message', async t => {
  const apiKey = 'fixture-"quoted"\\key';
  const service = await loopback(t, (_call, response) => completed(response, 'chosen'));
  const provider = new LocalProvider({
    baseUrl: service.baseUrl, model: 'chosen', apiKey, openAICompatible: true,
  });
  await provider.complete([{ role: 'user', content: JSON.stringify({ note: 'visible ' + apiKey }) }]);
  assert.ok(service.calls[0].authorization === 'Bearer ' + apiKey);
  const note = JSON.parse(service.calls[0].body.messages[0].content).note;
  assert.ok(!note.includes(apiKey));
  assert.equal(note, 'visible [redacted]');
});

test('malformed completion metadata is unknown even if subsequent SSE frames are valid', async t => {
  for (const [name, respond, streaming] of [
    ['JSON model has a control character', response => completed(response, 'chosen\nfake'), false],
    ['JSON usage is an array', response => completed(response, 'chosen', 'complete', { usage: [] }), false],
    ['SSE finish reason is a number', response => sse(response, delta('answer', {}, 1) + delta('', {}, 'stop') + done), true],
    ['SSE model changes', response => sse(response, delta('answer', { model: 'a' }) + delta('', { model: 'b' }, 'stop') + done), true],
    ['SSE usage is an array', response => sse(response, delta('answer', { usage: [] }) + delta('', { usage: null }, 'stop') + done), true],
  ]) {
    await t.test(name, async t => {
      const service = await loopback(t, (_call, response) => respond(response));
      const provider = new LocalProvider({
        baseUrl: service.baseUrl, model: 'chosen', openAICompatible: true, streaming, capabilities: manual(['json', 'sse']),
      });
      await assert.rejects(provider.complete([]), unknown);
      assert.deepEqual(service.calls.map(call => call.route), ['POST /v1/chat/completions']);
    });
  }
});

test('HTTP auth rejection, truncation and disconnection retain their outcomes without fallback', async t => {
  const apiKey = 'fixture-credential-3Qw';
  for (const [name, respond, streaming, validate] of [
    ['completed HTTP auth rejection', response => response.writeHead(401).end(apiKey), false,
      error => notDispatched(error) && error.httpStatus === 401],
    ['SSE HTTP auth rejection', response => response.writeHead(403).end(apiKey), true,
      error => notDispatched(error) && error.httpStatus === 403],
    ['incomplete SSE', response => sse(response, delta('partial ' + apiKey)), true, unknown],
    ['disconnected SSE', response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(delta('partial ' + apiKey), () => response.destroy());
    }, true, unknown],
  ]) {
    await t.test(name, async t => {
      const service = await loopback(t, (call, response) => {
        if (call.route.endsWith('/models')) return models(response, 'chosen');
        respond(response);
      });
      const provider = new LocalProvider({
        baseUrl: service.baseUrl, model: 'chosen', apiKey, openAICompatible: true, streaming,
        capabilities: advertised(['json', 'sse']),
      });
      const chunks = [];
      await assert.rejects(provider.complete([], { onContent: chunk => chunks.push(chunk) }),
        error => validate(error) && !error.message.includes(apiKey));
      assert.ok(!chunks.join('').includes(apiKey));
      assert.deepEqual(service.calls.map(call => call.route), ['GET /v1/models', 'POST /v1/chat/completions']);
      assert.equal(service.calls[1].body.stream, streaming);
    });
  }
});
