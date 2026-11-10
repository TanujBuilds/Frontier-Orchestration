import { digest, identifier, keys, normalizeTask } from '../contracts.mjs';
import { isOvernightV2 } from '../overnight.mjs';
import { validateBacklogIdentity, validateBacklogInput } from './contract.mjs';
import { inspectBacklog } from './view.mjs';

const GROUP = 'backlog_group';
const diagnostic = (code, message, key) => ({ code, message: message.slice(0, 400), ...(key ? { key } : {}) });

function getSubmission(c, kind, goalId, submissionId) {
  return c.store.db.prepare('SELECT hash FROM submissions WHERE kind=? AND scope=? AND key=?')
    .get(kind, goalId, submissionId);
}

function taskInput(input, item, dependsOn) {
  const submissionId = `backlog-${digest({goalId: input.goalId, submissionId: input.submissionId, key: item.key})}`;
  return { ...item.task, submissionId, dependsOn };
}

function checkDirectoryScope(spec, project) {
  // normalizeTask uses a placeholder path to check scope. An approved individual
  // file with that name cannot authorize the directory containing the file.
  for (const field of ['readPaths', 'writePaths']) {
    for (const scope of spec.permissions[field]) {
      if (scope.endsWith('/') && !project[field].some(approved => approved.endsWith('/') && scope.startsWith(approved))) {
        throw Error('Task expands directory scope');
      }
    }
  }
}

function checkGroup(c, input, ordered, goal, hash) {
  if (!goal) return [diagnostic('goal_unknown', 'Unknown goal')];
  if (goal.hash !== input.expectedGoalHash || digest(goal.manifest) !== goal.hash) {
    return [diagnostic('goal_hash_mismatch', 'Exact current goal approval hash required')];
  }
  if (goal.status !== 'active' || !Number.isFinite(goal.activatedAt) || !Number.isFinite(goal.deadline)) {
    return [diagnostic('goal_inactive', 'Goal must be active and approved')];
  }
  if (goal.deadline <= c.now()) return [diagnostic('goal_expired', 'Original goal deadline exceeded')];
  if (isOvernightV2(goal.manifest)) {
    return [diagnostic('overnight_planner_required', 'Overnight v2 stages require an atomically validated planner graph')];
  }

  const submitted = getSubmission(c, GROUP, input.goalId, input.submissionId);
  if (submitted) {
    return submitted.hash === hash ? [] : [diagnostic('submission_conflict', 'Backlog submission conflict')];
  }

  const errors = [];
  const existing = c.store.all('task').filter(task => task.goalId === goal.id);
  if (existing.length + ordered.length > goal.manifest.limits.maxTasks) {
    errors.push(diagnostic('goal_task_cap', 'Goal task cap reached'));
  }
  let learning = existing.some(task => task.spec.kind === 'learning');
  for (const item of ordered) {
    const raw = taskInput(input, item, item.dependsOnKeys);
    if (c.beta && (raw.kind === 'research' || Object.hasOwn(raw, 'researchPolicy'))) {
      errors.push(diagnostic('research_parked', 'Research is parked in Mosaic Beta', item.key));
      continue;
    }
    if (goal.integrationSealed && raw.kind === 'coding') {
      errors.push(diagnostic('integration_sealed', 'Goal coding integration is sealed', item.key));
      continue;
    }
    try {
      const spec = normalizeTask(raw, goal.manifest, c.registry);
      if (spec.kind === 'coding') checkDirectoryScope(spec, goal.manifest.project);
      if (spec.kind === 'learning') {
        if (learning) throw Error('Learning assignment limit reached');
        learning = true;
      }
    } catch (error) {
      errors.push(diagnostic('invalid_task', error.message, item.key));
      continue;
    }
    if (getSubmission(c, 'task', goal.id, raw.submissionId)) {
      errors.push(diagnostic('task_submission_conflict', 'Task submission identity conflict', item.key));
    }
  }
  return errors;
}

export class Backlog {
  constructor({ c, worker }) {
    this.c = c;
    this.worker = worker;
  }

  preview(input) {
    let ordered, hash;
    try {
      ordered = validateBacklogInput(input);
      hash = digest(input);
    } catch (error) {
      return { valid: false, goalId: null, goalHash: null, goalVersion: null, taskKeys: [], edges: [],
        errors: [diagnostic('invalid_input', error.message)] };
    }
    const goal = this.c.store.maybe('goal', input.goalId);
    const errors = checkGroup(this.c, input, ordered, goal, hash);
    return {
      valid: errors.length === 0,
      goalId: input.goalId, goalHash: goal?.hash ?? null, goalVersion: goal?.version ?? null,
      taskKeys: ordered.map(item => item.key),
      edges: ordered.flatMap(item => item.dependsOnKeys.map(from => ({ from, to: item.key }))),
      errors,
    };
  }

  submit(input, key) {
    const { c } = this;
    return c.store.command(key, { op: 'backlog.submit', input }, () => {
      validateBacklogIdentity(input);
      const hash = digest(input);
      return c.store.submission(GROUP, input.goalId, input.submissionId, hash, id => {
        const ordered = validateBacklogInput(input);
        const goal = c.store.maybe('goal', input.goalId);
        const errors = checkGroup(c, input, ordered, goal, hash);
        if (errors.length) {
          const [error] = errors;
          throw Error(error.key ? `Task ${error.key}: ${error.message}` : error.message);
        }
        // Nested Store commands, task events and urgent-yield updates share the
        // outer command transaction. The worker only observes committed state.
        const ids = new Map();
        for (const item of ordered) {
          const dependsOn = item.dependsOnKeys.map(dependency => ids.get(dependency));
          const task = c.submitTask({ goalId: goal.id, ...taskInput(input, item, dependsOn) },
            `backlog-task-${digest({ groupId: id, key: item.key })}`);
          ids.set(item.key, task.id);
        }
        const group = { id, goalId: goal.id, goalVersion: goal.version, goalHash: goal.hash,
          submissionId: input.submissionId, at: c.now(), items: ordered.map(({key}) => ({ key, taskId: ids.get(key) })) };
        c.emit('backlog.submitted', goal.id, null, { id, goalVersion: goal.version, taskCount: group.items.length });
        return group;
      });
    });
  }

  inspect(input = {}) {
    return inspectBacklog({ ...input, c: this.c, worker: this.worker });
  }

  control(input, key) {
    keys(input, ['taskId', 'action'], 'backlog control');
    identifier(input.taskId, 'taskId');
    if (!['pause', 'stop', 'resume'].includes(input.action)) throw Error('Invalid backlog control action');
    return this.c.control({ taskId: input.taskId, action: input.action }, key);
  }
}
