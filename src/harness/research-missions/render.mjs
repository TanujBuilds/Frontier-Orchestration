// Use entities for Markdown punctuation as well as raw HTML delimiters, and
// keep prose on one line so untrusted text cannot create Markdown blocks.
const escape = value => String(value ?? '').replace(/\s+/g, ' ').trim().replace(/[&<>"'\\`*_{}\[\]()#+!|~]/g,
  char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;'}[char] ?? '&#' + char.charCodeAt(0) + ';'));
const label = value => escape(value ?? 'unknown');
const line = (name, value) => '- ' + name + ' · ' + label(value);
const selectorText = selection => selection === null ? 'selector unavailable' :
  'characters ' + selection.start + '–' + selection.end + ' · text SHA-256 ' + label(selection.textSha256);

const sections = {
  summary:'Summary', claims:'Claims and evidence', comparisons:'Comparisons',
  recommendations:'Recommendations', contradictions:'Contradictions and disagreements', unanswered:'Unanswered questions',
};

export function renderMissionMarkdown(view) {
  const lines = ['# ' + label(view.title ?? 'Research mission'), ''];
  if (view.environment === 'fixture') lines.push('**Fixture research environment.**', '');
  if (view.historical) lines.push('**Archived candidate.** The task may have a newer candidate.', '');
  lines.push(
    line('Status', view.status + ' (' + view.reasonCode + ')'),
    ...(view.collectionReason ? [line('Collection reason', view.collectionReason)] : []),
    line('Task', view.taskId),
    line('Question', view.question), line('Scope', view.scope), line('Requested output', view.outputShape),
    line('As of', view.asOf), line('Generated', view.generatedAt), line('Source revision', view.sourceRevision),
    '', '## Independent review', '',
    line('State', view.review.state), line('Decision', view.review.decision),
    line('Ticket', view.review.ticketId), line('Candidate SHA-256', view.review.candidateHash),
    line('Rubric SHA-256', view.review.rubricSha256), line('Report SHA-256', view.reportHash),
    line('Source catalog SHA-256', view.sourcesHash),
    line('Covered units', view.review.coverage.length ? view.review.coverage.join(', ') : null),
    '', view.evidenceExplanation,
  );
  const scope = view.approvedSourceScope;
  if (scope) {
    lines.push('', '## Approved source scope', '', line('Scope SHA-256', scope.sha256));
    if (scope.reason) lines.push(line('Details', scope.reason));
    else {
      for (const [key, heading] of [['includeDomains','Included domains'], ['excludeDomains','Excluded domains'], ['seedUrls','Seed URLs']]) {
        if (scope[key]?.length) lines.push(line(heading, scope[key].join(', ')));
      }
    }
  }
  for (const finding of view.review.findings) {
    lines.push('- ' + label(finding.unit) + ' · ' + label(finding.code) + ' · ' + label(finding.message));
    for (const selector of finding.evidence) {
      lines.push('  - ' + label(selector.source_id) + ' · ' + selectorText({
        start:selector.start, end:selector.end, textSha256:selector.text_sha256,
      }));
    }
  }
  for (const [key, heading] of Object.entries(sections)) {
    if (!view[key]?.length) continue;
    lines.push('', '## ' + heading, '');
    for (const unit of view[key]) {
      lines.push('- **' + label(unit.unitId) + '** · ' + label(unit.kind) + ' · ' + label(unit.support) +
        ' · ' + (unit.text === null ? 'Text unavailable in this view. See the original artifact.' : escape(unit.text)));
      if (unit.claimIds.length) lines.push('  - Referenced claims · ' + label(unit.claimIds.join(', ')));
      for (const evidence of unit.evidence) {
        lines.push('  - ' + label(evidence.sourceId) + ' · ' + selectorText(evidence.selector) +
          ' · retrieved ' + label(evidence.source?.retrievedAt) + ' · ' + (evidence.linked ? 'linked' : 'unverified'));
        if (evidence.quote !== null) lines.push('    - “' + escape(evidence.quote) + '”');
      }
    }
  }
  if (view.sources.length) {
    lines.push('', '## Sources', '');
    for (const source of view.sources) {
      lines.push('- **' + label(source.id) + '** · ' + label(source.title) + ' · ' + label(source.url) +
        ' · retrieved ' + label(source.retrievedAt) + ' · content SHA-256 ' + label(source.contentSha256));
    }
  }
  if (view.artifacts.length) {
    lines.push('', '## Saved artifacts', '');
    for (const artifact of view.artifacts) lines.push('- ' + label(artifact.name) + ' · artifact ID ' + label(artifact.id));
  }
  if (view.review.history.length) {
    lines.push('', '## Review history', '');
    for (const entry of view.review.history) {
      lines.push('- ' + label(entry.candidateHash) + ' · ' + label(entry.decision) + ' · ticket ' + label(entry.ticketId));
      if (entry.affectedUnits?.length) lines.push('  - Affected units · ' + label(entry.affectedUnits.join(', ')));
    }
  }
  if (view.diagnostics.length) {
    lines.push('', '## Diagnostics', '');
    for (const diagnostic of view.diagnostics) lines.push('- ' + label(diagnostic.code) +
      (diagnostic.unitId ? ' · ' + label(diagnostic.unitId) : '') + ' · ' + label(diagnostic.message));
  }
  if (view.pagination) {
    lines.push('', '## View bounds', '',
      'This export displays the selected page. Read the saved artifact or request another page for more entries.');
  }
  return lines.join('\n') + '\n';
}
