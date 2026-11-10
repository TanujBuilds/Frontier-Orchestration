import { stripVTControlCharacters } from 'node:util';
import { digest } from './contracts.mjs';

function normalizeOutput(output = '') {
  return stripVTControlCharacters(output)
    .replace(/\r\n?/g, '\n')
    .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?\b/g, '<timestamp>')
    .replace(/\[\d\d:\d\d:\d\d(?:\.\d+)?\]/g, '[<timestamp>]')
    // Normalize allocated scratch directories while retaining stack filenames.
    .replace(/(^|file:\/\/|[\s("'\[=])\/(?:private\/)?(?:var\/folders\/[^/\s]+\/[^/\s]+\/T|var\/tmp|tmp)\/[^/\s:)"']+(?=\/)/gm, '$1<tmp>')
    .replace(/((?:^|\/)\.overnight-output\/tmp\/)[^/\s:)"']+(?=\/)/gm, '$1<tmp>')
    .replace(/\/\.overnight-output\/approved-inputs-[a-f0-9]{20}(?=\/)/g, '/<approved-inputs>')
    .replace(/(^\s*(?:duration(?:_ms)?|elapsed(?:_ms)?|time(?:_ms)?):\s*)\d+(?:\.\d+)?(?:\s*(?:ms|s))?\s*$/gim, '$1<duration>')
    .replace(/(^[ \t]*(?:ℹ|#)[ \t]+duration_ms[ \t]+)\d+(?:\.\d+)?[ \t]*$/gm, '$1<duration>')
    .replace(/\(\d+\.\d+\s*(?:ms|s)\)(?=\s*$)/gm, '(<duration>)')
    .trim();
}

export function recordFailedGate({attempt, snapshot, results, previous, previousSnapshot}) {
  const failures = results.filter(result => !result.passed).map(result => ({
    id: result.id,
    exitCode: result.code ?? null,
    stdout: normalizeOutput(result.stdout),
    stderr: normalizeOutput(result.stderr),
  })).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const candidateId = digest(snapshot);
  const failureId = digest(failures);
  const signature = digest({candidateId, failureId});
  const changedPaths = previousSnapshot
    ? [...new Set([...Object.keys(snapshot), ...Object.keys(previousSnapshot)])]
      .filter(file => snapshot[file] !== previousSnapshot[file]).sort()
    : [];
  return {
    gate: {attempt, candidateId, failureId, signature},
    repeated: Boolean(previous && previous.attempt < attempt && previous.signature === signature),
    changedPaths,
  };
}
