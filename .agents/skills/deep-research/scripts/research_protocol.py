"""Closed model actions and deterministic evidence/citation checks."""
import html
import json
import re

REPORT_SHAPE = {
 'title':'Report title', 'complete':True,
 'claims':[{'id':'C1','text':'A factual statement','kind':'fact',
            'evidence':[{'source_id':'S001','quote':'Exact passage from saved text'}]}],
 'summary':['C1'], 'comparisons':[{'text':'Comparison','claim_ids':['C1']}],
 'recommendations':[{'text':'Recommendation (inference)','claim_ids':['C1']}],
 'contradictions':[], 'unanswered':[]}


def parse_action(raw):
    if isinstance(raw, str):
        if len(raw) > 150000:
            raise ValueError('action exceeds size limit')
        raw = raw.strip()
        if raw.startswith('```') and raw.endswith('```'):
            raw = re.sub(r'^```(?:json)?\s*', '', raw)[:-3].strip()
        raw = json.loads(raw)
    if not isinstance(raw, dict):
        raise ValueError('action must be an object')
    action = raw.get('action')
    allowed = {'search':{'action','query'}, 'read':{'action','url','source_id','start','length'},
               'finish':{'action','report'}}
    if action not in allowed or set(raw) - allowed[action]:
        raise ValueError('only search, read and finish actions are permitted')
    if action == 'search':
        if not isinstance(raw.get('query'),str) or not 1 <= len(raw['query'].strip()) <= 1000:
            raise ValueError('search query must contain 1..1000 characters')
    elif action == 'read':
        if ('url' in raw) == ('source_id' in raw):
            raise ValueError('read needs exactly one url or source_id')
        key = 'url' if 'url' in raw else 'source_id'
        if not isinstance(raw[key],str) or not 1 <= len(raw[key]) <= 8192:
            raise ValueError('invalid read target')
        for key, default, maximum in [('start',0,50000),('length',8000,12000)]:
            value = raw.get(key,default)
            if type(value) is not int or value < 0 or value > maximum:
                raise ValueError('invalid source window')
    elif not isinstance(raw.get('report'),dict):
        raise ValueError('finish needs a report object')
    return raw


def validate_report(report, sources):
    errors = []
    if not isinstance(report,dict):
        return ['report must be an object']
    if not isinstance(report.get('title'),str) or not 1 <= len(report['title']) <= 300:
        errors.append('report title missing or too long')
    if type(report.get('complete')) is not bool:
        errors.append('complete must be boolean')
    claims = report.get('claims')
    if not isinstance(claims,list) or len(claims) > 100:
        return errors + ['claims must be a bounded list']
    ids = set()
    for claim in claims:
        if not isinstance(claim,dict):
            errors.append('invalid claim'); continue
        identifier = claim.get('id')
        if not isinstance(identifier,str) or not re.fullmatch(r'C[0-9]{1,4}',identifier) or identifier in ids:
            errors.append('invalid/duplicate claim ID'); continue
        ids.add(identifier)
        if not isinstance(claim.get('text'),str) or not 1 <= len(claim['text']) <= 6000:
            errors.append(identifier + ': invalid claim text')
        kind = claim.get('kind')
        if kind not in ('fact','vendor_claim','inference','unknown'):
            errors.append(identifier + ': invalid evidence label')
        evidence = claim.get('evidence',[])
        if not isinstance(evidence,list) or len(evidence) > 10:
            errors.append(identifier + ': invalid evidence'); continue
        if kind != 'unknown' and not evidence:
            errors.append(identifier + ': supporting passage required')
        for entry in evidence:
            if not isinstance(entry,dict):
                errors.append(identifier + ': invalid evidence entry'); continue
            sid, quote = entry.get('source_id'), entry.get('quote')
            source = sources.get(sid) if isinstance(sid,str) else None
            if not source:
                errors.append(identifier + ': unknown source'); continue
            if not isinstance(quote,str) or not 12 <= len(quote) <= 1000 or quote not in source.get('text',''):
                errors.append(identifier + ': exact saved passage required')
    summary = report.get('summary')
    if not isinstance(summary,list) or len(summary) > 30 or any(not isinstance(x,str) or x not in ids for x in summary):
        errors.append('summary must reference known claim IDs')
    for section in ('comparisons','recommendations','contradictions'):
        entries = report.get(section)
        if not isinstance(entries,list) or len(entries) > 30:
            errors.append(section + ' must be a bounded list'); continue
        for entry in entries:
            if not isinstance(entry,dict) or not isinstance(entry.get('text'),str) or not 1 <= len(entry['text']) <= 6000:
                errors.append(section + ': invalid text'); continue
            refs = entry.get('claim_ids')
            if not isinstance(refs,list) or not refs or any(not isinstance(x,str) or x not in ids for x in refs):
                errors.append(section + ': supporting claim IDs required')
    questions = report.get('unanswered')
    if not isinstance(questions,list) or len(questions) > 50 or any(not isinstance(x,str) or len(x)>3000 for x in questions):
        errors.append('unanswered must be a bounded string list')
    if report.get('complete') and not any(c.get('evidence') for c in claims if isinstance(c,dict)):
        errors.append('complete report needs retrieved evidence')
    return errors


def _text(value):
    return html.escape(str(value)).replace('[','\\[').replace(']','\\]')


def render_report(report, sources, status, mode, reason=None):
    lines = ['# ' + _text(report['title']), '', '**Status: ' + status + '**', '']
    if mode == 'fixture': lines += ['**FIXTURE — simulated providers; this is not live research.**','']
    if reason: lines += [_text(reason),'']
    lines += ['Citation and passage checks establish provenance. DeepSeek self-checks are not independent factual review.','']
    claims = {c['id']:c for c in report['claims']}
    def line(c):
        label = {'fact':'Source-supported claim','vendor_claim':'Vendor claim','inference':'Inference','unknown':'Unknown'}[c['kind']]
        citations = ' '.join('['+e['source_id']+']('+sources[e['source_id']]['url']+')' for e in c.get('evidence',[]))
        return '- **'+c['id']+' · '+label+':** '+_text(c['text'])+' '+citations
    lines += ['## Summary',''] + [line(claims[x]) for x in report['summary']]
    lines += ['', '## Findings',''] + [line(c) for c in report['claims']]
    for key,title in [('comparisons','Comparisons'),('recommendations','Recommendations (inferences)'),('contradictions','Contradictions')]:
        lines += ['', '## '+title,'']
        lines += ['- '+_text(e['text'])+' ('+', '.join(e['claim_ids'])+')' for e in report[key]] or ['No additional entries.']
    lines += ['', '## Unanswered questions',''] + ['- '+_text(x) for x in report['unanswered']]
    lines += ['', '## Sources','']
    for sid,s in sources.items():
        lines += ['- ['+sid+']('+s['url']+') · retrieved '+_text(s.get('fetchedAt','unknown'))+' · SHA-256 `'+s.get('contentSha256','unknown')+'`']
    return '\n'.join(lines)+'\n'
