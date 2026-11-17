import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {startApi} from '../src/harness/api.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {prepareAssignment} from '../src/harness/assignment-intake.mjs';
import {repository, assignment, repositoryBytes} from './fixtures/mosaic-assignment/repository.mjs';
import {readRequestBody} from '../src/harness/http-body.mjs';

// These fragments reach the production-used reader directly, independent of TCP coalescing.
async function* fragments(chunks) { yield* chunks; }
for (const value of ['é', '中', '😀', 'e\u0301', 'Before 😀 中 é after']) {
  test(`preserves exact UTF-8 at every byte split: ${JSON.stringify(value)}`, async () => {
    const text = JSON.stringify({name: 'assignment_prepare', input: {objective: value}});
    const bytes = Buffer.from(text);
    for (let split = 1; split < bytes.length; split++) {
      const actual = await readRequestBody(fragments([bytes.subarray(0, split), bytes.subarray(split)]));
      assert.equal(actual, text, `split at byte ${split}`);
      assert.deepEqual(JSON.parse(actual), JSON.parse(text));
    }
  });
}
test('rejects malformed and truncated UTF-8 with a fixed safe 400', async () => {
  for (const bytes of [Buffer.from([0x80]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80]), Buffer.from([0xe2, 0x82])]) {
    await assert.rejects(readRequestBody(fragments([bytes])), {status: 400, message: 'Invalid UTF-8 request body'});
  }
});

test('ASCII, empty text and a UTF-8 BOM retain their literal reader meaning', async () => {
  for (const text of ['', 'ordinary ASCII\r\n', '\ufeff{"name":"tools_list"}', '😀\ufeffé']) {
    assert.equal(await readRequestBody(fragments([Buffer.from(text)])), text);
  }
});

test('byte budgets accept the exact limit and reject limit+1 despite a smaller character count', async () => {
  const text = '😀'.repeat(256), bytes = Buffer.from(text);
  assert.equal(bytes.length, 1024);
  assert.equal(await readRequestBody(fragments([bytes]), 1024), text);
  await assert.rejects(readRequestBody(fragments([bytes, Buffer.from('x')]), 1024), {status: 413, message: 'Request body exceeds limit'});
  await assert.rejects(readRequestBody(fragments([bytes]), 1023), {status: 413});
});

test('oversized input is completely drained without retaining or dispatching its prefix', async () => {
  let yielded = 0, closed = false;
  async function* input() {
    try { for (let i = 0; i < 64; i++) { yielded++; yield Buffer.alloc(1024, 65); } }
    finally { closed = true; }
  }
  await assert.rejects(readRequestBody(input(), 32), {status: 413});
  assert.equal(yielded, 64);
  assert.equal(closed, true);
});

test('slow producer is pulled sequentially and reused Buffer fragments are copied before the next pull', async () => {
  let active = 0, pulls = 0, maxActive = 0;
  const buffer = Buffer.alloc(4);
  const source = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      maxActive = Math.max(maxActive, ++active);
      await delay(1);
      const i = pulls++;
      buffer.fill(65 + i);
      active--;
      return i < 16 ? {value: buffer, done: false} : {done: true};
    },
    get headers() { throw Error('Content-Length must not drive storage'); },
  };
  assert.equal(await readRequestBody(source, 64), 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP');
  assert.equal(maxActive, 1);
  assert.equal(pulls, 17);
  assert.equal(active, 0);
});

test('many one-byte fragments preserve the exact body without a fragment count limit', async () => {
  async function* input() { for (let i = 0; i < 8192; i++) yield Buffer.from('a'); }
  assert.equal(await readRequestBody(input(), 8192), 'a'.repeat(8192));
});

test('read errors and a mid-character stream abort reject once with a finite safe diagnostic', async () => {
  for (const input of [
    (async function* () { yield Buffer.from('prefix'); throw Error('PRIVATE_SOURCE_SENTINEL'); })(),
    new Readable({read() { this.push(Buffer.from([0xe2])); this.destroy(Error('PRIVATE_ABORT_SENTINEL')); }}),
  ]) {
    let settlements = 0;
    await assert.rejects(readRequestBody(input).then(value => { settlements++; return value; }, error => { settlements++; throw error; }), {status: 400, message: 'Incomplete request body'});
    await delay(0);
    assert.equal(settlements, 1);
  }
});

