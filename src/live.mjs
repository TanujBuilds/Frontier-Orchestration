import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexCliAdapter } from './adapters/codex-cli.mjs';
import { DeepSeekHttpAdapter } from './adapters/deepseek-http.mjs';
import { FakeFrontier, FakeLocal } from './adapters/fake.mjs';
import { runJob } from './coordinator.mjs';
import { JsonlJobStore } from './store.mjs';
import { exitCodeFor, printEvent, printFinal, promptForApproval } from './terminal.mjs';

function parseArgs(args) {
  let briefPath;
  let fake = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--brief' && args[index + 1]) briefPath = args[++index];
    else if (args[index] === '--fake') fake = true;
    else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
  if (!briefPath) throw new Error('Usage: npm run live -- --brief <file> [--fake]');
  return { briefPath, fake };
}

async function main() {
  const { briefPath, fake } = parseArgs(process.argv.slice(2));
  const goal = (await readFile(briefPath, 'utf8')).trim();
  if (!goal) throw new Error('Brief file is empty');
  const frontier = fake ? new FakeFrontier() : new CodexCliAdapter({ model: process.env.FRONTIER_MODEL_ID || undefined });
  const local = fake ? new FakeLocal() : new DeepSeekHttpAdapter({ baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL_ID || undefined });
  const store = new JsonlJobStore(path.resolve('.data/jobs'));
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  if (fake) process.stdout.write('FAKE MODE — no model calls or checks will run.\n');
  try {
    const outcome = await runJob({
      goal, frontier, local, store, signal: controller.signal,
      approvePlan: (plan, { signal }) => promptForApproval(plan, { signal, source: frontier.identity ?? 'fake frontier' }),
      onEvent: (event) => printEvent(event),
    });
    printFinal(outcome, path.resolve(`.data/jobs/${outcome.jobId}.jsonl`));
    process.exitCode = exitCodeFor(outcome.status);
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
}

main().catch((error) => {
  console.error(`Cannot start live job: ${error.message}`);
  process.exitCode = 1;
});
