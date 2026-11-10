import { digest, text } from '../contracts.mjs';
import { isOvernightV2 } from '../overnight.mjs';
import { assertBehavioralChecks, deriveBehavioralEvidence } from '../behavioral-validation.mjs';
import { checkDefinitionHash } from './contract.mjs';

const commitId = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const reviewKind = { checks: 'none', legacy: 'codex_legacy', operator: 'codex_operator' };

function approvedSource(c, task, event) {
  const current = c.store.get('goal', task.goalId);
  const goal = current.version === task.goalVersion ? current :
    c.store.maybe('goal_history', `${task.goalId}-${task.goalVersion}`);
  if (!goal?.manifest.project || goal.version !== task.goalVersion ||
      goal.activatedAt == null || digest(goal.manifest) !== goal.hash ||
      (goal.goalId ?? goal.id) !== task.goalId) {
    throw Error('Missing or invalid source approval for the integrated task');
  }
  const approval = c.store.db.prepare(`
    SELECT data FROM events
    WHERE goal_id=? AND seq<? AND type IN ('goal.activated','goal.revision_activated')
    ORDER BY seq DESC LIMIT 1
  `).get(task.goalId, event.seq);
  const data = approval && JSON.parse(approval.data);
  if (data?.version !== goal.version || data.hash !== goal.hash) {
    throw Error('Source task was not bound to the approved goal version at integration');
  }
  return goal;
}

function assertBoundBehavioralEvidence({ project, checks, checkIds, evidence, stage }) {
  if (!sha256.test(evidence?.snapshotHash) || !sha256.test(evidence?.executableModesHash)) {
    throw Error(`Integration receipt lacks bound ${stage} behavioral check evidence`);
  }
  // The accepted event carries the snapshot and mode hashes. Use only the
  // approved due IDs and the verified combined results to reconstruct the
  // required criterion descriptors and statuses for this stage.
  const expected = deriveBehavioralEvidence(project, {
    checks, checkIds, snapshot: {}, executableModesHash: evidence.executableModesHash,
  });
  expected.snapshotHash = evidence.snapshotHash;
  if (digest(expected) !== digest(evidence)) throw Error(`Integrated ${stage} behavioral check evidence changed`);
  assertBehavioralChecks(evidence);
}

function verifiedCheckDefinitions(receipt, task, goal, native) {
  const project = goal.manifest.project;
  if (!Array.isArray(receipt.checks) || !receipt.checks.length) {
    throw Error('Integration receipt lacks passing check evidence');
  }
  const definitions = new Map(project.checks.map(check => [check.id, check]));
  const passed = new Map();
  for (const result of receipt.checks) {
    const check = definitions.get(result?.id);
    if (!check || passed.has(check.id) || result.passed !== true || result.code !== 0 ||
        result.stopped !== false || !Array.isArray(result.argv) || digest(result.argv) !== digest(check.argv) ||
        (check.screenshots?.length ?? 0) !== (result.screenshots?.length ?? 0)) {
      throw Error('Integration receipt lacks a unique, passing registered check execution');
    }
    passed.set(check.id, checkDefinitionHash(check));
  }
  const intermediate = isOvernightV2(goal.manifest) && task.spec.role !== 'final';
  const requiredIds = intermediate ?
    [...task.spec.permissions.checks, ...goal.manifest.overnightPolicy.preflightCheckIds] :
    project.checks.map(check => check.id);
  if (requiredIds.some(id => !passed.has(id))) throw Error('Integration receipt omits required checks');
  if (project.behavioralChecks) {
    const checks = receipt.checks;
    const checkIds = [...passed.keys()];
    assertBoundBehavioralEvidence({
      project, checks, checkIds, evidence: receipt.behavioralEvidence, stage: 'combined',
    });
    if (!native) {
      // Overnight v2 uses the same effective approved checks for candidate and
      // combined stages. Other candidate layouts use the task's approved subset.
      const candidateIds = isOvernightV2(goal.manifest) ? checkIds : task.spec.permissions.checks;
      assertBoundBehavioralEvidence({
        project, checks, checkIds: candidateIds,
        evidence: receipt.candidateBehavioralEvidence, stage: 'candidate',
      });
    }
  }
  return Object.fromEntries(passed);
}