const operator = 'o'.repeat(64), viewer = 'v'.repeat(64);
async function apiFixture(t, options = {}) {
  const calls = [], sockets = new Set();
  const dispatcher = {
    async invoke(name, input) { calls.push({name, input}); return {received: input}; },
    tools() { return [{name: 'observer_snapshot'}, {name: 'goal_activate'}]; },
  };
  const api = await startApi({dispatcher, token: operator, viewerToken: viewer, ...options});
  api.server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => {
    api.server.closeAllConnections();
    await api.close();
    await delay(0);
    assert.equal(sockets.size, 0, 'owned API sockets all closed');
    assert.equal(api.server.listening, false);
  });
  return {...api, calls, sockets};
}

function exchange(api, bytes, {route = '/api/invoke', headers = {}, chunks} = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(api.url + route, {
      method: 'POST', agent: false,
      headers: {authorization: `Bearer ${operator}`, 'content-type': 'application/json', ...headers},
    }, response => {
      const data = [];
      response.on('data', chunk => data.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, text: Buffer.concat(data).toString('utf8')}));
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(Error('Owned request timed out')));
    (async () => {
      if (!chunks) return request.end(bytes);
      for (const chunk of chunks) if (!request.write(chunk)) await once(request, 'drain');
      request.end();
    })().catch(error => { request.destroy(); reject(error); });
  });
}
const packet = objective => JSON.stringify({name: 'assignment_prepare', input: {objective}});

function packetOfSize(size) {
  const prefix = '😀中e\u0301';
  return packet(prefix + 'x'.repeat(size - Buffer.byteLength(packet(prefix))));
}

test('real invoke preserves fragmented valid text and enforces the 1048576-byte wire budget', async t => {
  const api = await apiFixture(t), objective = 'Before 😀 中 é e\u0301\r\nAfter';
  const bytes = Buffer.from(packet(objective));
  const response = await exchange(api, null, {chunks: Array.from(bytes, byte => Buffer.from([byte]))});
  assert.equal(response.status, 200);
  assert.deepEqual(api.calls, [{name: 'assignment_prepare', input: {objective}}]);
  assert.equal(JSON.parse(response.text).received.objective, objective);
  const exact = packetOfSize(1048576);
  assert.equal(Buffer.byteLength(exact), 1048576);
  assert.ok(exact.length < 1048576);
  assert.equal((await exchange(api, Buffer.from(exact))).status, 200);
  assert.equal(api.calls[1].input.objective, JSON.parse(exact).input.objective);
  const over = await exchange(api, Buffer.from(exact + ' '));
  assert.equal(over.status, 413);
  assert.deepEqual(JSON.parse(over.text), {error: 'Request body exceeds limit'});
  assert.equal(api.calls.length, 2);
});

test('malformed JSON, malformed UTF-8, truncation and BOM never invoke a tool', async t => {
  const api = await apiFixture(t);
  const prefix = Buffer.from('{"name":"assignment_prepare","input":{"objective":"');
  const suffix = Buffer.from('"}}');
  for (const bytes of [
    Buffer.alloc(0), Buffer.from('{'), Buffer.from('null'), Buffer.from('\ufeff' + packet('ok')),
    Buffer.concat([prefix, Buffer.from([0x80]), suffix]),
    Buffer.concat([prefix, Buffer.from([0xc0, 0xaf]), suffix]),
    Buffer.concat([prefix, Buffer.from([0xed, 0xa0, 0x80]), suffix]),
    Buffer.concat([prefix, Buffer.from([0xf0, 0x9f])]),
  ]) {
    const response = await exchange(api, bytes);
    assert.equal(response.status, 400, bytes.toString('hex'));
    assert.ok(['Invalid JSON', 'Malformed tool packet', 'Invalid UTF-8 request body'].includes(JSON.parse(response.text).error));
  }
  assert.deepEqual(api.calls, []);
});

