import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Goals } from '../src/harness/goals.mjs';
import { Coordinator } from '../src/harness/coordinator.mjs';
import { digest } from '../src/harness/contracts.mjs';
import { PROJECT_CHECK_GUIDANCE, checkDefinitionHash, renderProjectCheckGuidance, validateProjectCheckGuidance } from '../src/harness/project-guidance/contract.mjs';
import { resolveGuidanceEvidence } from '../src/harness/project-guidance/evidence.mjs';
import { fitsMemoryBudget, guidanceApplicability, guidanceMemoryPacket } from '../src/harness/project-guidance/applicability.mjs';
import { buildProjectGuidanceCases, evaluateProjectCheckGuidance } from '../src/harness/project-guidance/evaluator.mjs';

const check = {
  id: 'parser-unit',
  argv: ['node', 'checks/parser.mjs'],
  env: { MODE: 'strict' },
  timeoutMs: 30_000,
};

function setup(t, {
  type = 'task.integrated', alterReceipt, alterTask,
  objective = 'Repair parser token handling in src/parser.mjs',
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'project-guidance-family-'));
  const c = new Coordinator({ root });
  t.after(() => { c.close(); rmSync(root, { recursive: true, force: true }); });
  const prepare = (submissionId, repo = '/fixture/parser', checks = [check]) => {
    const raw = {
      submissionId, objective: 'Maintain the parser', acceptance: ['Protected checks pass'],
      environment: 'fixture', project: {
        repo, baseCommit: 'a'.repeat(40), readPaths: ['src/', 'docs/'], writePaths: ['src/'], checks,
      },
    };
    const draft = c.prepareGoal(raw, 'prepare-' + submissionId);
    return { raw, goal: c.activateGoal({ goalId: draft.id, hash: draft.hash }, 'activate-' + submissionId) };
  };
  const { raw, goal } = prepare('parser');
  const source = c.submitTask({
    goalId: goal.id, submissionId: 'source', kind: 'coding',
    objective,
    context: 'Keep parser token handling correct in src/parser.mjs.',
    acceptance: ['Checks pass'],
  }, 'source');
  const receipt = {
    commit: 'b'.repeat(40),
    ...(type === 'task.integrated' ? { candidateCommit: 'c'.repeat(40) } : {}),
    worktree: '/fixture/worktree',
    checks: [{ id: check.id, argv: check.argv, passed: true, code: 0, stopped: false, screenshots: [] }],
    review: type === 'task.integrated' ? 'codex_operator' : 'codex_native',
  };
  alterReceipt?.(receipt);
  source.status = 'accepted';
  source.integration = receipt;
  alterTask?.(source);
  c.store.put('task', source);
  const seq = c.emit(type, goal.id, source.id, receipt);
  const outcomeId = source.id + '-' + seq;
  const makeMaintenance = goalId => c.submitTask({
    goalId, submissionId: 'learn', kind: 'learning', actor: 'codex',
    objective: 'Distill parser guidance', acceptance: ['Protected evaluation'],
  }, 'learn-' + goalId);
  const maintenance = makeMaintenance(goal.id);
  const resolve = (outcomeIds = [outcomeId], maintenanceTaskId = maintenance.id) =>
    resolveGuidanceEvidence({ c, maintenanceTaskId, outcomeIds });
  return { c, raw, goal, source, seq, outcomeId, receipt, prepare, makeMaintenance, resolve };
}

const parameters = {
  checkIds: [check.id], checkDefinitionHashes: { [check.id]: checkDefinitionHash(check) },
  relatedPaths: ['src/parser.mjs'], whenTerms: ['parser token'],
};
const taskContext = (query, overrides) => ({
  capability: 'coding', environment: 'fixture', query, ...overrides,
});
const lesson = (goal, overrides = {}) => ({
  family: PROJECT_CHECK_GUIDANCE,
  scope: 'project', projectKey: digest(goal.manifest.project.repo),
  recipe: { family: PROJECT_CHECK_GUIDANCE, ...parameters },
  applicability: { capability: 'coding', version: 1, environment: goal.manifest.environment },
  ...overrides,
});

