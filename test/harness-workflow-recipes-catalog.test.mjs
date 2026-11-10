import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import test from 'node:test';

test('the packaged catalog contains every canonical JSON definition in filename order', async () => {
  const directory = new URL('../src/harness/workflow-recipes/definitions/', import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith('.json')).sort();
  const definitions = await Promise.all(files.map(async file => JSON.parse(
    await readFile(new URL(file, directory), 'utf8')
  )));
  const {builtins} = await import('../src/harness/workflow-recipes/catalog.mjs');
  assert.deepEqual(builtins, definitions);
});
