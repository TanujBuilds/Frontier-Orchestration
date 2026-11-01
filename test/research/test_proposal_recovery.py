import copy,json,tempfile,sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
import research_review as review
import research_worker as worker
from research_state import Store,manifest_hash
from test_review_protocol import manifest
F=Path(__file__).parent/'fixtures/review-malformed-draft.json'
REF={'operationId':'fixture-op','requestSha256':'a'*64,'resultSha256':'b'*64,'offersSha256':'c'*64}
class ProposalRecoveryTests(unittest.TestCase):
 def setUp(self):self.f=json.loads(F.read_text())
 def build(self,r=None):
  fn=getattr(review,'build_repair_proposal',None);self.assertTrue(callable(fn),'Repair proposals missing')
  return fn(self.f['rawReport'] if r is None else r,self.f['sources'],self.f['offers'],REF)
 def test_actual_malformed_nonclaim_section_preserves_claim_evidence_without_canonical_approval(self):
  p=self.build();self.assertEqual(len(p['projection']['claims']),8);self.assertEqual(p['reportErrors'],['contradictions: invalid text']*2);self.assertEqual(p['claimErrors'],[])
  for cid,selection in [('C4',('S007',3980,4052)),('C8',('S004',5062,5758))]:
   c=next(c for c in p['projection']['claims'] if c['id']==cid);self.assertIn(selection,[(e['source_id'],e['start'],e['end']) for e in c['evidence']])
  self.assertNotIn('canonicalReport',p);self.assertNotIn('accepted',p)
 def test_one_bad_claim_or_model_flags_cannot_poison_other_claims_or_mint_support(self):
  r=copy.deepcopy(self.f['rawReport']);r['claims'][0]['evidence'][0]['text_sha256']='f'*64;r['claims'][1]['verified']=True;r['review']={'accepted':True};p=self.build(r)
  self.assertEqual(len(p['projection']['claims']),7);self.assertTrue(p['claimErrors']);self.assertNotIn('verified',json.dumps(p));self.assertNotIn('accepted',json.dumps(p))
 def test_actual_invalid_draft_reaches_next_request_as_repairable_claims(self):
  with tempfile.TemporaryDirectory() as root:
   store=Store(root);m=manifest();j=store.submit(m,manifest_hash(m));j=store.claim_next();c={'step':0,'phase':'explore','next':'model','history':[],'sources':self.f['sources'],'known_urls':[],'draft':None,'errors':[],'limited':False};store.checkpoint(j['id'],c)
   op=store.reserve(j['id'],'search',{'query':'fixture query'});store.complete_operation(op['id'],{'query':'fixture query','status':'ok','results':[]})
   inputs=[];first=copy.deepcopy(self.f['rawReport'])
   class Model:
    def complete(s,messages,timeout):
     inputs.append(json.loads(messages[-1]['content']));report=first if len(inputs)==1 else {'title':'Fixture partial','complete':False,'claims':[],'summary':[],'comparisons':[],'recommendations':[],'contradictions':[],'unanswered':['Fixture ends here.']}
     return {'content':json.dumps({'action':'finish','report':report})}
   w=worker.Worker(store,Model(),lambda *a: self.fail('Search forbidden'),lambda *a: self.fail('Read forbidden'),mode='fixture')
   with patch('research_worker.make_passages',return_value=self.f['offers']):w.drain()
   self.assertEqual(len(inputs),2);self.assertIsNotNone(inputs[1].get('candidate'));self.assertEqual(len(inputs[1]['candidate']['claims']),8);self.assertEqual(len(inputs[1]['synthesis_review']['claims']),8);self.assertEqual(inputs[1]['validation_errors'],['contradictions: invalid text']*2)
   end=store.get(j['id']);self.assertNotEqual(end['status'],'completed');self.assertEqual(end['counters']['model'],2)
   self.assertEqual(json.loads(store.operations(j['id'])[1]['result']['content'])['report'],first)
