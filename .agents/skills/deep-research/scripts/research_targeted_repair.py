"""Pure, opt-in named-unit assembly. Provenance is not semantic approval."""
import copy
import hashlib
import json
import re
from research_review import encoded, digest, closed
from research_protocol import validate_report
from research_passages import resolve_report

FIELDS=('title','complete','claims','summary','comparisons','recommendations','contradictions','unanswered')
SECTIONS=('summary','comparisons','recommendations','contradictions','unanswered')
HASH=re.compile('[a-f0-9]{64}')

def need(test,message):
    if not test:raise ValueError(message)

def units(report):
    need(isinstance(report,dict) and set(report)==set(FIELDS),'invalid canonical report fields')
    result={'title':report['title']}
    for claim in report['claims']:
        closed(claim,('id','kind','text','evidence'))
        key='claims:'+claim['id'];need(key not in result,'duplicate claim unit');result[key]=claim
    for section in SECTIONS:
        for i,value in enumerate(report[section]):result[section+':'+str(i)]=value
    return result

def catalog_union(a,b,sources):
    need(isinstance(a,list) and isinstance(b,list) and len(a)<=96 and len(b)<=96,'request offers exceed bound')
    rows={}
    for catalog in (a,b):
        seen=set()
        for row in catalog:
            need(isinstance(row,dict) and set(row) in ({'source_id','text_sha256','start','end','text'}, {'source_id','text_sha256','start','end','text','catalog_version','complete_unit'}),'invalid offered fields')
            sid,h,start,end=(row.get(k) for k in ('source_id','text_sha256','start','end'))
            need(isinstance(sid,str) and sid in sources and isinstance(h,str) and HASH.fullmatch(h),'invalid offer source')
            text=sources[sid].get('text');need(isinstance(text,str) and hashlib.sha256(text.encode()).hexdigest()==h,'stale offer source')
            need(type(start) is int and type(end) is int and 0<=start<end<=len(text) and 12<=end-start<=1000,'invalid offer range')
            need(row['text']==text[start:end],'offer text mismatch')
            if 'catalog_version' in row:need(type(row['catalog_version']) is int and row['catalog_version']==2 and type(row['complete_unit']) is bool,'invalid offer version')
            key=(sid,h,start,end);need(key not in seen,'duplicate request selector');seen.add(key)
            need(key not in rows or rows[key]==row,'conflicting union selector');rows[key]=copy.deepcopy(row)
    need(len(rows)<=192,'union exceeds bound')
    return [rows[k] for k in sorted(rows)]

def validate_base(base):
    closed(base,('descriptor','canonical'));d=base['descriptor'];c=base['canonical']
    closed(d,('version','jobId','manifestHash','rubricSha256','reportSha256','sourcesSha256','offersSha256','request','units','candidateHash'))
    need(type(d['version']) is int and d['version']==1,'reviewed base must be v1')
    need(digest({k:v for k,v in d.items() if k!='candidateHash'})==d['candidateHash'],'base descriptor mismatch')
    closed(c,('report','sources','offers'))
    for k in c:
        need(isinstance(c[k],str) and hashlib.sha256(c[k].encode()).hexdigest()==d[k+'Sha256'],'base canonical hash mismatch')
    need(len(c['report'].encode())<=131072,'base report exceeds targeted bound')
    report,sources,offers=(json.loads(c[k]) for k in ('report','sources','offers'))
    need(not validate_report(report,sources),'invalid reviewed report')
    u=units(report);need(list(u)==d['units'],'base unit coverage mismatch')
    need(d['request']['offersSha256']==d['offersSha256'],'base request catalog mismatch')
    catalog_union(offers,[],sources)
    need(resolve_report(report,sources,offers)==report,'base retained provenance differs')
    return report,sources,offers,u

