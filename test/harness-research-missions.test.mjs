import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {digest} from '../src/harness/contracts.mjs';
import {validateMissionBrief} from '../src/harness/research-missions/contract.mjs';
import {projectMission} from '../src/harness/research-missions/view.mjs';
import {renderMissionMarkdown} from '../src/harness/research-missions/render.mjs';

const brief = {
  question: 'What does the queue retain after a worker restart?',
  scope: 'Compare only the saved documentation and account for acknowledgments.',
  outputShape: 'Conditional comparison and recommendation',
  asOf: '2026-11-10',
};
const quote = '🧾 A pending message is recovered only if it was reserved and unacknowledged.';
const sourceText = '📘 Guide. ' + quote + ' This queue also has an unrelated setting.';
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = letter => letter.repeat(64);

function mission({decision = 'accept', status = 'accepted', findings = [], coverage} = {}) {
  const report = {
    title: 'Restart behavior',
    complete: true,
    claims: [
      {id:'C1', kind:'fact', text:'Recovery requires a reserved, unacknowledged message.',
        evidence:[{source_id:'S001', quote, selection:{text_sha256:sha(sourceText), start:9, end:9 + [...quote].length}}]},
      {id:'C2', kind:'unknown', text:'Exactly-once external effects are unresolved.', evidence:[]},
    ],
    summary: ['C1'],
    comparisons: [{text:'If messages are reserved and unacknowledged, recovery is available.', claim_ids:['C1']}],
    recommendations: [{text:'Use recovery if its acknowledgment assumptions fit.', claim_ids:['C1']}],
    contradictions: [{text:'The delivery premise does not resolve external effects.', claim_ids:['C1','C2']}],
    unanswered: ['What does the provider retain?'],
  };
  const sources = {S001:{title:'Queue guide', url:'https://example.test/guide', fetchedAt:'2026-11-09T21:02:03Z',
    contentSha256:hash('e'), text:sourceText}};
  const descriptor = {
    version:1, jobId:'remote', manifestHash:hash('b'), rubricSha256:hash('a'),
    reportSha256:digest(report), sourcesSha256:digest(sources), offersSha256:digest([]),
    request:{operationId:'op', requestSha256:hash('c'), resultSha256:hash('d'), offersSha256:digest([])},
    units:['title','claims:C1','claims:C2','summary:0','comparisons:0','recommendations:0','contradictions:0','unanswered:0'],
  };
  descriptor.candidateHash = digest(descriptor);
  const task = {
    id:'task', goalId:'goal', status,
    spec:{kind:'research', objective:brief.question, researchPolicy:{version:3, review:{version:1, rubricSha256:hash('a')}}},
    checkpoint:{remoteJobId:'remote', remoteHash:hash('b'), reviewCandidate:descriptor},
  };
  const authority = {
    descriptor, decision, findings, coverage:coverage ?? descriptor.units, ticketId:'review-ticket',
    reportHash:descriptor.reportSha256, sourcesHash:descriptor.sourcesSha256, brief,
    generatedAt:'2026-11-10T00:00:00.000Z', sourceRevision:'a'.repeat(40),
    diagnostics:[], artifacts:[{id:hash('f'), name:'claims.json'}], history:[],
  };
  return {task, report, sources, authority};
}

test('a bounded mission brief retains the question, scope, requested shape and explicit as-of date', () => {
  assert.deepEqual(validateMissionBrief({...brief, question:'  ' + brief.question + '\n'}), brief);
  for (const invalid of [
    {...brief, asOf:'2026-02-29'},
    {...brief, asOf:'2026-1-01'},
    {...brief, question:' '},
    {...brief, scope:'a'.repeat(2001)},
    {...brief, outputShape:'a'.repeat(1001)},
    {...brief, allowSources:['example.test']},
    {...brief, reportPath:'/etc/passwd'},
  ]) {
    assert.throws(() => validateMissionBrief(invalid));
  }
  assert.equal(validateMissionBrief({...brief, asOf:'2024-02-29'}).asOf, '2024-02-29');
});

