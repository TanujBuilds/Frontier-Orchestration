import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { summarizeJob, describeEvent, eventKind } from '../src/dashboard.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const visual = process.argv[2] !== 'behavior';
const now = Date.now();
const at = offset => new Date(now + offset).toISOString();
const started = at(-142_000);
const event = (sequence, type, label, data = {}, kind = 'system', time = started) =>
  ({ jobId: id, sequence, at: time, type, label, data, kind });

// The browser view must expose the start of a Mac check, and a job must be
// visible while Codex is still preparing its first plan.
const planning = summarizeJob(id, [event(1, 'project.plan.requested', 'Mac → DeepSeek: plan requested',
  { input: { brief: 'Build the Night Shift dashboard' }, source: 'deepseek-http/unresolved' }, 'deepseek')]);
assert.equal(planning?.status, 'planning', 'Planning must appear as an active job');
const checkStart = event(2, 'operation.started', '', { key: 'v1/interactions/local-1/checks' });
assert.match(describeEvent(checkStart, 'live') ?? '', /check/i, 'Mac check start must be visible');
assert.equal(eventKind(checkStart), 'check', 'Mac check start must be classified as a check');

const stages = [
  { id: 'layout', objective: 'Build the layout', status: 'accepted', localAttempts: 2, codexReviews: 1 },
  { id: 'interactions', objective: 'Add task interactions', status: 'in_progress', localAttempts: 1, codexReviews: 0 },
  { id: 'verify', objective: 'Final verification', status: 'pending', localAttempts: 0, codexReviews: 0 },
];
const baseEvents = [
  event(1, 'stage.accepted', 'Mac saved stage 1', { stageId: 'layout' }, 'workspace', at(-300_000)),
  event(2, 'operation.completed', 'Codex prepared the assignment',
    { key: 'v1/interactions/assignment', value: { instructions: 'Add task interactions' } }, 'codex', at(-150_000)),
  event(3, 'operation.started', 'Coordinator → DeepSeek: add task interactions',
    { key: 'v1/interactions/local-1/response-0', input: { assignment: { instructions: 'Add and filter tasks' } } }, 'deepseek'),
];
const cases = {
  deepseek: { events: baseEvents, status: 'running' },
  waiting: { events: [...baseEvents, event(4, 'provider.waiting', 'Waiting to reconnect to DeepSeek',
    { key: 'v1/interactions/local-1/response-0', reason: 'Connection lost', waitMs: 30_000 }, 'warning', at(-15_000))], status: 'running' },
  checks: { events: [...baseEvents,
    event(4, 'operation.completed', 'DeepSeek submitted changes', { key: 'v1/interactions/local-1/response-0', value: { reply: { type: 'submit_changes', edits: [] } } }, 'deepseek', at(-30_000)),
    event(5, 'operation.started', 'Mac running approved checks', { key: 'v1/interactions/local-1/checks' }, 'check', at(-10_000))], status: 'running' },
  review: { events: [...baseEvents,
    event(4, 'operation.completed', 'DeepSeek submitted changes', { key: 'v1/interactions/local-1/response-0', value: { reply: { type: 'submit_changes', edits: [] } } }, 'deepseek', at(-30_000)),
    event(5, 'operation.completed', 'Mac checks passed', { key: 'v1/interactions/local-1/checks', value: [{ id: 'dashboard', passed: true }] }, 'check', at(-10_000)),
    event(6, 'operation.started', 'Checks passed → Codex review', { key: 'v1/interactions/local-1/review' }, 'codex', at(-8_000))], status: 'running' },
  done: { events: [...baseEvents,
    event(4, 'run.finished', 'Final status: accepted', { status: 'accepted', reason: 'All stages passed' }, 'system', at(-2_000))], status: 'accepted' },
};

let activeCase = cases.deepseek;
const job = () => ({ id, type: 'coding', mode: 'live', title: 'Night Shift dashboard',
  description: 'Make the current worker obvious', status: activeCase.status,
  reason: activeCase.status === 'accepted' ? 'All stages passed' : null,
  updatedAt: activeCase.events.at(-1).at, planVersion: 1, stages: activeCase.status === 'accepted'
    ? stages.map(stage => ({ ...stage, status: 'accepted' })) : stages,
  limits: { attempts: 5, reviewRounds: 2, hours: 8 }, permissions: { readPaths: ['src/dashboard/'], writePaths: ['src/dashboard/'], checks: [] },
});

await mkdir('.overnight-output', { recursive: true });
const browser = await chromium.launch({ headless: true,
  args: ['--single-process', '--no-zygote', '--in-process-gpu', '--disable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://dashboard.invalid') return route.abort();
    if (url.pathname === '/api/jobs') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobs: [job()] }) });
    if (url.pathname === `/api/jobs/${id}`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ job: job(), events: activeCase.events }) });
    const file = { '/': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js' }[url.pathname];
    if (!file) return route.fulfill({ status: 404, body: 'Not found' });
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html';
    return route.fulfill({ contentType: type, body: await readFile(path.join('src/dashboard', file)) });
  });
  const activity = page.getByRole('region', { name: 'Current activity' });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  const load = async (name, expected) => {
    activeCase = cases[name];
    await page.goto('http://dashboard.invalid');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (expected.test(await activity.innerText())) return;
      await page.waitForTimeout(50);
    }
    assert.match(await activity.innerText(), expected, 'Expected activity did not load');
  };

  await load('deepseek', /DeepSeek/i);
  assert.match(await activity.innerText(), /DeepSeek/i);
  assert.match(await activity.innerText(), /working|waiting/i);
  assert.match(await page.locator('body').innerText(), /Stage 2 of 3/i);
  const before = await activity.innerText();
  await page.waitForTimeout(1200);
  assert.notEqual(await activity.innerText(), before, 'Elapsed activity time must update without a new log event');
  assert.ok(await page.locator('details').count(), 'Full saved handoffs must remain inspectable');
  if (visual) {
    assert.equal(await overflow(), false, 'Desktop dashboard must not overflow horizontally');
    await page.screenshot({ path: '.overnight-output/dashboard-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await overflow(), false, 'Mobile dashboard must not overflow horizontally');
    await page.screenshot({ path: '.overnight-output/dashboard-mobile.png', fullPage: true });
  }

  await load('waiting', /connection|reconnect/i);
  assert.match(await activity.innerText(), /connection|reconnect/i, 'Connection wait must be distinct from model work');
  await load('checks', /Mac/i);
  assert.match(await activity.innerText(), /Mac/i);
  assert.match(await activity.innerText(), /check/i);
  await load('review', /Codex/i);
  assert.match(await activity.innerText(), /Codex/i);
  assert.match(await activity.innerText(), /review/i);
  await load('done', /accepted|complete|finished/i);
  assert.match(await activity.innerText(), /accepted|complete|finished/i);
  assert.deepEqual(errors, [], 'Dashboard must not throw browser errors');
  console.log('dashboard: current worker, connection wait, checks, review, completion, desktop and mobile passed');
} finally { await browser.close(); }
