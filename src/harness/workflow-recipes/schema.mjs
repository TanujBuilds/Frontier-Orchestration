import {canonical, identifier, integer, keys, text} from '../contracts.mjs';
import {relativePath} from '../../project/contracts.mjs';
import {normalizeTaskRouting} from '../routing/contracts.mjs';

const MAX_PARAMETERS = 20;
const MAX_ITEMS = 100;
// Workflow submission adds "recipe-" plus a UUID and a hyphen to each key.
const MAX_TASK_KEY = 76;
const MAX_BYTES = 256 * 1024;
const TEXT_TYPES = ['text', 'enum'];
const PERMISSION_TYPES = {readPaths: 'paths', writePaths: 'paths', checks: 'checks'};

function record(value, label, fields) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw Error(label + ' must be a plain data object');
  }
  const names = Reflect.ownKeys(value);
  if (!fields && names.length > MAX_PARAMETERS) throw Error('Too many ' + label + ' fields');
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (typeof name !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw Error(label + ' must contain only JSON data fields');
    }
  }
  if (fields) keys(value, fields, label);
  return value;
}

function list(value, label, {min = 1, max = MAX_ITEMS} = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < min || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1) {
    throw Error('Invalid ' + label + ' list');
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw Error('Invalid ' + label + ' list item');
    }
  }
  return value;
}

function validateList(value, label, validateItem, bounds) {
  for (const item of list(value, label, bounds)) validateItem(item, label);
  if (new Set(value).size !== value.length) throw Error('Duplicate ' + label + ' item');
}

function validatePermissionList(value, type, label, min = 1) {
  validateList(value, label, (item, itemLabel) => {
    if (type === 'checks') {
      if (!/^[a-z0-9-]+$/.test(text(item, itemLabel, 120))) throw Error('Invalid check ID in ' + itemLabel);
    } else {
      text(item, itemLabel, 1024);
      if (/^[a-z]:/i.test(item)) throw Error('Unsafe relative path in ' + itemLabel);
      relativePath(item.endsWith('/') ? item.slice(0, -1) : item);
    }
  }, {min});
}

export function assertRecipeSize(value, label) {
  if (Buffer.byteLength(canonical(value)) > MAX_BYTES) throw Error(label + ' exceeds the 256 KiB size limit');
}

export function validateParameterPayload(raw) {
  record(raw, 'recipe parameters');
  for (const [name, value] of Object.entries(raw)) {
    const label = 'parameter ' + identifier(name, 'parameter name');
    if (Array.isArray(value)) validateList(value, label, text);
    else text(value, label);
  }
  assertRecipeSize(raw, 'Recipe parameters');
  return structuredClone(raw);
}

// Routing is an explicit task-key map, separate from permission/template values.
// Absence must preserve every historical recipe identity and output byte.
export function normalizeRecipeTaskRouting(raw, tasks) {
  if (raw === undefined) return undefined;
  record(raw, 'recipe taskRouting');
  if (Object.keys(raw).length > 10) throw Error('Too many recipe taskRouting entries');
  // Submission identity can normalize before the saved receipt is replayed.
  // New submissions additionally validate keys against their trusted definition.
  const known = tasks && new Set(tasks.map(task => task.key));
  const entries = Object.entries(raw).map(([key, value]) => {
    identifier(key, 'routing task key');
    if (key.length > MAX_TASK_KEY || known && !known.has(key)) throw Error('Unknown recipe routing task key ' + key);
    const routing = normalizeTaskRouting(value);
    if (!routing) throw Error('Recipe task routing requires a versioned object');
    return [key, routing];
  });
  const normalized = Object.fromEntries(entries);
  assertRecipeSize(normalized, 'Recipe taskRouting');
  return normalized;
}

export function validateRecipeParameters(raw, descriptors) {
  const parameters = validateParameterPayload(raw);
  keys(parameters, Object.keys(descriptors), 'recipe parameters');
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(parameters, name)) {
      if (descriptor.required !== false) throw Error('Missing required parameter ' + name);
      continue;
    }
    const value = parameters[name];
    const label = 'parameter ' + name;
    if (descriptor.type === 'text') text(value, label);
    else if (descriptor.type === 'enum') {
      if (!descriptor.values.includes(value)) throw Error('Invalid enumeration value for ' + label);
    } else validatePermissionList(value, descriptor.type, label);
  }
  return parameters;
}

