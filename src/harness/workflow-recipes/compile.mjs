import {Registry, digest, normalizeTask} from '../contracts.mjs';
import {isOvernightV2} from '../overnight.mjs';
import {matches} from '../../project/contracts.mjs';
import {assertRecipeSize, validateRecipeDefinition, validateRecipeParameters} from './schema.mjs';

function resolveTask(task, parameters) {
  const resolve = value => {
    if (typeof value === 'string' || Array.isArray(value)) return value;
    return Object.hasOwn(parameters, value.parameter) ? parameters[value.parameter] : undefined;
  };
  const objective = resolve(task.objective);
  if (objective === undefined) throw Error('Missing objective parameter for task ' + task.key);
  const acceptance = task.acceptance.map(resolve).filter(value => value !== undefined);
  if (!acceptance.length) throw Error('Missing acceptance for task ' + task.key);
  if (new Set(acceptance).size !== acceptance.length) throw Error('Duplicate resolved acceptance for task ' + task.key);

  const resolved = {key: task.key, kind: task.kind, objective, acceptance};
  if (Object.hasOwn(task, 'context')) {
    const context = resolve(task.context);
    if (context !== undefined) resolved.context = context;
  }
  if (Object.hasOwn(task, 'dependsOn')) resolved.dependsOn = [...task.dependsOn];
  if (Object.hasOwn(task, 'permissions')) {
    resolved.permissions = Object.fromEntries(Object.entries(task.permissions).map(([name, template]) => {
      const value = resolve(template);
      if (value === undefined) throw Error('Missing ' + name + ' parameter for task ' + task.key);
      return [name, [...value]];
    }));
  }
  return resolved;
}

function validateCodingScope(permissions, project) {
  for (const name of ['readPaths', 'writePaths']) {
    // Check the directory scope itself. An approved file named "placeholder"
    // must not authorize every file in its parent directory.
    if (permissions[name].some(scope => !matches(scope, project[name]))) throw Error('Task expands scope');
  }
  if (permissions.writePaths.some(scope => !matches(scope, permissions.readPaths))) {
    throw Error('Task write paths must be within its read scope');
  }
}

function describeTask(task, mode, project) {
  const actor = mode.actors.includes('deepseek') ? 'deepseek' : 'codex';
  let permissions = task.permissions ?? null;
  if (!permissions && task.kind === 'research') permissions = {readPaths: [], writePaths: [], checks: []};
  if (!permissions && project) {
    permissions = {readPaths: project.readPaths, writePaths: project.writePaths, checks: project.checks.map(check => check.id)};
  }
  return {key: task.key, kind: task.kind, actor, permissions: structuredClone(permissions)};
}

export function compileRecipe({definition, parameters, goal, registry}) {
  const recipe = validateRecipeDefinition(definition);
  const values = validateRecipeParameters(parameters, recipe.parameters);
  const registered = new Map();
  for (const id of [].concat(recipe.mode)) {
    try {
      registered.set(id, registry.mode(id));
    } catch (error) {
      throw Error('Unknown registered recipe mode ' + id, {cause: error});
    }
  }
  const manifest = goal.manifest;
  const compatibleMode = registered.has(manifest.mode.id);
  const mode = compatibleMode ? manifest.mode.id : registered.keys().next().value;
  const definitionDigest = digest(recipe), parameterDigest = digest(values);
  const resolvedDefinition = {
    id: 'recipe-' + digest({definitionDigest, parameterDigest, mode}),
    version: recipe.version, mode, tasks: recipe.tasks.map(task => resolveTask(task, values)),
  };
  assertRecipeSize(resolvedDefinition, 'Resolved workflow');
  const diagnostics = [];
  if (!compatibleMode) diagnostics.push({
    code: 'mode_mismatch',
    message: 'Recipe supports ' + [...registered.keys()].join(', ') + '; approved goal uses ' + manifest.mode.id,
  });

  // Workflow registration uses the latest registered mode, while actual task
  // normalization uses the version and capabilities pinned in the saved goal.
  const latest = registered.get(mode);
  for (const task of resolvedDefinition.tasks) {
    if (!latest.capabilities.includes(task.kind)) diagnostics.push({
      code: 'workflow_capability', taskKey: task.key,
      message: 'Registered mode ' + mode + ' v' + latest.version + ' prohibits workflow capability ' + task.kind,
    });
  }
  if (!diagnostics.some(diagnostic => diagnostic.code === 'workflow_capability')) {
    const isolated = new Registry();
    isolated.modes.clear();
    isolated.registerMode(latest);
    isolated.registerWorkflow(resolvedDefinition);
  }

  const requirements = {
    mode,
    tasks: resolvedDefinition.tasks.map(task => {
      const requirement = describeTask(task, compatibleMode ? manifest.mode : latest, compatibleMode ? manifest.project : null);
      if (compatibleMode && !isOvernightV2(manifest)) {
        const {key, ...spec} = task;
        try {
          // A stable local key suffices for validation. The coordinator maps
          // dependencies to actual task IDs when submitting the workflow.
          const normalized = normalizeTask({...spec, submissionId: key}, manifest, registry);
          if (task.kind === 'coding') validateCodingScope(normalized.permissions, manifest.project);
          requirement.actor = normalized.actor;
          requirement.permissions = normalized.permissions;
        } catch (error) {
          diagnostics.push({code: 'task_contract', taskKey: key, message: error.message});
        }
      }
      return requirement;
    }),
  };
  return {definitionDigest, parameterDigest, resolvedDefinition, resolvedDigest: digest(resolvedDefinition), requirements, diagnostics};
}