test('full exact independent review preserves selections, qualifiers and the original unit IDs', () => {
  const view = projectMission(mission());
  assert.equal(view.status, 'accepted');
  assert.equal(view.schemaVersion, 1);
  assert.equal(view.title, 'Restart behavior');
  assert.equal(view.question, brief.question);
  assert.equal(view.asOf, brief.asOf);
  assert.equal(view.review.decision, 'accept');
  assert.deepEqual(view.review.coverage, ['title','claims:C1','claims:C2','summary:0','comparisons:0','recommendations:0','contradictions:0','unanswered:0']);
  assert.equal(view.claims[0].id, 'C1');
  assert.equal(view.claims[0].unitId, 'claims:C1');
  assert.equal(view.claims[0].support, 'reviewed_supported');
  assert.equal(view.claims[0].evidence[0].quote, quote);
  assert.deepEqual(view.claims[0].evidence[0].selector, {textSha256:sha(sourceText), start:9, end:9 + [...quote].length});
  assert.equal(view.claims[0].evidence[0].source.retrievedAt, '2026-11-09T21:02:03Z');
  assert.equal(view.claims[1].kind, 'unknown');
  assert.equal(view.claims[1].support, 'unverified');
  assert.equal(view.summary[0].unitId, 'summary:0');
  assert.deepEqual(view.contradictions[0].claimIds, ['C1','C2']);
  assert.equal(view.unanswered[0].text, 'What does the provider retain?');
  assert.match(view.comparisons[0].text, /If messages are reserved and unacknowledged/);
});

test('a claimed accepted task with absent report yields pending evidence and a missing-report diagnostic', () => {
  const input = mission();
  const view = projectMission({...input, report:null, sources:null});
  assert.notEqual(view.status, 'accepted');
  assert.equal(view.title, null);
  assert.equal(view.review.decision, null);
  assert.ok(view.diagnostics.some(d => d.code === 'missing_report'));
});

test('a different report or source hash makes an otherwise exact review stale', () => {
  for (const field of ['reportHash','sourcesHash']) {
    const input = mission();
    input.authority[field] = hash('f');
    const view = projectMission(input);
    assert.notEqual(view.status, 'accepted');
    assert.ok(view.diagnostics.some(d => d.code === 'stale_review'));
    assert.equal(view.claims[0].support, 'mechanically_linked');
  }
});

test('an unsupported descriptor or review-policy version cannot accept a candidate', () => {
  const oldDescriptor = mission();
  oldDescriptor.authority.descriptor.version = 4;
  const oldPolicy = mission();
  oldPolicy.task.spec.researchPolicy.review.version = 2;
  for (const input of [oldDescriptor, oldPolicy]) {
    const view = projectMission(input);
    assert.notEqual(view.status, 'accepted');
    assert.ok(view.diagnostics.some(d => d.code === 'unsupported_review'));
  }
});

test('missing or duplicate review coverage cannot confer reviewed support', () => {
  for (const coverage of [undefined, ['claims:C1'], ['claims:C1','claims:C1']]) {
    const input = mission();
    input.authority.coverage = coverage;
    const view = projectMission(input);
    assert.notEqual(view.status, 'accepted');
    assert.equal(view.claims[0].support, 'mechanically_linked');
    assert.ok(view.diagnostics.some(d => d.code === 'invalid_review'));
  }
});

test('negative independent findings dispute a cited unit even when its selector is mechanically valid', () => {
  const selectors = [{source_id:'S001', text_sha256:sha(sourceText), start:9, end:9 + [...quote].length}];
  const findings = [
    {unit:'claims:C1', code:'missing_context', message:'The selected passage is about a different setting.', evidence:selectors},
    {unit:'comparisons:0', code:'cross_alternative_attribution', message:'The first tool does not describe the second.', evidence:selectors},
    {unit:'recommendations:0', code:'unsupported_premise', message:'The factual premise needs more support.', evidence:[]},
    {unit:'contradictions:0', code:'lost_condition', message:'The difference depends on a condition.', evidence:[]},
  ];
  const view = projectMission(mission({decision:'revise', status:'queued', findings}));
  assert.equal(view.status, 'revision_needed');
  assert.equal(view.claims[0].evidence[0].linked, true);
  assert.equal(view.claims[0].support, 'disputed');
  assert.equal(view.summary[0].support, 'disputed');
  assert.equal(view.comparisons[0].support, 'disputed');
  assert.equal(view.recommendations[0].support, 'disputed');
  assert.equal(view.contradictions[0].support, 'disputed');
  assert.deepEqual(view.review.findings, findings);
});