function validateDag(tasks) {
  const visited = new Set(), visiting = new Set();
  function visit(key) {
    if (visiting.has(key)) throw Error('Workflow dependency cycle at task ' + key);
    if (visited.has(key)) return;
    if (!tasks.has(key)) throw Error('Unknown workflow dependency ' + key);
    visiting.add(key);
    for (const dependency of tasks.get(key).dependsOn ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of tasks.keys()) visit(key);
}

export function validateRecipeDefinition(raw) {
  record(raw, 'recipe definition', ['schemaVersion', 'id', 'version', 'title', 'mode', 'parameters', 'tasks', 'provenance']);
  integer(raw.schemaVersion, 'recipe schemaVersion', 1, 1);
  identifier(raw.id, 'recipe ID');
  integer(raw.version, 'recipe version', 1, 10000);
  text(raw.title, 'recipe title', 200);
  validateList(Array.isArray(raw.mode) ? raw.mode : [raw.mode], 'recipe mode ID', identifier, {max: 10});

  record(raw.provenance, 'recipe provenance', ['source', 'description']);
  text(raw.provenance.source, 'recipe provenance source', 200);
  text(raw.provenance.description, 'recipe provenance description', 2000);

  const descriptors = Object.entries(record(raw.parameters, 'recipe parameter definitions'));
  for (const [name, descriptor] of descriptors) {
    identifier(name, 'parameter name');
    const label = 'parameter definition ' + name;
    record(descriptor, label, ['type', 'required', 'values']);
    if (!['text', 'enum', 'paths', 'checks'].includes(descriptor.type)) throw Error('Invalid type for ' + label);
    if (Object.hasOwn(descriptor, 'required') && typeof descriptor.required !== 'boolean') {
      throw Error('Expected a boolean required flag for ' + label);
    }
    if (descriptor.type === 'enum') validateList(descriptor.values, label + ' values', text);
    else if (Object.hasOwn(descriptor, 'values')) throw Error('Only enum parameters may declare values for ' + label);
  }

  const referenced = new Set();
  function reference(value, types, label) {
    record(value, label + ' parameter reference', ['parameter']);
    const name = identifier(value.parameter, label + ' parameter');
    if (!Object.hasOwn(raw.parameters, name)) throw Error('Undeclared parameter ' + name + ' in ' + label);
    if (!types.includes(raw.parameters[name].type)) throw Error('Invalid parameter type for ' + name + ' in ' + label);
    referenced.add(name);
  }
  function templateText(value, label, max = 20000) {
    if (typeof value === 'string') text(value, label, max);
    else reference(value, TEXT_TYPES, label);
  }

  const tasks = new Map();
  for (const task of list(raw.tasks, 'recipe tasks', {max: 10})) {
    record(task, 'recipe task', ['key', 'kind', 'objective', 'context', 'acceptance', 'dependsOn', 'permissions']);
    const key = identifier(task.key, 'recipe task key');
    if (key.length > MAX_TASK_KEY) throw Error('Recipe task key must be at most ' + MAX_TASK_KEY + ' characters');
    const label = 'task ' + key;
    if (tasks.has(key)) throw Error('Duplicate recipe task ' + key);
    if (!['coding', 'research'].includes(task.kind)) throw Error('Invalid recipe task kind for ' + key);
    templateText(task.objective, label + ' objective');
    if (Object.hasOwn(task, 'context') && task.context !== '') templateText(task.context, label + ' context', 40000);
    const criteria = list(task.acceptance, label + ' acceptance');
    for (const criterion of criteria) templateText(criterion, label + ' acceptance');
    if (new Set(criteria.map(canonical)).size !== criteria.length) throw Error('Duplicate acceptance in ' + label);
    if (Object.hasOwn(task, 'dependsOn')) validateList(task.dependsOn, label + ' dependencies', identifier, {min: 0});
    if (Object.hasOwn(task, 'permissions')) {
      record(task.permissions, label + ' permissions', Object.keys(PERMISSION_TYPES));
      for (const [name, type] of Object.entries(PERMISSION_TYPES)) {
        const value = task.permissions[name];
        if (Array.isArray(value)) validatePermissionList(value, type, label + ' ' + name, 0);
        else reference(value, [type], label + ' ' + name);
      }
    }
    tasks.set(key, task);
  }
  validateDag(tasks);
  for (const [name, descriptor] of descriptors) {
    if (descriptor.required !== false && !referenced.has(name)) throw Error('Unused required parameter ' + name);
  }
  assertRecipeSize(raw, 'Recipe definition');
  return structuredClone(raw);
}
