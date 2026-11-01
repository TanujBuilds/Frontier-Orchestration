"""Deterministic reproductions of exhausted live research context failures (no web/model)."""
import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_state import Store, manifest_hash
from research_worker import Worker
from research_protocol import validate_report
from test_worker import Model, report, URL, TEXT

OTHER='https://docs.temporal.io/activity-definition'
QUOTE='A late saved passage describes the actual recovery guarantee.'

def source(text,url=URL):
    return {'url':url,'requested_url':url,'text':text,'truncated':True,
            'contentSha256':'a'*64,'fetchedAt':'fixture'}

class ContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=Store(self.tmp.name)
        manifest={'submission_id':'context','question':'Compare SQLite and Temporal recovery.',
                  'mode':'fixture','scope':{'seed_urls':[URL,OTHER]}}
        self.job=self.store.submit(manifest,manifest_hash(manifest))
        self.job=self.store.claim_next()
        self.c={'step':0,'phase':'explore','next':'model','sources':{},'history':[],
                'known_urls':[URL,OTHER],'draft':None,'errors':[],'limited':False}
        self.model=Model([])
        self.w=Worker(self.store,self.model,lambda q:{'results':[]},
                      lambda *a,**k:self.fail('No hidden download'),mode='fixture')
    def payload(self):return json.loads(self.w.model_payload(self.job,self.c)['messages'][-1]['content'])
    def read(self,start=0,length=8000):
        return self.w.tool(self.job,self.c,{'action':'read','source_id':'S001','start':start,'length':length},60)
    def test_saved_end_is_explicit_and_repeated_empty_reads_do_not_fetch(self):
        self.c['sources']['S001']=source('x'*50000)
        for _ in range(3):result=self.read(50000)
        self.assertEqual(result['saved_chars'],50000)  # existing metadata remains
        self.assertEqual(result['end'],50000)
        self.assertEqual(result['returned_chars'],0)
        self.assertTrue(result['at_saved_end'])
        self.assertFalse(result['has_more_saved_text'])
        self.assertTrue(result['navigation']['no_new_evidence'])
        self.assertGreaterEqual(result['navigation']['repeats'],2)
        self.assertEqual(self.store.get(self.job['id'])['counters'],{'search':0,'download':0,'model':0})
    def test_late_passage_survives_history_eviction_and_checkpoint_reload(self):
        text='x'*40000+QUOTE+'y'*9900
        self.c['sources']['S001']=source(text)
        self.read(40000,1000)
        self.c['history']=[{'role':'user','content':{'unrelated':'z'*6000}}]*20
        self.c['phase']='draft'
        self.store.checkpoint(self.job['id'],self.c)
        self.c=self.store.get(self.job['id'])['checkpoint']
        windows=self.payload()['evidence_windows']
        self.assertEqual(len(windows),1)
        window=windows[0]
        self.assertIn(QUOTE,window['text'])
        self.assertEqual(window['start'],40000)
        self.assertEqual(window['end'],41000)
        self.assertEqual(window['text_sha256'],hashlib.sha256(text.encode()).hexdigest())
        self.assertEqual(window['content_sha256'],'a'*64)
    def test_stale_source_window_is_not_rebound_to_new_bytes(self):
        self.c['sources']['S001']=source('x'*40000+QUOTE)
        self.read(40000)
        self.c['sources']['S001']['text']='different bytes'
        context=self.payload()
        self.assertEqual(context['evidence_windows'],[])
        self.assertGreater(context['context_bounds']['stale_windows_omitted'],0)
    def test_comparison_seed_gaps_remain_visible_despite_many_sqlite_sources(self):
        for n in range(12):self.c['sources']['S'+str(n+1).zfill(3)]=source('SQLite only '+str(n),URL+str(n))
        self.c['sources']['S001']=source(TEXT)
        self.read()
        coverage=self.payload()['coverage']
        temporal=next(x for x in coverage['seeds'] if x['url']==OTHER)
        self.assertEqual(temporal['source_ids'],[])
        self.assertFalse(temporal['saved'])
        self.assertIn('not proof',coverage['interpretation'])
        self.assertTrue(self.payload()['navigation']['no_new_evidence'] is False)
    def test_repeated_reads_and_searches_report_bounded_nonprogress(self):
        self.c['sources']['S001']=source(TEXT)
        self.read();self.read();result=self.read()
        self.assertTrue(result['navigation']['no_new_evidence'])
        for _ in range(4):
            result=self.w.tool(self.job,self.c,{'action':'search','query':'same SQLite query'},60)
            self.c['step']+=1
        self.assertTrue(result['navigation']['no_new_evidence'])
        self.assertGreaterEqual(result['navigation']['repeats'],3)
        self.assertLess(len(json.dumps(self.c['navigation'])),2500)
        self.assertEqual(self.store.get(self.job['id'])['counters']['search'],4)
        self.assertEqual(len(self.payload()['evidence_windows']),1)
    def test_payload_is_bounded_for_unicode_history_sources_and_report(self):
        for n in range(50):
            sid='S'+str(n+1).zfill(3)
            self.c['sources'][sid]=source('\U0001f525'*50000)
            self.w.tool(self.job,self.c,{'action':'read','source_id':sid,'start':40000,'length':10000},60)
        self.c['history']=[{'role':'user','content':'\U0001f525'*50000}]*12
        self.c['phase']='draft';self.c['draft']={'large':'\U0001f525'*100000}
        payload=self.w.model_payload(self.job,self.c)
        self.assertLessEqual(len(json.dumps(payload,ensure_ascii=False).encode()),196608)
        self.assertLessEqual(len(self.c['evidence_windows']),12)
        context=json.loads(payload['messages'][-1]['content'])
        self.assertTrue(context['context_bounds']['omissions'])
    def test_oversized_approved_scope_fails_before_model_reservation(self):
        self.job['manifest']['scope']['seed_urls']=['https://example.com/'+('q'*300000)]
        with self.assertRaisesRegex(ValueError,'bounded model context'):
            self.w.model_payload(self.job,self.c)
        self.assertEqual(self.store.get(self.job['id'])['counters']['model'],0)
    def test_legacy_reserved_response_replays_original_payload_after_upgrade(self):
        self.store.checkpoint(self.job['id'],self.c)
        legacy={'phase':'explore','messages':[{'role':'user','content':'legacy exact payload'}]}
        opid=self.job['id']+':0:model'
        self.store.reserve(self.job['id'],'model',legacy,op_id=opid)
        incomplete={'title':'Missing comparison evidence','complete':False,'claims':[],
                    'summary':[],'comparisons':[],'recommendations':[],'contradictions':[],
                    'unanswered':['Temporal evidence missing.']}
        self.store.complete_operation(opid,{'content':json.dumps({'action':'finish','report':incomplete})})
        model=Model([{'action':'finish','report':incomplete}])
        Worker(self.store,model,lambda q:{},lambda *a,**k:{},mode='fixture').drain()
        final=self.store.get(self.job['id'])
        self.assertEqual(final['status'],'partial')
        self.assertEqual(final['counters']['model'],2)
        self.assertEqual(model.calls,1)
        self.assertEqual(self.store.operations(self.job['id'])[0]['payload'],legacy)
    def test_boundary_signals_never_allow_fabricated_quote(self):
        self.c['sources']['S001']=source('x'*50000)
        self.read(50000)
        bad=report();bad['claims'][0]['evidence'][0]['quote']=QUOTE
        self.assertIn('C1: exact saved passage required',validate_report(bad,self.c['sources']))


