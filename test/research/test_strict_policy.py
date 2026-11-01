"""Offline policy/security invariants. Real SQLite, no providers or old-state writes."""
import copy,hashlib,json,sys,tempfile,time,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
import research_state as state
from research_passages import resolve_report
POLICY={'version':1,'finish':'selectors_only','discovery':'search_required'}
TEXT='Exact\nUnicode 🔥 saved passage with sufficient context.'
def manifest(**kw):return {'submission_id':'one','question':'Which evidence supports this claim?',**kw}
def report(e):return {'title':'Fixture','complete':True,'claims':[{'id':'C1','kind':'fact','text':'Provenance fixture only','evidence':[e]}],'summary':['C1'],'comparisons':[],'recommendations':[],'contradictions':[],'unanswered':[]}
class StrictPolicyTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.store=state.Store(self.temp.name);self.now=time.time()
 def strict(self):
  try:return state.normalize_manifest(manifest(research_policy=POLICY))
  except state.StateError as e:self.fail('Approved strict policy must normalize: '+str(e))
 def job(self):
  m=self.strict();j=self.store.submit(m,state.manifest_hash(m));return self.store.claim_next(now=self.now)
 def discovery(self,j):
  fn=getattr(self.store,'discovery_status',None);self.assertTrue(callable(fn),'Durable discovery enforcement is missing');return fn(j['id'])
 def test_legacy_literal_hash_and_absence_unchanged(self):
  m=state.normalize_manifest(manifest());self.assertNotIn('research_policy',m);self.assertEqual(state.manifest_hash(m),'ddd9438a85094a9a9dbb97217094be4cc357cd62e818059abad77de3a7bba896')
 def test_strict_policy_hash_bound_not_mutable(self):
  m=self.strict();self.assertEqual(m['research_policy'],POLICY);self.assertNotEqual(state.manifest_hash(m),state.manifest_hash(manifest()))
  j=self.store.submit(m,state.manifest_hash(m));m['research_policy']['version']=9
  self.assertEqual(self.store.get(j['id'])['manifest']['research_policy'],POLICY)
  with self.assertRaises(state.StateError):self.store.submit(manifest(),j['manifest_hash'])
 def test_closed_unknown_policy_and_operator_reject(self):
  self.strict()
  invalid=[None,{},True,{**POLICY,'version':True},{**POLICY,'version':3},{**POLICY,'finish':'quotes'},{**POLICY,'discovery':'optional'},{**POLICY,'trusted':True}]
  for p in invalid:
   with self.subTest(p=p),self.assertRaises(state.StateError):state.normalize_manifest(manifest(research_policy=p))
  with self.assertRaises(state.StateError):state.normalize_manifest(manifest(schema=2,not_after=9000,collaboration={'supervisor':'none','max_questions':0},executor='operator',research_policy=POLICY))
 def test_checkpoint_seed_and_fake_flag_do_not_satisfy_discovery(self):
  j=self.job();self.store.checkpoint(j['id'],{'discovery_satisfied':True,'sources':{'S001':{'text':TEXT}},'searched':True})
  d=self.discovery(j);self.assertEqual((d['requested'],d['state'],d['attempted'],d['satisfied'],d['failed']),(True,'requested',0,False,0))
 def test_pending_failure_empty_and_replay_derive_from_operations(self):
  j=self.job();op=self.store.reserve(j['id'],'search',{'action':'search','query':'exact focused query'},op_id='search-1',now=self.now+1)
  d=self.discovery(j);self.assertEqual((d['state'],d['attempted'],d['satisfied']),('attempted',1,False))
  self.store.fail_operation(op['id'],{'code':'interrupted'});self.assertEqual(self.discovery(j)['state'],'failed')
  op=self.store.reserve(j['id'],'search',{'action':'search','query':'empty discovery'},op_id='search-2',now=self.now+2)
  self.store.complete_operation(op['id'],{'status':'empty','query':'empty discovery','results':[],'error':{'code':'no_usable_results'},'unresponsive_engines':[]})
  d=self.discovery(j);self.assertEqual((d['state'],d['attempted'],d['satisfied'],d['failed']),('satisfied',2,True,1));self.assertEqual(d['operations'][0]['query'],'exact focused query')
  before=self.store.get(j['id']);self.store=state.Store(self.temp.name);self.now=time.time();self.assertEqual(self.discovery(j),d)
  self.store.reserve(j['id'],'search',{'action':'search','query':'empty discovery'},op_id='search-2',now=99999);self.assertEqual(self.store.get(j['id'])['counters'],before['counters']);self.assertEqual(self.store.get(j['id'])['deadline'],before['deadline'])
 def test_blocked_engines_fake_result_error_and_nonsearch_do_not_count(self):
  j=self.job()
  outcomes=[{'results':[],'status':'error','error':{'code':'http_error'}},{'results':[],'status':'empty','error':{'code':'no_usable_results'},'unresponsive_engines':[['brave','blocked']]},{'results':[],'status':'ok','query':'different query'},{'searched':True},None,{'results':[],'status':'partial','unresponsive_engines':[['brave','blocked']]}]
  for n,result in enumerate(outcomes):
   op=self.store.reserve(j['id'],'search',{'action':'search','query':'query'},op_id=str(n),now=self.now+1+n);self.store.complete_operation(op['id'],result)
  self.assertFalse(self.discovery(j)['satisfied']);self.assertEqual(self.discovery(j)['failed'],len(outcomes))
  op=self.store.reserve(j['id'],'download',{'url':'https://example.org'},now=self.now+10);self.store.complete_operation(op['id'],{'results':[],'status':'ok'});self.assertFalse(self.discovery(j)['satisfied'])
 def test_store_cannot_terminal_complete_required_search_without_evidence(self):
  j=self.job()
  with self.assertRaises(state.StateError):self.store.finish(j['id'],'completed')
  self.assertEqual(self.store.get(j['id'])['status'],'running');self.store.finish(j['id'],'partial','unmet discovery');self.assertEqual(self.store.get(j['id'])['status'],'partial')
 def test_strict_rejects_legacy_and_forged_canonical_even_exact(self):
  sources={'S001':{'text':TEXT,'contentSha256':'a'*64}};s={'source_id':'S001','text_sha256':hashlib.sha256(TEXT.encode()).hexdigest(),'start':0,'end':len(TEXT)};offers=[{**s,'text':TEXT}]
  raw=report(s)
  try:canonical=resolve_report(raw,sources,offers,strict=True)
  except TypeError:self.fail('Strict selector contract missing')
  self.assertNotIn('quote',raw['claims'][0]['evidence'][0]);self.assertEqual(canonical['claims'][0]['evidence'][0]['quote'],TEXT)
  for e in [{'source_id':'S001','quote':TEXT},canonical['claims'][0]['evidence'][0],{**s,'quote':TEXT},{**s,'extra':True},None]:
   with self.subTest(e=e),self.assertRaises(ValueError):resolve_report(report(e),sources,offers,strict=True)
  self.assertEqual(resolve_report(report({'source_id':'S001','quote':TEXT}),sources,offers),report({'source_id':'S001','quote':TEXT}))
 def test_strict_offer_membership_and_range_attacks(self):
  s={'source_id':'S001','text_sha256':hashlib.sha256(TEXT.encode()).hexdigest(),'start':0,'end':len(TEXT)};sources={'S001':{'text':TEXT}};offer={**s,'text':TEXT}
  try:resolve_report(report(s),sources,[offer],strict=True)
  except TypeError:self.fail('Strict selector contract missing')
  for offers in [[],[offer,offer],[{**offer,'text':'forged'}],[{**offer,'start':True}]]:
   with self.subTest(offers=offers),self.assertRaises(ValueError):resolve_report(report(s),sources,offers,strict=True)
  for k,v in [('start',True),('end',99999),('start',-1),('text_sha256','b'*64),('source_id','S999')]:
   bad={**s,k:v}
   with self.subTest(k=k),self.assertRaises(ValueError):resolve_report(report(bad),sources,[{**bad,'text':TEXT}],strict=True)
if __name__=='__main__':unittest.main()
