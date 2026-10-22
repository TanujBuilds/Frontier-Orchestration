import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Journal, atomicJson } from './journal.mjs';
import { DEFAULT_LIMITS, digest, validatePermissions, validatePlan, text } from './contracts.mjs';
import { inspectRepository, Workspace } from './workspace.mjs';
import { summarize } from './runner.mjs';

// Zero-model plan: one implementation stage followed by final verification. Use it when the
// brief is already broken down by hand and no planning call is worth paying for.
export function templatePlan(permissions) {
  const checks = permissions.checks.map(check => check.id);
  const common = { writePaths: permissions.writePaths, checks, acceptance: ['Every approved check passes'] };
  return {
    summary: 'Template plan: implement the brief, then run final verification',
    stages: [
      { ...common, id: 'implementation', kind: 'implementation', objective: 'Implement the brief inside the approved write paths', deliverable: 'Edited source files' },
      { ...common, id: 'verification', kind: 'verification', objective: 'Verify the finished work and repair only what a failing check justifies', deliverable: 'Final check evidence' },
    ],
  };
}
export const templatePlanner = { identity: 'template-plan', planProject: async ({ permissions }) => templatePlan(permissions) };

async function requestPlan({ journal, planner, input, permissions, signal, planVersion }) {
  let lastError;
  // An explicit Codex plan is a single call, including malformed responses.
  const planAttempts = planner.usageKind === 'codex' ? 1 : 3;
  for (let attempt = 1; attempt <= planAttempts; attempt++) {
    await journal.append('project.plan.requested', { source: planner.identity ?? 'planner', input: { ...input, attempt }, ...(planVersion ? { planVersion } : {}) });
    const started = Date.now();
    try {
      const output = await planner.planProject({ ...input, permissions, attempt }, signal);
      if (planner.usageKind === 'codex') await journal.append('frontier.call', { kind: 'plan', key: `plan/v${planVersion ?? 1}/attempt-${attempt}`, durationMs: Date.now() - started, decision: 'returned' });
      if (output?.protocolError) throw new Error(output.protocolError);
      return validatePlan(output?.plan ?? output, permissions);
    } catch (error) {
      if (planner.usageKind === 'codex' && !journal.events.some(event => event.type === 'frontier.call' && event.data.key === `plan/v${planVersion ?? 1}/attempt-${attempt}`)) {
        await journal.append('frontier.call', { kind: 'plan', key: `plan/v${planVersion ?? 1}/attempt-${attempt}`, durationMs: Date.now() - started, decision: 'error' });
      }
      lastError = error;
      await journal.append('project.plan.failed', { reason: error.message, attempt });
      // Only a locally recoverable planning error is worth another local call.
      if (error instanceof Error && !/plan|JSON|truncated|stages|write|check|acceptance|stream disconnected|ECONN|HTTP (?:408|429|5\d\d)/i.test(error.message)) throw error;
    }
  }
  throw lastError;
}
export async function createProject({ root, repo, brief, permissions, planner, hours = 8, mode = 'live', signal }) {
  text(brief, 'brief'); validatePermissions(permissions);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error('Job hours must be greater than 0 and no more than 24');
  const inspected = await inspectRepository(repo, permissions);
  const journal = await new Journal(root, randomUUID()).load();
  const input = { brief, permissions, source: inspected.context };
  let plan;
  try { plan = await requestPlan({ journal, planner, input, permissions, signal }); }
  catch (error) {
    error.jobId = journal.id;
    throw error;
  }
  const manifest = {
    schemaVersion: 1, planVersion: 1, mode, brief, repo: inspected.repo, baseCommit: inspected.baseCommit,
    permissions, plan, limits: { ...DEFAULT_LIMITS, hours },
    initialContext: inspected.context.map(({ path, hash }) => ({ path, hash })),
  };
  await journal.append('project.created', manifest);
  return { ...summarize(journal), manifest };
}
export async function approveProject(journal, hash) {
  const release = await journal.lock();
  try {
    const manifest = journal.last('project.created');
    if (!manifest || hash !== digest(manifest)) throw new Error('Approval hash does not match the current plan and permissions');
    if (journal.last('project.approved')?.hash !== hash) await journal.append('project.approved', { hash, planVersion: manifest.planVersion });
    return summarize(journal);
  } finally { await release(); }
}
export async function guideStage({ journal, stageId, frontier, signal }) {
  const release = await journal.lock();
  try {
    const manifest = journal.last('project.created');
    if (!manifest || journal.last('project.approved')?.hash !== digest(manifest)) throw new Error('Approve the exact plan before requesting guidance');
    const index = manifest.plan.stages.findIndex(stage => stage.id === stageId);
    if (index < 0) throw new Error('Unknown stage ID');
    const accepted = new Set(journal.events.filter(event => event.type === 'stage.accepted').map(event => event.data.stageId));
    if (accepted.has(stageId) || manifest.plan.stages.slice(0, index).some(stage => !accepted.has(stage.id))) throw new Error('Guidance is available only for the next unfinished stage');
    if (journal.events.some(event => event.type === 'attempt.started' && event.data.stageId === stageId)) throw new Error('Pre-stage guidance must be requested before the first attempt');
    if (journal.events.some(event => event.type === 'frontier.call' && event.data.kind === 'guidance' && event.data.stageId === stageId)) throw new Error('This stage has already used its one guidance call');
    const input = { brief: manifest.brief, approvedPlan: manifest.plan, stage: manifest.plan.stages[index],
      acceptedStages: manifest.plan.stages.slice(0, index), permissions: manifest.permissions };
    const started = Date.now();
    let output;
    try { output = await frontier.guideStage(input, signal); }
    catch (error) {
      await journal.append('frontier.call', { kind: 'guidance', stageId, durationMs: Date.now() - started, decision: 'error' });
      throw error;
    }
    await journal.append('frontier.call', { kind: 'guidance', stageId, durationMs: Date.now() - started, decision: 'returned' });
    if (typeof output?.guidance !== 'string' || !output.guidance.trim() || output.guidance.length > 8000) throw new Error('Codex returned invalid stage guidance');
    await journal.append('stage.guidance', { stageId, guidance: output.guidance });
    return { ...summarize(journal), guidance: output.guidance };
  } finally { await release(); }
}
export async function reviseProject({ journal, brief, permissions, planner, signal }) {
  const release = await journal.lock();
  try {
    const previous = journal.last('project.created');
    if (!previous) throw new Error('Project job not found');
    if (journal.last('run.finished')?.status === 'accepted') throw new Error('Completed jobs are immutable; create a new job');
    text(brief, 'brief'); validatePermissions(permissions);
    let source;
    if (journal.last('workspace.created')) {
      const workspace = new Workspace({ ...previous, permissions }, journal);
      await workspace.recover();
      source = await workspace.readFiles((await workspace.inventory()).map(file => file.path));
    } else source = (await inspectRepository(previous.repo, permissions)).context;
    const acceptedIds = new Set(journal.events.filter(e => e.type === 'stage.accepted' || (e.type === 'attempt.finished' && e.data.accepted)).map(e => e.data.stageId));
    const acceptedStages = previous.plan.stages.filter(stage => acceptedIds.has(stage.id));
    const input = { brief, permissions, source, previousPlan: previous.plan, acceptedStages,
      instruction: 'Preserve accepted stages exactly as the ordered prefix. Refine only unfinished stages. Existing attempt limits remain in effect.' };
    const plan = await requestPlan({ journal, planner, input, permissions, signal, planVersion: previous.planVersion + 1 });
    if (acceptedStages.some((stage, index) => digest(stage) !== digest(plan.stages[index]))) throw new Error('Revised plan must preserve accepted stages exactly');
    // Existing stage IDs retain their consumed attempts; new IDs cannot reset an active stage.
    if (plan.stages.length !== previous.plan.stages.length || plan.stages.some((stage, index) => stage.id !== previous.plan.stages[index].id)) throw new Error('Revisions retain stage IDs and order; use a new job for a different stage structure');
    const manifest = { ...previous, brief, permissions, plan, planVersion: previous.planVersion + 1,
      initialContext: source.map(({ path, hash }) => ({ path, hash })) };
    await journal.append('project.created', manifest);
    return { ...summarize(journal), manifest };
  } finally { await release(); }
}
export async function prepareResume(journal, extendHours, extendAttempts) {
  const release = await journal.lock();
  try {
    if (extendHours !== undefined) {
      if (!Number.isFinite(extendHours) || extendHours <= 0 || extendHours > 24) throw new Error('Extension must be greater than 0 and no more than 24 hours');
      const previous = journal.last('budget.extended')?.deadline ?? journal.last('budget.started')?.deadline;
      if (!previous) throw new Error('Job has not started');
      await journal.append('budget.extended', { hours: extendHours, deadline: Math.max(Date.now(), previous) + extendHours * 3600_000 });
    }
    if (extendAttempts !== undefined) {
      if (!Number.isInteger(extendAttempts) || extendAttempts <= 0 || extendAttempts > 20) throw new Error('Attempt extension must be an integer from 1 to 20');
      const previous = journal.last('attempts.extended')?.attempts ?? journal.last('project.created').limits.attempts;
      await journal.append('attempts.extended', { attempts: previous + extendAttempts });
    }
    try { await unlink(path.join(journal.dir, 'stop.request')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await journal.append('resume.requested');
  } finally { await release(); }
}
export async function stopProject(journal) {
  await atomicJson(path.join(journal.dir, 'stop.request'), { at: new Date().toISOString() });
  return { jobId: journal.id, status: 'stop_requested' };
}
export async function projectStatus(journal) {
  const result = summarize(journal);
  if (result.status === 'running') {
    let lock;
    try {
      lock = JSON.parse(await readFile(path.join(journal.dir, 'lock.json'), 'utf8'));
      process.kill(lock.pid, 0);
      result.pid = lock.pid;
    } catch (error) {
      if (error.code === 'EPERM' && Number.isInteger(lock?.pid)) result.pid = lock.pid;
      else {
        result.status = 'interrupted';
        result.reason = 'Runner is no longer active; resume from its recorded operations';
      }
    }
  }
  return result;
}