class ComparisonFixtureTests(unittest.TestCase):
    def fixture(self,missing=False):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        store=Store(tmp.name)
        urls=[URL,'https://python-rq.org/docs/workers/',OTHER]
        quotes=['A fixture SQLite transaction commits durable queue state.',
                'A fixture lease generation rejects a stale worker update.',
                'A fixture RQ worker records failed jobs for later retry.',
                'A fixture Temporal activity retry may repeat side effects.',
                'A fixture idempotency key reconciles an ambiguous external request.']
        texts=['x'*3000+' '.join(quotes[:2]),'y'*3000+quotes[2],
               'z'*3000+' '.join(quotes[3:])]
        m={'submission_id':'comparison','question':'Compare SQLite, RQ and Temporal for one host.',
           'mode':'fixture','scope':{'seed_urls':urls},'limits':{'model_calls':12}}
        job=store.submit(m,manifest_hash(m));contexts=[]
        def reader(url,**kwargs):return {'ok':True,**source(texts[urls.index(url)],url)}
        findings=[]
        for i,quote in enumerate(quotes):
            sid='S001' if i<2 else 'S002' if i==2 else 'S003'
            findings.append({'id':'C'+str(i+1),'kind':'fact','text':'Fixture claim '+str(i+1),
                             'evidence':[{'source_id':sid,'quote':quote}]})
        complete={'title':'FIXTURE queue comparison','complete':not missing,
            'claims':findings[:3] if missing else findings,
            'summary':['C1','C2','C3'] if missing else ['C1','C2','C3','C4','C5'],
            'comparisons':[{'text':'Fixture comparison; independent factual assessment not performed.',
                            'claim_ids':['C1','C3']}],
            'recommendations':[] if missing else [{'text':'Fixture inference: choose SQLite under the stated one-host assumptions.',
                                                  'claim_ids':['C1','C2','C3','C4','C5']}],
            'contradictions':[],'unanswered':['Temporal evidence missing.'] if missing else []}
        class ScriptedModel:
            calls=0
            def complete(inner,messages,timeout):
                inner.calls+=1;context=json.loads(messages[-1]['content']);contexts.append(context)
                reads=2 if missing else 3
                if inner.calls<=reads:return {'content':json.dumps({'action':'read','url':urls[inner.calls-1]})}
                ids={w['source_id'] for w in context['evidence_windows']}
                self.assertEqual(ids,{'S001','S002'} if missing else {'S001','S002','S003'})
                self.assertTrue(all(any(e['quote'] in w['text'] for w in context['evidence_windows'] if w['source_id']==e['source_id'])
                    for claim in complete['claims'] for e in claim['evidence']))
                self.assertEqual(context['coverage']['seeds'][2]['saved'],not missing)
                return {'content':json.dumps({'action':'finish','report':complete})}
        model=ScriptedModel()
        Worker(store,model,lambda q:self.fail('No extra searches'),reader,mode='fixture').drain()
        final=store.get(job['id']);directory=store.job_dir(job['id'])
        self.assertEqual(final['status'],'partial' if missing else 'completed')
        self.assertEqual(final['counters'],{'search':0,'download':2 if missing else 3,'model':4 if missing else 5})
        accepted=json.loads((directory/'claims.json').read_text())
        self.assertEqual(len(accepted['claims']),3 if missing else 5)
        self.assertEqual(len(accepted['recommendations']),0 if missing else 1)
        self.assertIn('FIXTURE',(directory/'report.md').read_text())
        import os,shutil
        evidence=os.environ.get('RESEARCH_CONTEXT_EVIDENCE_DIR')
        if evidence:
            target=Path(evidence)/('comparison-partial' if missing else 'comparison-complete')
            target.mkdir(parents=True,exist_ok=True)
            for name in ('claims.json','sources.json','manifest.json','report.md','receipt.json'):
                shutil.copyfile(directory/name,target/name)
            (target/'payloads.json').write_text(json.dumps(contexts,indent=2))
    def test_five_claim_comparison_uses_retained_primary_source_shaped_fixture_passages(self):self.fixture()
    def test_missing_option_stays_partial_without_a_recommendation(self):self.fixture(missing=True)
    def test_last_three_calls_remain_draft_audit_repair_with_original_limits(self):
        with tempfile.TemporaryDirectory() as root:
            store=Store(root);m={'submission_id':'reserved','question':'Compare options with missing evidence.',
                'mode':'fixture','scope':{'seed_urls':[URL]},'limits':{'model_calls':7}}
            job=store.submit(m,manifest_hash(m));phases=[]
            bad=report();bad['claims'][0]['evidence'][0]['quote']='A nonexistent passage beyond the saved end.'
            class RepeatedModel:
                def complete(inner,messages,timeout):
                    phase=json.loads(messages[-1]['content'])['phase'];phases.append(phase)
                    action={'action':'read','url':URL} if phase=='explore' else {'action':'finish','report':bad}
                    return {'content':json.dumps(action)}
            Worker(store,RepeatedModel(),lambda q:{},lambda url,**k:{'ok':True,**source(TEXT)},mode='fixture').drain()
            final=store.get(job['id']);self.assertEqual(final['status'],'partial')
            self.assertEqual(phases,['explore']*4+['draft','audit','repair'])
            self.assertEqual(final['counters'],{'search':0,'download':1,'model':7})
            before=(final['manifest_hash'],final['deadline'],final['counters'],len(store.operations(job['id'])))
            Worker(store,Model([]),lambda q:{},lambda *a,**k:{},mode='fixture').drain()
            final=store.get(job['id'])
            self.assertEqual(before,(final['manifest_hash'],final['deadline'],final['counters'],len(store.operations(job['id']))))

if __name__=='__main__':unittest.main()
