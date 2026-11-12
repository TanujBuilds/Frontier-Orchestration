import { createHash } from 'node:crypto';

export const DEFAULT_LIMITS = Object.freeze({
  hours: 8, attempts: 5, reviewRounds: 2, contextRequests: 10, reconnectMs: 30 * 60_000,
});
export class Pause extends Error {
  constructor(message, code = 'needs_attention') { super(message); this.code = code; }
}
export class AttemptError extends Error {}
export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}
export function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be nonempty text`);
  return value;
}
export function relativePath(value) {
  text(value, 'path');
  if (value.startsWith('/') || value.includes('\\') || /[\0\r\n]/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Pause(`Unsafe relative path: ${value}`, 'scope');
  }
  return value;
}
export function protectedPath(value) {
  if (secretPath(value)) return true;
  return value.split('/').some(part =>
    /^(?:\.git|\.gitignore|\.gitattributes|\.gitmodules|\.agents|\.codex|\.aws|\.ssh|\.data|node_modules|checks|\.orchestrator)$/i.test(part) ||
    /^\.env(?:\.|$)/i.test(part) ||
    /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|AGENTS\.md|PROJECT_MEMORY\.md)$/i.test(part) ||
    /\.(?:pem|key|p12|pfx)$/i.test(part));
}
export function secretPath(value) {
  return value.split('/').some(part =>
    /^(?:\.git|\.agents|\.codex|\.aws|\.ssh|\.data|node_modules|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials\.json|auth\.json)$/i.test(part) ||
    /^\.env(?:\.|$)/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part) || part.toUpperCase() === 'PROJECT_MEMORY.MD');
}
export function matches(file, scopes) {
  return scopes.some(scope => scope.endsWith('/') ? file.startsWith(scope) : file === scope);
}
function scopes(values, name) {
  if (!Array.isArray(values) || !values.length) throw new Error(`${name} must list paths (directories end in /)`);
  for (const scope of values) relativePath(scope.endsWith('/') ? scope.slice(0, -1) : scope);
}
export function validatePermissions(p) {
  scopes(p?.readPaths, 'readPaths');
  scopes(p?.writePaths, 'writePaths');
  for (const scope of p.writePaths) {
    const file = scope.endsWith('/') ? `${scope}placeholder` : scope;
    if (protectedPath(file) || !matches(file, p.readPaths)) throw new Error(`Invalid write scope: ${scope}`);
  }
  if (!Array.isArray(p.checks) || !p.checks.length) throw new Error('At least one approved check is required');
  const ids = new Set();
  for (const check of p.checks) {
    text(check.id, 'check.id');
    if (!/^[a-z0-9-]+$/.test(check.id)) throw new Error('Check IDs must be lowercase identifiers');
    if (ids.has(check.id)) throw new Error('Duplicate check ID');
    ids.add(check.id);
    if (!Array.isArray(check.argv) || !check.argv.length || check.argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Check argv must be a nonempty string array');
    if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 100 || check.timeoutMs > 600_000)) throw new Error('Check timeout must be 100–600000 ms');
    for (const file of check.screenshots ?? []) {
      relativePath(file);
      if (!file.startsWith('.overnight-output/') || !file.endsWith('.png')) throw new Error('Screenshots must be PNGs in .overnight-output/');
    }
  }
  return p;
}
export function validatePlan(plan, permissions) {
  text(plan?.summary, 'plan.summary');
  if (!Array.isArray(plan.stages) || plan.stages.length < 1 || plan.stages.length > 10) throw new Error('Plan must have 1–10 stages');
  const ids = new Set();
  for (const stage of plan.stages) {
    if (!['implementation', 'verification'].includes(stage.kind)) throw new Error('Invalid stage kind');
    if (!/^[a-z0-9-]+$/.test(stage.id) || ids.has(stage.id)) throw new Error('Stage IDs must be unique lowercase identifiers');
    ids.add(stage.id);
    text(stage.objective, 'stage.objective'); text(stage.deliverable, 'stage.deliverable');
    if (!Array.isArray(stage.acceptance) || !stage.acceptance.length) throw new Error('Stage acceptance criteria required');
    stage.acceptance.forEach(item => text(item, 'acceptance criterion'));
    scopes(stage.writePaths, 'stage.writePaths');
    for (const scope of stage.writePaths) {
      const file = scope.endsWith('/') ? `${scope}placeholder` : scope;
      if (!matches(file, permissions.writePaths) || protectedPath(file)) throw new Pause('Plan expands write permissions', 'scope');
    }
    if (!Array.isArray(stage.checks) || !stage.checks.length || stage.checks.some(id => !permissions.checks.some(check => check.id === id))) throw new Error('Every stage must name approved check IDs');
    if (new Set(stage.checks).size !== stage.checks.length) throw new Error('Stage check IDs must be unique');
  }
  if (plan.stages.at(-1).kind !== 'verification') throw new Error('Last stage must be final integration verification');
  const finalChecks = plan.stages.at(-1).checks;
  if (permissions.checks.some(check => !finalChecks.includes(check.id))) throw new Error('Final stage must run every approved check');
  return plan;
}
// The approved stage already carries objective, deliverable, scope, acceptance and checks.
// Composing the assignment here keeps Codex out of the per-stage prompt-writing path.
export function stageAssignment({ stage, plan, acceptedStages = [], priorAttempts = [], guidance }) {
  const lines = [
    `Stage ${stage.id} (${stage.kind}).`,
    `Objective: ${stage.objective}`,
    `Deliverable: ${stage.deliverable}`,
    'Acceptance criteria:',
    ...stage.acceptance.map(item => `- ${item}`),
    `Editable paths: ${stage.writePaths.join(', ')}`,
    `Approved checks: ${stage.checks.join(', ')}`,
  ];
  if (acceptedStages.length) {
    lines.push('Accepted earlier stages:', ...acceptedStages.map(item => `- ${item.id}: ${item.objective}`));
  }
  if (guidance) lines.push('Optional Codex guidance approved for this stage:', guidance);
  if (priorAttempts.length) {
    lines.push('Earlier attempts on this stage (most recent last):');
    for (const attempt of priorAttempts.slice(-5)) {
      const failed = (attempt.checks ?? []).filter(check => !check.passed).map(check => check.id);
      lines.push(`- attempt ${attempt.number}: ${attempt.accepted ? 'accepted' : 'not accepted'}`,
        ...(failed.length ? [`  failing checks: ${failed.join(', ')}`] : []),
        `  feedback: ${attempt.feedback ?? 'none recorded'}`);
    }
  }
  if (stage.kind === 'verification') {
    lines.push('Final verification stage: read the accepted work, submit an empty edit batch when it is already correct, and leave only repairs that a failing check justifies.');
  }
  lines.push('Plan summary:', plan.summary);
  return { instructions: lines.join('\n'), needsApproval: false };
}

export function validateReply(reply) {
  if (reply?.type === 'needs_approval') throw new Pause(reply.summary || 'Worker requests expanded scope', 'scope');
  if (reply?.type === 'read_files' && Array.isArray(reply.paths) && reply.paths.length > 0 && reply.paths.length <= 20 && reply.paths.every(file => typeof file === 'string' && file.trim())) return reply;
  if (reply?.type === 'submit_changes' && Array.isArray(reply.edits) && reply.edits.length <= 30 && typeof reply.summary === 'string' && reply.edits.every(edit => edit && Object.keys(edit).every(key => ['path', 'action', 'baseHash', 'content'].includes(key)) && typeof edit.path === 'string' && ['write', 'delete'].includes(edit.action) && (edit.baseHash === null || typeof edit.baseHash === 'string'))) return reply;
  throw new AttemptError('Invalid worker reply; return read_files or submit_changes JSON');
}