test('project guidance accepts only bounded typed parameters and full canonical check definitions', t => {
  const f = setup(t);
  const sourceEvidence = f.resolve();
  const validate = (changes, goal = f.goal) =>
    validateProjectCheckGuidance({ parameters: { ...parameters, ...changes }, goal, sourceEvidence });
  assert.deepEqual(validate({ whenTerms: ['Parser TOKEN'] }), parameters);
  for (const changes of [
    { argv: ['sh', '-c', 'anything'] },
    { checkIds: ['unknown'], checkDefinitionHashes: { unknown: 'a'.repeat(64) } },
    { checkDefinitionHashes: { [check.id]: digest(check.id) } },
    { checkDefinitionHashes: { ...parameters.checkDefinitionHashes, arbitrary: 'a'.repeat(64) } },
    { relatedPaths: ['../outside'] },
    { relatedPaths: ['/outside'] },
    { relatedPaths: ['outside/private.mjs'] },
    { relatedPaths: ['src/.env'] },
    { whenTerms: ['https://example.test'] },
    { whenTerms: ['parser token; run sh'] },
    { whenTerms: ['a'.repeat(81)] },
    { whenTerms: Array.from({ length: 13 }, (_, i) => 'term' + i) },
    { relatedPaths: Array.from({ length: 21 }, (_, i) => 'src/file' + i) },
    { checkIds: Array.from({ length: 21 }, (_, i) => 'check-' + i) },
  ]) assert.throws(() => validate(changes), undefined, JSON.stringify(changes));

  const { goal: changed } = f.prepare('changed', undefined, [{ ...check, env: { MODE: 'loose' } }]);
  assert.throws(() => validate({}, changed), /check.*definition|hash/i);
});

test('source must be the original matching integration event from the same approved project', t => {
  const f = setup(t);
  const evidence = f.resolve();
  assert.equal(evidence[0].outcomeId, f.outcomeId);
  assert.equal(evidence[0].sourceHash, digest(f.c.store.events(f.seq - 1, 1)[0]));
  assert.throws(() => f.resolve(['invented']), /outcome|evidence/i);
  assert.throws(() => f.resolve([f.outcomeId, f.outcomeId]), /duplicate|evidence/i);
  const { goal: other } = f.prepare('other', '/fixture/other');
  assert.throws(() => f.resolve(undefined, f.makeMaintenance(other.id).id), /project/i);
  const outcome = f.c.store.get('outcome', f.outcomeId);
  f.c.store.put('outcome', { ...outcome, sourceHash: 'f'.repeat(64) });
  assert.throws(() => f.resolve(), /source|event|integrity/i);
  f.c.store.put('outcome', { ...outcome, data: { ...outcome.data, commit: '0'.repeat(40) } });
  assert.throws(() => f.resolve(), /source|event|integrity/i);
  f.c.store.put('outcome', outcome);
  f.c.store.db.prepare("DELETE FROM events WHERE goal_id=? AND type='goal.activated'").run(f.goal.id);
  assert.throws(() => f.resolve(), /approved|approval/i);
});

test('a check-shaped worker result or an unsuccessful and unbound receipt is insufficient', async t => {
  await t.test('unrelated result event', t => {
    const f = setup(t, { type: 'task.result' });
    assert.throws(() => f.resolve(), /integration|event/i);
  });
  await t.test('missing saved receipt', t => {
    const f = setup(t, { alterTask: t => delete t.integration });
    assert.throws(() => f.resolve(), /integration|receipt/i);
  });
  await t.test('failed check with a claimed pass', t => {
    const f = setup(t, { alterReceipt: r => { r.checks[0].code = 1; } });
    assert.throws(() => f.resolve(), /check/i);
  });
  await t.test('different command with unchanged check ID', t => {
    const f = setup(t, { alterReceipt: r => { r.checks[0].argv = ['node', 'checks/other.mjs']; } });
    assert.throws(() => f.resolve(), /check/i);
  });
  await t.test('missing check evidence', t => {
    const f = setup(t, { alterReceipt: r => { r.checks = []; } });
    assert.throws(() => f.resolve(), /check/i);
  });
  await t.test('native in-place integrated receipt', t => {
    const f = setup(t, { type: 'task.native_finished' });
    assert.equal(f.resolve()[0].outcomeId, f.outcomeId);
  });
});