def build_plan(base,submission,ticket_id):
    report,sources,offers,u=validate_base(base);d=base['descriptor']
    closed(submission,('ticketId','candidateHash','rubricSha256','decision','findings','coverage','key'))
    need(submission['ticketId']==ticket_id and isinstance(ticket_id,str) and 1<=len(ticket_id)<=200 and submission['decision']=='revise' and submission['candidateHash']==d['candidateHash'] and submission['rubricSha256']==d['rubricSha256'],'plan requires genuine bound revise submission')
    need(isinstance(submission['key'],str) and 1<=len(submission['key'])<=200,'invalid submission key')
    need(isinstance(submission['coverage'],list) and all(isinstance(x,str) and x in u for x in submission['coverage']) and len(set(submission['coverage']))==len(submission['coverage']),'invalid revise coverage')
    findings=submission['findings'];need(isinstance(findings,list) and 1<=len(findings)<=50,'invalid revise findings')
    required=set();summaries={};selectors=[{k:o[k] for k in ('source_id','text_sha256','start','end')} for o in offers]
    for f in findings:
        closed(f,('unit','code','message','evidence'))
        need(isinstance(f['unit'],str) and f['unit'] in u and f['code'] in ('missing_context','cross_alternative_attribution','unsupported_premise','lost_condition','unsupported_claim','material_omission','contradiction','other') and isinstance(f['message'],str) and 1<=len(f['message'])<=2000 and isinstance(f['evidence'],list) and len(f['evidence'])<=10 and all(e in selectors for e in f['evidence']),'invalid plan finding')
        if f['unit'].startswith('summary:'):summaries[f['unit']]=u[f['unit']]
        else:required.add(f['unit'])
    edges=set()
    for name,value in u.items():
        refs=[value] if name.startswith('summary:') else value['claim_ids'] if name.split(':')[0] in ('comparisons','recommendations','contradictions') else []
        for ref in refs:edges.add(('claims:'+ref,name))
    targets=required|set(summaries)|{'claims:'+c for c in summaries.values()}
    affected=targets|{to for fr,to in edges if fr in targets}
    need(len(affected)<=250,'required closure exceeds 250')
    return {'version':1,'baseCandidateHash':d['candidateHash'],'baseDescriptorSha256':digest(d),'baseReportSha256':d['reportSha256'],'sourcesSha256':d['sourcesSha256'],'offersSha256':d['offersSha256'],'rubricSha256':d['rubricSha256'],'review':{'ticketId':ticket_id,'submission':copy.deepcopy(submission)},'units':[{'unit':name,'beforeSha256':digest(value)} for name,value in u.items()],'required':sorted(required),'summaries':[{'unit':name,'claim':summaries[name]} for name in sorted(summaries)],'edges':[{'from':fr,'to':to} for fr,to in sorted(edges)],'affected':sorted(affected)}

def parse_patch(patch):
    closed(patch,('action','base_candidate_hash','plan_sha256','replacements','checked_units','cannot_repair'))
    need(patch['action']=='repair','targeted correction permits repair only')
    need(all(isinstance(patch[k],str) and HASH.fullmatch(patch[k]) for k in ('base_candidate_hash','plan_sha256')),'invalid patch binding')
    for key in ('replacements','checked_units','cannot_repair'):need(isinstance(patch[key],list) and len(patch[key])<=250,'invalid bounded patch list')
    names=[]
    for key,fields in [('replacements',('unit','before_sha256','value')),('checked_units',('unit','before_sha256'))]:
        for row in patch[key]:
            closed(row,fields);need(isinstance(row['unit'],str) and 1<=len(row['unit'])<=200 and isinstance(row['before_sha256'],str) and HASH.fullmatch(row['before_sha256']),'invalid patch unit/hash');names.append(row['unit'])
    need(len(names)<=250 and len(set(names))==len(names),'duplicate/oversize patch units')
    need(all(isinstance(x,str) for x in patch['cannot_repair']) and len(set(patch['cannot_repair']))==len(patch['cannot_repair']),'invalid cannot_repair units')
    need(not patch['cannot_repair'] or not names,'cannot_repair cannot apply replacements/checks')
    need(len(encoded(patch))<=150000,'action exceeds size limit')
    return patch

