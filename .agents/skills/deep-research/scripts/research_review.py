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


class ReviewLifecycle:
    """Coordinator-owned, bounded native review ledger; never invokes a model."""
    @staticmethod
    def _reviewed(job):
        if not policy_parameters(job['manifest'].get('research_policy'))['requires_review']:
            raise ValueError('research policy does not authorize independent review')

    @staticmethod
    def _save_review(db, job, state, status, event, data):
        import time
        now = time.time()
        db.execute('UPDATE jobs SET checkpoint_json=?,status=?,updated_at=? WHERE id=?',
                   (encoded(state),status,now,job['id']))
        ReviewLifecycle._event(db,job['id'],event,data,now)

    @staticmethod
    def _event(db, job_id, kind, data, now):
        db.execute('INSERT INTO events(job_id,type,time,data_json) VALUES(?,?,?,?)',
                   (job_id,kind,now,encoded(data)))

    def _review_boundary(self, db, job):
        import time
        self._reviewed(job)
        owner=db.execute('SELECT * FROM executions WHERE job_id=?',(job['id'],)).fetchone()
        pending=db.execute("SELECT 1 FROM operations WHERE job_id=? AND status='pending'",(job['id'],)).fetchone()
        if job['status']!='awaiting_semantic_review' or job['deadline'] is None or time.time()>=job['deadline']:
            raise ValueError('review requires a waiting job before its original deadline')
        if (owner and owner['status']!='quiescent') or pending:
            raise ValueError('review requires known quiescent execution with no pending operations')

    def stage_candidate(self, job_id, state, report, offered, request_ref):
        import time
        from pathlib import Path
        # Keep only defined report fields; model approval metadata has no authority.
        fields=('title','complete','claims','summary','comparisons','recommendations','contradictions','unanswered')
        report={k:copy.deepcopy(report[k]) for k in fields}
        report['claims']=[{k:v for k,v in c.items() if k in ('id','kind','text','evidence')} for c in report['claims']]
        canonical={'report':encoded(report),'sources':encoded(state['sources']),'offers':encoded(offered)}
        units=['title']+['claims:'+c['id'] for c in report['claims']]
        for field in ('summary','comparisons','recommendations','contradictions','unanswered'):
            units += [field+':'+str(i) for i in range(len(report[field]))]
        with self._db(transaction=True) as db:
            job=self._get(db,job_id);self._reviewed(job)
            if job['status']!='running' or time.time()>=job['deadline']:raise ValueError('candidate outside active deadline')
            semantic=state.setdefault('semantic',{'tickets':[],'revisions':0,'candidates':[]})
            if len(semantic['candidates'])>=2:raise ValueError('candidate review rounds exhausted')
            descriptor={'version':1,'jobId':job_id,'manifestHash':job['manifest_hash'],
                'rubricSha256':job['manifest']['research_policy']['review']['rubricSha256'],
                'reportSha256':digest(report),'sourcesSha256':digest(state['sources']),
                'offersSha256':digest(offered),'request':copy.deepcopy(request_ref),'units':units}
            descriptor['candidateHash']=digest(descriptor)
            packet={'descriptor':descriptor,'canonical':canonical}
            target=self.job_dir(job_id)/'candidates'/(descriptor['candidateHash']+'.json')
            target.parent.mkdir(parents=True,exist_ok=True)
            data=encoded(packet)
            if target.is_symlink() or (target.exists() and target.read_text()!=data):raise ValueError('candidate artifact conflict')
            if not target.exists():
                with target.open('x') as stream:
                    stream.write(data);stream.flush()
                    import os
                    os.fsync(stream.fileno())
            semantic['active']=descriptor;semantic['candidates'].append(descriptor)
            state['next']='review';state['draft']=report
            self._save_review(db,job,state,'awaiting_semantic_review','candidate_ready',descriptor)
        return packet

    def _packet(self, job):
        self._reviewed(job)
        d=job['checkpoint'].get('semantic',{}).get('active')
        if not d:raise ValueError('no current candidate')
        expected=copy.deepcopy(d);h=expected.pop('candidateHash',None)
        if h!=digest(expected) or not re.fullmatch('[a-f0-9]{64}',h or ''):raise ValueError('candidate descriptor hash mismatch')
        target=self.job_dir(job['id'])/'candidates'/(h+'.json')
        if target.is_symlink() or not target.is_file():raise ValueError('unsafe or missing candidate')
        packet=json.loads(target.read_text())
        if packet.get('descriptor')!=d or set(packet.get('canonical',{}))!={'report','sources','offers'}:raise ValueError('candidate identity mismatch')
        for key,field in [('report','reportSha256'),('sources','sourcesSha256'),('offers','offersSha256')]:
            raw=packet['canonical'][key]
            if not isinstance(raw,str) or hashlib.sha256(raw.encode()).hexdigest()!=d[field]:raise ValueError('candidate artifact hash mismatch')
        if d['manifestHash']!=job['manifest_hash'] or d['rubricSha256']!=job['manifest']['research_policy']['review']['rubricSha256']:raise ValueError('candidate policy mismatch')
        return packet

    def proposal_export(self, job_id):
        with self._db() as db:return self._packet(self._get(db,job_id))

    @staticmethod
    def _review_key(key):
        if not isinstance(key,str) or not 1<=len(key)<=200:raise ValueError('invalid review idempotency key')

    def review_reserve(self, job_id, candidate_hash, rubric_hash, idempotency_key):
        import uuid
        self._review_key(idempotency_key)
        binding={'candidateHash':candidate_hash,'rubricSha256':rubric_hash}
        with self._db(transaction=True) as db:
            job=self._get(db,job_id);self._reviewed(job)
            state=job['checkpoint'];s=state.get('semantic',{})
            for t in s.get('tickets',[]):
                if t['key']==idempotency_key:
                    if t['binding']!=binding:raise ValueError('review key request conflict')
                    return {'id':t['id'],**binding,'dispatchRequired':False}
            self._review_boundary(db,job)
            d=self._packet(job)['descriptor']
            if binding!={k:d[k] for k in binding}:raise ValueError('stale review binding')
            if len(s['tickets'])>=2 or any(t['binding']==binding for t in s['tickets']):raise ValueError('review reservation already spent')
            ticket={'id':str(uuid.uuid4()),'key':idempotency_key,'binding':binding}
            s['tickets'].append(ticket)
            self._save_review(db,job,state,job['status'],'review_reserved',ticket)
            return {'id':ticket['id'],**binding,'dispatchRequired':True}

    def review_submit(self, job_id, ticket_id, candidate_hash, rubric_hash, decision, findings, coverage, idempotency_key):
        import time
        self._review_key(idempotency_key)
        request={'ticketId':ticket_id,'candidateHash':candidate_hash,'rubricSha256':rubric_hash,
                 'decision':decision,'findings':findings,'coverage':coverage,'key':idempotency_key}
        if len(encoded(request).encode())>32768:raise ValueError('review feedback exceeds bound')
        with self._db(transaction=True) as db:
            job=self._get(db,job_id);self._reviewed(job);state=job['checkpoint'];s=state.get('semantic',{})
            tickets=s.get('tickets',[])
            for previous in tickets:
                if previous.get('submission',{}).get('key')==idempotency_key:
                    if previous['submission']!=request:raise ValueError('review submission key conflict')
                    return previous['result']
            self._review_boundary(db,job)
            d=self._packet(job)['descriptor'];ticket=next((t for t in tickets if t['id']==ticket_id),None)
            if not ticket or ticket.get('submission') or ticket['binding']!={'candidateHash':candidate_hash,'rubricSha256':rubric_hash} or candidate_hash!=d['candidateHash'] or rubric_hash!=d['rubricSha256']:
                raise ValueError('invalid, used or stale review ticket')
            if decision not in ('accept','revise','reject') or not isinstance(findings,list) or len(findings)>50 or not isinstance(coverage,list) or any(not isinstance(u,str) for u in coverage) or len(set(coverage))!=len(coverage) or not set(coverage)<=set(d['units']):raise ValueError('invalid review verdict')
            offers=json.loads(self._packet(job)['canonical']['offers'])
            selectors=[{k:e[k] for k in ('source_id','text_sha256','start','end')} for e in offers]
            codes=('missing_context','cross_alternative_attribution','unsupported_premise','lost_condition','unsupported_claim','material_omission','contradiction','other')
            for f in findings:
                closed(f,('unit','code','message','evidence'))
                if f['unit'] not in d['units'] or f['code'] not in codes or not isinstance(f['message'],str) or not 1<=len(f['message'])<=2000 or not isinstance(f['evidence'],list) or len(f['evidence'])>10 or any(e not in selectors for e in f['evidence']):raise ValueError('invalid review finding')
            if decision=='accept' and (findings or set(coverage)!=set(d['units'])):raise ValueError('acceptance requires complete independent coverage and no findings')
            if decision!='accept' and not findings:raise ValueError('negative review requires findings')
            ticket['submission']=copy.deepcopy(request)
            state['next']='finalize';state['reason']='independent review rejected candidate'
            if decision=='accept':
                s['accepted']=copy.deepcopy(d);s['finalizationIntentAt']=time.time();state['reason']=None
            elif decision=='revise' and s['revisions']<1 and len(tickets)<2:
                available=job['manifest']['limits']['model_calls']-job['counters']['model']
                if available<1:raise ValueError('no reserved correction capacity')
                s['revisions']+=1;s['correctionStartModel']=job['counters']['model']
                s['correctionAllowance']=min(2,available)
                state.update(next='model',phase='repair',draft=None,errors=[],reason=None)
                state['semantic_feedback']={'candidateHash':candidate_hash,'rubricSha256':rubric_hash,'findings':copy.deepcopy(findings)}
                s['active']=None
            result={'jobId':job_id,'ticketId':ticket_id,'decision':decision,'candidateHash':candidate_hash,'status':'queued'}
            ticket['result']=result
            self._save_review(db,job,state,'queued','review_submitted',request)
            return result

    def accepted_packet(self, job):
        self._reviewed(job);s=job['checkpoint'].get('semantic',{})
        if not s.get('accepted') or not isinstance(s.get('finalizationIntentAt'),(float,int)) or s['finalizationIntentAt']>=job['deadline']:raise ValueError('no timely accepted finalization intent')
        packet=self._packet(job)
        if packet['descriptor']!=s['accepted']:raise ValueError('acceptance does not bind current candidate')
        return packet
