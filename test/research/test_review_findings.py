"""Regressions for the single independent Sol source review."""
import copy,hashlib,json,unittest
from unittest.mock import patch
import test_review_lifecycle as life
from research_state import Store
from research_worker import Worker
class IndependentReviewFindings(unittest.TestCase):
 setUp=life.ReviewLifecycleTests.setUp
 seed=life.ReviewLifecycleTests.seed
 run_report=life.ReviewLifecycleTests.run_report
 pending=life.ReviewLifecycleTests.pending
 ticket=life.ReviewLifecycleTests.ticket
 submit=life.ReviewLifecycleTests.submit
 corrected=life.ReviewLifecycleTests.corrected
 def test_completed_initial_call_eighteen_replays_into_review_without_spending(self):
  jid=self.seed();c=self.store.get(jid)['checkpoint'];c.update(phase='repair',step=17);self.store.checkpoint(jid,c)
  for i in range(17):
   op=self.store.reserve(jid,'model',{'fixture':i},'spent-'+str(i));self.store.complete_operation(op['id'],{})
  j=self.store.get(jid);w=Worker(self.store,None,None,None,mode='fixture')
  with patch('research_worker.make_passages',return_value=self.f['offers']):payload=w.model_payload(j,c)
  op=self.store.reserve(jid,'model',payload,jid+':17:model');self.store.complete_operation(op['id'],{'content':json.dumps({'action':'finish','report':self.negative})});self.store=Store(self.tmp.name)
  self.assertEqual(self.run_report([]).inputs,[]);self.assertEqual(self.store.get(jid)['status'],'awaiting_semantic_review');self.assertEqual(self.store.get(jid)['counters']['model'],18)
 def test_second_correction_result_replays_after_saved_result_crash(self):
  jid,p=self.pending();t=self.ticket(jid,p);self.submit(jid,p,t,'revise',[{'unit':'claims:C8','code':'missing_context','message':'Fixture repair.','evidence':[]}]);bad=copy.deepcopy(self.negative);bad['contradictions']=['broken'];complete=self.store.complete_operation
  def crash(opid,result,*args,**kw):
   saved=complete(opid,result,*args,**kw)
   if opid==jid+':2:model':raise RuntimeError('crash after second correction result persisted')
   return saved
  with patch.object(self.store,'complete_operation',side_effect=crash):self.run_report([bad,self.corrected()])
  self.assertEqual(self.store.get(jid)['status'],'failed');self.store=Store(self.tmp.name);self.store.resume(jid);self.assertEqual(self.run_report([]).inputs,[]);self.assertEqual(self.store.get(jid)['status'],'awaiting_semantic_review');self.assertEqual(self.store.get(jid)['counters']['model'],3)
 def test_final_report_and_source_bytes_equal_exact_reviewed_artifacts(self):
  jid,p=self.pending();t=self.ticket(jid,p);self.submit(jid,p,t);self.run_report([])
  for file,field in [('claims.json','reportSha256'),('sources.json','sourcesSha256')]:self.assertEqual(hashlib.sha256((self.store.job_dir(jid)/file).read_bytes()).hexdigest(),p['descriptor'][field])
