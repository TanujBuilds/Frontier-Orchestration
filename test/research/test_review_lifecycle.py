"""Scripted review verdicts exercise lifecycle, not an entailment oracle."""
import copy,json,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_state import Store,manifest_hash,StateError,BudgetExceeded
from research_worker import Worker
from research_review import digest
from test_review_protocol import manifest
from test_proposal_recovery import F
NEG=Path(__file__).parent/'fixtures/review-final-negative.json'

class ScriptModel:
 def __init__(self,reports):self.reports=list(reports);self.inputs=[]
 def complete(self,messages,timeout):
  self.inputs.append(json.loads(messages[-1]['content']))
  if not self.reports:raise AssertionError('Unexpected model call')
  return {'content':json.dumps({'action':'finish','report':self.reports.pop(0)})}

class ReviewLifecycleTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.store=Store(self.tmp.name);self.f=json.loads(F.read_text());self.negative=json.loads(NEG.read_text())
 def seed(self,limit=20):
  m=manifest();m['limits']={'model_calls':limit};j=self.store.submit(m,manifest_hash(m));j=self.store.claim_next();c={'step':0,'phase':'explore','next':'model','history':[],'sources':self.f['sources'],'known_urls':[],'draft':None,'errors':[],'limited':False};self.store.checkpoint(j['id'],c)
  op=self.store.reserve(j['id'],'search',{'query':'fixture query'});self.store.complete_operation(op['id'],{'query':'fixture query','status':'ok','results':[]});return j['id']
 def run_report(self,reports):
  model=ScriptModel(reports);w=Worker(self.store,model,lambda *a:self.fail('No search'),lambda *a:self.fail('No download'),mode='fixture')
  with patch('research_worker.make_passages',return_value=self.f['offers']):w.drain()
  return model
 def pending(self):
  jid=self.seed();model=self.run_report([self.negative]);j=self.store.get(jid);self.assertEqual(j['status'],'awaiting_semantic_review');self.assertTrue(self.store.execution_status(jid)['quiescent']);self.assertEqual(len(model.inputs),1)
  return jid,self.store.proposal_export(jid)
 def ticket(self,jid,packet,key='r0'):
  d=packet['descriptor'];return self.store.review_reserve(jid,d['candidateHash'],d['rubricSha256'],key)
 def submit(self,jid,p,ticket,decision='accept',findings=None,coverage=None,key='submit0'):
  d=p['descriptor'];return self.store.review_submit(jid,ticket['id'],d['candidateHash'],d['rubricSha256'],decision,findings or [],d['units'] if coverage is None else coverage,key)
 def corrected(self):
  r=copy.deepcopy(self.negative);r['claims']=[c for c in r['claims'] if c['id'] not in ['C4','C8']];r['summary']=[c['id'] for c in r['claims']];r['comparisons']=[]
  r['recommendations']=[{'text':'Inference: If durable workflow state and recovery are required, consider Temporal based on its documented recovery/replay; external effects require separate application/provider design.','claim_ids':['C7']}];r['unanswered']=['Fixture proposal: lease/fencing design and other operational premises remain untested.'];return r
 def test_protocol_valid_negative_cannot_finalize_without_review(self):
  jid,p=self.pending();self.assertEqual(self.store.get(jid)['counters']['model'],1)
  with self.assertRaises((ValueError,StateError)):self.store.finish(jid,'completed')
  self.assertFalse((self.store.job_dir(jid)/'receipt.json').exists())
 def test_same_job_correction_rechecks_full_replacement_and_keeps_counts(self):
  jid,p=self.pending();deadline=self.store.get(jid)['deadline'];t=self.ticket(jid,p);finding={'unit':'claims:C8','code':'missing_context','message':'Selected continuation lacks crash antecedent.','evidence':[e for e in self.f['offers'] if e['source_id']=='S004' and e['start']==5062][0]};finding['evidence']=[{k:finding['evidence'][k] for k in ['source_id','text_sha256','start','end']}]
  self.submit(jid,p,t,'revise',[finding]);m=self.run_report([self.corrected()]);j=self.store.get(jid);self.assertEqual(j['status'],'awaiting_semantic_review');p2=self.store.proposal_export(jid);self.assertNotEqual(p['descriptor']['candidateHash'],p2['descriptor']['candidateHash']);self.assertIn('missing_context',json.dumps(m.inputs[0]));self.assertEqual(len(json.loads(p2['canonical']['report'])['claims']),6)
  t2=self.ticket(jid,p2,'r1');self.submit(jid,p2,t2,key='submit1');self.run_report([]);j=self.store.get(jid);self.assertEqual(j['status'],'completed');self.assertEqual(j['deadline'],deadline);self.assertEqual(j['counters'],{'model':2,'search':1,'download':0});self.assertEqual(len(j['checkpoint']['semantic']['tickets']),2)
  official=json.loads((self.store.job_dir(jid)/'claims.json').read_text());self.assertEqual(digest(official),p2['descriptor']['reportSha256'])
  receipt=json.loads((self.store.job_dir(jid)/'receipt.json').read_text());self.assertEqual(receipt['quality']['independent_semantic_review'],'passed');self.assertEqual(receipt['quality']['accepted_candidate_hash'],p2['descriptor']['candidateHash'])
 def test_wrong_hash_incomplete_coverage_and_forged_flags_cannot_accept(self):
  jid,p=self.pending();d=p['descriptor']
  with self.assertRaises(ValueError):self.store.review_reserve(jid,'f'*64,d['rubricSha256'],'wrong')
  t=self.ticket(jid,p)
  with self.assertRaises(ValueError):self.submit(jid,p,t,coverage=d['units'][:-1])
  with self.assertRaises(ValueError):self.store.review_submit(jid,t['id'],'f'*64,d['rubricSha256'],'accept',[],d['units'],'wrong-submit')
  self.assertEqual(self.store.get(jid)['status'],'awaiting_semantic_review')
 def test_reservation_and_submission_replay_survive_restart_without_refund(self):
  jid,p=self.pending();t=self.ticket(jid,p);self.store=Store(self.tmp.name);again=self.ticket(jid,p);self.assertEqual(t['id'],again['id']);self.assertFalse(again['dispatchRequired'])
  first=self.submit(jid,p,t);self.store=Store(self.tmp.name);self.assertEqual(self.submit(jid,p,t),first);self.run_report([]);self.assertEqual(self.store.get(jid)['counters']['model'],1)
 def test_stale_acceptance_cannot_cover_revision_or_new_prose(self):
  jid,p=self.pending();t=self.ticket(jid,p);self.submit(jid,p,t,'revise',[{'unit':'recommendations:1','code':'cross_alternative_attribution','message':'RQ evidence cannot prove Celery framework details.','evidence':[]}]);self.run_report([self.corrected()]);p2=self.store.proposal_export(jid)
  with self.assertRaises(ValueError):self.ticket(jid,p,'stale')
  t2=self.ticket(jid,p2,'r1');self.submit(jid,p2,t2,'reject',[{'unit':'recommendations:0','code':'unsupported_premise','message':'Scripted replacement introduced a new premise.','evidence':[]}],key='rejected');self.run_report([]);self.assertEqual(self.store.get(jid)['status'],'partial')
 def test_stop_deadline_and_unknown_execution_owner_block_review(self):
  jid,p=self.pending();self.store.execution_uncertain(jid)
  with self.assertRaises(ValueError):self.ticket(jid,p)
  self.store.execution_end(jid,'not-the-token')
  with self.assertRaises(ValueError):self.ticket(jid,p)
  self.store.stop(jid)
  with self.assertRaises(ValueError):self.ticket(jid,p)
 def test_deadline_wait_and_committed_accept_intent_replay(self):
  jid,p=self.pending();t=self.ticket(jid,p);deadline=self.store.get(jid)['deadline']
  with patch('time.time',return_value=deadline+1):
   with self.assertRaises((ValueError,BudgetExceeded)):self.submit(jid,p,t)
   self.run_report([])
  self.assertEqual(self.store.get(jid)['status'],'partial')
 def test_accept_before_deadline_may_replay_local_finalize_intent_later(self):
  jid,p=self.pending();t=self.ticket(jid,p);self.submit(jid,p,t);deadline=self.store.get(jid)['deadline'];self.store=Store(self.tmp.name)
  with patch('time.time',return_value=deadline+1):self.run_report([])
  self.assertEqual(self.store.get(jid)['status'],'completed')
 def test_correction_capacity_is_reserved_and_attempts_are_bounded(self):
  jid,p=self.pending();t=self.ticket(jid,p);self.submit(jid,p,t,'revise',[{'unit':'claims:C4','code':'missing_context','message':'Destination not selected.','evidence':[]}]);bad=copy.deepcopy(self.negative);bad['contradictions']=['invalid'];self.run_report([bad,bad]);j=self.store.get(jid);self.assertEqual(j['status'],'partial');self.assertEqual(j['counters']['model'],3);self.assertEqual(len(j['checkpoint']['semantic']['tickets']),1)
 def test_nonclaim_format_errors_do_not_reuse_previous_candidate(self):
  jid,p=self.pending();t=self.ticket(jid,p);self.submit(jid,p,t,'revise',[{'unit':'claims:C8','code':'missing_context','message':'Context missing.','evidence':[]}]);bad=copy.deepcopy(self.negative);bad['contradictions']=['broken'];self.run_report([bad,self.corrected()]);p2=self.store.proposal_export(jid);self.assertNotEqual(p['descriptor']['candidateHash'],p2['descriptor']['candidateHash']);self.assertEqual(self.store.get(jid)['status'],'awaiting_semantic_review');self.assertEqual(len(self.store.get(jid)['checkpoint']['repair_history']),3)
