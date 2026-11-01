"""Crash/pressure/heldout verdict fixtures. No automated semantic adjudication."""
import copy,hashlib,json,time,unittest
from pathlib import Path
from unittest.mock import patch
import test_review_lifecycle as life
import test_heldout_synthesis as heldout
from research_state import Store,StateError
from research_worker import Worker
from research_review import digest
from research_protocol import completion_payload

class ReviewEdges(unittest.TestCase):
 setUp=life.ReviewLifecycleTests.setUp
 seed=life.ReviewLifecycleTests.seed
 run_report=life.ReviewLifecycleTests.run_report
 pending=life.ReviewLifecycleTests.pending
 ticket=life.ReviewLifecycleTests.ticket
 submit=life.ReviewLifecycleTests.submit
 corrected=life.ReviewLifecycleTests.corrected
 def revise(self,jid,p,code='missing_context',unit='claims:C4',evidence=None):
  t=self.ticket(jid,p);return self.submit(jid,p,t,'revise',[{'unit':unit,'code':code,'message':'Curated fixture finding; review the full replacement.','evidence':evidence or []}])
 def test_candidate_write_before_checkpoint_crash_replays_cached_result(self):
  jid=self.seed()
  with patch.object(self.store,'_save_review',side_effect=RuntimeError('crash after candidate file')):self.run_report([self.negative])
  self.assertEqual(self.store.get(jid)['status'],'failed');files=list((self.store.job_dir(jid)/'candidates').glob('*.json'));self.assertEqual(len(files),1)
  deadline=self.store.get(jid)['deadline'];self.store.resume(jid);m=self.run_report([]);self.assertEqual(m.inputs,[]);self.assertEqual(self.store.get(jid)['status'],'awaiting_semantic_review');self.assertEqual(self.store.get(jid)['deadline'],deadline);self.assertEqual(self.store.get(jid)['counters']['model'],1)
 def test_proposal_tamper_and_wrong_rubric_never_approve(self):
  jid,p=self.pending()
  with self.assertRaises(ValueError):self.store.review_reserve(jid,p['descriptor']['candidateHash'],'b'*64,'wrong-rubric')
  file=self.store.job_dir(jid)/'candidates'/(p['descriptor']['candidateHash']+'.json');tampered=copy.deepcopy(p);tampered['canonical']['sources']+=' ';file.write_text(json.dumps(tampered))
  with self.assertRaises(ValueError):self.store.proposal_export(jid)
  with self.assertRaises(ValueError):self.ticket(jid,p)
 def test_correction_result_replays_without_another_model_dispatch(self):
  jid,p=self.pending();self.revise(jid,p);j=self.store.claim_next();w=Worker(self.store,None,None,None,mode='fixture');c=j['checkpoint']
  with patch('research_worker.make_passages',return_value=self.f['offers']):payload=w.model_payload(j,c)
  op=self.store.reserve(jid,'model',payload,jid+':'+str(c['step'])+':model');self.store.complete_operation(op['id'],{'content':json.dumps({'action':'finish','report':self.corrected()})});self.store=Store(self.tmp.name)
  m=self.run_report([]);self.assertEqual(m.inputs,[]);self.assertEqual(self.store.get(jid)['counters']['model'],2);self.assertEqual(self.store.get(jid)['status'],'awaiting_semantic_review')
 def test_pending_correction_owner_remains_uncertain_on_restart(self):
  jid,p=self.pending();self.revise(jid,p);j=self.store.claim_next();self.store.execution_start(jid,'original');w=Worker(self.store,None,None,None,mode='fixture')
  with patch('research_worker.make_passages',return_value=self.f['offers']):payload=w.model_payload(j,j['checkpoint'])
  self.store.reserve(jid,'model',payload,jid+':'+str(j['checkpoint']['step'])+':model');self.store=Store(self.tmp.name)
  self.assertEqual(self.run_report([]).inputs,[])
  self.assertEqual(self.store.execution_status(jid)['execution']['status'],'uncertain');self.assertEqual(self.store.get(jid)['counters']['model'],2)
 def test_initial_generation_reserves_two_correction_calls_inside_twenty(self):
  jid=self.seed();c=self.store.get(jid)['checkpoint'];c.update(phase='repair',step=18);self.store.checkpoint(jid,c)
  for i in range(18):
   op=self.store.reserve(jid,'model',{'fixture':i},'spent-'+str(i));self.store.complete_operation(op['id'],{})
  self.run_report([]);self.assertEqual(self.store.get(jid)['counters']['model'],18);self.assertEqual(self.store.get(jid)['status'],'partial')
 def test_final_artifact_crash_can_replay_only_committed_intent_after_deadline(self):
  jid,p=self.pending();t=self.ticket(jid,p);self.submit(jid,p,t);deadline=self.store.get(jid)['deadline']
  import research_worker
  original=research_worker.atomic
  def fail_receipt(path,data):
   if Path(path).name=='receipt.json':raise OSError('fixture crash before receipt')
   return original(path,data)
  with patch('research_worker.atomic',side_effect=fail_receipt):self.run_report([])
  self.assertEqual(self.store.get(jid)['status'],'failed')
  with patch('time.time',return_value=deadline+1):self.store.resume(jid);self.run_report([])
  self.assertEqual(self.store.get(jid)['status'],'completed');self.assertEqual(self.store.get(jid)['counters']['model'],1)
 def test_real_destination_and_antecedent_feedback_do_not_change_citations(self):
  for cid,sid,start in [('C4','S007',3980),('C8','S004',5062)]:
   with self.subTest(cid=cid):
    self.setUp();jid,p=self.pending();before=p['canonical']['report'];offer=next(e for e in self.f['offers'] if e['source_id']==sid and e['start']==start);e={k:offer[k] for k in ('source_id','text_sha256','start','end')};self.revise(jid,p,unit='claims:'+cid,evidence=[e]);j=self.store.get(jid);w=Worker(self.store,None,None,None,mode='fixture')
    with patch('research_worker.make_passages',return_value=self.f['offers']):payload=w.model_payload(j,j['checkpoint'])
    content=json.loads(payload['messages'][-1]['content']);self.assertEqual(content['semantic_feedback']['findings'][0]['evidence'],[e]);self.assertEqual(before,json.loads((self.store.job_dir(jid)/'candidates'/(p['descriptor']['candidateHash']+'.json')).read_text())['canonical']['report']);self.assertIsNone(j['checkpoint']['semantic']['active'])
 def test_protected_fictional_alternatives_and_conditions_still_need_review(self):
  # Existing heldout file is consumed without edits; fixture judgments remain external.
  for code,text in [('cross_alternative_attribution','Archive A retains records only when retention mode is enabled. Archive B does not retain discarded records.'),('lost_condition','Only if the greenhouse valve loses power before closing. In this case the reservoir remains connected until manual isolation.')]:
   with self.subTest(code=code):
    self.setUp();jid=self.seed();s={'S001':{'url':'https://fixture.invalid/heldout','text':text,'contentSha256':hashlib.sha256(text.encode()).hexdigest()}};offer=heldout.offer('S001',0,text,hashlib.sha256(text.encode()).hexdigest());offer.update(catalog_version=2,complete_unit=True);self.f['offers']=[offer];c=self.store.get(jid)['checkpoint'];c['sources']=s;self.store.checkpoint(jid,c)
    r={'title':'Fictional fixture','complete':True,'claims':[{'id':'C1','kind':'fact','text':text,'evidence':[heldout.selection(offer)]}],'summary':['C1'],'comparisons':[{'text':'Both alternatives always retain everything.','claim_ids':['C1']}],'recommendations':[],'contradictions':[],'unanswered':[]};self.run_report([r]);p=self.store.proposal_export(jid);t=self.ticket(jid,p);self.submit(jid,p,t,'reject',[{'unit':'comparisons:0','code':code,'message':'Curated negative fixture, never a runtime keyword decision.','evidence':[]}]);self.run_report([]);self.assertEqual(self.store.get(jid)['status'],'partial')
 def test_useful_positive_conditional_proposal_needs_no_benchmark(self):
  jid=self.seed();r=self.corrected();self.assertGreaterEqual(len(r['claims']),5);self.run_report([r]);p=self.store.proposal_export(jid);t=self.ticket(jid,p);self.submit(jid,p,t);self.run_report([]);self.assertEqual(self.store.get(jid)['status'],'completed');self.assertIn('untested',json.dumps(r).lower())
 def test_wire_unicode_and_oversized_untrusted_feedback_are_bounded(self):
  jid,p=self.pending();t=self.ticket(jid,p)
  with self.assertRaises(ValueError):self.submit(jid,p,t,coverage=['x'*40000])
  self.submit(jid,p,t,'revise',[{'unit':'claims:C8','code':'missing_context','message':'🔥'*1900,'evidence':[]}]);j=self.store.get(jid);c=j['checkpoint'];c['history']=[{'role':'user','content':'🔥'*20000}]*12;w=Worker(self.store,None,None,None,mode='fixture')
  with patch('research_worker.make_passages',return_value=self.f['offers']):payload=w.model_payload(j,c)
  wire=completion_payload('unreported',payload['messages']);self.assertLessEqual(len(json.dumps(wire).encode()),196608);content=json.loads(payload['messages'][-1]['content']);self.assertLessEqual(len(content['citation_passages']),96);self.assertTrue(content['context_bounds']['omissions'])
 def test_review_reservation_exhaustion_no_refund_or_implicit_replacement(self):
  jid,p=self.pending();t=self.ticket(jid,p)
  with self.assertRaises(ValueError):self.ticket(jid,p,'duplicate-context')
  self.submit(jid,p,t,'revise',[{'unit':'claims:C8','code':'missing_context','message':'Review entire replacement.','evidence':[]}]);self.run_report([self.corrected()]);p2=self.store.proposal_export(jid);t2=self.ticket(jid,p2,'r1');self.submit(jid,p2,t2,'revise',[{'unit':'recommendations:0','code':'unsupported_premise','message':'No further correction allowed.','evidence':[]}],key='s1');self.run_report([]);self.assertEqual(self.store.get(jid)['status'],'partial');self.assertEqual(len(self.store.get(jid)['checkpoint']['semantic']['tickets']),2)
