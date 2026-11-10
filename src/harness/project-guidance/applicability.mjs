import { digest } from '../contracts.mjs';
import {
  PROJECT_CHECK_GUIDANCE, checkDefinitionsMatch, guidancePath, guidancePathInScope,
} from './contract.mjs';

const urls = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
const tokens = /[\p{L}\p{M}\p{N}_@.+/\\:-]+/gu;
const word = /^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/;
const pathLike = /[./\\]/;

export function guidanceQueryTokens(query) {
  return (query.replace(urls, ' ').match(tokens) ?? [])
    .map(token => token.replace(/[.:]+$/, ''))
    .filter(Boolean);
}

export function findScopedGuidancePaths(queryTokens, scopes) {
  return [...new Set(queryTokens.filter(token => {
    if (!pathLike.test(token) && !scopes.includes(token)) return false;
    if (!guidancePathInScope(token, scopes)) return false;
    try { return guidancePath(token) === token; } catch { return false; }
  }))];
}

export function guidanceTermsMatch(terms, queryTokens, observedPaths) {
  const paths = new Set(observedPaths);
  const prose = ' ' + queryTokens
    .map(token => word.test(token) && !paths.has(token) ? token.toLowerCase() : '\0')
    .join(' ') + ' ';
  return terms.filter(term => prose.includes(' ' + term + ' '));
}

export function guidancePathMatches(selector, observed) {
  return selector === observed || (selector.endsWith('/') && observed.startsWith(selector));
}

export function guidanceApplicability({ lesson, goal, taskContext }) {
  const { project, environment, capabilities } = goal.manifest;
  const { recipe, applicability } = lesson;
  if (!project || lesson.family !== PROJECT_CHECK_GUIDANCE || lesson.scope !== 'project' ||
      lesson.projectKey !== digest(project.repo) || recipe?.family !== PROJECT_CHECK_GUIDANCE ||
      applicability?.capability !== 'coding' || taskContext.capability !== 'coding' ||
      applicability.version !== capabilities.find(capability => capability.id === 'coding')?.version ||
      applicability.environment !== environment ||
      (taskContext.environment != null && taskContext.environment !== environment) ||
      !checkDefinitionsMatch(recipe, project)) return null;

  const queryTokens = guidanceQueryTokens(taskContext.query ?? '');
  const observed = findScopedGuidancePaths(queryTokens, project.readPaths);
  const taskReadPaths = taskContext.permissions?.readPaths ?? project.readPaths;
  const matchedPaths = recipe.relatedPaths.filter(selector =>
    guidancePathInScope(selector, project.readPaths) &&
    observed.some(file => guidancePathInScope(file, taskReadPaths) && guidancePathMatches(selector, file)));
  const matchedTerms = guidanceTermsMatch(recipe.whenTerms, queryTokens, observed);
  return matchedPaths.length && matchedTerms.length ? { matchedPaths, matchedTerms } : null;
}

export function guidanceMemoryPacket({ lesson, goal, taskContext }) {
  const explanation = guidanceApplicability({ lesson, goal, taskContext });
  if (!explanation) return null;
  const { id, version, recipeHash, recipe, content, evidence, applicability } = lesson;
  return { id, version, recipeHash, recipe, content, evidence, applicability, explanation };
}

export function fitsMemoryBudget(packets) {
  return Buffer.byteLength(JSON.stringify(packets)) <= 8192;
}
