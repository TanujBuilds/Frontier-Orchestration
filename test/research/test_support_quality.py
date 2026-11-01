"""Offline v2 support plumbing; no claim of automated semantic certification."""
import copy, hashlib, json, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
import research_passages as p
from research_state import Store, manifest_hash, normalize_manifest, StateError
from research_worker import Worker
from research_protocol import completion_payload
import test_worker_strict as strict_fixture
from test_worker_strict import checkpoint, URL, TEXT
from unittest.mock import patch

POLICY={'version':2,'finish':'selectors_only','discovery':'search_required'}
FIELDS=('source_id','text_sha256','start','end')
def selector(offer):return {k:offer[k] for k in FIELDS}
def fact_report(offers, text='Failure is recorded; execution policy is unspecified.'):
 return {'title':'Offline proposed findings','complete':True,'claims':[{'id':'C1','kind':'fact','text':text,'evidence':[selector(o) for o in offers]}], 'summary':['C1'],'comparisons':[],'recommendations':[],'contradictions':[],'unanswered':[]}

class BoundaryTests(unittest.TestCase):
 def setUp(self):
  import inspect
  self.assertIn('version',inspect.signature(p.make_passages).parameters,'Version-pinned boundary-aware offer generation is missing')
 def test_actual_old_boundaries_omit_material_conditions_and_v2_offers_keep_them(self):
  f=json.loads((Path(__file__).parent/'fixtures/support-boundaries.json').read_text());sources=f['sources']
  needles={'C2':['PRAGMA synchronous is set to FULL','PRAGMA synchronous is set to NORMAL'], 'C7':['Another worker collects this job and moves it to the FailedJobRegistry.'], 'C9':['even when acks_late is enabled','task_reject_on_worker_lost setting.']}
  for c in f['claims']:
   sid=c['evidence'][0]['source_id'];s=sources[sid];text=s['text'];old=c['evidence'][0]['selection'];quote=text[old['start']:old['end']]
   self.assertEqual(hashlib.sha256(text.encode()).hexdigest(),old['text_sha256']);self.assertFalse(all(n in quote for n in needles[c['id']]))
   self.assertFalse(next(a for a in f['assessment'] if a['id']==c['id'])['citationFullySupportsCompoundClaimAsSubmitted'])
   window={'source_id':sid,'start':0,'end':min(12000,len(text)), 'text_sha256':old['text_sha256'],'content_sha256':s['contentSha256']}
   legacy=p.make_passages({sid:s},[window]);self.assertTrue(any(o['start']==old['start'] and o['end']==old['end'] for o in legacy))
   offers=p.make_passages({sid:s},[window],version=2)
   for needle in needles[c['id']]:
    self.assertTrue(any(needle in o['text'] for o in offers),(c['id'],needle))
   for o in offers:self.assertEqual(o['text'],text[o['start']:o['end']]);self.assertLessEqual(len(o['text']),1000)
 def test_abbreviations_decimal_unicode_conditions_and_bullets_keep_exact_units(self):
  text='Heading\n\n- Dr. Vega measured 3.14 units, e.g. at noon. Enabled only if α is set.\n- The next item is not enabled by default.\n\n'+('Stable complete sentence. '*35)
  offers=p.make_passages({'S001':{'text':text}},[],version=2)
  for o in offers:self.assertEqual(o['text'],text[o['start']:o['end']]);self.assertEqual(o['catalog_version'],2)
  self.assertTrue(any('Dr. Vega measured 3.14 units, e.g. at noon.' in o['text'] for o in offers))
  self.assertTrue(any('Enabled only if α is set.' in o['text'] for o in offers))
  self.assertTrue(all(o['complete_unit'] for o in offers))
 def test_no_punctuation_and_window_cut_long_units_are_explicitly_incomplete(self):
  for text in ['🔥'*4000,'word '*1100]:
   offers=p.make_passages({'S001':{'text':text}},[],version=2)
   self.assertTrue(offers);self.assertTrue(all(not o['complete_unit'] for o in offers));self.assertTrue(all(len(o['text'])<=1000 for o in offers))
 def test_window_and_source_fairness_no_stale_ranges(self):
  text='Complete statement. '*3000;digest=hashlib.sha256(text.encode()).hexdigest();sources={f'S{i:03}':{'text':text,'contentSha256':'a'*64} for i in range(50)}
  windows=[{'source_id':sid,'start':10000,'end':12000,'text_sha256':digest,'content_sha256':'a'*64} for sid in list(sources)[:12]]
  offers=p.make_passages(sources,windows,version=2);self.assertEqual(len(offers),96);self.assertEqual(len({o['source_id'] for o in offers[:50]}),50)
  self.assertTrue(any(o['start']>=10000 for o in offers));self.assertEqual(len({(o['source_id'],o['start'],o['end']) for o in offers}),len(offers))
  self.assertFalse(any(o['start']>=10000 for o in p.make_passages(sources,[{**w,'text_sha256':'b'*64} for w in windows],version=2)))
 def test_short_negation_after_long_fallback_and_prefix_is_not_dropped(self):
  for text in ['x'*1100+'\n\nNot always.', 'x'*1000+'!\n\nNo.', 'No.\n\n'+'x'*1000+'.']:
   offers=p.make_passages({'S001':{'text':text}},[],version=2)
   needle='Not always.' if 'Not always.' in text else 'No.'
   self.assertTrue(any(needle in o['text'] for o in offers),(needle,[(o['start'],o['end']) for o in offers]))
   for o in offers:self.assertTrue(12<=len(o['text'])<=1000);self.assertEqual(o['text'],text[o['start']:o['end']])
 def test_window_ending_with_wrapped_newline_is_not_a_complete_unit(self):
  text='This incomplete paragraph continues on the next line\nwith a material condition.'
  end=text.index('\n')+1;h=hashlib.sha256(text.encode()).hexdigest()
  offers=p.make_passages({'S001':{'text':text}},[{'source_id':'S001','start':0,'end':end,'text_sha256':h}],version=2)
  clipped=[o for o in offers if o['end']==end];self.assertTrue(clipped);self.assertTrue(all(not o['complete_unit'] for o in clipped))
 def test_multiple_selectors_require_each_exact_reserved_offer_and_same_source_hash(self):
  text='The first documented assertion is local. '+('Useful independent statement. '*40)+'The second assertion requires another passage.'
  sources={'S001':{'text':text}};offers=p.make_passages(sources,[],version=2);self.assertGreater(len(offers),1)
  raw=fact_report(offers[:2]);self.assertEqual(len(p.resolve_report(raw,sources,offers,strict=True)['claims'][0]['evidence']),2)
  for offered,ss in [(offers[1:],sources),(offers,{'S001':{'text':text+' mutation'}})]:
   with self.assertRaises(ValueError):p.resolve_report(raw,ss,offered,strict=True)
  hostile=fact_report([{**offers[0],'complete_unit':True}]);hostile['claims'][0]['evidence'][0]['complete_unit']=True
  with self.assertRaises(ValueError):p.resolve_report(hostile,sources,offers,strict=True)
 def test_unknown_catalog_version_rejects_and_v1_bytes_remain_identical(self):
  s={'S001':{'text':'x'*2100}};old=p.make_passages(s,[])
  self.assertEqual(old,p.make_passages(s,[],version=1));self.assertEqual([(o['start'],o['end']) for o in old],[(0,800),(800,1600),(1600,2000)])
  self.assertTrue(all(set(o)==set(FIELDS)|{'text'} for o in old))
  for v in [True,0,3,'2']:
   with self.assertRaises(ValueError):p.make_passages(s,[],version=v)

