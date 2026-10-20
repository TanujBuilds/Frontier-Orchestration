// Real worktree, HTTP adapter, edits, sandbox, checks, screenshots and commits;
// scripted planner/worker/reviewer. This does not satisfy the live model release gate.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createProject, approveProject } from '../src/project/service.mjs';
import { Journal } from '../src/project/journal.mjs';
import { ProjectLocal } from '../src/project/providers.mjs';
import { runProject } from '../src/project/runner.mjs';
import { pilotSource, pilotCss } from './fixtures/pilot-source.mjs';
const repo = process.argv[2];
if (!repo) throw new Error('Usage: node scripts/verify-pilot.mjs <prepared-pilot-repo>');
const permissions = JSON.parse(await readFile(new URL('../examples/overnight-permissions.json', import.meta.url), 'utf8'));
const stages = ['layout', 'interactions', 'persistence', 'final'].map((id, index) => ({ id,
  kind: index === 3 ? 'verification' : 'implementation', objective: `SCRIPTED ${id} verification`, deliverable: `${id} evidence`,
  writePaths: ['src/'], acceptance: ['Protected behavior checks and screenshot capture pass'], checks: index === 3 ? permissions.checks.map(c => c.id) : [id],
}));
const frontier = {
  identity: 'SCRIPTED-frontier', planProject: async () => ({ summary: 'Offline scripted web UI integration exercise', stages }),
  assign: async ({ stage }) => ({ instructions: stage.objective, needsApproval: false }),
  reviewCode: async ({ evidence }) => ({ decision: evidence.checks.every(c => c.passed) ? 'accept' : 'revise', feedback: 'SCRIPTED review of check outcomes only', unverified: ['No real Codex judgment or DeepSeek implementation in this exercise'] }),
  rescue: async () => { throw new Error('Unexpected rescue in scripted pilot'); },
};
let malformedSent = false;
const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'SCRIPTED-worker' }] }));
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages[1].content);
  let reply;
  if (!malformedSent) { malformedSent = true; reply = 'deliberately malformed first answer'; }
  else if (input.stage.id === 'final') reply = { type: 'submit_changes', paths: [], edits: [], summary: 'Verification only' };
  else if (!input.context.length) reply = { type: 'read_files', paths: ['src/main.tsx', 'src/style.css'], edits: [], summary: 'Read current hashes' };
  else reply = { type: 'submit_changes', paths: [], summary: 'SCRIPTED fixture edit', edits: input.context[0].files.map(file => ({
    path: file.path, action: 'write', baseHash: file.hash, content: file.path.endsWith('.css') ? pilotCss : pilotSource(stages.findIndex(stage => stage.id === input.stage.id) + 1),
  })) };
  res.end(JSON.stringify({ model: 'SCRIPTED-worker', choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) }, finish_reason: 'stop' }], usage: { total_tokens: 0 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const root = path.resolve('.data');
  const created = await createProject({ root, repo, brief: 'Offline scripted UI test; not a live model result', permissions, frontier, mode: 'scripted' });
  const journal = await new Journal(root, created.jobId).load();
  await approveProject(journal, created.planHash); // This script explicitly authorizes only the disposable test fixture.
  const result = await runProject(journal, { frontier, local: new ProjectLocal({ baseUrl: `http://127.0.0.1:${server.address().port}/v1` }), keepAwake: false });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'accepted') process.exitCode = 1;
} finally { server.close(); }
