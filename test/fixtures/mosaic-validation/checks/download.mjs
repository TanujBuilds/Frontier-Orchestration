import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import './build.mjs';

const origin = 'http://csv-fixture.invalid';
const assets = new Map([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/csv.mjs', { file: 'csv.mjs', contentType: 'application/javascript' }],
  ['/export.mjs', { file: 'export.mjs', contentType: 'application/javascript' }],
]);
// Serve the exact built files through Playwright so the existing network-denied sandbox works.
const browser = await chromium.launch({
  headless: true,
  timeout: 10000,
  // Chromium on macOS uses its own temporary-directory variable for downloads.
  env: { ...process.env, MAC_CHROMIUM_TMPDIR: tmpdir() },
  args: ['--single-process', '--no-zygote', '--in-process-gpu', '--disable-gpu'],
});
try {
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const asset = url.origin === origin && assets.get(url.pathname);
    if (!asset) return route.abort();
    await route.fulfill({ body: await readFile(`dist/${asset.file}`), contentType: asset.contentType });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(origin);
  await page.getByRole('checkbox', { name: 'North, West', exact: true }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV', exact: true }).click(),
  ]);
  assert.equal(download.suggestedFilename(), 'sales.csv');
  const stream = await download.createReadStream();
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    assert.ok(size <= 4096, 'download exceeded the fixture byte limit');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  assert.deepEqual(bytes, Buffer.from('name,total\r\n"North, West",12.50\r\n'), 'downloads selected rows only');
  console.log(`Downloaded sales.csv (${bytes.length} bytes, sha256=${createHash('sha256').update(bytes).digest('hex')})`);
} finally {
  await browser.close();
}
