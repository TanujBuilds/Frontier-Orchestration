import {digest, identifier, integer, keys} from '../contracts.mjs';
import {isOvernightV2} from '../overnight.mjs';
import {compileRecipe} from './compile.mjs';
import {validateParameterPayload, validateRecipeDefinition, normalizeRecipeTaskRouting} from './schema.mjs';
import {builtins} from './catalog.mjs';
import {routeDecision} from '../routing/runtime.mjs';

const previewFields = ['goalId', 'recipeId', 'version', 'parameters', 'taskRouting'];
const digestFields = ['expectedGoalHash', 'definitionDigest', 'previewDigest', 'parameterDigest'];
const submitFields = [...previewFields, ...digestFields, 'submissionId'];
const definitionKind = 'workflow_recipe_definition';
const versionKey = definition => `${definition.id}@${definition.version}`;

export class WorkflowRecipes {
  #definitions = new Map();

  constructor({c}) {
    this.c = c;
    // A saved version conflict disables submission for that recipe only.
    for (const definition of builtins) this.#saveDefinition(validateRecipeDefinition(definition), null);
  }

  // Catalog entries come from trusted data files. Public tools only read them.
  register(raw) {
    const definition = validateRecipeDefinition(raw);
    const pinned = this.c.store.maybe(definitionKind, versionKey(definition));
    return this.#saveDefinition(definition, pinned);
  }

  #saveDefinition(definition, pinned) {
    const definitionDigest = digest(definition);
    const key = versionKey(definition);
    const saved = this.#definitions.get(key);
    if ([saved, pinned].some(entry => entry && entry.definitionDigest !== definitionDigest)) {
      throw Error('Recipe definition version conflict');
    }
    if (!saved && this.#definitions.size >= 100) throw Error('Recipe catalog limit reached');
    if (!saved) this.#definitions.set(key, {definition, definitionDigest});
    return this.inspect(definition);
  }

