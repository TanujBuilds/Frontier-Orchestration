import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import './build.mjs';

const mode = process.argv[2];
assert.ok(['layout', 'interactions', 'persistence', 'final'].includes(mode));
await mkdir('.overnight-output', { recursive: true });
// Every request is fulfilled from dist in memory; no HTTP server or network grant.
// Keep Chromium inside one OS-sandboxed process; no Mach rendezvous grant is needed.
const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote', '--in-process-gpu', '--disable-gpu'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://pilot.invalid') return route.abort();
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve('dist', `.${relative}`);
    if (!file.startsWith(`${path.resolve('dist')}${path.sep}`)) return route.abort();
    try {
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      await route.fulfill({ body: await readFile(file), contentType: types[path.extname(file)] ?? 'application/octet-stream' });
    } catch { await route.fulfill({ status: 404, body: 'Not found' }); }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://pilot.invalid');
  await page.getByRole('heading', { name: 'Night Shift', exact: true, level: 1 }).waitFor();
  await page.getByRole('textbox', { name: 'New task', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add task', exact: true }).waitFor();
  for (const name of ['All', 'Active', 'Completed']) await page.getByRole('button', { name, exact: true }).waitFor();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(await overflow(), false, 'Desktop must not overflow horizontally');
  if (mode !== 'layout') {
    const input = page.getByRole('textbox', { name: 'New task', exact: true });
    await input.fill('Write release notes');
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    const done = page.getByRole('checkbox', { name: 'Write release notes', exact: true });
    await done.waitFor();
    assert.equal(await input.inputValue(), '', 'Adding clears the input');
    const count = await page.getByRole('checkbox').count();
    await input.fill('   ');
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    assert.equal(await page.getByRole('checkbox').count(), count, 'Blank tasks are rejected');
    await done.check();
    await page.getByRole('button', { name: 'Active', exact: true }).click();
    assert.equal(await done.count(), 0, 'Completed item hidden by Active');
    await page.getByRole('button', { name: 'Completed', exact: true }).click();
    assert.equal(await done.isChecked(), true);
    if (mode === 'persistence' || mode === 'final') {
      await page.reload();
      await page.getByRole('button', { name: 'All', exact: true }).click();
      assert.equal(await done.isChecked(), true, 'Task and completion persist after reload');
      await input.focus();
      await input.fill('Keyboard task');
      await input.press('Enter');
      await page.getByRole('checkbox', { name: 'Keyboard task', exact: true }).waitFor();
      await done.focus();
      await done.press('Space');
      assert.equal(await done.isChecked(), false, 'Checkbox works with keyboard');
      assert.equal(await page.locator('main').count(), 1);
      assert.ok(await page.locator('[aria-live]').count(), 'Task status announced in a live region');
    }
  }
  await page.screenshot({ path: `.overnight-output/${mode}-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await overflow(), false, 'Mobile must not overflow horizontally');
  await page.screenshot({ path: `.overnight-output/${mode}-mobile.png`, fullPage: true });
  if (mode === 'persistence' || mode === 'final') {
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) localStorage.setItem(key, '{invalid saved data');
    });
    await page.reload();
    await page.getByRole('heading', { name: 'Night Shift', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'New task', exact: true }).waitFor();
  }
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log(`${mode}: behavior, desktop and mobile checks passed`);
} finally { await browser.close(); }
