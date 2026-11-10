import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry, digest, normalizeGoal} from '../src/harness/contracts.mjs';
import {validateParameterPayload, validateRecipeDefinition} from '../src/harness/workflow-recipes/schema.mjs';
import {compileRecipe} from '../src/harness/workflow-recipes/compile.mjs';
import bugfix from '../src/harness/workflow-recipes/definitions/bugfix.v1.json' with {type: 'json'};
import feature from '../src/harness/workflow-recipes/definitions/feature.v1.json' with {type: 'json'};
import researchComparison from '../src/harness/workflow-recipes/definitions/research-comparison.v1.json' with {type: 'json'};

const project = {
  repo: '/fixture/repo', baseCommit: 'a'.repeat(40), readPaths: ['src/'], writePaths: ['src/'],
  checks: [{id: 'verify', argv: ['private-fixture-command']}, {id: 'behavior', argv: ['second-command']}],
};

function goalRecord(registry, overrides = {}) {
  const manifest = normalizeGoal({
    submissionId: 'recipe-fixture', objective: 'Complete fixture work', acceptance: ['Evidence recorded'],
    environment: 'fixture', project, ...overrides,
  }, registry);
  return {id: 'fixture', version: 1, hash: digest(manifest), manifest};
}

function definition() {
  return {
    schemaVersion: 1, id: 'fix', version: 1, title: 'Fix an issue', mode: ['collaborative', 'codex_only'],
    parameters: {
      issue: {type: 'text'}, context: {type: 'text', required: false},
      paths: {type: 'paths'}, checks: {type: 'checks'}, outcome: {type: 'enum', values: ['Pass', 'Verified']},
    },
    tasks: [{
      key: 'fix', kind: 'coding', objective: {parameter: 'issue'}, context: {parameter: 'context'},
      acceptance: [{parameter: 'outcome'}, 'Preserve literal ${issue}'],
      permissions: {readPaths: {parameter: 'paths'}, writePaths: {parameter: 'paths'}, checks: {parameter: 'checks'}},
    }],
    provenance: {source: 'Mosaic', description: 'Fixture'},
  };
}

const parameters = {
  issue: 'Fix ${still-literal}', paths: ['src/a.mjs'], checks: ['verify'], outcome: 'Verified',
};

test('legacy workflow bytes and omitted optional fields survive registration', () => {
  const registry = new Registry();
  const original = {id: 'legacy-example', version: 1, mode: 'collaborative', tasks: [
    {key: 'fix', kind: 'coding', objective: 'Fix the issue', acceptance: ['Checks pass']},
  ]};
  const stored = registry.registerWorkflow(original);
  assert.deepEqual(stored, original);
  assert.equal(digest(stored), '0ae6ae2848c0ef9ecb1ada90e66b9694f26b5a4fc83cafe7e933618f1deac205');
});

test('workflow registration keeps optional fields exact and rejects malformed permissions', () => {
  const registry = new Registry();
  const task = {key: 'fix', kind: 'coding', objective: 'Fix the issue', acceptance: ['Checks pass'], context: 'Relevant context'};
  const original = {id: 'new-example', version: 1, mode: 'collaborative', tasks: [task]};
  assert.deepEqual(registry.registerWorkflow(original), original);
  const permissions = {readPaths: ['src/'], writePaths: ['src/a.mjs'], checks: ['verify']};
  const changed = {...original, tasks: [{...task, permissions}]};
  assert.throws(() => registry.registerWorkflow(changed), /already exists/);
  assert.deepEqual(registry.registerWorkflow({...changed, version: 2}).tasks[0].permissions, permissions);
  assert.throws(() => registry.registerWorkflow({
    ...changed, version: 3, tasks: [{...task, permissions: {...permissions, argv: ['node']}}],
  }), /unknown field argv/);
  assert.throws(() => registry.registerWorkflow({
    ...changed, version: 3, tasks: [{...task, permissions: {...permissions, readPaths: ['../outside']}}],
  }), /Unsafe relative path/);
});

test('recipe validation returns an independent clone and rejects undeclared and unused required parameters', () => {
  const raw = definition();
  const valid = validateRecipeDefinition(raw);
  assert.deepEqual(valid, raw);
  valid.tasks[0].objective.parameter = 'other';
  assert.equal(raw.tasks[0].objective.parameter, 'issue');

  const missing = definition();
  missing.tasks[0].objective.parameter = 'unknown';
  assert.throws(() => validateRecipeDefinition(missing), /undeclared parameter.*unknown/i);
  const unused = definition();
  unused.parameters.unused = {type: 'text'};
  assert.throws(() => validateRecipeDefinition(unused), /unused required parameter.*unused/i);
});

