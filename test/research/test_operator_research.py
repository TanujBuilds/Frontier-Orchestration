"""Native Codex research uses saved public evidence and zero model dispatch."""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_state import Store, manifest_hash, StateError
from research_worker import Worker

class OperatorResearchTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.store=Store(self.tmp.name)
 def job(self,executor='operator',submission='native'):
  m={'schema':2,'executor':executor,'mode':'fixture','submission_id':submission,'question':'Explain SQLite durability',
     'not_after':time.time()+120,'collaboration':{'supervisor':'codex','max_questions':3},
     'scope':{'seed_urls':['https://sqlite.org/wal.html']}}
  return self.store.submit(m,manifest_hash(m))
 def operator(self):
  from research_operator import Operator
  text='SQLite WAL commits append records to the write-ahead log before checkpointing.'
  def search(query):return {'results':[{'url':'https://sqlite.org/wal.html','title':'WAL','content':'Discovery only'}]}
  def read(url,**kwargs):return {'ok':True,'url':url,'finalUrl':url,'text':text,'contentSha256':'a'*64,'fetchedAt':'fixture','truncated':False}
  return Operator(self.store,search,read,'fixture')
 def test_worker_does_not_claim_operator_jobs_or_reserve_model_requests(self):
  job=self.job()
  class ForbiddenModel:
   def complete(self,*args):raise AssertionError('Operator job reached DeepSeek')
  Worker(self.store,ForbiddenModel(),None,None,mode='fixture').drain()
  self.assertEqual(self.store.get(job['id'])['status'],'queued');self.assertEqual(self.store.get(job['id'])['counters']['model'],0)
 def test_read_replay_and_report_preserve_provenance_without_a_model(self):
  job=self.job();op=self.operator();request={'action':'read','url':'https://sqlite.org/wal.html'}
  source=op.action(job['id'],request,'read-1');self.assertEqual(op.action(job['id'],request,'read-1'),source)
  reread=op.action(job['id'],{'action':'read','source_id':'S001','start':0,'length':1000},'saved-source');self.assertEqual(reread['source_id'],'S001')
  report={'title':'WAL evidence','complete':True,'claims':[{'id':'C1','kind':'fact','text':'SQLite uses a WAL.','evidence':[{'source_id':'S001','quote':'SQLite WAL commits append records'}]}],
          'summary':['C1'],'comparisons':[],'recommendations':[],'contradictions':[],'unanswered':[]}
  result=op.action(job['id'],{'action':'finish','report':report},'finish');self.assertEqual(result['status'],'completed')
  self.assertEqual(op.action(job['id'],{'action':'finish','report':report},'finish'),result)
  saved=self.store.get(job['id']);self.assertEqual(saved['counters'],{'search':0,'download':1,'model':0})
  receipt=json.loads((self.store.job_dir(job['id'])/'receipt.json').read_text());self.assertEqual(receipt['model_self_check'],'not_run_operator_mode')
 def test_operator_cannot_take_over_deepseek_jobs_or_fabricate_citations(self):
  job=self.job('deepseek');op=self.operator()
  with self.assertRaises(StateError):op.action(job['id'],{'action':'read','url':'https://sqlite.org/wal.html'},'wrong')
  job=self.job(submission='second')
  with self.assertRaises(StateError):op.action(job['id'],{'action':'finish','report':{'title':'Fake'}},'fake')
  self.assertNotEqual(self.store.get(job['id'])['status'],'completed')
 def test_evidence_error_can_be_repaired_without_stranding_an_operator_command(self):
  job=self.job();op=self.operator()
  report={'title':'Fake','complete':True,'claims':[{'id':'C1','kind':'fact','text':'Fake','evidence':[{'source_id':'S999','quote':'Invented passage'}]}],
          'summary':['C1'],'comparisons':[],'recommendations':[],'contradictions':[],'unanswered':[]}
  with self.assertRaises(StateError):op.action(job['id'],{'action':'finish','report':report},'bad-report')
  result=op.action(job['id'],{'action':'read','url':'https://sqlite.org/wal.html'},'repair-read');self.assertEqual(result['source_id'],'S001')

if __name__=='__main__':unittest.main()