test('login keeps the 4096-byte limit, strict decoding and the previous BOM form behavior', async t => {
  const api = await apiFixture(t), prefix = `token=${operator}&note=é&padding=`;
  const exact = Buffer.from(prefix + 'x'.repeat(4096 - Buffer.byteLength(prefix)));
  const options = {route: '/login', headers: {origin: api.url, 'content-type': 'application/x-www-form-urlencoded'}};
  assert.equal((await exchange(api, exact, options)).status, 303);
  assert.equal((await exchange(api, Buffer.concat([exact, Buffer.from('x')]), options)).status, 413);
  assert.equal((await exchange(api, Buffer.from([0x80]), options)).status, 400);
  assert.equal((await exchange(api, Buffer.from(`\ufefftoken=${operator}`), options)).status, 401);
  assert.deepEqual(api.calls, []);
});

test('authentication, Host, Origin, CSRF, content type and viewer authority still gate invocation', async t => {
  const api = await apiFixture(t), bytes = Buffer.from(packet('authorized text'));
  for (const [headers, status] of [
    [{authorization: ''}, 401], [{authorization: 'Bearer wrong'}, 401],
    [{host: 'evil.invalid'}, 403], [{origin: 'https://evil.invalid'}, 403],
    [{'content-type': 'text/plain'}, 415], [{authorization: `Bearer ${viewer}`}, 403],
  ]) {
    assert.equal((await exchange(api, bytes, {headers})).status, status);
  }
  assert.deepEqual(api.calls, []);
  const login = await exchange(api, Buffer.from(`token=${operator}`), {route: '/login', headers: {origin: api.url}});
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const session = await fetch(api.url + '/api/session', {headers: {cookie}, signal: AbortSignal.timeout(3000)}).then(r => r.json());
  const browser = {authorization: '', origin: api.url, cookie};
  assert.equal((await exchange(api, bytes, {headers: browser})).status, 403);
  assert.deepEqual(api.calls, []);
  assert.equal((await exchange(api, bytes, {headers: {...browser, 'x-csrf-token': session.csrf}})).status, 200);
  assert.equal(api.calls.length, 1);
  assert.equal((await exchange(api, Buffer.from('{"name":"observer_snapshot"}'), {headers: {authorization: `Bearer ${viewer}`}})).status, 200);
  const tools = await exchange(api, Buffer.from('{"name":"tools_list"}'), {headers: {authorization: `Bearer ${viewer}`}});
  assert.deepEqual(JSON.parse(tools.text), [{name: 'observer_snapshot'}]);
  assert.equal(api.calls.length, 2);
});

test('a partial client disconnect during a UTF-8 character never invokes a tool', async t => {
  const api = await apiFixture(t), accepted = once(api.server, 'request');
  const request = http.request(api.url + '/api/invoke', {method: 'POST', agent: false, headers: {
    authorization: `Bearer ${operator}`, 'content-type': 'application/json', 'content-length': '1000',
  }});
  request.on('error', () => {});
  request.write(Buffer.concat([Buffer.from('{"name":"assignment_prepare","input":{"objective":"'), Buffer.from([0xe2])]));
  const [incoming] = await accepted;
  const closed = new Promise(resolve => incoming.once('close', resolve));
  request.destroy();
  await closed;
  assert.deepEqual(api.calls, []);
});

test('existing request deadline closes both a stalled body and a stalled oversized drain', {timeout: 40000}, async t => {
  const api = await apiFixture(t);
  async function stall(bytes) {
    const socket = net.connect({host: '127.0.0.1', port: new URL(api.url).port});
    socket.setTimeout(38000, () => socket.destroy(Error('Owned stalled client exceeded deadline')));
    const chunks = [];
    socket.on('data', bytes => chunks.push(bytes));
    const finished = new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    socket.write(`POST /api/invoke HTTP/1.1\r\nHost: ${new URL(api.url).host}\r\nAuthorization: Bearer ${operator}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length + 1}\r\nConnection: close\r\n\r\n`);
    socket.write(bytes);
    return finished;
  }
  const started = Date.now();
  const responses = await Promise.all([stall(Buffer.from('{')), stall(Buffer.alloc(1048577, 65))]);
  for (const response of responses) assert.match(response, /^HTTP\/1\.1 408 Request Timeout\r\n/);
  assert.ok(Date.now() - started < 39000);
  assert.deepEqual(api.calls, []);
});

