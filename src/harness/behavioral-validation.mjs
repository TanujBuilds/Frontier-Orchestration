import {digest, keys, text} from './contracts.mjs';

const MAX_CRITERIA = 32;
const MAX_CHECKS_PER_CRITERION = 16;
const MAX_DESCRIPTION = 512;
const MAX_ID = 120;
const criterionIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const checkIdPattern = '^[a-z0-9-]+$';
const fields = {
  criterionId: {type: 'string', pattern: criterionIdPattern.source, maxLength: MAX_ID},
  description: {type: 'string', pattern: '\\S', maxLength: MAX_DESCRIPTION},
  checkIds: {
    type: 'array', minItems: 1, maxItems: MAX_CHECKS_PER_CRITERION, uniqueItems: true,
    items: {type: 'string', pattern: checkIdPattern, maxLength: MAX_ID},
  },
};

export const behavioralChecksSchema = {
  type: 'array', minItems: 1, maxItems: MAX_CRITERIA,
  items: {type: 'object', additionalProperties: false, required: Object.keys(fields), properties: fields},
};

export function normalizeBehavioralChecks(raw, checks) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_CRITERIA) {
    throw Error('behavioralChecks must list 1–' + MAX_CRITERIA + ' criteria');
  }

  const known = new Set(checks.map(check => check.id));
  const seen = new Set();
  return Array.from(raw, criterion => {
    keys(criterion, Object.keys(fields), 'behavioral criterion');
    const {criterionId, description, checkIds} = criterion;
    if (!criterionIdPattern.test(text(criterionId, 'criterionId', MAX_ID))) {
      throw Error('Invalid behavioral criterionId');
    }
    if (seen.has(criterionId)) throw Error('Duplicate behavioral criterionId ' + criterionId);
    seen.add(criterionId);

    text(description, 'behavioral criterion description', MAX_DESCRIPTION);
    if (!Array.isArray(checkIds) || !checkIds.length || checkIds.length > MAX_CHECKS_PER_CRITERION) {
      throw Error('Invalid behavioral checkIds for ' + criterionId);
    }
    if (new Set(checkIds).size !== checkIds.length) throw Error('Duplicate behavioral check ID for ' + criterionId);
    for (const id of checkIds) {
      text(id, 'behavioral check ID', MAX_ID);
      if (!known.has(id)) throw Error('Unknown behavioral check ID ' + id);
    }
    return {criterionId, description, checkIds: [...checkIds]};
  });
}

function passedReceipt(receipt, check) {
  if (receipt.passed !== true || receipt.code !== 0 || receipt.stopped) return false;
  const artifactCount = check.screenshots?.length ?? 0;
  return !artifactCount || (Array.isArray(receipt.screenshots) && receipt.screenshots.length === artifactCount);
}

// Call with receipts from one coordinator check run and the snapshot verified
// across that run. Model output and separately collected artifacts are not receipts.
export function deriveBehavioralEvidence(project, {checks = [], checkIds, snapshot}) {
  if (!project?.behavioralChecks) return undefined;
  const snapshotHash = snapshot == null ? null : digest(snapshot);
  const declared = new Map(project.checks.map(check => [check.id, check]));
  const applicable = new Set(checkIds ?? declared.keys());
  const outcomes = new Map();
  for (const receipt of checks) {
    const id = receipt?.id;
    if (!applicable.has(id) || !declared.has(id)) continue;
    outcomes.set(id, !outcomes.has(id) && passedReceipt(receipt, declared.get(id)) ? 'passed' : 'failed');
  }

  return {
    snapshotHash,
    criteria: project.behavioralChecks.map(criterion => {
      const checks = criterion.checkIds.map(id => applicable.has(id)
        ? {id, status: snapshotHash ? outcomes.get(id) ?? 'not_run' : 'not_run'}
        : {id, status: 'not_run', reason: 'not_due'});
      const status = checks.some(check => check.status === 'failed') ? 'failed'
        : checks.every(check => check.status === 'passed') ? 'passed' : 'not_run';
      return {...criterion, checkIds: [...criterion.checkIds], checks, status};
    }),
  };
}

export function assertBehavioralChecks(evidence) {
  for (const criterion of evidence?.criteria ?? []) {
    for (const check of criterion.checks) {
      if (check.reason === 'not_due' || check.status === 'passed') continue;
      throw Error(`Required behavioral check ${check.id} (${criterion.criterionId}): ${check.status}`);
    }
  }
}
