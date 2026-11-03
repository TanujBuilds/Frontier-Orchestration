"""Synthetic premises test correction mechanics; no semantic truth certification."""
import copy, importlib.util, json, sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_review import digest,encoded
from research_passages import make_passages,resolve_report
from research_protocol import validate_report,parse_action

def fixture(premise='Cache entries remain readable only while their lease is valid.'):
 sources={'S001':{'url':'https://fixture.invalid/premise','text':premise}}
 offers=make_passages(sources,[],version=2)
 claim={'id':'C1','kind':'fact','text':'Entries always remain readable.','evidence':[{k:offers[0][k] for k in ('source_id','text_sha256','start','end')}]}
 report={'title':'Synthetic conditional premise','complete':True,'claims':[claim], 'summary':['C1'],'comparisons':[], 'recommendations':[{'text':'Use entries while valid.','claim_ids':['C1']}],'contradictions':[],'unanswered':[]}
 report=resolve_report(report,sources,offers,strict=True)
 units=['title','claims:C1','summary:0','recommendations:0']
 d={'version':1,'jobId':'fixture-job','manifestHash':'a'*64,'rubricSha256':'b'*64,'reportSha256':digest(report),'sourcesSha256':digest(sources),'offersSha256':digest(offers),'request':{'operationId':'fixture-job:1:model','requestSha256':'c'*64,'resultSha256':'d'*64,'offersSha256':digest(offers)},'units':units};d['candidateHash']=digest(d)
 base={'descriptor':d,'canonical':{'report':encoded(report),'sources':encoded(sources),'offers':encoded(offers)}}
 finding={'unit':'claims:C1','code':'lost_condition','message':'Preserve the conditional premise in this claim itself.','evidence':[{k:offers[0][k] for k in ('source_id','text_sha256','start','end')}]}
 sub={'ticketId':'ticket-A','candidateHash':d['candidateHash'],'rubricSha256':d['rubricSha256'],'decision':'revise','findings':[finding],'coverage':units,'key':'submit-A'}
 return base,sub,sources,offers,claim

class TargetedTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  spec=importlib.util.find_spec('research_targeted_repair')
  cls.impl=__import__('research_targeted_repair') if spec else None
 def setUp(self):
  self.assertIsNotNone(self.impl,'targeted unit protocol must exist before omitted-claim repair can be rejected')
  self.base,self.sub,self.sources,self.offers,self.raw=fixture()
  self.plan=self.impl.build_plan(self.base,self.sub,'ticket-A')
  self.request={'operationId':'fixture-job:2:model','requestSha256':'e'*64,'resultSha256':'f'*64,'offersSha256':digest(self.offers)}
 def patch(self,text='Entries remain readable only while their lease is valid.'):
  hashes={u['unit']:u['beforeSha256'] for u in self.plan['units']}
  return {'action':'repair','base_candidate_hash':self.base['descriptor']['candidateHash'],'plan_sha256':digest(self.plan),'replacements':[{'unit':'claims:C1','before_sha256':hashes['claims:C1'],'value':self.raw|{'text':text}}],'checked_units':[{'unit':u,'before_sha256':hashes[u]} for u in ['summary:0','recommendations:0']],'cannot_repair':[]}
 def apply(self,patch=None,**kw):
  return self.impl.apply_patch(self.base,self.plan,self.patch() if patch is None else patch,self.sources,self.offers,self.request,**kw)
 def test_correct_patch_preserves_unaffected_and_requires_whole_review(self):
  result=self.apply();old=json.loads(self.base['canonical']['report']);new=result['report']
  self.assertNotEqual(new['claims'],old['claims'])
  for key in set(old)-{'claims'}:self.assertEqual(old[key],new[key])
  self.assertFalse(validate_report(new,self.sources));self.assertNotIn('accepted',result)
  self.assertEqual(result['receipt']['request'],self.request)
  self.assertEqual(result['bundle']['receipt'],result['receipt'])
 def test_omitted_named_claim_and_missing_dependent_rejected(self):
  p=self.patch();p['replacements']=[]
  with self.assertRaisesRegex(ValueError,'required'):self.apply(p)
  p=self.patch();p['checked_units'].pop()
  with self.assertRaisesRegex(ValueError,'dependent'):self.apply(p)
 def test_canonical_noop_and_stale_bindings_rejected(self):
  p=self.patch(self.raw['text'])
  with self.assertRaisesRegex(ValueError,'no.op'):self.apply(p)
  for name in ['base_candidate_hash','plan_sha256']:
   p=self.patch();p[name]='0'*64
   with self.assertRaises(ValueError):self.apply(p)
  p=self.patch();p['replacements'][0]['before_sha256']='0'*64
  with self.assertRaises(ValueError):self.apply(p)
 def test_foreign_duplicate_unknown_fields_and_changed_id_rejected(self):
  for mutate in [lambda p:p.update(execute='rm'),lambda p:p['replacements'].append(p['replacements'][0]),lambda p:p['replacements'][0].update(unit='../claims'),lambda p:p['replacements'][0]['value'].update(id='C2'),lambda p:p['replacements'][0]['value'].update(accepted=True)]:
   p=self.patch();mutate(p)
   with self.assertRaises(ValueError):self.apply(p)
 def test_unrelated_unit_and_empty_or_foreign_decline_rejected(self):
  p=self.patch();p['replacements'].append({'unit':'title','before_sha256':digest('Synthetic conditional premise'),'value':'Hide failed claim'})
  with self.assertRaises(ValueError):self.apply(p)
  p=self.patch();p.update(replacements=[],checked_units=[],cannot_repair=['title'])
  with self.assertRaises(ValueError):self.apply(p)
 def test_cannot_repair_short_circuits_without_mutation(self):
  before=copy.deepcopy(self.base);p=self.patch();p.update(replacements=[],checked_units=[],cannot_repair=['claims:C1'])
  self.assertIsNone(self.apply(p));self.assertEqual(self.base,before)
  p['replacements']=self.patch()['replacements']
  with self.assertRaises(ValueError):self.apply(p)
 def test_tampered_plan_and_sources_fail_closed(self):
  self.plan['required']=[]
  with self.assertRaises(ValueError):self.apply()
  self.base,self.sub,self.sources,self.offers,self.raw=fixture();self.plan=self.impl.build_plan(self.base,self.sub,'ticket-A');self.sources['S001']['text']+='tamper'
  with self.assertRaises(ValueError):self.apply()
 def test_failed_summary_requires_its_claim_change_or_changed_pointer(self):
  self.sub['findings'][0]['unit']='summary:0';self.plan=self.impl.build_plan(self.base,self.sub,'ticket-A')
  self.assertIsNotNone(self.apply())
  p=self.patch();p['replacements']=[]
  with self.assertRaises(ValueError):self.apply(p)
 def test_still_wrong_but_changed_is_not_semantically_certified(self):
  result=self.apply(self.patch('Entries always remain readable!'))
  self.assertFalse(validate_report(result['report'],self.sources))
  # Scripted independent B verdict: deliberately remains negative despite structure.
  verdict={'decision':'reject','findings':[self.sub['findings'][0]],'coverage':self.base['descriptor']['units']}
  self.assertEqual(verdict['decision'],'reject');self.assertNotIn('accepted',result['receipt'])
 def test_three_held_out_condition_fixtures(self):
  for premise in ['Cache recovery is possible only before lease expiry.','Durable writes survive restart only after the commit is acknowledged.','Access is permitted only while the grant is valid.']:
   self.base,self.sub,self.sources,self.offers,self.raw=fixture(premise);self.plan=self.impl.build_plan(self.base,self.sub,'ticket-A');self.request['offersSha256']=digest(self.offers)
   self.assertIsNotNone(self.apply(self.patch(premise)))
   with self.assertRaises(ValueError):self.apply(self.patch(self.raw['text']))
   self.assertIsNotNone(self.apply(self.patch('The premise always holds!')))
 def test_parser_is_closed_by_default_and_finish_forbidden_when_targeted(self):
  with self.assertRaises(ValueError):parse_action(encoded(self.patch()))
  self.assertEqual(parse_action(encoded(self.patch()),targeted=True)['action'],'repair')
  with self.assertRaises(ValueError):parse_action({'action':'finish','report':{}},targeted=True)

