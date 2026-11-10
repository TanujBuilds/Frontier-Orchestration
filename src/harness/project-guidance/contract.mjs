import { digest, keys, text } from '../contracts.mjs';
import { matches, relativePath, secretPath } from '../../project/contracts.mjs';

export const PROJECT_CHECK_GUIDANCE = 'project_check_guidance';
export const checkDefinitionHash = check => digest(check);

const checkIdPattern = /^[a-z0-9-]+$/;
const termPattern = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;
const pathPattern = /^[A-Za-z0-9_@.+/-]+$/;

function boundedList(values, max, label, normalize) {
  if (!Array.isArray(values) || !values.length || values.length > max) {
    throw Error(`Invalid guidance ${label}: expected 1–${max} entries`);
  }
  const normalized = Array.from(values, normalize);
  if (new Set(normalized).size !== normalized.length) throw Error(`Duplicate guidance ${label}`);
  return normalized;
}

export function guidancePath(value) {
  text(value, 'guidance path', 240);
  if (!pathPattern.test(value)) throw Error('Invalid guidance path');
  const file = relativePath(value.endsWith('/') ? value.slice(0, -1) : value);
  if (secretPath(file)) throw Error('Sensitive paths cannot appear in guidance');
  return value;
}

export function guidancePathInScope(relatedPath, scopes) {
  if (relatedPath.endsWith('/')) {
    return scopes.some(scope => scope.endsWith('/') && relatedPath.startsWith(scope));
  }
  return matches(relatedPath, scopes);
}

export function checkDefinitionsMatch(recipe, project) {
  if (!Array.isArray(recipe?.checkIds) || !recipe.checkIds.length) return false;
  return recipe.checkIds.every(id => {
    const check = project?.checks.find(check => check.id === id);
    return check && recipe.checkDefinitionHashes?.[id] === checkDefinitionHash(check);
  });
}

export function validateProjectCheckGuidance({ parameters, goal, sourceEvidence }) {
  keys(parameters, ['checkIds', 'checkDefinitionHashes', 'relatedPaths', 'whenTerms'], 'guidance parameters');
  const project = goal.manifest.project;
  if (!project) throw Error('Project check guidance needs an approved project');
  const checkIds = boundedList(parameters.checkIds, 20, 'check IDs', id => {
    text(id, 'guidance check ID', 120);
    if (!checkIdPattern.test(id)) throw Error('Invalid guidance check ID');
    return id;
  });
  keys(parameters.checkDefinitionHashes, checkIds, 'guidance check definition hashes');
  const checkDefinitionHashes = Object.fromEntries(checkIds.map(id => {
    const check = project.checks.find(check => check.id === id);
    if (!check) throw Error(`Unknown registered check: ${id}`);
    const hash = checkDefinitionHash(check);
    if (parameters.checkDefinitionHashes[id] !== hash) throw Error(`Check definition hash mismatch: ${id}`);
    if (!sourceEvidence.some(source => source.checkDefinitionHashes[id] === hash)) {
      throw Error(`Check ${id} lacks passing evidence for this exact definition`);
    }
    return [id, hash];
  }));
  const relatedPaths = boundedList(parameters.relatedPaths, 20, 'related paths', value => {
    const relatedPath = guidancePath(value);
    if (!guidancePathInScope(relatedPath, project.readPaths) ||
        !sourceEvidence.some(source => guidancePathInScope(relatedPath, source.readPaths))) {
      throw Error(`Guidance path outside project or source scope: ${relatedPath}`);
    }
    return relatedPath;
  });
  const whenTerms = boundedList(parameters.whenTerms, 12, 'applicability terms', term => {
    text(term, 'guidance applicability term', 80);
    if (!termPattern.test(term)) throw Error('Guidance applicability terms must be plain words');
    return term.toLowerCase();
  });
  return { checkIds, checkDefinitionHashes, relatedPaths, whenTerms };
}

export function renderProjectCheckGuidance(parameters) {
  return `Observed passing checks in accepted work in this project: ${parameters.checkIds.join(', ')}. ` +
    'Use the currently approved check plan and permissions. The observation does not establish check sufficiency.';
}
