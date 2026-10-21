import { access, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { digest, validateReply, Pause, AttemptError } from './contracts.mjs';
import { Workspace } from './workspace.mjs';
import { CheckRunner } from './sandbox.mjs';
import { transient, providerFailure } from './providers.mjs';

export function summarize(journal) {
  const manifest = journal.last('project.created');
  if (!manifest) throw new Error('Not a project job');
  const last = journal.events.findLast(event => ['run.started', 'run.finished'].includes(event.type));
  const stages = manifest.plan.stages.map(stage => {
    const accepted = journal.events.findLast(event => event.type === 'stage.accepted' && event.data.stageId === stage.id)?.data;
    const attempts = journal.events.filter(event => event.type === 'attempt.started' && event.data.stageId === stage.id);
    const latest = journal.events.findLast(event => event.type === 'attempt.finished' && event.data.stageId === stage.id)?.data;
    return { id: stage.id, objective: stage.objective, status: accepted ? 'accepted' : attempts.length ? 'unfinished' : 'pending',
      localAttempts: attempts.filter(event => event.data.role === 'local').length,
      codexRescues: attempts.filter(event => event.data.role === 'rescue').length,
      checkpoint: accepted?.commit ?? null, lastFeedback: latest?.feedback ?? null,
      checks: latest?.checks ?? [], unverified: latest?.unverified ?? [] };
  });
  return {
    jobId: journal.id, mode: manifest.mode, status: journal.last('project.approved')?.hash !== digest(manifest) ? 'awaiting_approval' : last?.type === 'run.started' ? 'running' : last?.data.status ?? 'approved',
    reason: last?.data.reason ?? null, planHash: digest(manifest), planVersion: manifest.planVersion,
    branch: `codex/overnight-${journal.id}`, worktree: path.join(journal.dir, 'worktree'),
    deadline: journal.last('budget.extended')?.deadline ?? journal.last('budget.started')?.deadline ?? null,
    budgetStartedAt: journal.events.find(event => event.type === 'budget.started')?.at ?? null,
    reportedLocalTokens: journal.events.filter(event => event.type === 'operation.completed')
      .reduce((total, event) => total + (Number(event.data.value?.usage?.total_tokens) || 0), 0),
    stages, eventFile: journal.file, report: path.join(journal.dir, 'report.md'),
  };
}
export async function writeReport(journal) {
  const report = summarize(journal);
  const lines = [
    `# Overnight job ${report.jobId}`, '', `Status: **${report.status}**`, `Provider mode: **${report.mode}**`, '',
    report.reason ? `Reason: ${report.reason}` : '',
    `Branch: ${report.branch}`, `Worktree: ${report.worktree}`, `Events: ${report.eventFile}`, '',
    `Deadline: ${report.deadline ? new Date(report.deadline).toISOString() : 'not started'}`,
    `Reported local tokens: ${report.reportedLocalTokens} (only when the provider supplies usage; Codex CLI usage is not estimated)`, '',
    '| Stage | Status | DeepSeek attempts | Codex rescues | Checkpoint |',
    '| --- | --- | ---: | ---: | --- |',
    ...report.stages.map(stage => `| ${stage.id} | ${stage.status} | ${stage.localAttempts} | ${stage.codexRescues} | ${stage.checkpoint ?? '—'} |`),
    '', '## Latest review limits',
    ...(report.stages.findLast(stage => stage.lastFeedback)?.unverified.length
      ? report.stages.findLast(stage => stage.lastFeedback).unverified.map(item => `- ${item}`)
      : ['- None recorded by the latest review.']),
    '',
    ...report.stages.flatMap(stage => [`## ${stage.id}`, stage.objective, stage.lastFeedback ?? '',
      ...stage.checks.map(check => `- ${check.id}: ${check.passed ? 'passed' : 'failed'}`),
      ...stage.unverified.map(item => `- At this stage review, unverified: ${item}`), '']),
  ];
  await writeFile(report.report, lines.join('\n'), { mode: 0o600 });
  return report;
}

export async function runProject(journal, {
  frontier, local, workspace, checks, signal, now = Date.now,
  sleep = (ms, signal) => delay(ms, undefined, { signal }), keepAwake = true,
} = {}) {
  const release = await journal.lock();
  let timer, stopPoll, awake;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let stopReason;
  try {
    const manifest = journal.last('project.created');
    if (!manifest || journal.last('project.approved')?.hash !== digest(manifest)) throw new Pause('Approve the exact plan and permissions before running', 'approval');
    if (journal.last('run.finished')?.status === 'accepted') return await writeReport(journal);
    workspace ??= new Workspace(manifest, journal);
    checks ??= new CheckRunner(workspace);
    const firstBudget = journal.last('budget.started');
    if (!firstBudget) await journal.append('budget.started', { deadline: now() + manifest.limits.hours * 3600_000 });
    const deadline = journal.last('budget.extended')?.deadline ?? journal.last('budget.started').deadline;
    const guard = () => {
      if (now() >= deadline) throw new Pause('Eight-hour/job time budget exhausted; extend it explicitly to continue', 'budget');
      if (controller.signal.aborted) throw new Pause(stopReason ?? 'Stopped by user; progress is saved', 'stopped');
    };
    guard();
    try { await access(path.join(journal.dir, 'stop.request')); throw new Pause('Stopped by user; use resume to continue', 'stopped'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    timer = setTimeout(() => { stopReason = 'Job time budget exhausted'; cancel(); }, Math.min(deadline - now(), 2_147_483_647));
    stopPoll = setInterval(async () => {
      try { await access(path.join(journal.dir, 'stop.request')); stopReason = 'Stopped by user'; cancel(); } catch {}
    }, 500);
    await journal.append('run.started');
    if (keepAwake && process.platform === 'darwin') {
      awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      awake.on('error', () => {});
    }
    await workspace.initialize();
    await workspace.recover();
    guard();
    await journal.append('sandbox.verified', await checks.verify(controller.signal));

    const provider = async (key, action, input) => journal.memo(key, async () => {
      const resumeSequence = journal.events.findLast(event => event.type === 'resume.requested')?.sequence ?? 0;
      let outageStart = journal.events.findLast(event => event.type === 'provider.waiting' && event.data.key === key && event.sequence > resumeSequence)?.data.outageStart;
      let failures = 0;
      while (true) {
        guard();
        if (outageStart !== undefined && now() - outageStart >= manifest.limits.reconnectMs) throw new Pause('Provider reconnection window exhausted; resume after reconnecting', 'connection');
        const callStarted = now();
        const remaining = outageStart === undefined ? manifest.limits.reconnectMs : manifest.limits.reconnectMs - (now() - outageStart);
        const callSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, remaining))]);
        try { return await action(callSignal); }
        catch (error) {
          guard();
          if (outageStart !== undefined && now() - outageStart >= manifest.limits.reconnectMs) throw new Pause('Provider reconnection window exhausted; resume after reconnecting', 'connection');
          if (error instanceof AttemptError || error instanceof Pause) throw error;
          if (!transient(error)) throw providerFailure(error);
          outageStart ??= callStarted;
          if (now() - outageStart >= manifest.limits.reconnectMs) throw new Pause('Provider unavailable for 30 minutes; resume after reconnecting', 'connection');
          const waitMs = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5), manifest.limits.reconnectMs - (now() - outageStart), deadline - now());
          await journal.append('provider.waiting', { key, reason: error.message, waitMs, outageStart });
          await sleep(waitMs, controller.signal);
        }
      }
    }, input);

    for (const stage of manifest.plan.stages) {
      if (journal.events.some(event => event.type === 'stage.accepted' && event.data.stageId === stage.id)) continue;
      guard();
      await workspace.assertSnapshot();
      const inventory = await workspace.inventory();
      const source = await workspace.readFiles(inventory.map(file => file.path));
      const input = { brief: manifest.brief, plan: manifest.plan, stage, source, acceptedStages: summarize(journal).stages.filter(item => item.status === 'accepted') };
      const assignment = await provider(`v${manifest.planVersion}/${stage.id}/assignment`, s => frontier.assign(input, s), input);
      if (assignment.needsApproval) throw new Pause(assignment.instructions, 'scope');
      if (typeof assignment.instructions !== 'string' || !assignment.instructions.trim()) throw new Pause('Invalid frontier stage assignment', 'provider');

      let accepted = false;
      for (let number = 1; number <= manifest.limits.attempts + 1; number++) {
        const role = number > manifest.limits.attempts ? 'rescue' : 'local';
        const key = `${stage.id}/${role}-${number}`;
        const operationKey = `v${manifest.planVersion}/${key}`;
        const prior = journal.events.find(event => event.type === 'attempt.finished' && event.data.key === key);
        if (prior) {
          if (prior.data.accepted) { accepted = true; break; }
          continue;
        }
        guard();
        const started = journal.events.some(event => event.type === 'attempt.started' && event.data.key === key);
        if (!started) {
          if (role === 'rescue' && journal.events.filter(event => event.type === 'attempt.started' && event.data.role === 'rescue').length >= manifest.limits.rescues) throw new Pause('Job Codex rescue limit reached', 'needs_review');
          await journal.append('attempt.started', { key, stageId: stage.id, number, role });
        }
        const failures = journal.events.filter(event => event.type === 'attempt.finished' && event.data.stageId === stage.id).map(event => event.data);
        let reply, checkResults = [], review;
        try {
          const context = [];
          for (let exchange = 0; exchange <= manifest.limits.contextRequests; exchange++) {
            const request = { stage, assignment, permissions: manifest.permissions, inventory: await workspace.inventory(), priorAttempts: failures,
              context, note: stage.kind === 'verification'
                ? 'Only one edit submission per attempt. If no source edit is warranted, submit_changes with edits:[]. The coordinator runs approved checks and gives screenshots and accepted checkpoint diffs directly to Codex; do not request those generated artifacts or ask for approval to review them.'
                : 'Only one edit submission per attempt; use read_files to obtain current base hashes.' };
            const output = await provider(`${operationKey}/response-${exchange}`, s => role === 'local' ? local.reply(request, s) : frontier.rescue(request, s), request);
            if (output?.protocolError) throw new AttemptError(output.protocolError);
            if (stage.kind === 'verification' && role === 'local' && output?.reply?.type === 'needs_approval' &&
                Array.isArray(output.reply.paths) && output.reply.paths.length > 0 &&
                output.reply.paths.every(file => /^\.overnight-output\/[a-zA-Z0-9_.-]+\.png$/.test(file)) &&
                Array.isArray(output.reply.edits) && output.reply.edits.length === 0) {
              throw new AttemptError('The coordinator already gives generated screenshots and accepted checkpoint diffs to Codex. Submit changes with an empty edits array when no source edit is needed.');
            }
            reply = validateReply(role === 'local' ? output?.reply : output);
            if (reply.type === 'submit_changes') break;
            if (exchange === manifest.limits.contextRequests) throw new AttemptError('Context request limit reached; submit a focused edit batch');
            const files = await journal.memo(`${operationKey}/files-${exchange}`, () => workspace.readFiles(reply.paths), { paths: reply.paths });
            context.push({ request: reply, files });
            if (Buffer.byteLength(JSON.stringify(context)) > 512 * 1024) throw new AttemptError('Context exceeds 512 KiB; request fewer files');
          }
          guard();
          await workspace.apply(operationKey, stage, reply.edits);
          checkResults = await journal.memo(`${operationKey}/checks`, () => checks.run(manifest.permissions.checks.filter(check => stage.checks.includes(check.id)), operationKey, controller.signal));
          if (checkResults.length !== stage.checks.length || stage.checks.some(id => !checkResults.some(check => check.id === id))) throw new Pause('Required check evidence is missing', 'evidence');
          guard();
          const evidence = { ...await workspace.evidence(), checks: checkResults.map(check => ({
            ...check, stdout: check.stdout?.slice(-32_768), stderr: check.stderr?.slice(-32_768),
            outputTruncated: (check.stdout?.length ?? 0) > 32_768 || (check.stderr?.length ?? 0) > 32_768,
          })), ...(stage.kind === 'verification' ? { acceptedDiffs: await workspace.acceptedDiffs() } : {}) };
          const reviewInput = { brief: manifest.brief, approvedPlan: manifest.plan, stage, assignment,
            acceptedStages: summarize(journal).stages.filter(item => item.status === 'accepted'),
            currentSource: await workspace.readFiles((await workspace.inventory()).map(file => file.path)),
            workerSummary: reply.summary, evidence };
          review = await provider(`${operationKey}/review`, s => frontier.reviewCode(reviewInput, s), reviewInput);
          if (!['accept', 'revise', 'blocked'].includes(review.decision) || typeof review.feedback !== 'string' || !Array.isArray(review.unverified)) throw new Pause('Invalid frontier review', 'provider');
          if (review.decision === 'blocked') throw new Pause(review.feedback, 'blocked');
          accepted = review.decision === 'accept' && checkResults.every(check => check.passed === true);
          const feedback = checkResults.some(check => !check.passed)
            ? `Required checks failed: ${checkResults.filter(check => !check.passed).map(check => check.id).join(', ')}. ${review.feedback}`
            : review.feedback;
          await journal.append('attempt.finished', { key, stageId: stage.id, role, accepted, feedback,
            checks: checkResults.map(({ id, passed, code, stdout, stderr }) => ({ id, passed, code, stdout: stdout?.slice(-16_384), stderr: stderr?.slice(-16_384) })),
            unverified: review.unverified });
        } catch (error) {
          if (!(error instanceof AttemptError)) throw error;
          await journal.append('attempt.finished', { key, stageId: stage.id, role, accepted: false, feedback: error.message, checks: [] });
        }
        if (accepted) break;
      }
      if (!accepted) throw new Pause(`Stage ${stage.id} exhausted DeepSeek attempts and its Codex rescue`, 'needs_review');
      guard();
      const checkpoint = await journal.memo(`${stage.id}/checkpoint`, () => workspace.checkpoint(stage));
      await journal.append('stage.accepted', { stageId: stage.id, ...checkpoint });
      await writeReport(journal);
    }
    await journal.append('run.finished', { status: 'accepted', reason: 'Every approved stage passed its checks and frontier review' });
  } catch (error) {
    const budgetExpired = stopReason === 'Job time budget exhausted';
    const status = error instanceof Pause
      ? (['needs_review', 'blocked'].includes(error.code) ? error.code : 'paused')
      : controller.signal.aborted ? 'paused' : 'failed';
    await journal.append('run.finished', { status, reason: stopReason ?? error.message, code: budgetExpired ? 'budget' : error.code ?? 'error' });
  } finally {
    clearTimeout(timer); clearInterval(stopPoll); awake?.kill();
    signal?.removeEventListener('abort', cancel);
    await release();
  }
  return writeReport(journal);
}
