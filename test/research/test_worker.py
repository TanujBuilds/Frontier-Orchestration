import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_state import Store, manifest_hash
try:
    from research_worker import Worker
except ModuleNotFoundError:
    Worker=None

URL='https://www.sqlite.org/wal.html'
TEXT='All processes must be on the same host computer.'
def report():
    return {'title':'Queue comparison','complete':True,'claims':[{'id':'C1','kind':'fact','text':'SQLite WAL uses one host.','evidence':[{'source_id':'S001','quote':'must be on the same host computer'}]}], 'summary':['C1'],'comparisons':[], 'recommendations':[{'text':'Consider SQLite for a single host.','claim_ids':['C1']}], 'contradictions':[], 'unanswered':[]}

class Model:
    def __init__(self,actions): self.actions=actions; self.calls=0
    def complete(self,messages,timeout):
        self.calls+=1
        action=self.actions.pop(0)
        if isinstance(action,Exception): raise action
        return {'content':json.dumps(action),'usage':{'total_tokens':20}}

class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Worker,'worker not implemented')
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=Store(self.temp.name)
        self.reads=[]; self.searches=[]
    def submit(self,**kwargs):
        m={'submission_id':'one','question':'Compare durable single-host queues.','mode':'fixture','scope':{'seed_urls':[URL]},**kwargs}
        return self.store.submit(m,manifest_hash(m))
    def reader(self,url,**kwargs):
        self.reads.append(url)
        return {'ok':True,'url':url,'finalUrl':url,'text':TEXT,'contentSha256':'a'*64,'fetchedAt':'2026-10-28T00:00:00Z'}
    def search(self,q):
        self.searches.append(q)
        return {'status':'ok','results':[{'url':URL,'title':'WAL','content':'discovery only'}]}
    def worker(self,model,**kwargs): return Worker(self.store,model,self.search,self.reader,mode='fixture',**kwargs)
    def test_cited_report_self_check_and_no_duplicate_restart(self):
        job=self.submit()
        model=Model([{'action':'read','url':URL},{'action':'finish','report':report()},{'action':'finish','report':report()}])
        self.worker(model).drain()
        result=self.store.get(job['id'])
        self.assertEqual(result['status'],'completed')
        self.assertEqual(result['counters'],{'search':0,'download':1,'model':3})
        self.assertIn('FIXTURE',(self.store.job_dir(job['id'])/'report.md').read_text())
        self.worker(model).drain()
        self.assertEqual(model.calls,3);self.assertEqual(len(self.reads),1)
    def test_hallucinated_citation_never_passes_as_completed(self):
        job=self.submit(limits={'model_calls':4})
        bad=report();bad['claims'][0]['evidence'][0]['source_id']='S999'
        model=Model([{'action':'finish','report':bad}]*4)
        self.worker(model).drain()
        self.assertEqual(self.store.get(job['id'])['status'],'partial')
        self.assertLessEqual(model.calls,4)
    def test_model_cannot_execute_shell_or_fetch_unseen_url(self):
        job=self.submit(limits={'model_calls':5})
        model=Model([{'action':'shell','command':'touch /tmp/not-allowed'}, {'action':'read','url':'https://unseen.com/a'}, {'action':'finish','report':report()}]*2)
        self.worker(model).drain()
        self.assertEqual(self.reads,[])
        self.assertNotEqual(self.store.get(job['id'])['status'],'completed')
    def test_ambiguous_saved_call_stays_spent_and_is_not_sent_again(self):
        job=self.submit(limits={'model_calls':4});job=self.store.claim_next()
        self.store.checkpoint(job['id'],{'step':0,'phase':'explore','next':'model','history':[],'sources':{},'known_urls':[URL],'draft':None,'errors':[],'limited':False})
        job=self.store.get(job['id'])
        # Payload is bound to the checkpoint, as the real worker does before reserve.
        model=Model([{'action':'finish','report':report()}]*4)
        w=self.worker(model)
        payload=w.model_payload(job,job['checkpoint'])
        self.store.reserve(job['id'],'model',payload,op_id=job['id']+':0:model')
        w.drain()
        self.assertEqual(self.store.operations(job['id'])[0]['status'],'failed')
        self.assertLessEqual(model.calls,3)
        self.assertEqual(self.store.get(job['id'])['counters']['model'],4)
    def test_fixture_job_is_blocked_by_live_worker(self):
        job=self.submit()
        model=Model([])
        Worker(self.store,model,self.search,self.reader,mode='live').drain()
        self.assertEqual(model.calls,0)
        self.assertEqual(self.store.get(job['id'])['status'],'blocked')
    def test_stop_during_call_prevents_next_dispatch(self):
        job=self.submit()
        class StopModel:
            calls=0
            def complete(inner,messages,timeout):
                inner.calls+=1; self.store.stop(job['id'])
                return {'content':json.dumps({'action':'read','url':URL})}
        model=StopModel(); self.worker(model).drain()
        self.assertEqual(self.store.get(job['id'])['status'],'stopped')
        self.assertEqual(self.reads,[]);self.assertEqual(model.calls,1)

    def test_malformed_public_links_do_not_poison_backlog(self):
        job=self.submit()
        def html_reader(url,artifact_dir=None,**kwargs):
            artifact_dir.mkdir(parents=True,exist_ok=True)
            path=artifact_dir/'page.html';path.write_text('<a href="http://[">bad</a>')
            return {**self.reader(url),'contentType':'text/html','sourcePath':str(path),'links':['http://[','/valid']}
        model=Model([{'action':'read','url':URL},{'action':'finish','report':report()},{'action':'finish','report':report()}])
        Worker(self.store,model,self.search,html_reader,mode='fixture').drain()
        self.assertEqual(self.store.get(job['id'])['status'],'completed')

        self.assertIn('https://www.sqlite.org/valid',self.store.get(job['id'])['checkpoint']['known_urls'])

    def test_exhausted_counter_does_not_prevent_replaying_a_saved_final_report(self):
        job=self.submit(limits={'downloads':1})
        self.store.claim_next()
        self.store.reserve(job['id'],'download',{'url':URL})
        self.store.checkpoint(job['id'],{'step':8,'phase':'audit','next':'finalize','history':[],
            'sources':{'S001':{'url':URL,'text':TEXT,'fetchedAt':'fixture','contentSha256':'a'*64}},
            'draft':report(),'errors':[],'limited':False,'known_urls':[URL]})
        self.store.stop(job['id']);self.store.resume(job['id'])
        model=Model([]);self.worker(model).drain()
        self.assertEqual(self.store.get(job['id'])['status'],'completed')
        self.assertEqual(model.calls,0)

if __name__=='__main__':unittest.main()
