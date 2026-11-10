#!/usr/bin/env node
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {identifier} from '../src/harness/contracts.mjs';
import {isEntry} from '../src/harness/entry.mjs';

const exec = promisify(execFile);
const harnessCli = fileURLToPath(new URL('../src/harness/cli.mjs', import.meta.url));
const usage = `Mosaic research missions

demo --output NEW_TEMP_DIRECTORY
inspect --root STATE_DIR --task ID [--candidate HASH] [--offset N] [--limit N]
export --root STATE_DIR --task ID --format json|markdown [--candidate HASH] [--offset N] [--limit N]
`;

export async function main(args = process.argv.slice(2)) {
  const [action, ...options] = args;
  if (!action || (args.length === 1 && action === '--help')) {
    process.stdout.write(usage);
    return;
  }
  const reads = ['root', 'task', 'candidate', 'offset', 'limit'];
  const allowed = new Map([['demo', ['output']], ['inspect', reads], ['export', [...reads, 'format']]]);
  if (!allowed.has(action)) throw Error('Use demo, inspect or export');
  const flags = new Map();
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (!option.startsWith('--') || !allowed.get(action).includes(option.slice(2)) ||
        !value || value.startsWith('--') || flags.has(option.slice(2))) {
      throw Error('Invalid or duplicate mission option');
    }
    flags.set(option.slice(2), value);
  }
  if (action === 'demo') {
    if (!flags.has('output')) throw Error('Provide --output NEW_TEMP_DIRECTORY');
    const {runFixtureMission} = await import('../src/harness/research-missions/fixture.mjs');
    const result = await runFixtureMission(flags.get('output'));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (!flags.has('root') || !flags.has('task')) throw Error('Provide --root STATE_DIR and --task ID');
  const input = {taskId: identifier(flags.get('task'), 'task ID')};
  for (const name of ['offset', 'limit']) {
    if (!flags.has(name)) continue;
    const raw = flags.get(name);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw Error('Invalid --' + name);
    input[name] = Number(raw);
  }
  if (flags.has('candidate')) {
    const hash = flags.get('candidate');
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid --candidate');
    input.candidateHash = hash;
  }
  if (action === 'export') {
    input.format = flags.get('format');
    if (!['json', 'markdown'].includes(input.format)) throw Error('Provide --format json or markdown');
  }
  // Call through the existing authenticated harness CLI. Read commands never
  // construct a Coordinator or fall back to opening the state database.
  let stdout;
  try {
    ({stdout} = await exec(process.execPath, [
      harnessCli, 'call', '--root', flags.get('root'), '--tool', 'research_mission_' + action,
      '--input-json', JSON.stringify(input),
    ], {timeout: 38_000, maxBuffer: 2 * 1024 * 1024}));
  } catch (error) {
    throw Error(error.stderr?.trim() || 'Coordinator inspection failed');
  }
  const result = JSON.parse(stdout);
  if (input.format === 'markdown') {
    if (result.format !== 'markdown' || typeof result.content !== 'string') throw Error('Invalid Markdown export');
    process.stdout.write(result.content);
  } else {
    process.stdout.write(stdout);
  }
}

if (isEntry(import.meta.url)) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
