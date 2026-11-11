import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../../src/harness/cli.mjs', import.meta.url));

export async function coordinator(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mosaic-assignment-'));
  const state = path.join(root, 'state');
  const home = path.join(root, 'home');
  const config = path.join(root, 'config.json');
  const bin = path.join(root, 'bin');
  const codexMarker = path.join(root, 'codex-ran');
  const codexPath = path.join(bin, 'codex');
  const providerRequests = [];
  const provider = http.createServer((request, response) => {
    providerRequests.push(`${request.method} ${request.url}`);
    response.writeHead(503).end();
  });
  let child;
  let closed;
  t.after(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await waitForClose(closed, 2000);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      if (closed && !await waitForClose(closed, 2000)) {
        child.stdout.destroy();
        child.stderr.destroy();
        throw Error('Disposable coordinator did not close');
      }
    } finally {
      provider.closeAllConnections();
      if (provider.listening) await new Promise(resolve => provider.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(home);
  await mkdir(bin);
  await writeFile(codexPath, '#!/bin/sh\nprintf attempted > "$MOSAIC_TEST_CODEX_MARKER"\nexit 1\n', { mode: 0o700 });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const env = {
    PATH: `${bin}:${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: root,
    CODEX_HOME: path.join(home, 'codex'),
    MOSAIC_TEST_CODEX_MARKER: codexMarker,
    OPENAI_API_KEY: 'dummy-fixture-key',
    DEEPSEEK_API_KEY: 'dummy-fixture-key',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  await writeFile(config, JSON.stringify({
    deepseekBaseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    deepseekModelId: 'assignment-fixture-model',
    codexPath,
    hostId: 'codex', // Trusted host context for fresh portable preparation.
  }), { mode: 0o600 });
  child = spawn(process.execPath, [cli, 'serve', '--root', state, '--config', config, '--port', '0'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = new Promise(resolve => child.once('close', resolve));
  const { url, token } = await readyConnection(child, state);
  assert.equal(new URL(url).hostname, '127.0.0.1');

  async function request(name, input, auth = token) {
    const response = await fetch(`${url}/api/invoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, input }),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function call(name, input = {}) {
    const result = await request(name, input);
    assert.equal(result.status, 200, `${name} returned ${JSON.stringify(result.body)}`);
    return result.body;
  }
  function savedRequestCount() {
    const db = new DatabaseSync(path.join(state, 'harness.sqlite3'), { readOnly: true });
    try { return db.prepare('SELECT COUNT(*) AS count FROM requests').get().count; }
    finally { db.close(); }
  }
  return { root, state, env, request, call, providerRequests, cli, codexMarker, savedRequestCount };
}

async function readyConnection(child, state) {
  await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(Error(`Coordinator did not become ready: ${stderr}`)), 5000);
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.on('data', data => {
      stdout += data;
      if (!stdout.includes('\n')) return;
      clearTimeout(timeout);
      try {
        assert.equal(JSON.parse(stdout.split('\n')[0]).status, 'ready');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); reject(Error(`Coordinator exited (${code}): ${stderr}`)); });
  });
  return JSON.parse(await readFile(path.join(state, 'connection.json'), 'utf8'));
}

async function waitForClose(closed, timeoutMs) {
  const timeout = new AbortController();
  try {
    return await Promise.race([closed.then(() => true), delay(timeoutMs, false, { signal: timeout.signal })]);
  } finally {
    timeout.abort();
  }
}