test('recipes reject authority fields, mistyped references, executable check data and non-JSON shapes', () => {
  for (const [mutate, expected] of [
    [d => { d.tasks[0].actor = 'codex'; }, /unknown field actor/],
    [d => { d.tasks[0].role = 'final'; }, /unknown field role/],
    [d => { d.tasks[0].scope = {}; }, /unknown field scope/],
    [d => { d.tasks[0].permissions.argv = ['node']; }, /unknown field argv/],
    [d => { d.tasks[0].permissions.checks = [{id: 'verify', argv: ['node']}]; }, /check/],
    [d => { d.tasks[0].permissions.checks = ['node -e bad']; }, /check/],
    [d => { d.tasks[0].permissions.readPaths = ['../outside']; }, /relative path/],
    [d => { d.tasks[0].permissions.readPaths = ['C:/absolute']; }, /relative path/],
    [d => { d.tasks[0].objective = {parameter: 'paths'}; }, /parameter type/],
    [d => { d.tasks[0].objective = {parameter: {parameter: 'issue'}}; }, /parameter/],
    [d => { d.tasks[0].objective = {parameter: 'issue', expand: true}; }, /unknown field expand/],
    [d => { d.tasks[0].kind = 'learning'; }, /kind/],
    [d => { d.parameters.issue.default = 'fallback'; }, /unknown field default/],
    [d => { d.tasks[0].acceptance = Array(1); }, /acceptance/],
    [d => { d.provenance = Object.create({source: 'inherited'}); }, /provenance/],
  ]) {
    const raw = definition();
    mutate(raw);
    assert.throws(() => validateRecipeDefinition(raw), expected);
  }
  for (const raw of [{issue: {shell: ['run']}}, {issue: Array(1)}, {issue: [true]}, {issue: 'x'.repeat(20001)}]) {
    assert.throws(() => validateParameterPayload(raw), /parameter/);
  }
  let accessed = false;
  const raw = {get issue() { accessed = true; return 'run'; }};
  assert.throws(() => validateParameterPayload(raw), /parameter/);
  assert.equal(accessed, false);
});

test('recipes bound the number of tasks and reject invalid dependency graphs', () => {
  const build = count => {
    const raw = definition();
    raw.tasks = Array.from({length: count}, (_, i) => ({
      ...structuredClone(raw.tasks[0]), key: 'task-' + i, ...(i > 0 ? {dependsOn: ['task-' + (i - 1)]} : {}),
    }));
    return raw;
  };
  assert.equal(validateRecipeDefinition(build(10)).tasks.length, 10);
  assert.throws(() => validateRecipeDefinition(build(11)), /tasks/);
  const duplicate = build(2);
  duplicate.tasks[1].key = duplicate.tasks[0].key;
  assert.throws(() => validateRecipeDefinition(duplicate), /duplicate.*task-0/i);
  const missing = build(2);
  missing.tasks[1].dependsOn = ['not-there'];
  assert.throws(() => validateRecipeDefinition(missing), /unknown.*not-there/i);
  const cyclic = build(2);
  cyclic.tasks[0].dependsOn = ['task-1'];
  assert.throws(() => validateRecipeDefinition(cyclic), /cycle.*task-0/i);
});

test('recipe keys leave room for the generated workflow-run task submission prefix', () => {
  const raw = definition();
  raw.tasks[0].key = 'k'.repeat(76);
  assert.equal(validateRecipeDefinition(raw).tasks[0].key, raw.tasks[0].key);
  raw.tasks[0].key += 'k';
  assert.throws(() => validateRecipeDefinition(raw), /task key.*76/);
});

test('parameter payloads reject custom array prototypes before iterating', () => {
  let accessed = false;
  class CustomArray extends Array {
    [Symbol.iterator]() {
      accessed = true;
      return super[Symbol.iterator]();
    }
  }
  assert.throws(() => validateParameterPayload({paths: new CustomArray('src/')}), /parameter/);
  assert.equal(accessed, false);
});

test('recipe bounds limit aggregate definition and parameter size', () => {
  const raw = definition();
  raw.tasks[0].acceptance.push(...Array.from({length: 15}, (_, i) => String(i) + 'x'.repeat(19000)));
  assert.throws(() => validateRecipeDefinition(raw), /definition.*size/i);
  const oversized = Object.fromEntries(Array.from({length: 15}, (_, i) => ['p' + i, 'x'.repeat(19000)]));
  assert.throws(() => validateParameterPayload(oversized), /parameter.*size/i);
});