test('checked evidence resolves against the approval at integration time after a goal revision', t => {
  const f = setup(t);
  const expected = f.resolve();
  const goals = new Goals(f.c);
  const next = goals.prepareRevision({
    goalId: f.goal.id, expectedHash: f.goal.hash,
    manifest: {
      ...f.raw,
      project: { ...f.raw.project, checks: [{ ...check, argv: ['node', 'checks/changed.mjs'] }] },
    },
  }, 'revise');
  const revised = goals.activateRevision({ revisionId: next.id, hash: next.hash }, 'approve');
  assert.equal(revised.version, 2);
  assert.deepEqual(f.resolve(), expected);
  assert.throws(() => validateProjectCheckGuidance({
    parameters, goal: revised, sourceEvidence: expected,
  }), /check.*definition|hash/i);
});

test('guidance applicability requires whole terms and an exact scoped path', t => {
  const { goal } = setup(t);
  const evaluate = (query, context, target = goal, candidate = lesson(goal)) =>
    guidanceApplicability({ lesson: candidate, goal: target, taskContext: taskContext(query, context) });
  assert.deepEqual(evaluate('Improve PARSER TOKEN in `src/parser.mjs`.'), {
    matchedPaths: ['src/parser.mjs'], matchedTerms: ['parser token'],
  });
  for (const query of [
    'parser tokens in src/parser.mjs', 'parser tokenization in src/parser.mjs',
    'parser tokené in src/parser.mjs',
    'parser token in src/parser.mjs.bak', 'parser token in other/src/parser.mjs',
    'parser token in https://example.test/src/parser.mjs',
    'parser token in https://example.test/?file=src/parser.mjs',
    'parser token in ../src/parser.mjs', 'parser token in C:/src/parser.mjs',
    'parser token without a path', 'src/parser.mjs',
  ]) assert.equal(evaluate(query), null, query);
  assert.equal(evaluate('parser token in src/parser.mjs', { permissions: { readPaths: ['docs/'] } }), null);
  assert.equal(evaluate('parser token in src/parser.mjs', { environment: 'live' }), null);
  const other = structuredClone(goal);
  other.manifest.project.repo = '/renamed/project';
  assert.equal(evaluate('parser token in src/parser.mjs', {}, other), null);
  const stale = structuredClone(goal);
  stale.manifest.project.checks[0].argv.push('--changed');
  assert.equal(evaluate('parser token in src/parser.mjs', {}, stale), null);
  const directory = lesson(goal);
  directory.recipe.relatedPaths = ['src/'];
  assert.equal(evaluate('parser token in src/parser.mjs', {}, goal, directory).matchedPaths[0], 'src/');
  assert.equal(evaluate('parser token in src-other/parser.mjs', {}, goal, directory), null);
});