class SupportWorkerTests(unittest.TestCase):
 setUp=strict_fixture.StrictWorkerTests.setUp
 worker=strict_fixture.StrictWorkerTests.worker
 def submit_v2(self, limit=12):
  m={'submission_id':'support-fixture','mode':'fixture','question':'Compare public evidence, conditions and unknowns.','scope':{'seed_urls':[URL]},'limits':{'model_calls':limit},'research_policy':POLICY}
  try:return self.store.submit(m,manifest_hash(m))
  except StateError as error:self.fail('Explicit v2 support contract must normalize: '+str(error))
 def seed_v2(self):
  job=self.submit_v2();job=self.store.claim_next();c=checkpoint();c['sources']={'S001':{'url':URL,'text':TEXT,'contentSha256':'a'*64}};self.store.checkpoint(job['id'],c)
  op=self.store.reserve(job['id'],'search',{'action':'search','query':'fixture discovery'});self.store.complete_operation(op['id'],{'query':'fixture discovery','status':'empty','results':[],'error':{'code':'no_usable_results'},'unresponsive_engines':[]})
  return self.store.get(job['id'])
 def test_v2_opt_in_changes_hash_not_defaults_and_rejects_unknown_versions(self):
  base={'submission_id':'one','question':'Which evidence supports this claim?'}
  self.assertEqual(manifest_hash(base),'ddd9438a85094a9a9dbb97217094be4cc357cd62e818059abad77de3a7bba896')
  old={**base,'research_policy':{**POLICY,'version':1}}
  self.assertEqual(manifest_hash(old),'e5b70d304a0b4e9dbc7f51b9ed37dae7e21c00ea0290b02cb7d09cd03b30d3d9')
  self.assertNotEqual(manifest_hash(old),manifest_hash({**base,'research_policy':POLICY}))
  for v in [True,0,3,'2']:
   with self.assertRaises(StateError):normalize_manifest({**base,'research_policy':{**POLICY,'version':v}})
 def test_v2_each_phase_contains_atomic_support_guidance_without_more_calls(self):
  j=self.seed_v2();c=j['checkpoint'];w=self.worker(lambda c,n:{})
  for phase in ['explore','draft','audit','repair']:
   c['phase']=phase;payload=w.model_payload(j,c);context=json.loads(payload['messages'][-1]['content'])
   self.assertEqual(context['citation_catalog_version'],2);self.assertEqual(context['support_guidance']['phase'],phase)
   self.assertEqual(context['budget']['reserved_final_calls'],3)
   self.assertIn('multiple',context['support_guidance']['claim_rule']);self.assertIn('independent',context['support_guidance']['authority'])
   self.assertIn('failure registry',payload['messages'][0]['content']);self.assertIn('remote success',payload['messages'][0]['content'])
 def test_compliant_atomic_multiple_selection_run_retains_raw_causality_and_pending_quality(self):
  j=self.seed_v2()
  c=copy.deepcopy(j['checkpoint']);c['sources']['S002']={'url':URL,'text':'Retry requires explicit configuration and is not implied by failure visibility.','contentSha256':'b'*64};self.store.checkpoint(j['id'],c)
  self.worker(lambda c,n:{'action':'finish','report':fact_report(c['citation_passages'][:2])}).drain();end=self.store.get(j['id']);self.assertEqual(end['status'],'completed');self.assertEqual(end['counters'],{'model':2,'search':1,'download':0})
  self.assertEqual(len(end['checkpoint']['draft']['claims'][0]['evidence']),2)
  directory=self.store.job_dir(j['id']);receipt=json.loads((directory/'receipt.json').read_text());quality=receipt['quality']
  self.assertEqual(quality['independent_semantic_review'],'pending');self.assertEqual(quality['model_support'],'proposed_only');self.assertEqual(quality['release_acceptance'],'not_granted')
  self.assertEqual(quality['report_sha256'],hashlib.sha256((directory/'claims.json').read_bytes()).hexdigest());self.assertEqual(quality['source_artifact_sha256'],hashlib.sha256((directory/'sources.json').read_bytes()).hexdigest());self.assertNotIn('quality.json',receipt['artifacts'])
  ops=[o for o in self.store.operations(j['id']) if o['kind']=='model'];self.assertEqual(len(ops),2)
  self.assertEqual([o['payload']['phase'] for o in ops],['explore','audit']);self.assertTrue(all(o['result']['content'] for o in ops))
 def test_structurally_valid_unsupported_output_and_forged_flags_never_mint_approval(self):
  j=self.seed_v2()
  def decide(c,n):
   r=fact_report(c['citation_passages'][:1], 'This platform guarantees every external effect exactly once.')
   r.update(independent_semantic_review='passed',release_acceptance='granted',support_verified=True)
   r['recommendations']=[{'text':'Use it because it needs no operations staff.', 'claim_ids':['C1']}]
   return {'action':'finish','report':r}
  self.worker(decide).drain();directory=self.store.job_dir(j['id']);quality=json.loads((directory/'receipt.json').read_text())['quality']
  self.assertEqual(quality['independent_semantic_review'],'pending');self.assertEqual(quality['release_acceptance'],'not_granted');self.assertEqual(quality['model_support'],'proposed_only')
  self.assertEqual(quality['provenance'],'validated');self.assertEqual(self.store.get(j['id'])['status'],'completed')
 def test_reserved_v2_catalog_version_is_bound_before_canonicalization(self):
  j=self.seed_v2();w=self.worker(lambda c,n:{'action':'finish','report':fact_report([])|{'complete':False,'claims':[],'summary':[],'unanswered':['Missing valid support.']}})
  payload=w.model_payload(j,j['checkpoint']);context=json.loads(payload['messages'][-1]['content']);raw={'action':'finish','report':fact_report(context['citation_passages'][:1])}
  context['citation_catalog_version']=1;payload['messages'][-1]['content']=json.dumps(context,ensure_ascii=False)
  self.store.reserve(j['id'],'model',payload,op_id=j['id']+':0:model');self.store.complete_operation(j['id']+':0:model',{'content':json.dumps(raw)})
  w.drain();self.assertFalse((self.store.job_dir(j['id'])/'canonical/0.json').exists());self.assertTrue(any('catalog version' in h.get('content',{}).get('protocol_error','') for h in self.store.get(j['id'])['checkpoint']['history']))
 def test_saved_v2_request_replays_verbatim_without_catalog_regeneration(self):
  j=self.seed_v2();w=self.worker(lambda c,n:{});c=j['checkpoint'];payload=w.model_payload(j,c)
  self.store.reserve(j['id'],'model',payload,op_id=j['id']+':0:model')
  with patch('research_worker.make_passages',side_effect=AssertionError('Must replay saved offers')):
   self.assertEqual(w.model_payload(j,c),payload)
 def test_stubborn_v2_legacy_quotes_remain_bounded_partial(self):
  j=self.submit_v2(7)
  def decide(c,n):
   if n==1:return {'action':'read','url':URL}
   return {'action':'finish','report':fact_report([], 'unsupported')|{'claims':[{'id':'C1','kind':'fact','text':'unsupported','evidence':[{'source_id':'S001','quote':TEXT}]}]}}
  self.worker(decide).drain();end=self.store.get(j['id']);self.assertEqual(end['status'],'partial');self.assertEqual(end['counters'],{'model':7,'search':0,'download':1});self.assertEqual([c['phase'] for _,c in self.contexts][-3:],['draft','audit','repair'])

class SupportRecoveryTests(strict_fixture.StrictWorkerTests):
 """Replay the existing strict security/recovery matrix against explicit v2."""
 def setUp(self):
  super().setUp()
  for replacement in [patch.object(strict_fixture,'POLICY',POLICY),patch.object(strict_fixture,'selection',lambda context:selector(context['citation_passages'][0]))]:
   replacement.start();self.addCleanup(replacement.stop)

if __name__=='__main__':unittest.main()
