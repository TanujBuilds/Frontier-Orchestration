"""Real Store/Worker same-job lifecycle with deterministic offline actions."""
import copy,json,tempfile,unittest,sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_state import Store,manifest_hash
from research_worker import Worker
from research_review import digest
from test_review_protocol import manifest
from test_targeted_repair import fixture

class TargetedLifecycleTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.store=Store(self.tmp.name)
  self.base,self.sub,self.sources,self.offers,self.raw=fixture()
  m=manifest();m['research_policy'].update(repairContextVersion=1,correctionStrategy='targeted_v1');m['limits']={'model_calls':18}
  j=self.store.submit(m,manifest_hash(m));j=self.store.claim_next();self.id=j['id'];self.deadline=j['deadline']
  self.store.checkpoint(self.id,{'step':0,'phase':'draft','next':'model','history':[],'sources':self.sources,'known_urls':[],'draft':None,'errors':[],'limited':False})
  o=self.store.reserve(self.id,'search',{'query':'synthetic discovery'});self.store.complete_operation(o['id'],{'status':'ok','results':[]})
 def run_actions(self,actions):
  calls=[]
  class Model:
   model_id='offline-targeted-fixture'
   def complete(s,messages,timeout):
    calls.append(json.loads(messages[-1]['content']));a=actions.pop(0);a=a(calls[-1]) if callable(a) else a;return {'content':json.dumps(a)}
  with patch('research_worker.make_passages',return_value=self.offers):Worker(self.store,Model(),None,None,mode='fixture').drain()
  return calls
 def initial(self):
  raw=json.loads(self.base['canonical']['report']);raw['claims']=[self.raw];self.run_actions([{'action':'finish','report':raw}]);p=self.store.proposal_export(self.id);d=p['descriptor']
  t=self.store.review_reserve(self.id,d['candidateHash'],d['rubricSha256'],'A');self.store.review_submit(self.id,t['id'],d['candidateHash'],d['rubricSha256'],'revise',self.sub['findings'],d['units'],'revise-A');return p
 def repair(self,content,decline=False):
  context=content['targeted_repair'];plan=context['plan'];hashes={r['unit']:r['beforeSha256'] for r in plan['units']}
  return {'action':'repair','base_candidate_hash':plan['baseCandidateHash'],'plan_sha256':digest(plan),'replacements':[] if decline else [{'unit':'claims:C1','before_sha256':hashes['claims:C1'],'value':self.raw|{'text':'Entries remain readable only while their lease is valid.'}}],'checked_units':[] if decline else [{'unit':u,'before_sha256':hashes[u]} for u in ['summary:0','recommendations:0']],'cannot_repair':['claims:C1'] if decline else []}
 def test_real_revise_repair_full_B_review_and_final_receipt(self):
  a=self.initial();inputs=self.run_actions([self.repair]);j=self.store.get(self.id);self.assertEqual(j['status'],'awaiting_semantic_review',j.get('reason'));b=self.store.proposal_export(self.id);d=b['descriptor'];self.assertEqual(d['version'],2);self.assertIn('repair',b)
  self.assertEqual(d['units'],a['descriptor']['units']);self.assertNotEqual(d['candidateHash'],a['descriptor']['candidateHash']);self.assertEqual(inputs[0]['finalization']['allowed_actions'],['repair'])
  t=self.store.review_reserve(self.id,d['candidateHash'],d['rubricSha256'],'B');self.store.review_submit(self.id,t['id'],d['candidateHash'],d['rubricSha256'],'accept',[],d['units'],'accept-B');self.run_actions([])
  j=self.store.get(self.id);self.assertEqual(j['status'],'completed');self.assertEqual(j['deadline'],self.deadline);self.assertEqual(j['counters'],{'model':2,'search':1,'download':0});r=json.loads((self.store.job_dir(self.id)/'receipt.json').read_text());self.assertEqual(r['targetedRepair'],b['repair'])
 def test_explicit_decline_is_partial_without_B(self):
  a=self.initial();self.run_actions([lambda c:self.repair(c,True)]);j=self.store.get(self.id);self.assertEqual(j['status'],'partial');self.assertEqual(j['deadline'],self.deadline)
  r=json.loads((self.store.job_dir(self.id)/'receipt.json').read_text());report=json.loads((self.store.job_dir(self.id)/'claims.json').read_text());self.assertFalse(report['complete']);self.assertNotIn('targetedRepair',r);self.assertIsNone(r['quality']['review_binding']);self.assertEqual(len(j['checkpoint']['semantic']['candidates']),1)
 def test_saved_result_replays_without_new_call(self):
  self.initial();complete=self.store.complete_operation
  def crash(op,result):
   complete(op,result);raise RuntimeError('process-loss-fixture')
  with patch.object(self.store,'complete_operation',side_effect=crash):self.run_actions([self.repair])
  before=copy.deepcopy(self.store.operations(self.id));self.store=Store(self.tmp.name);self.store.resume(self.id);self.run_actions([])
  self.assertEqual(self.store.get(self.id)['status'],'awaiting_semantic_review');self.assertEqual(self.store.operations(self.id),before);self.assertEqual(self.store.get(self.id)['deadline'],self.deadline)
 def test_exact_unicode_HTTP_body_and_context_overflow_never_dispatches(self):
  import threading
  from http.server import ThreadingHTTPServer
  from test_http_recovery import Handler
  from research_providers import DeepSeek
  self.base,self.sub,self.sources,self.offers,self.raw=fixture('😀 Cache entries remain readable only while their lease is valid.')
  c=self.store.get(self.id)['checkpoint'];c['sources']=self.sources;self.store.checkpoint(self.id,c)
  self.initial();j=self.store.get(self.id);w=Worker(self.store,None,None,None,mode='fixture')
  with patch('research_worker.make_passages',return_value=self.offers):payload=w.model_payload(j,j['checkpoint'])
  context=json.loads(payload['messages'][-1]['content']);action=self.repair(context)
  server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.model_id='offline-targeted-fixture';server.gets=0;server.posts=[];server.raw_bodies=[];server.actions=[action]
  threading.Thread(target=server.serve_forever,daemon=True).start();self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
  model=DeepSeek('http://127.0.0.1:'+str(server.server_port)+'/v1',server.model_id)
  with patch('research_worker.make_passages',return_value=self.offers):Worker(self.store,model,None,None,mode='fixture').drain()
  self.assertEqual(len(server.posts),1);self.assertLessEqual(len(server.raw_bodies[0]),196608);self.assertEqual(json.loads(server.posts[0]['messages'][-1]['content'])['targeted_repair']['plan'],context['targeted_repair']['plan'])
 def test_full_finish_cannot_bypass_targeted_phase_and_calls_remain_spent(self):
  self.initial();raw=json.loads(self.base['canonical']['report']);raw['claims']=[self.raw];self.run_actions([{'action':'finish','report':raw},{'action':'finish','report':raw}]);j=self.store.get(self.id)
  self.assertEqual(j['status'],'partial');self.assertEqual(j['counters']['model'],3);self.assertEqual(len(j['checkpoint']['semantic']['candidates']),1);self.assertEqual(j['deadline'],self.deadline)
 def test_critical_context_overflow_finishes_partial_before_reservation(self):
  raw=json.loads(self.base['canonical']['report']);raw['claims']=[self.raw|{'id':'C'+str(i),'text':'🔥'*4000} for i in range(1,4)];raw['summary']=['C1','C2','C3']
  self.run_actions([{'action':'finish','report':raw}]);d=self.store.proposal_export(self.id)['descriptor'];t=self.store.review_reserve(self.id,d['candidateHash'],d['rubricSha256'],'A')
  findings=[self.sub['findings'][0]|{'unit':'claims:C'+str(i),'message':'🔥'*1800} for i in range(1,4)]
  self.store.review_submit(self.id,t['id'],d['candidateHash'],d['rubricSha256'],'revise',findings,d['units'],'revise-A');before=self.store.operations(self.id);self.assertEqual(self.run_actions([]),[]);j=self.store.get(self.id);self.assertEqual(j['status'],'partial');self.assertEqual(j['counters']['model'],1);self.assertEqual(self.store.operations(self.id),before);self.assertIn('wire bound',j['reason'])
 def test_wrong_but_changed_claim_requires_and_fails_whole_B_review(self):
  self.initial()
  def wrong(c):
   p=self.repair(c);p['replacements'][0]['value']['text']='Entries always remain readable!';return p
  self.run_actions([wrong]);d=self.store.proposal_export(self.id)['descriptor'];t=self.store.review_reserve(self.id,d['candidateHash'],d['rubricSha256'],'B');self.store.review_submit(self.id,t['id'],d['candidateHash'],d['rubricSha256'],'reject',self.sub['findings'],d['units'],'reject-B');self.run_actions([]);j=self.store.get(self.id);self.assertEqual(j['status'],'partial');self.assertEqual(j['counters']['model'],2);receipt=json.loads((self.store.job_dir(self.id)/'receipt.json').read_text());self.assertEqual(receipt['quality']['independent_semantic_review'],'not_accepted');self.assertIsNone(receipt['quality']['review_binding'])
 def test_pause_resume_preserves_targeted_identity_and_spending(self):
  self.initial();before=self.store.get(self.id);self.store.request_yield(self.id);self.assertEqual(self.run_actions([]),[]);self.assertEqual(self.store.get(self.id)['status'],'suspended');self.store.resume(self.id);self.run_actions([self.repair]);j=self.store.get(self.id);self.assertEqual(j['deadline'],before['deadline']);self.assertEqual(j['counters']['model'],2);self.assertEqual(j['id'],self.id)
 def test_expiry_and_corrupted_snapshot_do_not_dispatch(self):
  for mode in ['expired','missing','corrupt']:
   with self.subTest(mode=mode):
    self.setUp();self.initial();before=self.store.operations(self.id)
    if mode=='expired':
     with patch('time.time',return_value=self.deadline+1):self.assertEqual(self.run_actions([]),[])
    else:
     ref=self.store.get(self.id)['checkpoint']['targeted_snapshot'];p=self.store.job_dir(self.id)/ref['path']
     if mode=='missing':p.unlink()
     else:p.write_text(p.read_text()+' ')
     self.assertEqual(self.run_actions([]),[])
    j=self.store.get(self.id);self.assertEqual(j['status'],'partial');self.assertEqual(j['deadline'],self.deadline);self.assertEqual(self.store.operations(self.id),before);self.assertEqual(j['counters']['model'],1)