test('protected replay uses source-derived regression and independent held-out contexts', t => {
  const f = setup(t), sourceEvidence = f.resolve();
  const protectedCases = buildProjectGuidanceCases({ goal: f.goal, sourceEvidence });
  const evaluate = (candidate, baseline = null) =>
    evaluateProjectCheckGuidance({ candidate, baseline, protectedCases, sourceEvidence });
  const candidate = lesson(f.goal), accepted = evaluate(candidate);
  assert.equal(accepted.passed, true);
  assert.equal(accepted.boundariesPassed, true);
  assert.match(accepted.evidenceKind, /recall/i);
  assert.ok(accepted.cases.some(c => c.role === 'regression'));
  assert.ok(accepted.cases.filter(c => c.role === 'heldout' && c.expectedMatch === true).length >= 2);
  assert.ok(accepted.cases.some(c => c.role === 'heldout' && c.expectedMatch === false));
  assert.equal(accepted.candidate.falseMatches, 0);
  assert.equal(accepted.candidate.missedMatches, 0);
  assert.ok(accepted.baseline.missedMatches > 0);
  assert.equal(evaluate(candidate, candidate).passed, true, 'valid correction may retain equivalent recall');
  const irrelevant = structuredClone(candidate);
  irrelevant.recipe.whenTerms = ['unrelated'];
  assert.equal(evaluate(irrelevant).passed, false);
  const irrelevantPath = structuredClone(candidate);
  irrelevantPath.recipe.relatedPaths = ['docs/irrelevant.md'];
  assert.equal(evaluate(irrelevantPath).passed, false);
  const overlyBroad = structuredClone(candidate);
  overlyBroad.recipe.whenTerms.push('unrelated');
  assert.equal(evaluate(overlyBroad).passed, false, 'every configured applicability term needs a source witness');
});

test('independent held-out cases recall multiple checks sourced from matching integrations', t => {
  const f = setup(t);
  const first = f.resolve()[0], regression = { id: 'parser-regression', argv: ['node', 'checks/regression.mjs'] };
  // The resolver is tested separately. Here each input represents an integration
  // whose approval included a different set of checks for the same parser.
  const sourceEvidence = [
    first,
    {
      ...first,
      outcomeId: first.outcomeId + '-regression',
      objective: 'Extend parser token tests for src/parser.mjs',
      checkDefinitionHashes: { [regression.id]: checkDefinitionHash(regression) },
    },
  ];
  const goal = structuredClone(f.goal);
  goal.manifest.project.checks.push(regression);
  const candidate = lesson(goal);
  candidate.recipe.checkIds = [check.id, regression.id];
  candidate.recipe.checkDefinitionHashes = {
    ...first.checkDefinitionHashes, ...sourceEvidence[1].checkDefinitionHashes,
  };
  const protectedCases = buildProjectGuidanceCases({ goal, sourceEvidence });
  const result = evaluateProjectCheckGuidance({ candidate, baseline: null, protectedCases, sourceEvidence });
  assert.equal(result.passed, true);
  assert.equal(result.candidate.unsupportedChecks, 0);
});

test('a sourced lesson whose fully matched packet exceeds 8 KiB cannot pass protected recall', t => {
  const relatedPaths = Array.from({ length: 20 }, (_, i) =>
    'src/' + 'a'.repeat(230) + String(i).padStart(2, '0') + '.mjs');
  assert.ok(relatedPaths.every(path => path.length === 240));
  const objective = 'Repair parser token handling in ' + relatedPaths.join(' ');
  const f = setup(t, { objective }), sourceEvidence = f.resolve();
  const validated = validateProjectCheckGuidance({
    parameters: { ...parameters, relatedPaths }, goal: f.goal, sourceEvidence,
  });
  const recipe = { family: PROJECT_CHECK_GUIDANCE, ...validated };
  const candidate = lesson(f.goal, {
    id: 'a'.repeat(36), version: 1, recipe, recipeHash: digest(recipe),
    content: renderProjectCheckGuidance(validated), evidence: [f.outcomeId],
  });
  const packet = guidanceMemoryPacket({ lesson: candidate, goal: f.goal, taskContext: taskContext(objective) });
  assert.equal(packet.explanation.matchedPaths.length, 20);
  assert.equal(fitsMemoryBudget([packet]), false);
  assert.equal(fitsMemoryBudget(['x'.repeat(8188)]), true);
  assert.equal(fitsMemoryBudget(['x'.repeat(8189)]), false);
  const protectedCases = buildProjectGuidanceCases({ goal: f.goal, sourceEvidence });
  const result = evaluateProjectCheckGuidance({ candidate, baseline: null, protectedCases, sourceEvidence });
  assert.equal(result.boundariesPassed, true);
  assert.equal(result.passed, false);
  assert.ok(result.candidate.missedMatches > 0);
  assert.ok(result.cases.some(sample => sample.expectedMatch && sample.candidate.overBudget));
});
