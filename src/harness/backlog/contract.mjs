import { identifier, keys, taskDispatchInputSchema } from '../contracts.mjs';

export const MAX_BACKLOG_ITEMS = 20;
const taskFields = Object.keys(taskDispatchInputSchema.properties)
  .filter(field => field !== 'submissionId' && field !== 'dependsOn');

function requireFields(raw, fields, label) {
  keys(raw, fields, label);
  for (const field of fields) if (!Object.hasOwn(raw, field)) throw Error(`Missing ${field}`);
}

export function validateBacklogIdentity(raw) {
  requireFields(raw, ['goalId', 'expectedGoalHash', 'expectedGoalVersion', 'submissionId', 'items'], 'backlog group');
  identifier(raw.goalId, 'goalId');
  identifier(raw.submissionId, 'submissionId');
  if (!Number.isSafeInteger(raw.expectedGoalVersion) || raw.expectedGoalVersion < 1) {
    throw Error('Invalid expectedGoalVersion');
  }
  if (typeof raw.expectedGoalHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.expectedGoalHash)) {
    throw Error('Invalid expectedGoalHash');
  }
}

export function validateBacklogInput(raw) {
  validateBacklogIdentity(raw);
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > MAX_BACKLOG_ITEMS) {
    throw Error(`Backlog group must contain 1–${MAX_BACKLOG_ITEMS} items`);
  }
  const byKey = new Map();
  for (const item of raw.items) {
    requireFields(item, ['key', 'task', 'dependsOnKeys'], 'backlog item');
    identifier(item.key, 'task key');
    if (byKey.has(item.key)) throw Error(`Duplicate task key ${item.key}`);
    keys(item.task, taskFields, `task ${item.key}`);
    if (!Array.isArray(item.dependsOnKeys) || item.dependsOnKeys.length >= MAX_BACKLOG_ITEMS) {
      throw Error(`Invalid dependencies for task ${item.key}`);
    }
    for (const dependency of item.dependsOnKeys) identifier(dependency, 'dependency key');
    if (new Set(item.dependsOnKeys).size !== item.dependsOnKeys.length) {
      throw Error(`Duplicate dependencies for task ${item.key}`);
    }
    byKey.set(item.key, item);
  }

  const ordered = [];
  const visited = new Set();
  const visiting = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    if (visiting.has(key)) throw Error(`Backlog dependency cycle at ${key}`);
    const item = byKey.get(key);
    if (!item) throw Error(`Unknown backlog dependency ${key}`);
    visiting.add(key);
    for (const dependency of item.dependsOnKeys) visit(dependency);
    visiting.delete(key);
    visited.add(key);
    ordered.push(item);
  }
  for (const key of byKey.keys()) visit(key);
  return ordered;
}
