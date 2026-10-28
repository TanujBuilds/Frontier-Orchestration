"""Harness deadlines and cooperative handoffs retain standalone compatibility."""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_state import Store, manifest_hash, StateError
from research_worker import Worker

class HarnessResearchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=Store(self.temp.name)
    def submit(self, **changes):
        m={'schema':2,'submission_id':'harness','question':'Compare durable queue approaches',
           'mode':'fixture','not_after':time.time()+60,
           'collaboration':{'supervisor':'codex','max_questions':3},**changes}
        return self.store.submit(m,manifest_hash(m))
    def worker(self,model):
        return Worker(self.store,model,lambda q:{'results':[]},lambda *a,**k:{'ok':False},mode='fixture')
    def test_absolute_deadline_is_bound_by_approval_and_clamps_start(self):
        job=self.submit();running=self.store.claim_next()
        self.assertEqual(running['deadline'],job['manifest']['not_after'])
        m=dict(job['manifest'],not_after=job['manifest']['not_after']+1)
        self.assertNotEqual(manifest_hash(m),job['manifest_hash'])
    def test_question_releases_worker_and_answer_preserves_spending(self):
        job=self.submit()
        class Model:
            def complete(self,messages,timeout):return {'content':json.dumps({'action':'ask_supervisor','question':'Compare throughput or reliability first?'})}
        self.worker(Model()).drain();waiting=self.store.get(job['id'])
        self.assertEqual(waiting['status'],'awaiting_supervisor')
        self.assertTrue(self.store.execution_status(job['id'])['quiescent'])
        answer=self.store.answer(job['id'],'Reliability first','codex')
        self.assertEqual(answer['status'],'queued');self.assertEqual(answer['counters']['model'],1)
        self.assertEqual(answer['deadline'],waiting['deadline'])
        self.assertIn('Reliability first',json.dumps(answer['checkpoint']))
    def test_deepseek_only_question_cannot_be_answered_by_codex(self):
        job=self.submit(collaboration={'supervisor':'user','max_questions':3});self.store.claim_next()
        self.store.ask(job['id'],'Which focus?')
        with self.assertRaises(StateError):self.store.answer(job['id'],'latency','codex')
        self.assertEqual(self.store.answer(job['id'],'latency','user')['status'],'queued')
    def test_yield_during_model_returns_only_after_saved_boundary(self):
        job=self.submit();store=self.store;seen=[]
        class Model:
            def complete(self,messages,timeout):
                seen.append(store.execution_status(job['id'])['quiescent'])
                store.request_yield(job['id'])
                return {'content':json.dumps({'action':'search','query':'durable queues'})}
        self.worker(Model()).drain();paused=store.get(job['id'])
        self.assertEqual(seen,[False]);self.assertEqual(paused['status'],'suspended')
        self.assertTrue(store.execution_status(job['id'])['quiescent'])
        self.assertEqual(paused['checkpoint']['next'],'tool');self.assertEqual(paused['counters']['search'],0)
        resumed=store.resume(job['id']);self.assertEqual(resumed['deadline'],paused['deadline'])
    def test_legacy_job_cannot_gain_collaboration_without_new_approval(self):
        m={'submission_id':'legacy','question':'Legacy research'}
        job=self.store.submit(m,manifest_hash(m));self.store.claim_next()
        with self.assertRaises(StateError):self.store.ask(job['id'],'Expand permissions?')
    def test_running_status_is_not_quiescence_proof(self):
        job=self.submit();self.store.claim_next();self.store.execution_start(job['id'],'test-token')
        self.store.stop(job['id'])
        self.assertFalse(self.store.execution_status(job['id'])['quiescent'])
        self.store.execution_end(job['id'],'test-token')
        self.assertTrue(self.store.execution_status(job['id'])['quiescent'])
