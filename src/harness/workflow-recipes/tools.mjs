import {WorkflowRecipes} from './service.mjs';
import {taskRoutingInputSchema} from '../contracts.mjs';

const id = {type: 'string', maxLength: 120};
const version = {type: 'integer', minimum: 1, maximum: 10000};
const hash = {type: 'string', minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$'};
const parameter = {type: 'string', maxLength: 20000};
const parameters = {
  type: 'object', maxProperties: 20,
  additionalProperties: {anyOf: [parameter, {type: 'array', maxItems: 100, items: parameter}]},
};

export function registerWorkflowRecipeTools({add, c}) {
  const recipes = new WorkflowRecipes({c});
  const taskRouting = {type: 'object', maxProperties: 10, propertyNames: {pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,75}$'}, additionalProperties: taskRoutingInputSchema};
  const preview = {goalId: id, recipeId: id, version, parameters, taskRouting};
  const submit = {...preview, expectedGoalHash: hash, definitionDigest: hash, previewDigest: hash,
    parameterDigest: hash, submissionId: id};
  add('workflow_recipe_list', 'List the available versioned workflow recipes.', {}, [], false, () => recipes.list());
  add('workflow_recipe_inspect', 'Read the exact recipe definition and digest.', {id, version}, ['id', 'version'],
    false, input => recipes.inspect(input));
  add('workflow_recipe_preview', 'Resolve a recipe against the saved goal and show eligibility without creating tasks.',
    preview, Object.keys(preview).filter(key => key !== 'taskRouting'), false, input => recipes.preview(input));
  add('workflow_recipe_submit', 'Create the exact previewed workflow inside an active approved goal.',
    submit, Object.keys(submit).filter(key => key !== 'taskRouting'), true, (input, key) => recipes.submit(input, key));
}