export function resolveGuidanceEvidence({ c, maintenanceTaskId, outcomeIds }) {
  if (!Array.isArray(outcomeIds) || !outcomeIds.length || outcomeIds.length > 10 ||
      new Set(outcomeIds).size !== outcomeIds.length) {
    throw Error('Guidance needs 1–10 distinct outcome evidence IDs');
  }
  const maintenance = c.store.get('task', maintenanceTaskId);
  const target = c.store.get('goal', maintenance.goalId);
  const targetRepo = target.manifest.project?.repo;
  if (!targetRepo || maintenance.spec.kind !== 'learning') throw Error('Project learning assignment required');
  const projectKey = digest(targetRepo);
  const targetVersion = target.manifest.capabilities.find(capability => capability.id === 'coding')?.version;

  return Array.from(outcomeIds, id => {
    text(id, 'outcome evidence ID', 120);
    const outcome = c.store.maybe('outcome', id);
    if (!outcome || outcome.projectKey !== projectKey) throw Error('Unknown or cross-project outcome evidence');
    if (!Number.isSafeInteger(outcome.eventSequence) || outcome.eventSequence < 1) {
      throw Error('Invalid source event sequence');
    }
    const event = c.store.events(outcome.eventSequence - 1, 1)[0];
    if (!event || event.seq !== outcome.eventSequence || event.task_id !== outcome.taskId ||
        event.goal_id !== outcome.goalId || event.type !== outcome.kind ||
        id !== `${outcome.taskId}-${event.seq}` || outcome.id !== id ||
        digest(event) !== outcome.sourceHash || digest(outcome.data) !== digest(event.data)) {
      throw Error('Outcome source event integrity failed');
    }
    const native = event.type === 'task.native_finished';
    if (!native && event.type !== 'task.integrated') throw Error('Checked integration event required');
    const task = c.store.get('task', event.task_id);
    const receipt = task.integration;
    if (task.id !== event.task_id || task.goalId !== event.goal_id || task.status !== 'accepted' || task.spec.kind !== 'coding' ||
        digest(task.spec) !== task.hash || outcome.status !== 'accepted' || outcome.capability !== 'coding' ||
        !receipt || typeof receipt.commit !== 'string' || !commitId.test(receipt.commit) || (!native && !commitId.test(receipt.candidateCommit)) ||
        digest(receipt) !== digest(event.data)) {
      throw Error('Accepted coding integration receipt required');
    }
    const sourceGoal = approvedSource(c, task, event);
    const sourceVersion = sourceGoal.manifest.capabilities.find(capability => capability.id === 'coding')?.version;
    const environment = sourceGoal.manifest.environment;
    if (sourceGoal.manifest.project.repo !== targetRepo || environment !== target.manifest.environment ||
        environment !== outcome.environment || sourceVersion !== outcome.capabilityVersion || sourceVersion !== 1 || sourceVersion !== targetVersion ||
        receipt.review !== (native ? 'codex_native' : reviewKind[sourceGoal.manifest.mode.review])) {
      throw Error('Incompatible source project, environment, capability or integration review');
    }
    return {
      outcomeId: id,
      sourceHash: outcome.sourceHash,
      taskId: task.id,
      taskHash: task.hash,
      goalId: task.goalId,
      goalVersion: task.goalVersion,
      goalHash: sourceGoal.hash,
      commit: receipt.commit,
      environment,
      capabilityVersion: sourceVersion,
      checkDefinitionHashes: verifiedCheckDefinitions(receipt, task, sourceGoal, native),
      readPaths: task.spec.permissions.readPaths,
      objective: task.spec.objective,
      context: task.spec.context,
    };
  });
}
