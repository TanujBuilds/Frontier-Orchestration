import { digest } from '../contracts.mjs';
import { PROJECT_CHECK_GUIDANCE, checkDefinitionHash, validateProjectCheckGuidance } from './contract.mjs';
import {
  findScopedGuidancePaths, fitsMemoryBudget, guidanceMemoryPacket, guidancePathMatches, guidanceQueryTokens, guidanceTermsMatch,
} from './applicability.mjs';

export const PROJECT_GUIDANCE_EVALUATOR_VERSION = 'project-check-guidance-recall-v1';

// The owner-approved assignment and its receipts determine the examples.
// Candidate paths, terms and asserted expectations never seed a fixture.
export function buildProjectGuidanceCases({ goal, sourceEvidence }) {
  const stale = structuredClone(goal);
  stale.manifest.project.checks = stale.manifest.project.checks.map(check => ({
    ...check, argv: [...check.argv, 'protected-stale-definition-fixture'],
  }));
  const crossProject = structuredClone(goal);
  crossProject.manifest.project.repo += '/protected-different-project-fixture';
  const witnesses = sourceEvidence.map(source => {
    const query = source.objective + '\n' + source.context;
    const queryTokens = guidanceQueryTokens(query);
    const observedPaths = findScopedGuidancePaths(queryTokens, source.readPaths);
    return { source, query, queryTokens, observedPaths };
  });
  const approvedChecks = goal.manifest.project.checks.map(check => [check.id, checkDefinitionHash(check)]);
  const samples = [];
  for (const { source, query, queryTokens, observedPaths } of witnesses) {
    // Two accepted outcomes can supply different checks for the same path.
    // An outcome in a disjoint area cannot supply checks for this sample.
    const related = witnesses.filter(other => other.source === source ||
      observedPaths.some(path => other.observedPaths.some(observed =>
        guidancePathMatches(path, observed) || guidancePathMatches(observed, path))));
    const checkDefinitionHashes = Object.fromEntries(approvedChecks.filter(([id, hash]) =>
      related.some(witness => witness.source.checkDefinitionHashes[id] === hash)));
    const pathTokens = new Set(observedPaths);
    const prose = queryTokens
      .map(token => pathTokens.has(token) || /[./\\]/.test(token) ? '.' : token)
      .join(' ');
    const heldout = observedPaths.map(path => `"${path}"`).join(' ') + '\n' + prose;
    const id = source.outcomeId;
    const make = (suffix, role, target, text, expectedMatch, overrides) => ({
      id: id + '/' + suffix, role, goal: target, expectedMatch, checkDefinitionHashes,
      taskContext: { query: text, capability: 'coding', environment: source.environment, ...overrides },
    });

    samples.push(
      make('source-assignment', 'regression', goal, query, true),
      make('scoped-recall', 'heldout', goal, heldout, true, { permissions: { readPaths: source.readPaths } }),
      make('case-normalized-recall', 'heldout', goal, prose.toUpperCase() + '\n' + observedPaths.join(' '), true, {
        permissions: { readPaths: observedPaths },
      }),
      make('unrelated-context-on-same-paths', 'heldout', goal,
        'Repair unrelated fixture topic zz_mosaic_protected_fixture at ' + observedPaths.join(' '), false),
      make('terms-without-paths', 'heldout', goal, prose, false),
      make('paths-without-terms', 'heldout', goal, observedPaths.join(' '), false),
      make('stale-check-definitions', 'heldout', stale, heldout, false),
      make('different-project', 'heldout', crossProject, heldout, false),
      make('different-environment', 'heldout', goal, heldout, false, {
        environment: source.environment === 'fixture' ? 'live' : 'fixture',
      }),
    );
  }
  return { goal, samples, witnesses };
}

function score(lesson, sample) {
  const packet = lesson && guidanceMemoryPacket({ lesson, goal: sample.goal, taskContext: sample.taskContext });
  const overBudget = Boolean(packet && !fitsMemoryBudget([packet]));
  const matched = Boolean(packet) && !overBudget;
  const checkIds = matched ? packet.recipe.checkIds : [];
  const unsupportedCheckIds = checkIds.filter(id =>
    sample.checkDefinitionHashes[id] !== lesson.recipe.checkDefinitionHashes[id]);
  return { matched, checkIds, unsupportedCheckIds, overBudget };
}

function summarize(cases, key) {
  return {
    falseMatches: cases.filter(result => !result.expectedMatch && result[key].matched).length,
    missedMatches: cases.filter(result => result.expectedMatch && !result[key].matched).length,
    unsupportedChecks: cases.reduce((total, result) => total + result[key].unsupportedCheckIds.length, 0),
  };
}

function exactEvidenceBoundaries(lesson, goal, sourceEvidence, witnesses) {
  try {
    const { family, ...parameters } = lesson.recipe;
    const validated = validateProjectCheckGuidance({ parameters, goal, sourceEvidence });
    const { relatedPaths, whenTerms } = validated;
    return lesson.family === PROJECT_CHECK_GUIDANCE && family === PROJECT_CHECK_GUIDANCE &&
      digest(validated) === digest(parameters) &&
      relatedPaths.every(path => witnesses.some(witness =>
        witness.observedPaths.some(observed => guidancePathMatches(path, observed)))) &&
      whenTerms.every(term => witnesses.some(witness =>
        guidanceTermsMatch([term], witness.queryTokens, witness.observedPaths).length === 1));
  } catch {
    return false;
  }
}

export function evaluateProjectCheckGuidance({ candidate, baseline, protectedCases, sourceEvidence }) {
  const { goal, samples, witnesses } = protectedCases;
  const boundariesPassed = samples.length > 0 && exactEvidenceBoundaries(candidate, goal, sourceEvidence, witnesses);
  const cases = samples.map(sample => ({
    id: sample.id,
    role: sample.role,
    expectedMatch: sample.expectedMatch,
    baseline: score(baseline, sample),
    candidate: boundariesPassed ? score(candidate, sample) : score(null, sample),
  }));
  const counts = summarize(cases, 'candidate');
  return {
    evaluatorVersion: PROJECT_GUIDANCE_EVALUATOR_VERSION,
    evidenceKind: 'protected_project_check_recall',
    cases,
    baseline: summarize(cases, 'baseline'),
    candidate: counts,
    boundariesPassed,
    passed: boundariesPassed && Object.values(counts).every(count => count === 0),
  };
}