test('compiler substitutes structured positions, preserves literals and canonicalizes key order', () => {
  const registry = new Registry(), goal = goalRecord(registry);
  const before = registry.snapshot();
  const input = {definition: definition(), parameters, goal, registry};
  const preview = compileRecipe(input);
  assert.deepEqual(preview.diagnostics, []);
  assert.equal(preview.resolvedDefinition.mode, 'collaborative');
  assert.deepEqual(preview.resolvedDefinition.tasks, [{
    key: 'fix', kind: 'coding', objective: 'Fix ${still-literal}',
    acceptance: ['Verified', 'Preserve literal ${issue}'],
    permissions: {readPaths: ['src/a.mjs'], writePaths: ['src/a.mjs'], checks: ['verify']},
  }]);
  assert.deepEqual(preview.requirements.tasks[0], {
    key: 'fix', kind: 'coding', actor: 'deepseek',
    permissions: {readPaths: ['src/a.mjs'], writePaths: ['src/a.mjs'], checks: ['verify']},
  });
  assert.deepEqual(registry.snapshot(), before);
  assert.match(preview.resolvedDefinition.id, /^recipe-[a-f0-9]{64}$/);
  assert.equal(preview.resolvedDigest, digest(preview.resolvedDefinition));
  const reordered = Object.fromEntries(Object.entries(parameters).reverse());
  assert.deepEqual(compileRecipe({...input, parameters: reordered}), preview);
  const changed = compileRecipe({...input, parameters: {...parameters, context: 'New issue details'}});
  assert.equal(changed.definitionDigest, preview.definitionDigest);
  assert.notEqual(changed.parameterDigest, preview.parameterDigest);
  assert.notEqual(changed.resolvedDigest, preview.resolvedDigest);
  assert.equal(changed.resolvedDefinition.tasks[0].context, 'New issue details');
  assert.equal(JSON.stringify(preview).includes('private-fixture-command'), false);
});

test('compiler rejects missing, extra, mistyped, traversing and out-of-enum parameters', () => {
  const registry = new Registry(), goal = goalRecord(registry);
  const run = input => compileRecipe({definition: definition(), parameters: input, goal, registry});
  const {issue, ...missing} = parameters;
  assert.throws(() => run(missing), /missing.*issue/i);
  assert.throws(() => run({...parameters, extra: 'not declared'}), /unknown.*extra/i);
  assert.throws(() => run({...parameters, issue: ['not text']}), /issue/);
  assert.throws(() => run({...parameters, paths: ['src/../other']}), /relative path/);
  assert.throws(() => run({...parameters, outcome: 'Untested'}), /outcome/);
});

test('compiler shows pinned defaults without changing a context-only workflow definition', () => {
  const registry = new Registry(), goal = goalRecord(registry, {mode: 'codex_only'});
  const raw = definition();
  delete raw.tasks[0].permissions;
  delete raw.parameters.paths;
  delete raw.parameters.checks;
  const preview = compileRecipe({definition: raw, parameters: {issue: 'Fix', outcome: 'Pass'}, goal, registry});
  assert.deepEqual(preview.diagnostics, []);
  assert.equal(preview.requirements.tasks[0].actor, 'codex');
  assert.deepEqual(preview.requirements.tasks[0].permissions, {
    readPaths: ['src/'], writePaths: ['src/'], checks: ['verify', 'behavior'],
  });
  assert.equal(Object.hasOwn(preview.resolvedDefinition.tasks[0], 'permissions'), false);
});

test('mode mismatch, disallowed capabilities and unpublished mode IDs are distinguishable', () => {
  const registry = new Registry(), goal = goalRecord(registry, {mode: 'deepseek_only'});
  const raw = definition();
  const run = () => compileRecipe({definition: raw, parameters, goal, registry});
  const incompatible = run();
  assert.equal(incompatible.resolvedDefinition.mode, 'collaborative');
  assert.equal(incompatible.diagnostics[0].code, 'mode_mismatch');
  assert.equal(incompatible.resolvedDefinition.tasks[0].key, 'fix');
  raw.mode.push('unregistered');
  assert.throws(run, /unknown.*mode.*unregistered/i);

  registry.registerMode({
    id: 'research-only', version: 1, planner: 'deepseek', actors: ['deepseek'], review: 'checks', capabilities: ['research'],
  });
  raw.mode = 'research-only';
  const limited = compileRecipe({definition: raw, parameters, goal: goalRecord(registry, {mode: raw.mode}), registry});
  assert.equal(limited.resolvedDefinition.tasks[0].kind, 'coding');
  assert.ok(limited.diagnostics.some(d => d.code === 'workflow_capability'));
});

test('compiler observes latest registry registration and the saved goal version independently', () => {
  const registry = new Registry();
  const oldGoal = goalRecord(registry);
  const raw = definition();
  registry.registerMode({
    id: 'collaborative', version: 2, planner: 'codex', actors: ['codex'], review: 'operator', capabilities: ['research'],
  });
  const preview = compileRecipe({definition: raw, parameters, goal: oldGoal, registry});
  assert.equal(preview.requirements.tasks[0].actor, 'deepseek');
  assert.ok(preview.diagnostics.some(d => d.code === 'workflow_capability'));
  assert.ok(!preview.diagnostics.some(d => d.code === 'task_contract'));

  const stripped = {...oldGoal, manifest: {...oldGoal.manifest, capabilities: []}};
  const pinned = compileRecipe({definition: raw, parameters, goal: stripped, registry});
  assert.ok(pinned.diagnostics.some(d => d.code === 'task_contract' && /pinned capability/i.test(d.message)));
});

