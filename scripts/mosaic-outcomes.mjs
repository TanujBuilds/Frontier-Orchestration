import {constants} from 'node:fs';
import {access, mkdtemp, open, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {readOutcomeSnapshot} from '../src/harness/outcomes/snapshot.mjs';
import {summarizeOutcomes} from '../src/harness/outcomes/aggregate.mjs';
import {renderOutcomeMarkdown} from '../src/harness/outcomes/render.mjs';

const usage = `Usage: node scripts/mosaic-outcomes.mjs report --state-root <path>
       [--goal <id>] [--project <key>] [--from <UTC ISO>] [--to <UTC ISO>]
       [--limit <1-500>] [--cursor <cursor>] [--format json|markdown]
       node scripts/mosaic-outcomes.mjs demo --output <existing-directory>`;
const json = value => JSON.stringify(value, null, 2) + '\n';

async function demo(output) {
  if (!output || !(await stat(output)).isDirectory()) throw Error('--output must name an existing directory');
  const outputs = ['outcomes.json', 'outcomes.md'].map(name => path.join(output, name));
  for (const file of outputs) {
    try { await access(file, constants.F_OK); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw Error('Demo output already exists; choose a new output directory');
  }
  const root = await mkdtemp(path.join(tmpdir(), 'mosaic-outcomes-demo-'));
  try {
    const {createOutcomeDemo} = await import('../src/harness/outcomes/demo.mjs');
    const fixture = await createOutcomeDemo(root);
    const report = summarizeOutcomes(readOutcomeSnapshot(fixture));
    const contents = [json(report), renderOutcomeMarkdown(report)];
    const created = [];
    try {
      for (const [index, file] of outputs.entries()) {
        const handle = await open(file, 'wx', 0o600);
        created.push(file);
        try { await handle.writeFile(contents[index]); }
        finally { await handle.close(); }
      }
    } catch (error) {
      await Promise.all(created.map(file => rm(file, {force: true})));
      throw error;
    }
    process.stdout.write(json({fixture: true, goalId: fixture.goalId, files: outputs}));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

async function main([action, ...args]) {
  if (!action || action === '--help') {
    process.stdout.write(usage + '\n');
    return;
  }
  if (action === 'demo') {
    const {values} = parseArgs({args, options: {output: {type: 'string'}}});
    await demo(values.output);
    return;
  }
  if (action !== 'report') throw Error(usage);
  const string = {type: 'string'};
  const {values} = parseArgs({args, options: {
    'state-root': string, goal: string, project: string, format: string,
    from: string, to: string, limit: string, cursor: string,
  }});
  const {'state-root': stateRoot, goal: goalId, project: projectKey, format = 'json', from, to, limit, cursor} = values;
  if (!stateRoot) throw Error('--state-root is required');
  if (!['json', 'markdown'].includes(format)) throw Error('--format must be json or markdown');
  if (limit !== undefined && !/^\d{1,3}$/.test(limit)) throw Error('--limit must be an integer from 1 to 500');
  const report = summarizeOutcomes(readOutcomeSnapshot({
    stateRoot, goalId, projectKey, from, to, limit: limit === undefined ? undefined : Number(limit), cursor,
  }));
  process.stdout.write(format === 'json' ? json(report) : renderOutcomeMarkdown(report));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write('mosaic-outcomes: ' + error.message + '\n');
  process.exitCode = 1;
}
