// Fresh beta scope-only fixtures supply trusted host context; core approvals remain historical.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {canonical, digest} from '../src/harness/contracts.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';

const project = {
  repo: '/tmp/mosaic-recipe-fixture',
  baseCommit: 'a'.repeat(40),
  readPaths: ['src/'],
  writePaths: ['src/'],
  checks: [{id: 'verify', argv: ['node', 'checks/verify.mjs']}, {id: 'format', argv: ['node', 'checks/format.mjs']}],
  behavioralChecks: [{criterionId: 'correctness', description: 'Output matches the expected behavior', checkIds: ['verify']}],
};
const parameters = {
  issue: 'Rows with an empty value are lost.',
  context: 'Preserve input order.',
  readPaths: ['src/rows.mjs'],
  writePaths: ['src/rows.mjs'],
  checks: ['verify'],
};
const profile = {baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', displayName: 'Fixture', revision: 'r1', streaming: false};

function fixture(t, {manifest = {}, beta = false, activate = true} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-recipes-'));
  let now = 1700000000000;
  const c = new Coordinator({root, now: () => now, beta, ...(beta ? {selectedHost: 'codex'} : {}), workerProfile: beta ? profile : undefined});
  t.after(() => {
    c.close();
    rmSync(root, {recursive: true, force: true});
  });
  const d = new Dispatcher({c, config: {beta}});
  const raw = {submissionId: 'approved-fixture', environment: 'fixture', objective: 'Keep the row processing behavior correct',
    acceptance: ['Protected checks pass'], project, mode: 'collaborative', ...manifest};
  const g = c.prepareGoal(raw, 'prepare');
  if (activate) c.activateGoal({goalId: g.id, hash: g.hash}, 'approve');
  return {c, d, g, raw, root, advance: ms => { now += ms; }};
}

const preview = ({d, g}, overrides = {}) => d.invoke('workflow_recipe_preview', {
  goalId: g.id, recipeId: 'bugfix', version: 1, parameters, ...overrides,
});
function submitInput(f, p, overrides = {}) {
  return {goalId: f.g.id, recipeId: 'bugfix', version: 1, expectedGoalHash: p.goalHash,
    definitionDigest: p.definitionDigest, parameterDigest: p.parameterDigest, previewDigest: p.previewDigest,
    parameters, submissionId: 'fix-rows', idempotencyKey: 'submit-recipe', ...overrides};
}
const submit = ({d}, input) => d.invoke('workflow_recipe_submit', input);

function saved({c}) {
  const counts = Object.fromEntries(['records', 'commands', 'submissions', 'events', 'requests']
    .map(table => [table, c.store.db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count]));
  return {counts, registry: c.registry.snapshot(), tasks: c.store.all('task')};
}

test('public schemas are closed and preview of a draft is pure and readable', async t => {
  const f = fixture(t, {activate: false});
  const catalog = await f.d.invoke('workflow_recipe_list');
  assert.deepEqual(catalog.map(r => r.id).sort(), ['bugfix', 'feature', 'research-comparison']);
  const inspect = await f.d.invoke('workflow_recipe_inspect', {id: 'bugfix', version: 1});
  const before = saved(f), p = await preview(f);
  assert.equal(p.definitionDigest, inspect.definitionDigest);
  assert.equal(p.goalHash, f.g.hash);
  assert.equal(p.validTemplate, true);
  assert.equal(p.compatible, true);
  assert.equal(p.launchable, false);
  assert.ok(p.diagnostics.some(x => x.code === 'goal_inactive'));
  assert.equal(p.resolvedDigest, digest(p.resolvedDefinition));
  assert.deepEqual(p.resolvedDefinition.tasks[0].permissions, {
    readPaths: parameters.readPaths, writePaths: parameters.writePaths, checks: parameters.checks,
  });
  assert.deepEqual(p, await preview(f, {parameters: Object.fromEntries(Object.entries(parameters).reverse())}));
  const tools = f.d.tools().filter(x => x.name.startsWith('workflow_recipe_'));
  assert.equal(tools.length, 4);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
  await assert.rejects(preview(f, {force: true}), /unknown field force/);
  await assert.rejects(preview(f, {parameters: {...parameters, command: ['rm', '-r']}}), /parameter|field/i);
  const input = submitInput(f, p);
  const {idempotencyKey, ...unkeyed} = input;
  await assert.rejects(submit(f, unkeyed), /Missing idempotencyKey/);
  await assert.rejects(submit(f, {...input, force: true}), /unknown field force/);
  await assert.rejects(submit(f, input), /not active/i);
  assert.deepEqual(saved(f), before);
});

test('a changed parameter or approval digest cannot reuse preview A or create any task', async t => {
  const f = fixture(t), p = await preview(f), before = saved(f);
  assert.equal(p.launchable, true);
  await assert.rejects(submit(f, submitInput(f, p, {parameters: {...parameters, issue: 'B'}})), /parameter|preview/i);
  for (const field of ['definitionDigest', 'previewDigest', 'parameterDigest', 'expectedGoalHash']) {
    await assert.rejects(submit(f, submitInput(f, p, {[field]: '0'.repeat(64)})), /digest|approval|preview/i);
  }
  assert.deepEqual(saved(f), before);
});

test('concurrent duplicates and restart replay return the same pinned task and workflow IDs', async t => {
  const f = fixture(t), p = await preview(f), input = submitInput(f, p);
  const [a, b, retry] = await Promise.all([
    submit(f, input), submit(f, input), submit(f, {...input, idempotencyKey: 'other-retry'}),
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(a, retry);
  const task = f.c.getTask(a.tasks[0]);
  assert.equal(task.spec.context, parameters.context);
  assert.deepEqual(task.spec.permissions, {readPaths: parameters.readPaths, writePaths: parameters.writePaths, checks: parameters.checks});
  assert.equal(task.goalVersion, f.g.version);
  assert.equal(a.goalHash, f.g.hash);
  assert.equal(a.definitionDigest, p.definitionDigest);
  assert.equal(a.parameterDigest, p.parameterDigest);
  assert.equal(a.previewDigest, p.previewDigest);
  assert.equal(f.c.store.get('workflow_run', a.workflowRunId).definitionHash, p.resolvedDigest);
  assert.deepEqual(f.c.store.get('workflow_recipe_run', a.id), a);
  assert.equal(f.c.store.all('task').length, 1);
  assert.deepEqual(f.c.registry.snapshot().workflows, []);
  const secondParams = {...parameters, issue: 'A different bug.'};
  const second = await preview(f, {parameters: secondParams});
  await assert.rejects(submit(f, submitInput(f, second, {parameters: secondParams})), /Idempotency key conflict/);
  await assert.rejects(submit(f, submitInput(f, second, {parameters: secondParams, idempotencyKey: 'different-key'})), /Submission conflict/);
  const independent = await submit(f, submitInput(f, second, {parameters: secondParams, submissionId: 'fix-other', idempotencyKey: 'second-run'}));
  assert.notDeepEqual(independent.tasks, a.tasks);
  assert.notEqual(independent.parameterDigest, a.parameterDigest);
  assert.equal(f.c.getTask(a.tasks[0]).spec.objective, parameters.issue);

  f.c.control({goalId: f.g.id, action: 'stop'}, 'stop');
  const reopened = new Coordinator({root: f.root});
  t.after(() => reopened.close());
  const restarted = {d: new Dispatcher({c: reopened})};
  assert.deepEqual(await submit(restarted, input), a);
  assert.deepEqual(await submit(restarted, {...input, idempotencyKey: 'restart-retry'}), a);
  assert.deepEqual(reopened.registry.snapshot().workflows, []);
  assert.equal(reopened.getGoal(f.g.id).tasks.length, 2);
});

for (const kind of ['revision', 'same-hash revision', 'mode change', 'stop', 'expiry', 'task cap']) {
  test(`${kind} after preview prevents a new recipe workflow and preserves spending`, async t => {
    const f = fixture(t, {manifest: {limits: {maxTasks: 1, hours: 1, taskLimits: {coding: {modelCalls: 1}}}}});
    const p = await preview(f), input = submitInput(f, p);
    if (kind.endsWith('revision') || kind === 'mode change') {
      const manifest = kind === 'mode change' ? {...f.raw, mode: 'codex_only'} : kind === 'revision'
        ? {...f.raw, objective: 'Revised approval'} : f.raw;
      const r = await f.d.invoke('goal_revision_prepare', {goalId: f.g.id, expectedHash: f.g.hash, manifest, idempotencyKey: 'revision'});
      await f.d.invoke('goal_revision_activate', {revisionId: r.id, hash: r.hash, idempotencyKey: 'approve-revision'});
    } else if (kind === 'stop') {
      f.c.control({goalId: f.g.id, action: 'stop'}, 'stop');
    } else if (kind === 'expiry') {
      f.advance(3600000);
    } else {
      const task = f.c.submitTask({goalId: f.g.id, submissionId: 'first-task', kind: 'coding',
        objective: 'Consume the approved slot', acceptance: ['Verify']}, 'first');
      f.c.claimNext('fixture-owner');
      f.c.reserve(task.id, {kind: 'model', key: 'already-spent'}, 'fixture-owner');
    }
    const before = saved(f), deadline = f.c.getGoal(f.g.id).deadline;
    await assert.rejects(submit(f, input), /approval|preview|not active|deadline|task cap/i);
    assert.deepEqual(saved(f), before);
    assert.equal(f.c.getGoal(f.g.id).deadline, deadline);
  });
}

test('beta recipes use the exact approved profile and hide the generic register tool', async t => {
  const f = fixture(t, {beta: true, manifest: {mode: 'deepseek_only', limits: {taskLimits: {coding: {modelCalls: 1}}}}});
  assert.equal(f.d.tools().some(x => x.name === 'workflow_register'), false);
  const p = await preview(f);
  assert.equal(p.launchable, true);
  assert.equal(p.goalHash, digest(f.c.getGoal(f.g.id).manifest));
  assert.deepEqual(f.c.getGoal(f.g.id).manifest.workerProfile, f.c.workerProfile);
  const first = await submit(f, submitInput(f, p));
  assert.equal(f.c.getTask(first.tasks[0]).spec.actor, 'deepseek');
  assert.equal(f.c.getTask(first.tasks[0]).spec.limits.modelCalls, 1);
  const before = saved(f);
  f.c.workerProfile = {...f.c.workerProfile, revision: 'r2'};
  assert.equal((await preview(f)).launchable, false);
  await assert.rejects(submit(f, submitInput(f, p, {submissionId: 'other', idempotencyKey: 'profile-drift'})), /profile/i);
  assert.deepEqual(saved(f), before);
});

test('Codex-only recipe defaults to native execution and parks research in core and beta', async t => {
  const f = fixture(t, {manifest: {mode: 'codex_only'}});
  const feature = {recipeId: 'feature', parameters: {
    brief: 'Support an extra output field.', acceptance: 'The selected field is exported.',
    readPaths: parameters.readPaths, writePaths: parameters.writePaths, checks: parameters.checks,
  }};
  const p = await preview(f, feature);
  const run = await submit(f, submitInput(f, p, feature));
  assert.equal(f.c.getTask(run.tasks[0]).spec.acceptance[0], feature.parameters.acceptance);
  assert.equal(f.c.getTask(run.tasks[0]).status, 'codex_ready');
  assert.equal(f.c.getTask(run.tasks[0]).spec.actor, 'codex');
  const input = {recipeId: 'research-comparison', parameters: {question: 'Which format is easier to check?',
    alternatives: 'CSV and JSON', constraints: 'Public evidence only', asOf: '2026-11-10'}};
  for (const beta of [false, true]) {
    const research = fixture(t, {beta}), before = saved(research);
    const blocked = await preview(research, input);
    assert.equal(blocked.validTemplate, true);
    assert.equal(blocked.launchable, false);
    assert.ok(blocked.diagnostics.some(x => x.code === 'research_parked'));
    assert.equal(blocked.resolvedDefinition.tasks[0].kind, 'research');
    await assert.rejects(submit(research, submitInput(research, blocked, input)), /research.*parked/i);
    assert.deepEqual(saved(research), before);
  }
});

test('overnight v2 recipe preview explains planner ownership and refuses submission', async t => {
  const f = fixture(t, {activate: false, manifest: {mode: 'overnight_review', modeVersion: 2,
    overnightPolicy: {preflightCheckIds: ['verify'], finalOnlyCheckIds: []}}});
  // Simulate the saved state after preflight and activation. This test never
  // starts the planner or a worker. The existing regression suite runs preflight.
  const active = f.c.store.get('goal', f.g.id);
  active.status = 'active';
  active.activatedAt = f.c.now();
  active.deadline = f.c.now() + 3600000;
  f.c.store.put('goal', active);
  const p = await preview(f), before = saved(f);
  assert.equal(p.launchable, false);
  assert.ok(p.diagnostics.some(x => /planner graph/.test(x.message)));
  assert.equal(p.diagnostics.some(x => x.code === 'goal_inactive'), false);
  await assert.rejects(submit(f, submitInput(f, p)), /planner graph/);
  assert.deepEqual(saved(f), before);

  const definition = {...p.resolvedDefinition, mode: 'overnight_review'};
  await f.d.invoke('workflow_register', {definition, idempotencyKey: 'generic-definition'});
  const registered = saved(f);
  await assert.rejects(f.d.invoke('workflow_submit', {goalId: f.g.id, workflowId: definition.id,
    version: 1, submissionId: 'generic-workflow', idempotencyKey: 'generic-submit'}), /role/i);
  assert.deepEqual(saved(f), registered);
});

test('compiled registry version collision fails without adopting an existing workflow', async t => {
  const f = fixture(t), p = await preview(f);
  f.c.registry.registerWorkflow({...p.resolvedDefinition,
    tasks: p.resolvedDefinition.tasks.map(task => ({...task, objective: 'A different workflow'})),
  });
  const before = saved(f);
  assert.equal((await preview(f)).launchable, false);
  await assert.rejects(submit(f, submitInput(f, p)), /workflow.*conflict/i);
  assert.deepEqual(saved(f), before);
});

test('normal workflow registration and atomic expansion preserve optional fields and legacy hashes', async t => {
  const f = fixture(t), {c, d, g} = f;
  const legacy = {id: 'legacy', version: 1, mode: 'collaborative',
    tasks: [{key: 'one', kind: 'coding', objective: 'Legacy objective', acceptance: ['Legacy acceptance']}]};
  const registered = await d.invoke('workflow_register', {definition: legacy, idempotencyKey: 'legacy-definition'});
  assert.deepEqual(registered, legacy);
  assert.equal(digest(registered), digest(legacy));
  const legacyRun = c.submitWorkflow({goalId: g.id, workflowId: 'legacy', version: 1, submissionId: 'legacy-run'}, 'legacy-submit');
  assert.equal(c.getTask(legacyRun.tasks[0]).spec.context, '');
  assert.deepEqual(c.getTask(legacyRun.tasks[0]).spec.permissions.checks, ['verify', 'format']);
  const contextOnly = {key: 'context', kind: 'coding', objective: 'With context', context: 'Bounded context', acceptance: ['Pass']};
  const scoped = {key: 'scoped', kind: 'coding', objective: 'Narrow scope', acceptance: ['Pass'], dependsOn: ['context'],
    permissions: {readPaths: ['src/rows.mjs'], writePaths: ['src/rows.mjs'], checks: ['verify']}};
  const workflow = {id: 'optional', version: 1, mode: 'collaborative', tasks: [scoped, contextOnly]};
  await d.invoke('workflow_register', {definition: workflow, idempotencyKey: 'optional-definition'});
  const run = await d.invoke('workflow_submit', {goalId: g.id, workflowId: 'optional', version: 1,
    submissionId: 'optional-run', idempotencyKey: 'optional-submit'});
  const [a, b] = run.tasks.map(id => c.getTask(id));
  assert.equal(a.spec.context, contextOnly.context);
  assert.deepEqual(a.spec.permissions.checks, ['verify', 'format']);
  assert.deepEqual(b.spec.permissions, scoped.permissions);
  assert.deepEqual(b.spec.dependsOn, [a.id]);
  assert.throws(() => c.registry.registerWorkflow({...workflow,
    tasks: [scoped, {...contextOnly, context: 'Different context'}]}), /exists/i);
  assert.throws(() => c.registry.registerWorkflow({...workflow,
    tasks: [{...scoped, permissions: {...scoped.permissions, checks: ['format']}}, contextOnly]}), /exists/i);
  for (const [id, permissions, error] of [
    ['scope', {...scoped.permissions, writePaths: ['outside/']}, /scope/i],
    ['unknown-check', {...scoped.permissions, checks: ['unknown']}, /unknown check/i],
    ['omitted-mapping', {...scoped.permissions, checks: ['format']}, /required behavioral check/i],
  ]) {
    c.registry.registerWorkflow({...workflow, id, tasks: [contextOnly, {...scoped, permissions}]});
    const before = saved(f);
    assert.throws(() => c.submitWorkflow({goalId: g.id, workflowId: id, version: 1, submissionId: id}, 'submit-' + id), error);
    assert.deepEqual(saved(f), before);
  }
  assert.equal(canonical(c.registry.workflows.get('legacy@1')), canonical(legacy));
});

test('ten workflow stages fit the existing goal cap, eleven exceed the definition bound', t => {
  const f = fixture(t), {c, g} = f;
  const stages = Array.from({length: 11}, (_, index) => ({
    key: 'stage-' + index, kind: 'coding', objective: 'Stage ' + index, acceptance: ['Pass'],
    ...(index === 0 ? {} : {dependsOn: ['stage-' + (index - 1)]}),
  }));
  const definition = {id: 'ten', version: 1, mode: 'collaborative', tasks: stages.slice(0, 10)};
  assert.throws(() => c.registry.registerWorkflow({...definition, tasks: stages}), /workflow tasks/i);
  c.registry.registerWorkflow(definition);
  const run = c.submitWorkflow({goalId: g.id, workflowId: 'ten', version: 1, submissionId: 'ten'}, 'ten');
  assert.equal(run.tasks.length, 10);
  assert.equal(c.getGoal(g.id).tasks.length, 10);
});

test('registering a new recipe version preserves the original receipt and task bytes', async t => {
  const {WorkflowRecipes} = await import('../src/harness/workflow-recipes/service.mjs');
  const f = fixture(t), recipes = new WorkflowRecipes({c: f.c});
  const v1 = recipes.inspect({id: 'bugfix', version: 1});
  const p1 = recipes.preview({goalId: f.g.id, recipeId: 'bugfix', version: 1, parameters});
  const {idempotencyKey, ...input} = submitInput(f, p1);
  const run1 = recipes.submit(input, idempotencyKey);
  const pinnedBefore = canonical(f.c.store.get('workflow_recipe_run', run1.id));
  const specsBefore = run1.tasks.map(id => canonical(f.c.getTask(id).spec));

  const v2 = {...v1.definition, version: 2, title: 'Bugfix with additional evidence',
    tasks: v1.definition.tasks.map(task => ({...task, acceptance: [...task.acceptance, 'Record the reproduction.']}))};
  const registered = recipes.register(v2);
  assert.notEqual(registered.definitionDigest, v1.definitionDigest);
  registered.definition.tasks[0].objective = 'Attempt to rewrite the catalog';
  assert.deepEqual(recipes.inspect({id: 'bugfix', version: 2}).definition, v2);
  assert.deepEqual(recipes.register(v1.definition), v1);
  assert.throws(() => recipes.register({...v1.definition, title: 'Conflicting version'}), /version conflict/i);
  const p2 = recipes.preview({goalId: f.g.id, recipeId: 'bugfix', version: 2, parameters});
  assert.equal(p2.launchable, true);
  assert.throws(() => recipes.submit({...input, version: 2, submissionId: 'new-version'}, 'stale-version'), /digest mismatch/i);
  const {idempotencyKey: key2, ...input2} = submitInput(f, p2, {version: 2, submissionId: 'new-version', idempotencyKey: 'v2'});
  const run2 = recipes.submit(input2, key2);
  assert.notEqual(run1.id, run2.id);
  assert.notEqual(run1.definitionDigest, run2.definitionDigest);
  assert.equal(canonical(f.c.store.get('workflow_recipe_run', run1.id)), pinnedBefore);
  assert.deepEqual(run1.tasks.map(id => canonical(f.c.getTask(id).spec)), specsBefore);
});

test('a failure after the first actual stage rolls back all records and releases temporary registration', async t => {
  const {WorkflowRecipes} = await import('../src/harness/workflow-recipes/service.mjs');
  const f = fixture(t), recipes = new WorkflowRecipes({c: f.c});
  recipes.register({schemaVersion: 1, id: 'two-stage', version: 1, title: 'Two fixture stages',
    mode: 'collaborative', parameters: {}, provenance: {source: 'fixture', description: 'Rollback exercise'},
    tasks: [
      {key: 'first', kind: 'coding', objective: 'First stage', acceptance: ['Pass']},
      {key: 'second', kind: 'coding', objective: 'Second stage', acceptance: ['Pass'], dependsOn: ['first']},
    ],
  });
  const p = recipes.preview({goalId: f.g.id, recipeId: 'two-stage', version: 1, parameters: {}});
  assert.equal(p.launchable, true);
  const {idempotencyKey, ...input} = submitInput(f, p, {recipeId: 'two-stage', parameters: {}});
  const before = saved(f), submitTask = f.c.submitTask.bind(f.c);
  let observedFirstStage = false;
  f.c.submitTask = (stage, key) => {
    if (stage.submissionId.endsWith('-second')) {
      observedFirstStage = f.c.store.all('task').length === 1;
      throw Error('Fixture: final stage failed');
    }
    return submitTask(stage, key);
  };
  assert.throws(() => recipes.submit(input, idempotencyKey), /final stage failed/);
  assert.equal(observedFirstStage, true);
  assert.deepEqual(saved(f), before);
  f.c.submitTask = submitTask;
  const run = recipes.submit(input, idempotencyKey);
  assert.equal(run.tasks.length, 2);
  assert.deepEqual(f.c.getTask(run.tasks[1]).spec.dependsOn, [run.tasks[0]]);
  assert.deepEqual(f.c.registry.snapshot().workflows, []);
});

test('a saved manifest that differs from its approval hash cannot launch', async t => {
  const f = fixture(t);
  const changed = f.c.store.get('goal', f.g.id);
  changed.manifest.objective = 'An unapproved change to the saved approval';
  f.c.store.put('goal', changed);
  const p = await preview(f), before = saved(f);
  assert.equal(p.launchable, false);
  await assert.rejects(submit(f, submitInput(f, p)), /manifest.*approval hash/i);
  assert.deepEqual(saved(f), before);
});

test('a successful submission pins recipe identity across catalogs and restarts', async t => {
  const {WorkflowRecipes} = await import('../src/harness/workflow-recipes/service.mjs');
  const f = fixture(t);
  const first = new WorkflowRecipes({c: f.c}), second = new WorkflowRecipes({c: f.c});
  const {definition} = first.inspect({id: 'bugfix', version: 1});
  const v2 = {...definition, version: 2}, changed = {...v2, title: 'Incompatible reuse'};
  first.register(v2);
  second.register(changed);
  const view = {goalId: f.g.id, recipeId: 'bugfix', version: 2, parameters};
  const p1 = first.preview(view), p2 = second.preview(view);
  assert.equal(p1.launchable, true);
  assert.equal(p2.launchable, true);
  const {idempotencyKey, ...input} = submitInput(f, p1, {version: 2});
  first.submit(input, idempotencyKey);

  const blocked = second.preview(view);
  assert.equal(blocked.launchable, false);
  assert.ok(blocked.diagnostics.some(d => /recipe definition version conflict/i.test(d.message)));
  const {idempotencyKey: key2, ...input2} = submitInput(f, p2, {version: 2, submissionId: 'conflicting', idempotencyKey: 'other'});
  const before = saved(f);
  assert.throws(() => second.submit(input2, key2), /recipe definition version conflict/i);
  assert.deepEqual(saved(f), before);

  const reopened = new Coordinator({root: f.root});
  t.after(() => reopened.close());
  const restored = new WorkflowRecipes({c: reopened});
  assert.throws(() => restored.register(changed), /recipe definition version conflict/i);
  assert.equal(restored.register(v2).definitionDigest, p1.definitionDigest);
});

test('forwarding explicit workflow permissions cannot widen an approved placeholder file into a directory', async t => {
  const f = fixture(t, {manifest: {project: {...project,
    readPaths: ['src/placeholder'], writePaths: ['src/placeholder'],
  }}});
  const definition = {id: 'scope-guard', version: 1, mode: 'collaborative', tasks: [
    {key: 'first', kind: 'coding', objective: 'Exact approved file', acceptance: ['Pass']},
    {key: 'second', kind: 'coding', objective: 'Unapproved directory', acceptance: ['Pass'], dependsOn: ['first'],
      permissions: {readPaths: ['src/'], writePaths: ['src/'], checks: ['verify']}},
  ]};
  await f.d.invoke('workflow_register', {definition, idempotencyKey: 'register-scope-guard'});
  const before = saved(f);
  await assert.rejects(f.d.invoke('workflow_submit', {goalId: f.g.id, workflowId: definition.id,
    version: 1, submissionId: 'scope-guard', idempotencyKey: 'submit-scope-guard'}), /scope/i);
  assert.deepEqual(saved(f), before);
});