test('compiler diagnoses unknown and omitted mapped checks without hiding resolved requests', () => {
  const registry = new Registry();
  const goal = goalRecord(registry, {project: {
    ...project, behavioralChecks: [{criterionId: 'Behavior', description: 'Required behavior', checkIds: ['behavior']}],
  }});
  for (const [check, pattern] of [['unknown', /Unknown check/], ['verify', /omits required behavioral check behavior/]]) {
    const preview = compileRecipe({definition: definition(), parameters: {...parameters, checks: [check]}, goal, registry});
    assert.deepEqual(preview.resolvedDefinition.tasks[0].permissions.checks, [check]);
    assert.ok(preview.diagnostics.some(d => d.code === 'task_contract' && pattern.test(d.message)));
  }
});

test('compiler never lets an approved placeholder file authorize its whole directory', () => {
  const registry = new Registry(), goal = goalRecord(registry, {project: {
    ...project, readPaths: ['src/placeholder'], writePaths: ['src/placeholder'],
  }});
  const preview = compileRecipe({definition: definition(), parameters: {...parameters, paths: ['src/']}, goal, registry});
  assert.ok(preview.diagnostics.some(d => d.code === 'task_contract' && /expands scope/.test(d.message)));
  const exact = compileRecipe({definition: definition(), parameters: {...parameters, paths: ['src/placeholder']}, goal, registry});
  assert.deepEqual(exact.diagnostics, []);
});

test('compiler diagnoses write permissions that are broader than the task read scope', () => {
  const registry = new Registry(), goal = goalRecord(registry);
  const raw = definition();
  raw.tasks[0].permissions.writePaths = ['src/'];
  const preview = compileRecipe({definition: raw, parameters, goal, registry});
  assert.ok(preview.diagnostics.some(d => d.code === 'task_contract' && /write.*read scope/i.test(d.message)));
});

test('built-in coding recipes compile with scoped checks and the selected mode actor', () => {
  const registry = new Registry();
  const scope = {readPaths: ['src/'], writePaths: ['src/a.mjs'], checks: ['verify']};
  const examples = [
    {definition: bugfix, values: {issue: 'Fix the ordering bug', context: 'Preserve older inputs', ...scope},
      expectedObjective: 'Fix the ordering bug', expectedContext: 'Preserve older inputs'},
    {definition: feature, values: {brief: 'Add an option', acceptance: 'Keep the prior default', ...scope},
      expectedObjective: 'Add an option', expectedAcceptance: 'Keep the prior default'},
  ];
  for (const [mode, actor] of [['collaborative', 'deepseek'], ['deepseek_only', 'deepseek'], ['codex_only', 'codex']]) {
    const goal = goalRecord(registry, {mode});
    for (const example of examples) {
      const result = compileRecipe({definition: example.definition, parameters: example.values, goal, registry});
      const [task] = result.resolvedDefinition.tasks;
      assert.deepEqual(result.diagnostics, []);
      assert.equal(task.kind, 'coding');
      assert.equal(task.objective, example.expectedObjective);
      assert.equal(task.context, example.expectedContext);
      if (example.expectedAcceptance) assert.ok(task.acceptance.includes(example.expectedAcceptance));
      assert.deepEqual(task.permissions, scope);
      assert.equal(result.requirements.tasks[0].actor, actor);
    }
  }
});

test('built-in research preview carries its brief and asks for evidence without granting coding permissions', () => {
  const registry = new Registry(), goal = goalRecord(registry, {project: null});
  const values = {question: 'Which queue preserves order?', alternatives: 'Compare A and B',
    constraints: 'Use original documentation', asOf: '2026-11-10'};
  const result = compileRecipe({definition: researchComparison, parameters: values, goal, registry});
  const [task] = result.resolvedDefinition.tasks;
  assert.deepEqual(result.diagnostics, []);
  assert.equal(task.kind, 'research');
  assert.equal(task.objective, values.question);
  assert.equal(task.context, values.alternatives);
  assert.ok(task.acceptance.includes(values.constraints));
  assert.ok(task.acceptance.includes(values.asOf));
  assert.ok(task.acceptance.some(criterion => /evidence.*contradictions/.test(criterion)));
  assert.deepEqual(result.requirements.tasks[0].permissions, {readPaths: [], writePaths: [], checks: []});
});
