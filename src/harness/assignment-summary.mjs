import { isOvernightV2 } from './overnight.mjs';

const roleDescriptions = {
  collaborative: 'Main Codex plans and supervises. Codex and DeepSeek may implement, and Main Codex reviews the evidence before integration.',
  deepseek_only: 'DeepSeek plans and implements. Protected checks govern acceptance.',
  codex_only: 'Codex plans and implements. Main Codex reviews the protected check evidence before integration.',
  overnight_review: 'DeepSeek plans and implements. The coordinator calls Codex for bounded independent review after the protected checks pass.',
};

function display(value, limit) {
  const safe = value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/gi, '[redacted]')
    .replace(/\b(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(?:bearer\s+|(?:password|passphrase|secret|token|api[_-]?key)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[redacted]')
    .replace(/\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gi, '[redacted]')
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .trim();
  return safe.length > limit ? `${safe.slice(0, limit - 1)}…` : safe;
}

const list = values => values.slice(0, 8).map(value => display(value, 140));

export function assignmentSummary(manifest) {
  const { mode, project, limits, overnightPolicy } = manifest;
  const overnight = isOvernightV2(manifest);
  const codingDefaults = manifest.capabilities.find(capability => capability.id === 'coding').limits;
  const next = overnight
    ? 'Review the exact draft. With explicit authorization, run overnight_preflight before activating the same approval hash.'
    : 'Review the exact draft. Activate the saved approval hash only with explicit authorization.';
  return {
    objective: display(manifest.objective, 400),
    project: { repo: display(project.repo, 500), baseCommit: project.baseCommit },
    mode: { id: mode.id, version: mode.version },
    roles: {
      planner: mode.planner,
      workers: mode.actors,
      reviewer: mode.review === 'checks' ? null : 'codex',
      review: mode.review,
      description: roleDescriptions[mode.id],
    },
    editablePaths: list(project.writePaths),
    editablePathCount: project.writePaths.length,
    checks: list(project.checks.map(check => check.id)),
    checkCount: project.checks.length,
    limits: {
      hours: limits.hours,
      maxTasks: limits.maxTasks,
      reviewAgentRuns: limits.reviewAgentRuns,
      coding: { ...codingDefaults, ...limits.taskLimits?.coding },
      ...(overnight ? { overnight: {
        maxBatches: overnightPolicy.maxBatches,
        maxExchanges: overnightPolicy.maxExchanges,
        maxCorrections: overnightPolicy.maxCorrections,
        reconnectMs: overnightPolicy.reconnectMs,
      } } : {}),
    },
    providerVerification: 'unverified',
    next,
  };
}