  list() {
    return Array.from(this.#definitions.values(), ({definition, definitionDigest}) => {
      const {id, version, title, mode, provenance} = definition;
      return structuredClone({id, version, title, mode, provenance, definitionDigest});
    }).sort((a, b) => a.id.localeCompare(b.id, 'en') || a.version - b.version);
  }

  inspect({id, version}) {
    identifier(id, 'recipeId');
    integer(version, 'recipe version', 1, 10000);
    const saved = this.#definitions.get(`${id}@${version}`);
    if (!saved) throw Error('Unknown recipe version');
    return structuredClone(saved);
  }

  preview(input) {
    keys(input, previewFields, 'recipe preview');
    const {goalId, recipeId, version, parameters} = input;
    identifier(goalId, 'goalId');
    const goal = this.c.store.get('goal', goalId);
    const {definition} = this.inspect({id: recipeId, version});
    const compiled = compileRecipe({definition, parameters, taskRouting: input.taskRouting, goal, registry: this.c.registry,
      // Recipe keys are local graph names, not saved submission identities.
      // A fresh proposal must not inherit an unrelated task's historical pin.
      routePreview: spec => ({...routeDecision(this.c, goal, {id: null, spec}),
        expectedGoalHash: goal.hash, expectedGoalVersion: goal.version})});
    const {definitionDigest, parameterDigest, resolvedDigest, resolvedDefinition} = compiled;

    const diagnostics = [];
    const report = (code, message) => diagnostics.push({code, message});
    if (digest(goal.manifest) !== goal.hash) {
      report('goal_binding', 'Saved goal manifest differs from its approval hash.');
    }
    const pinned = this.c.store.maybe(definitionKind, versionKey(definition));
    if (pinned && pinned.definitionDigest !== definitionDigest) {
      report('recipe_version_conflict', 'Recipe definition version conflict.');
    }
    const overnight = goal.manifest.mode.id === 'overnight_review';
    if (overnight) {
      report('overnight_route', isOvernightV2(goal.manifest)
        ? 'Overnight v2 stages require an atomically validated planner graph.'
        : 'Overnight review uses its dedicated workflow. Recipes cannot submit stages to this mode.');
    }
    if (resolvedDefinition.tasks.some(task => task.kind === 'research')) {
      report('research_parked', 'Research execution is parked in this coding release. This recipe previews the research brief and evidence requirements only.');
    }
    diagnostics.push(...compiled.diagnostics);
    const compatible = !overnight && compiled.diagnostics.length === 0;
    if (this.c.registry.workflows.has(versionKey(resolvedDefinition))) {
      report('workflow_conflict', 'Compiled workflow version conflict.');
    }
    if (goal.status !== 'active') report('goal_inactive', `Goal is not active (${goal.status}).`);
    else if (this.c.now() >= goal.deadline) report('goal_expired', 'Goal deadline exceeded.');
    if (goal.integrationSealed && resolvedDefinition.tasks.some(task => task.kind === 'coding')) {
      report('integration_sealed', 'The preserved integration workspace is retired. Use a separately approved goal.');
    }
    const taskCount = this.c.store.all('task').filter(task => task.goalId === goalId).length;
    const remainingTaskSlots = Math.max(0, goal.manifest.limits.maxTasks - taskCount);
    if (resolvedDefinition.tasks.length > remainingTaskSlots) report('task_cap', 'Goal task cap reached for this workflow.');
    if (compatible && goal.status === 'active' && diagnostics.length === 0) {
      try {
        this.c.verifyGoalBinding(goal);
      } catch (error) {
        report('worker_binding', error.message);
      }
    }
    const binding = {goalId, goalVersion: goal.version, goalHash: goal.hash,
      recipeId, version, definitionDigest, parameterDigest, resolvedDigest};
    return {
      ...compiled, ...binding, schemaVersion: 1, previewDigest: digest(binding),
      mode: {id: goal.manifest.mode.id, version: goal.manifest.mode.version},
      goalDeadline: goal.deadline, remainingTaskSlots, validTemplate: true, compatible,
      launchable: diagnostics.length === 0, diagnostics,
    };
  }

  submit(input, key) {
    keys(input, submitFields, 'recipe submission');
    identifier(input.goalId, 'goalId');
    identifier(input.recipeId, 'recipeId');
    identifier(input.submissionId, 'submissionId');
    integer(input.version, 'recipe version', 1, 10000);
    for (const field of digestFields) {
      if (typeof input[field] !== 'string' || !/^[a-f0-9]{64}$/.test(input[field])) throw Error(`Invalid ${field} digest`);
    }
    const {c} = this;
    const {goalId, recipeId, version, submissionId, expectedGoalHash} = input;
    const parameters = validateParameterPayload(input.parameters);
    const taskRouting = normalizeRecipeTaskRouting(input.taskRouting);
    const request = {...input, parameters, ...(taskRouting === undefined ? {} : {taskRouting})};
    return c.store.command(key, {op: 'workflow.recipe.submit', ...request}, () =>
      c.store.submission('workflow_recipe_run', goalId, submissionId, digest(request), id => {
        const goal = c.store.get('goal', goalId);
        if (goal.hash !== expectedGoalHash) throw Error('Goal approval changed. Preview the recipe again.');
        const preview = this.preview({goalId, recipeId, version, parameters, ...(taskRouting === undefined ? {} : {taskRouting})});
        for (const field of ['definitionDigest', 'parameterDigest', 'previewDigest']) {
          if (input[field] !== preview[field]) throw Error(`Recipe ${field} mismatch. Preview the recipe again.`);
        }
        if (!preview.launchable) throw Error(preview.diagnostics[0].message);

        const definition = preview.resolvedDefinition;
        const registryKey = versionKey(definition);
        // Keep the compiled graph private to this synchronous transaction.
        // Persisting it in the registry would make it available to workflow_submit.
        c.registry.registerWorkflow(definition);
        let run;
        try {
          run = c.submitWorkflow({goalId, workflowId: definition.id, version: definition.version,
            submissionId: `recipe-${id}`}, `recipe-workflow-${id}`);
        } finally {
          c.registry.workflows.delete(registryKey);
        }
        const definitionId = `${recipeId}@${version}`;
        if (!c.store.maybe(definitionKind, definitionId)) {
          c.store.put(definitionKind, {id: definitionId, definitionDigest: preview.definitionDigest});
        }
        return {
          id, schemaVersion: 1, goalId, goalVersion: goal.version, goalHash: goal.hash,
          recipeId, version, submissionId, definitionDigest: preview.definitionDigest,
          parameterDigest: preview.parameterDigest, previewDigest: preview.previewDigest,
          resolvedDigest: preview.resolvedDigest, resolvedDefinition: definition,
          workflowRunId: run.id, tasks: run.tasks, at: run.at,
        };
      }),
    );
  }
}