test('selector offsets must match the recorded quote, even when it occurs elsewhere in the source', () => {
  const input = mission();
  input.report.claims[0].evidence[0].selection.start = 0;
  const view = projectMission(input);
  assert.equal(view.claims[0].evidence[0].linked, false);
  assert.equal(view.claims[0].support, 'unverified');
  assert.notEqual(view.status, 'accepted');
  assert.ok(view.diagnostics.some(d => d.code === 'invalid_evidence' && d.unitId === 'claims:C1'));
});

test('a malformed contradiction leaves parseable claims and its original artifact available', () => {
  const input = mission();
  input.report.contradictions = ['unstructured contradiction', 'x'.repeat(10000)];
  const view = projectMission(input);
  assert.equal(view.status, 'partial');
  assert.equal(view.claims[0].support, 'mechanically_linked');
  assert.equal(view.contradictions[0].unitId, 'contradictions:0');
  assert.equal(view.contradictions[0].text, 'unstructured contradiction');
  assert.equal(view.contradictions[1].text, null);
  assert.ok(view.diagnostics.some(d => d.code === 'malformed_unit' && d.unitId === 'contradictions:1'));
  assert.deepEqual(view.artifacts, [{id:hash('f'), name:'claims.json'}]);
});

test('missing source retrieval date stays unknown and local paths are excluded from references', () => {
  const input = mission({decision:null, status:'awaiting_review', coverage:[]});
  delete input.sources.S001.fetchedAt;
  input.authority.artifacts.push({id:'/etc/passwd', name:'claims.json'});
  input.authority.artifacts.push({id:hash('c'), name:'receipt.json', file:'/etc/shadow'});
  const view = projectMission(input);
  assert.equal(view.sources[0].retrievedAt, null);
  assert.equal(view.sources[0].retrievalReason, 'not_recorded');
  assert.equal(view.claims[0].support, 'mechanically_linked');
  assert.ok(!JSON.stringify(view).includes('/etc/'));
});

test('Markdown keeps qualifiers, review evidence and artifact references while neutralizing model markup', () => {
  const input = mission();
  input.report.title = '<script>alert(1)</script>';
  input.report.unanswered[0] = '[click](javascript:evil)\n# New heading\n![](https://example.test/tracker)';
  const result = renderMissionMarkdown(projectMission(input));
  assert.match(result, /If messages are reserved and unacknowledged/);
  assert.match(result, /claims:C1/);
  assert.match(result, /2026-11-09T21:02:03Z/);
  assert.match(result, /claims\.json/);
  assert.match(result, /&lt;script&gt;/);
  assert.doesNotMatch(result, /<script>|\]\(javascript:|\n# New heading|!\[\]\(/);
});

test('archive inspection preserves its exact negative verdict after replacement or terminal blocking', () => {
  const finding = {unit:'claims:C1', code:'lost_condition', message:'Retain the original condition.', evidence:[]};
  const input = mission({decision:'revise', status:'blocked', findings:[finding]});
  input.task.checkpoint.reviewCandidate = {candidateHash:hash('f')};
  assert.equal(projectMission(input).review.decision, null);
  input.authority.historical = true;
  const archived = projectMission(input);
  assert.equal(archived.historical, true);
  assert.equal(archived.status, 'revision_needed');
  assert.equal(archived.review.decision, 'revise');
  assert.equal(archived.claims[0].support, 'disputed');
  assert.match(renderMissionMarkdown(archived), /Archived candidate/);
});

test('a service integrity diagnostic prevents a positive decision from becoming current reviewed support', () => {
  const input = mission();
  input.authority.diagnostics = [{code:'stale_review', message:'The saved receipt differs from the bound candidate.'}];
  const view = projectMission(input);
  assert.notEqual(view.status, 'accepted');
  assert.equal(view.review.decision, null);
  assert.equal(view.claims[0].support, 'mechanically_linked');
  assert.match(view.evidenceExplanation, /independent review/i);
});

test('fixture retrieval markers and non-web source addresses do not become retrieval dates or source URLs', () => {
  const input = mission({decision:null});
  input.sources.S001.fetchedAt = 'fixture';
  input.sources.S001.url = 'file:///etc/passwd';
  const view = projectMission(input);
  assert.equal(view.sources[0].retrievedAt, null);
  assert.equal(view.sources[0].url, null);
  assert.equal(view.claims[0].evidence[0].linked, true);
});