def apply_patch(base,plan,patch,sources,correction_offers,request):
    report,original_sources,a_offers,u=validate_base(base)
    need(plan==build_plan(base,plan['review']['submission'],plan['review']['ticketId']),'repair plan mismatch')
    need(sources==original_sources,'repair source mutation')
    parse_patch(patch)
    need(patch['base_candidate_hash']==plan['baseCandidateHash'] and patch['plan_sha256']==digest(plan),'stale base/plan hash')
    required=set(plan['required']);summary_units={s['unit'] for s in plan['summaries']}
    if patch['cannot_repair']:
        need(set(patch['cannot_repair'])<=required|summary_units,'cannot_repair needs known required units')
        return None
    closed(request,('operationId','requestSha256','resultSha256','offersSha256'))
    need(isinstance(request['operationId'],str) and 1<=len(request['operationId'])<=200 and all(isinstance(request[k],str) and HASH.fullmatch(request[k]) for k in ('requestSha256','resultSha256','offersSha256')) and request['offersSha256']==digest(correction_offers),'correction request binding mismatch')
    union=catalog_union(a_offers,correction_offers,sources)
    replacements={row['unit']:row for row in patch['replacements']};checks={row['unit']:row for row in patch['checked_units']}
    need(set(replacements)|set(checks)<=set(plan['affected']),'foreign/unrelated repair units')
    for name,row in list(replacements.items())+list(checks.items()):need(name in u and row['before_sha256']==digest(u[name]),'stale unit hash')
    need(required<=set(replacements),'required replacement missing')
    out=copy.deepcopy(report);new_units=copy.deepcopy(u);ids={c['id'] for c in report['claims']}
    for name,row in replacements.items():
        value=copy.deepcopy(row['value']);section=name.split(':')[0]
        if section=='claims':
            closed(value,('id','kind','text','evidence'));need(value['id']==u[name]['id'],'replacement claim ID changed')
            value=resolve_report({'claims':[value]},sources,correction_offers,strict=True)['claims'][0]
        elif section in ('comparisons','recommendations','contradictions'):
            closed(value,('text','claim_ids'));need(isinstance(value['text'],str) and 1<=len(value['text'])<=6000 and isinstance(value['claim_ids'],list) and value['claim_ids'] and all(isinstance(c,str) and c in ids for c in value['claim_ids']),'invalid synthesis replacement')
        elif section=='summary':need(isinstance(value,str) and value in ids,'invalid summary replacement')
        elif section in ('title','unanswered'):need(isinstance(value,str) and (1 if section=='title' else 0)<=len(value)<=(300 if section=='title' else 3000),'invalid text replacement')
        else:raise ValueError('unknown replacement unit')
        need(value!=u[name],'canonical no-op replacement')
        new_units[name]=value
        if name=='title':out['title']=value
        elif section=='claims':out['claims'][next(i for i,c in enumerate(out['claims']) if c['id']==value['id'])]=value
        else:out[section][int(name.split(':')[1])]=value
    for s in plan['summaries']:need(s['unit'] in replacements or 'claims:'+s['claim'] in replacements,'required failed summary/claim replacement missing')
    changed_claims={name for name in replacements if name.startswith('claims:')}
    dependents={edge['to'] for edge in plan['edges'] if edge['from'] in changed_claims}
    need(dependents<=set(replacements)|set(checks),'dependent check missing')
    need(not validate_report(out,sources),'assembled report invalid')
    need(list(units(out))==list(u) and out['complete']==report['complete'],'report identity/order changed')
    receipt={'version':1,'baseCandidateHash':plan['baseCandidateHash'],'planSha256':digest(plan),'patchSha256':digest(patch),'request':copy.deepcopy(request),'reportSha256':digest(out),'sourcesSha256':digest(sources),'offersSha256':digest(union),'retained':[{'unit':name,'sha256':digest(u[name])} for name in sorted(set(u)-set(replacements))],'changed':[{'unit':name,'beforeSha256':digest(u[name]),'afterSha256':digest(new_units[name])} for name in sorted(replacements)],'rechecked':[{'unit':name,'beforeSha256':digest(u[name])} for name in sorted(checks)]}
    bundle={'version':1,'base':{'descriptor':copy.deepcopy(base['descriptor']),'report':base['canonical']['report'],'offers':base['canonical']['offers']},'plan':copy.deepcopy(plan),'patch':copy.deepcopy(patch),'correctionOffers':encoded(correction_offers),'receipt':receipt}
    need(len(encoded(bundle).encode())<=262144,'repair bundle exceeds bound')
    return {'report':out,'offers':union,'receipt':receipt,'bundle':bundle}

def describe_plan(base,plan):
    _,_,_,u=validate_base(base)
    need(plan==build_plan(base,plan['review']['submission'],plan['review']['ticketId']),'repair plan mismatch')
    return {'plan':copy.deepcopy(plan),'values':[{'unit':name,'before_sha256':digest(u[name]),'value':copy.deepcopy(u[name])} for name in plan['affected']], 'instruction':'Return only closed repair action bound to base_candidate_hash and plan_sha256. Replace every required unit itself, account for failed summaries and all structured dependents. Claim values use only strict raw selectors from citation_passages; same claim ID. Check acknowledgements are not proof of support. To decline use known required cannot_repair with empty replacements and checked_units. Whole independent replacement review remains mandatory.', 'action_shape':{'action':'repair','base_candidate_hash':plan['baseCandidateHash'],'plan_sha256':digest(plan),'replacements':[{'unit':'named affected unit','before_sha256':'exact hash','value':'typed replacement'}],'checked_units':[{'unit':'dependent unit','before_sha256':'exact hash'}],'cannot_repair':[]}}