class TargetedBoundsTests(unittest.TestCase):
 setUpClass=classmethod(TargetedTests.setUpClass.__func__)
 setUp=TargetedTests.setUp
 patch=TargetedTests.patch
 apply=TargetedTests.apply
 def test_mixed_catalog_preserves_A_quotes_and_resolves_new_unicode_selection(self):
  text='😀 retained premise remains conditional.\nNew condition applies only after explicit commit.'
  self.base,self.sub,self.sources,self.offers,self.raw=fixture(text)
  h=__import__('hashlib').sha256(text.encode()).hexdigest();start=text.index('New condition')
  correction=[{'source_id':'S001','text_sha256':h,'start':start,'end':len(text),'text':text[start:],'catalog_version':2,'complete_unit':True}]
  self.plan=self.impl.build_plan(self.base,self.sub,'ticket-A');p=self.patch('New condition applies only after explicit commit.')
  p['replacements'][0]['value']['evidence']=[{k:correction[0][k] for k in ('source_id','text_sha256','start','end')}];req=self.request|{'offersSha256':digest(correction)}
  result=self.impl.apply_patch(self.base,self.plan,p,self.sources,correction,req)
  self.assertEqual(len(result['offers']),len(self.offers)+1);self.assertNotEqual(req['offersSha256'],result['receipt']['offersSha256']);self.assertEqual(result['receipt']['request'],req)
  self.assertEqual(result['report']['claims'][0]['evidence'][0]['quote'],text[start:])
  bad=copy.deepcopy(p);bad['replacements'][0]['value']['evidence']=self.raw['evidence']
  with self.assertRaises(ValueError):self.impl.apply_patch(self.base,self.plan,bad,self.sources,correction,req)
 def test_response_limit_and_unknown_nested_fields_are_closed(self):
  p=self.patch();p['replacements'][0]['value']['text']='x'*150001
  with self.assertRaises(ValueError):parse_action(encoded(p),targeted=True)
  p=self.patch();p['checked_units'][0]['accept']=True
  with self.assertRaises(ValueError):self.apply(p)
 def test_oversize_base_and_bundle_refuse_instead_of_trimming(self):
  b=copy.deepcopy(self.base);r=json.loads(b['canonical']['report']);r['unanswered']=['🔥'*3000]*20;b['canonical']['report']=encoded(r);d=b['descriptor'];d['reportSha256']=digest(r);d['units']+=['unanswered:'+str(i) for i in range(20)];d['candidateHash']=digest({k:v for k,v in d.items() if k!='candidateHash'});sub=self.sub|{'candidateHash':d['candidateHash']}
  with self.assertRaisesRegex(ValueError,'bound'):self.impl.build_plan(b,sub,'ticket-A')
 def test_checked_units_cannot_overlap_replacements_or_claim_to_authorize_edit(self):
  p=self.patch();p['checked_units'].append({'unit':'claims:C1','before_sha256':p['replacements'][0]['before_sha256']})
  with self.assertRaises(ValueError):self.apply(p)
 def test_stale_current_offers_fail_even_if_hashes_resealed(self):
  correction=copy.deepcopy(self.offers);correction[0]['text']='wrong saved text'
  with self.assertRaises(ValueError):self.impl.apply_patch(self.base,self.plan,self.patch(),self.sources,correction,self.request|{'offersSha256':digest(correction)})
 def test_duplicate_JSON_keys_cannot_hide_targeted_fields(self):
  p=encoded(self.patch());raw=p.replace('"action":"repair"','"action":"finish","action":"repair"')
  with self.assertRaisesRegex(ValueError,'duplicate'):parse_action(raw,targeted=True)
 def test_exact_repair_bundle_bound_refuses_oversize_proof(self):
  b=copy.deepcopy(self.base);r=json.loads(b['canonical']['report']);r['claims']=[copy.deepcopy(r['claims'][0])|{'id':'C'+str(i),'text':'A'*5000} for i in range(1,9)];r['unanswered']=['gap'+'x'*2997]*25
  b['canonical']['report']=encoded(r);d=b['descriptor'];d.update(reportSha256=digest(r),units=list(self.impl.units(r)));d['candidateHash']=digest({k:v for k,v in d.items() if k!='candidateHash'});sub=copy.deepcopy(self.sub);sub.update(candidateHash=d['candidateHash'],coverage=d['units'],findings=[self.sub['findings'][0]|{'unit':'claims:C'+str(i%8+1),'message':'m'*2000} for i in range(50)]);plan=self.impl.build_plan(b,sub,'ticket-A');hs={x['unit']:x['beforeSha256'] for x in plan['units']}
  p={'action':'repair','base_candidate_hash':d['candidateHash'],'plan_sha256':digest(plan),'replacements':[{'unit':'claims:C'+str(i),'before_sha256':hs['claims:C'+str(i)],'value':self.raw|{'id':'C'+str(i),'text':'B'*6000}} for i in range(1,9)],'checked_units':[{'unit':u,'before_sha256':hs[u]} for u in ['summary:0','recommendations:0']],'cannot_repair':[]}
  with self.assertRaisesRegex(ValueError,'bundle exceeds bound'):self.impl.apply_patch(b,plan,p,self.sources,self.offers,self.request)
