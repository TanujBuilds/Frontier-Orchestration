import {createHash} from 'node:crypto';
import {verifyDescriptor, verifyReviewVerdict} from '../research-review.mjs';

const sections = {claims:100, summary:30, comparisons:30, recommendations:30, contradictions:30, unanswered:50};
const claimKinds = new Set(['fact', 'vendor_claim', 'inference', 'unknown']);
const findingCodes = new Set(['missing_context', 'cross_alternative_attribution', 'unsupported_premise',
  'lost_condition', 'unsupported_claim', 'material_omission', 'contradiction', 'other']);
const artifactNames = new Set(['proposal.json', 'claims.json', 'sources.json', 'report.md', 'manifest.json', 'receipt.json']);
const terminalBlocks = new Set(['blocked', 'failed', 'stopped', 'paused', 'uncertain', 'expired', 'suspended', 'awaiting_answer']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isClaimId = value => typeof value === 'string' && /^C[0-9]{1,4}$/.test(value);
const isSourceId = value => typeof value === 'string' && /^S[0-9]{3,6}$/.test(value);
function boundedText(value, max, min = 1) {
  if (typeof value !== 'string' || value.length > max * 2) return null;
  const size = [...value].length;
  return size >= min && size <= max ? value : null;
}

function sourceUrl(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

function retrievalDate(value) {
  const timestamp = boundedText(value, 100);
  return timestamp && /^\d{4}-\d{2}-\d{2}T/.test(timestamp) && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function sourceCatalog(sources, issue) {
  const catalog = new Map();
  if (!isObject(sources)) {
    issue('missing_sources', 'The saved source catalog is unavailable or malformed.');
    return catalog;
  }
  const entries = Object.entries(sources);
  if (entries.length > 1000) issue('malformed_sources', 'The source catalog exceeds the display limit. See the original artifact.');
  for (const [id, source] of entries.slice(0, 1000)) {
    if (!isSourceId(id) || !isObject(source) || typeof source.text !== 'string') {
      issue('malformed_source', 'A source record is malformed. See the original source catalog.');
      continue;
    }
    const retrievedAt = retrievalDate(source.fetchedAt);
    const metadata = {
      id,
      url: sourceUrl(source.url),
      title: boundedText(source.title, 500),
      retrievedAt,
      retrievalReason: retrievedAt === null ? 'not_recorded' : null,
      contentSha256: isHash(source.contentSha256) ? source.contentSha256 : null,
    };
    catalog.set(id, {metadata, text:source.text});
  }
  return catalog;
}

function linkEvidence(value, catalog, verifiedCandidate) {
  const sourceId = isSourceId(value?.source_id) ? value.source_id : null;
  const quote = boundedText(value?.quote, 1000, 12);
  const source = catalog.get(sourceId);
  const raw = value?.selection;
  const selector = isObject(raw) && isHash(raw.text_sha256) && Number.isSafeInteger(raw.start) &&
    Number.isSafeInteger(raw.end) && raw.start >= 0 && raw.end > raw.start
    ? {textSha256:raw.text_sha256, start:raw.start, end:raw.end} : null;
  let linked = false;
  if (source && quote !== null && selector) {
    source.hash ??= createHash('sha256').update(source.text).digest('hex');
    source.characters ??= [...source.text];
    const {textSha256, start, end} = selector;
    linked = textSha256 === source.hash && end <= source.characters.length &&
      end - start >= 12 && end - start <= 1000 && source.characters.slice(start, end).join('') === quote;
  } else if (source && quote !== null && raw === undefined && !verifiedCandidate) {
    // Legacy report quotes establish a saved-text link without a selector.
    linked = source.text.includes(quote);
  }
  // The paginated source catalog carries the full URL when the citation
  // would otherwise duplicate a long address for every selected passage.
  const metadata = source?.metadata ?? null;
  const inlineSource = metadata?.url && Buffer.byteLength(metadata.url) > 2048
    ? {...metadata, url:null, urlReason:'see_source_catalog'} : metadata;
  return {sourceId, selector, quote, source:inlineSource, linked};
}

function projectReport(report, catalog, verifiedCandidate, issue) {
  const ledger = Object.fromEntries(Object.keys(sections).map(section => [section, []]));
  if (!isObject(report)) {
    issue('missing_report', 'A parseable saved report is unavailable.');
    return {title:null, complete:null, ledger, unitIds:[]};
  }
  const title = boundedText(report.title, 300);
  const complete = typeof report.complete === 'boolean' ? report.complete : null;
  const unitIds = ['title'];
  const claims = new Map();
  if (title === null) issue('malformed_unit', 'The report title is malformed. See the original artifact.', 'title');
  if (complete === null) issue('malformed_report', 'The report is missing its completion flag. See the original artifact.');

  for (const [section, limit] of Object.entries(sections)) {
    const items = report[section];
    if (!Array.isArray(items)) {
      issue('malformed_section', 'The ' + section + ' section is malformed. See the original artifact.');
    }
    // Keep readable text from malformed sections, even when the section has no array.
    const entries = Array.isArray(items) ? items : Object.hasOwn(report, section) ? [items] : [];
    if (entries.length > limit) {
      issue('malformed_section', 'The ' + section + ' section exceeds its ' + limit + '-unit bound. See the original artifact for all units.');
    }
    for (const [index, value] of entries.slice(0, limit).entries()) {
      const claimId = section === 'claims' && isClaimId(value?.id) ? value.id : null;
      const unitId = section + ':' + (claimId ?? index);
      const refs = section === 'summary' ? [value] : value?.claim_ids;
      const claimIds = Array.isArray(refs) ? [...new Set(refs.filter(isClaimId))] : [];
      let text = boundedText(typeof value === 'string' ? value : value?.text, section === 'unanswered' ? 3000 : 6000,
        section === 'unanswered' ? 0 : 1);
      let kind = section;
      let evidence = [];
      let valid = false;
      if (section === 'claims') {
        kind = claimKinds.has(value?.kind) ? value.kind : null;
        if (Array.isArray(value?.evidence)) {
          evidence = value.evidence.slice(0, 10).map(entry => linkEvidence(entry, catalog, verifiedCandidate));
        }
        valid = !!claimId && !claims.has(claimId) && kind !== null && text !== null &&
          Array.isArray(value.evidence) && value.evidence.length <= 10 && (kind === 'unknown' || evidence.length > 0);
        if (claimId && !claims.has(claimId)) claims.set(claimId, text);
        if (evidence.some(entry => !entry.linked)) {
          issue('invalid_evidence', 'A cited passage does not match its saved source and selection. See the original artifact.', unitId);
        }
      } else if (section === 'summary') {
        valid = claims.has(value);
        if (valid) text = claims.get(value);
      } else if (section === 'unanswered') {
        valid = typeof value === 'string' && text !== null;
      } else {
        valid = isObject(value) && text !== null && Array.isArray(refs) && refs.length > 0 &&
          refs.every(ref => claims.has(ref));
      }
      if (!valid) issue('malformed_unit', 'The report unit is malformed. See the original artifact.', unitId);
      unitIds.push(unitId);
      ledger[section].push({unitId, id:claimId ?? unitId, kind, text, claimIds, evidence, valid});
    }
  }
  if (complete && !ledger.claims.some(claim => claim.evidence.some(entry => entry.linked))) {
    issue('malformed_report', 'The report claims completeness without linked evidence.');
  }
  return {title, complete, ledger, unitIds};
}

function projectReview(task, authority, unitIds, integrityFailed, issue) {
  const {descriptor, decision, coverage, findings, ticketId} = authority;
  const review = {
    state:'unverified', decision:null, ticketId:null, candidateHash:null, rubricSha256:null,
    coverage:[], findings:[], history:authority.history ?? [],
  };
  if (!descriptor) {
    if (decision || task.status === 'accepted') issue('missing_review', 'No verified independent review is bound to the current report.');
    return review;
  }
  const policy = task.spec?.researchPolicy;
  if (![1,2].includes(descriptor.version) || policy?.version !== 3 || policy.review?.version !== 1 ||
      (descriptor.version === 2 && policy.correctionStrategy !== 'targeted_v1')) {
    issue('unsupported_review', 'The report uses an unsupported review descriptor or policy.');
    return review;
  }
  try {
    verifyDescriptor(descriptor);
  } catch {
    issue('invalid_review', 'The review descriptor is malformed.');
    return review;
  }
  if (authority.reportHash !== descriptor.reportSha256 || authority.sourcesHash !== descriptor.sourcesSha256 ||
      descriptor.jobId !== task.checkpoint?.remoteJobId || descriptor.manifestHash !== task.checkpoint?.remoteHash ||
      descriptor.rubricSha256 !== policy.review.rubricSha256 ||
      (!authority.historical && task.checkpoint?.reviewCandidate &&
        descriptor.candidateHash !== task.checkpoint.reviewCandidate.candidateHash) ||
      descriptor.units.length !== unitIds.length || descriptor.units.some((unit, index) => unit !== unitIds[index])) {
    issue('stale_review', 'The current report, sources or unit identities differ from the bound review candidate.');
    return review;
  }
  review.state = 'pending';
  review.candidateHash = descriptor.candidateHash;
  review.rubricSha256 = descriptor.rubricSha256;
  if (decision == null || (decision === 'accept' && (integrityFailed || authority.historical))) return review;
  try {
    verifyReviewVerdict({decision, coverage, findings}, descriptor);
    if (!boundedText(ticketId, 200) || findings.some(finding => !validFinding(finding, descriptor.units))) {
      throw Error('Malformed research verdict');
    }
  } catch {
    issue('invalid_review', 'The independent verdict lacks valid findings or required unit coverage.');
    return review;
  }
  return {...review, state:'bound', decision, ticketId, coverage:[...coverage], findings:structuredClone(findings)};
}

function validFinding(finding, units) {
  return isObject(finding) && Object.keys(finding).length === 4 && units.includes(finding.unit) &&
    findingCodes.has(finding.code) && boundedText(finding.message, 2000) !== null &&
    Array.isArray(finding.evidence) && finding.evidence.length <= 10 && finding.evidence.every(selector =>
      isObject(selector) && Object.keys(selector).length === 4 && isSourceId(selector.source_id) &&
      isHash(selector.text_sha256) && Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end) &&
      selector.start >= 0 && selector.end - selector.start >= 12 && selector.end - selector.start <= 1000);
}

function missionState(task, report, review, integrityFailed, historical) {
  if (historical) return review.decision === 'revise' ? ['revision_needed', 'archived_revision_requested'] :
    ['partial', 'archived_candidate'];
  if (terminalBlocks.has(task.status)) return ['blocked', 'task_' + task.status];
  if (review.decision === 'reject') return ['partial', 'review_rejected'];
  if (task.status === 'partial') return ['partial', 'task_partial'];
  if (review.decision === 'revise') return ['revision_needed', 'review_requested_revision'];
  if (!integrityFailed && task.status === 'accepted' && review.decision === 'accept' && report.complete) {
    return ['accepted', 'full_independent_review'];
  }
  if (task.status === 'accepted') return ['partial', 'acceptance_evidence_incomplete'];
  if (integrityFailed && report.title !== null) return ['partial', 'report_evidence_incomplete'];
  if (task.status === 'awaiting_review' || (report.title !== null && ['pending','bound'].includes(review.state))) {
    return ['awaiting_review', report.title === null ? 'report_unavailable' :
      review.decision === 'accept' ? 'awaiting_finalization' : 'awaiting_independent_review'];
  }
  if (task.startedAt != null || task.checkpoint?.remoteJobId || ['running','codex_active'].includes(task.status)) {
    return ['running', report.title === null ? 'awaiting_report' : 'awaiting_finalization'];
  }
  return ['drafted', 'awaiting_execution'];
}

function withSupport(ledger, review, canSupport) {
  const disputed = new Set(review.findings.map(finding => finding.unit));
  const covered = new Set(review.coverage);
  const claims = new Map(ledger.claims.map(claim => [claim.id, claim]));
  const links = claim => claim?.valid && claim.evidence.length > 0 && claim.evidence.every(entry => entry.linked);
  return Object.fromEntries(Object.entries(ledger).map(([section, rows]) => [section, rows.map(row => {
    const {valid, ...unit} = row;
    const references = unit.claimIds.map(id => claims.get(id));
    const linked = valid && (section === 'claims' ? links(row) :
      references.length > 0 && references.every(links));
    let support = 'unverified';
    if (disputed.has(unit.unitId) || references.some(claim => disputed.has(claim?.unitId))) support = 'disputed';
    else if (linked && canSupport && unit.kind !== 'unknown' && covered.has(unit.unitId)) support = 'reviewed_supported';
    else if (linked) support = 'mechanically_linked';
    return {...unit, support};
  })]));
}

// The service supplies byte hashes and verified authority from the same reads
// that produced report and sources. This projector cannot authorize a verdict.
export function projectMission({task, report, sources, authority = {}}) {
  const diagnostics = [...(authority.diagnostics ?? [])];
  const issue = (code, message, unitId) => diagnostics.push({code, message, ...(unitId ? {unitId} : {})});
  const catalog = sourceCatalog(sources, issue);
  const projected = projectReport(report, catalog, !!authority.descriptor, issue);
  const integrityFailed = diagnostics.length > 0;
  const review = projectReview(task, authority, projected.unitIds, integrityFailed, issue);
  const canSupport = !integrityFailed && review.decision === 'accept';
  const [status, reasonCode] = missionState(task, projected, review, integrityFailed, authority.historical);
  const artifacts = (authority.artifacts ?? []).filter(artifact =>
    isHash(artifact?.id) && artifactNames.has(artifact.name)).map(({id, name}) => ({id, name}));
  const brief = authority.brief;
  return {
    schemaVersion:1, generatedAt:authority.generatedAt ?? null, sourceRevision:authority.sourceRevision ?? null,
    missionId:task.id, goalId:task.goalId, taskId:task.id,
    question:brief?.question ?? boundedText(task.spec?.objective, 20000), scope:brief?.scope ?? null,
    outputShape:brief?.outputShape ?? null, asOf:brief?.asOf ?? null,
    briefReason:brief ? null : 'No prepared brief matches the saved research task.',
    status, sourceStatus:task.status, reasonCode, historical:authority.historical === true,
    environment:task.checkpoint?.manifest?.mode ?? null,
    evidenceExplanation:'Linked passages identify saved source text. Reviewed support requires a bound independent review with full coverage.',
    title:projected.title, complete:projected.complete,
    reportHash:isHash(authority.reportHash) ? authority.reportHash : null,
    sourcesHash:isHash(authority.sourcesHash) ? authority.sourcesHash : null,
    ...withSupport(projected.ledger, review, canSupport),
    sources:[...catalog.values()].map(source => source.metadata),
    review, artifacts, diagnostics,
  };
}