async function checkoutFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-owner-intake-'));
  const c = new Coordinator({root: path.join(root, 'state'), selectedHost: 'codex'});
  t.after(async () => { c.close(); await rm(root, {recursive: true, force: true}); });
  return {root, c, env: {PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'}};
}
function noExecution(c) {
  assert.deepEqual(c.store.all('task'), []);
  assert.deepEqual(c.store.all('operation'), []);
  assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
  for (const goal of c.store.all('goal')) {
    assert.equal(goal.status, 'draft');
    assert.equal(goal.activatedAt, null);
    assert.equal(goal.deadline, null);
  }
}
function safeIssue(result, code, field, root, guidance) {
  assert.equal(result.status, 'needs_input');
  assert.equal(result.issues.length, 1);
  const issue = result.issues[0];
  assert.deepEqual(Object.keys(issue).sort(), ['code', 'field', 'message']);
  assert.equal(issue.code, code);
  assert.equal(issue.field, field);
  assert.match(issue.message, guidance);
  assert.ok(!issue.message.includes(root));
  assert.doesNotMatch(issue.message, /git\s+(?:add|commit|clean|reset|stash)\b/i);
}

test('unborn checkout guidance offers owner review or a clean committed checkout without changing bytes', async t => {
  const service = await checkoutFixture(t), repo = await repository(service, {committed: false});
  const before = await repositoryBytes(repo.root);
  const result = await prepareAssignment(service.c, assignment(repo), 'unborn');
  assert.deepEqual(await repositoryBytes(repo.root), before);
  safeIssue(result, 'missing_commit', 'project.repo', repo.root, /review.*(?:workflow|clean checkout).*prepare again/i);
  noExecution(service.c);
});
for (const state of ['staged', 'unstaged', 'untracked']) {
  test(`${state} checkout guidance keeps source, index and HEAD bytes while suggesting owner action`, async t => {
    const service = await checkoutFixture(t), repo = await repository(service);
    await writeFile(path.join(repo.root, state === 'untracked' ? 'untracked.txt' : 'src/export.mjs'), 'OWNER_WORK_SENTINEL\n');
    if (state === 'staged') await repo.git('add', 'src/export.mjs');
    const before = await repositoryBytes(repo.root);
    const result = await prepareAssignment(service.c, assignment(repo), state);
    assert.deepEqual(await repositoryBytes(repo.root), before);
    safeIssue(result, 'dirty_repository', 'project.repo', repo.root, /review.*(?:workflow|clean committed checkout).*prepare again/i);
    assert.doesNotMatch(result.issues[0].message, /OWNER_WORK_SENTINEL/);
    noExecution(service.c);
  });
}

test('stale base guidance requires a fresh preparation, while exact replay survives a moved checkout', async t => {
  const service = await checkoutFixture(t), repo = await repository(service), raw = assignment(repo);
  const before = await repositoryBytes(repo.root);
  const prepared = await prepareAssignment(service.c, raw, 'original');
  assert.equal(prepared.status, 'prepared');
  const goal = service.c.store.get('goal', prepared.goalId);
  const canonical = JSON.stringify(goal.manifest, (_, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  assert.equal(prepared.hash, createHash('sha256').update(canonical).digest('hex'));
  assert.deepEqual(await repositoryBytes(repo.root), before);
  t.diagnostic(`Valid original draft/hash reference: ${prepared.hash}`);
  await repo.git('commit', '--allow-empty', '-m', 'Advance owned fixture');
  const advanced = await repositoryBytes(repo.root);
  assert.deepEqual(await prepareAssignment(service.c, raw, 'original'), prepared);
  const stale = {...raw, project: {...raw.project, baseCommit: repo.baseCommit}};
  const result = await prepareAssignment(service.c, stale, 'stale');
  safeIssue(result, 'base_mismatch', 'project.baseCommit', repo.root, /review.*prepare again.*(?:HEAD|baseCommit)/i);
  assert.deepEqual(await repositoryBytes(repo.root), advanced);
  assert.equal(service.c.store.all('goal').length, 1);
  await assert.rejects(prepareAssignment(service.c, stale, 'original'), /idempotency key conflict/i);
  assert.deepEqual(service.c.store.get('goal', prepared.goalId), goal);
  noExecution(service.c);
});
