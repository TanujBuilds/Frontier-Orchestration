"""Opt-in research review data. Hashes prove binding, never semantic truth."""
import copy
import hashlib
import json
import re


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def closed(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ValueError('invalid closed review fields')


def normalize_review_policy(policy):
    closed(policy, ('version', 'finish', 'discovery', 'review'))
    if type(policy['version']) is not int or policy['version'] != 3 or policy['finish'] != 'selectors_only' or policy['discovery'] != 'search_required':
        raise ValueError('unsupported reviewed research policy')
    r = policy['review']
    closed(r, ('version', 'role', 'maxRounds', 'maxRevisions', 'maxCorrectionModelCalls', 'rubricSha256'))
    for field, expected in [('version', 1), ('maxRounds', 2), ('maxRevisions', 1), ('maxCorrectionModelCalls', 2)]:
        if type(r[field]) is not int or r[field] != expected:
            raise ValueError('unsupported review limits')
    if r['role'] != 'independent_operator' or not isinstance(r['rubricSha256'], str) or not re.fullmatch('[a-f0-9]{64}', r['rubricSha256']):
        raise ValueError('invalid reviewer role or rubric hash')
    return copy.deepcopy(policy)


def policy_parameters(policy):
    version = policy.get('version') if isinstance(policy, dict) else None
    if version == 3:
        normalize_review_policy(policy)
    return {'strict': policy is not None, 'support': version in (2, 3),
            'catalog_version': 2 if version in (2, 3) else 1, 'requires_review': version == 3}


def build_repair_proposal(raw_report, sources, offered, request_ref):
    """Salvage bounded provenance-valid claim records, never approve a report."""
    from research_passages import resolve_report
    from research_protocol import validate_report
    closed(request_ref, ('operationId', 'requestSha256', 'resultSha256', 'offersSha256'))
    if not isinstance(request_ref['operationId'], str) or not 1 <= len(request_ref['operationId']) <= 200:
        raise ValueError('invalid proposal operation')
    if any(not isinstance(request_ref[k], str) or not re.fullmatch('[a-f0-9]{64}', request_ref[k]) for k in ('requestSha256','resultSha256','offersSha256')):
        raise ValueError('invalid proposal hashes')
    try:
        errors = validate_report(resolve_report(raw_report, sources, offered, strict=True), sources)
    except (ValueError, TypeError, KeyError) as error:
        errors = [str(error)[:500]]
    projection = {'claims': [], 'unanswered': []}
    bad = []; omitted = 0
    claims = raw_report.get('claims', []) if isinstance(raw_report, dict) else []
    if not isinstance(claims, list): claims = []
    ids = [c.get('id') for c in claims[:100] if isinstance(c, dict)]
    for index, c in enumerate(claims[:100]):
        if not isinstance(c, dict):
            bad.append({'index': index, 'errors': ['invalid claim']}); continue
        claim = {k: copy.deepcopy(c[k]) for k in ('id','kind','text','evidence') if k in c}
        try:
            normalized = resolve_report({'claims':[claim]}, sources, offered, strict=True)
            envelope = {'title':'Repair projection','complete':False,'claims':normalized['claims'],
                        'summary':[],'comparisons':[],'recommendations':[],'contradictions':[],'unanswered':[]}
            problems = validate_report(envelope, sources)
            if ids.count(c.get('id')) != 1: problems.append('ambiguous claim ID')
        except (ValueError, TypeError, KeyError) as error: problems = [str(error)[:500]]
        if problems:
            bad.append({'index':index,'errors':problems[:10]}); continue
        proposed = {**projection, 'claims':projection['claims']+[claim]}
        if len(encoded(proposed).encode()) > 32768: omitted += 1
        else: projection = proposed
    if isinstance(raw_report, dict) and isinstance(raw_report.get('unanswered'), list):
        for gap in raw_report['unanswered'][:50]:
            if isinstance(gap,str) and len(gap)<=3000:
                proposed = {**projection,'unanswered':projection['unanswered']+[gap]}
                if len(encoded(proposed).encode())<=32768: projection=proposed
    return {'version':1,'request':copy.deepcopy(request_ref),'projection':projection,
            'reportErrors':errors[:15], 'claimErrors':bad,'omittedClaims':omitted+max(0,len(claims)-100)}
