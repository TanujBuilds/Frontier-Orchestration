"""Source-bound passage selection; no network, model or historical-state writes."""
import copy
import hashlib
import unittest
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
try:
 import research_passages as p
except ModuleNotFoundError:p=None

TEXT='Saved evidence has exact\nline breaks and Unicode 🔥 characters. '+('More source evidence. '*70)
def source(text=TEXT):return {'text':text,'contentSha256':'a'*64}
def report(evidence):return {'title':'Fixture','complete':True,'claims':[{'id':'C1','kind':'fact','text':'Fixture evidence','evidence':[evidence]}],'summary':['C1'],'comparisons':[],'recommendations':[],'contradictions':[],'unanswered':[]}
def selection(start=0,end=62,text=TEXT):return {'source_id':'S001','text_sha256':hashlib.sha256(text.encode()).hexdigest(),'start':start,'end':end}
def offer(s):return {**s,'text':TEXT[s['start']:s['end']]}

class PassageTests(unittest.TestCase):
 def setUp(self):self.assertIsNotNone(p,'source-bound passage implementation missing');self.sources={'S001':source()};self.sel=selection();self.offered=[offer(self.sel)]
 def test_exact_newlines_and_unicode_are_copied_not_normalized(self):
  r=p.resolve_report(report(self.sel),self.sources,self.offered);e=r['claims'][0]['evidence'][0]
  self.assertEqual(e['quote'],TEXT[:62]);self.assertIn('\n',e['quote']);self.assertIn('🔥',e['quote']);self.assertEqual(e['selection'],{k:v for k,v in self.sel.items() if k!='source_id'})
 def test_legacy_quote_record_is_unchanged_and_inputs_immutable(self):
  for raw in [report({'source_id':'S001','quote':TEXT[:62]}),report(self.sel)]:
   before=copy.deepcopy((raw,self.sources,self.offered));r=p.resolve_report(raw,self.sources,self.offered);self.assertEqual((raw,self.sources,self.offered),before);self.assertIsNot(r,raw)
   if 'quote' in raw['claims'][0]['evidence'][0]:self.assertEqual(r,raw)
 def test_unknown_source_and_stale_full_text_hash_reject(self):
  for fields in [{'source_id':'S999'},{'text_sha256':'b'*64},{'text_sha256':'not-a-hash'}]:
   s={**self.sel,**fields}
   with self.subTest(fields=fields),self.assertRaises(ValueError):p.resolve_report(report(s),self.sources,[{**offer(self.sel),**fields}])
 def test_closed_selector_and_no_mixed_quote(self):
  for extra in [{'quote':TEXT[:62]},{'command':'ignored'},{'selection':{}}]:
   with self.subTest(extra=extra),self.assertRaises(ValueError):p.resolve_report(report({**self.sel,**extra}),self.sources,self.offered)
 def test_range_types_bounds_and_lengths_reject(self):
  for start,end in [(True,62),(0,True),(-1,62),(62,0),(0,0),(0,11),(0,1001),(0,len(TEXT)+1),(0,62.0),(0,'62')]:
   s=selection(start,end)
   with self.subTest(start=start,end=end),self.assertRaises(ValueError):p.resolve_report(report(s),self.sources,[{**s,'text':TEXT[:62]}])
 def test_only_exact_offered_selection_allowed(self):
  for offered in [[],[offer(selection(1,63))],[{**offer(self.sel),'text':'tampered evidence'}],self.offered*2]:
   with self.subTest(offered=offered),self.assertRaises(ValueError):p.resolve_report(report(self.sel),self.sources,offered)
 def test_missing_selector_fields_and_invented_quote_are_not_repaired(self):
  for key in self.sel:
   s={k:v for k,v in self.sel.items() if k!=key}
   with self.subTest(key=key),self.assertRaises(ValueError):p.resolve_report(report(s),self.sources,self.offered)
  raw=report({'source_id':'S001','quote':'Invented ungrounded words'});self.assertEqual(p.resolve_report(raw,self.sources,self.offered),raw)
 def test_final_unchanged_validator_still_enforces_provenance(self):
  from research_protocol import validate_report
  self.assertTrue(validate_report(report(self.sel),self.sources));normalized=p.resolve_report(report(self.sel),self.sources,self.offered);self.assertEqual(validate_report(normalized,self.sources),[])
  normalized['claims'][0]['evidence'][0]['quote']='Invented ungrounded words';self.assertTrue(validate_report(normalized,self.sources))
 def test_model_supplied_normalized_metadata_must_be_revalidated(self):
  valid={'source_id':'S001','quote':TEXT[:62],'selection':{k:v for k,v in self.sel.items() if k!='source_id'}}
  bad=copy.deepcopy(valid);bad['selection'].update(text_sha256='b'*64,start=-1,end=999999)
  with self.assertRaises(ValueError):p.resolve_report(report(bad),self.sources,[])
  with self.assertRaises(ValueError):p.resolve_report(report(valid),self.sources,[])
  normalized=p.resolve_report(report(valid),self.sources,self.offered);self.assertEqual(normalized['claims'][0]['evidence'][0],valid)
  bad=copy.deepcopy(valid);bad['selection']['command']='untrusted'
  with self.assertRaises(ValueError):p.resolve_report(report(bad),self.sources,self.offered)
  bad=copy.deepcopy(valid);bad['quote']='Invented ungrounded words'
  with self.assertRaises(ValueError):p.resolve_report(report(bad),self.sources,self.offered)
 def test_catalog_exact_ranges_bounded_and_source_fair(self):
  sources={f'S{i:03}':source(TEXT*30) for i in range(1,51)};offers=p.make_passages(sources,[],max_items=96)
  self.assertEqual(len(offers),96);self.assertEqual(len({x['source_id'] for x in offers[:50]}),50)
  self.assertEqual(len({(x['source_id'],x['start'],x['end']) for x in offers}),len(offers))
  for e in offers:
   self.assertLessEqual(e['end'],2000);self.assertTrue(12<=len(e['text'])<=800);self.assertEqual(e['text'],sources[e['source_id']]['text'][e['start']:e['end']])
 def test_retained_late_windows_and_stale_windows(self):
  text='x'*4000+'Exact late evidence with\nnewlines.'+'y'*3000;sources={'S001':source(text)};h=hashlib.sha256(text.encode()).hexdigest();w={'source_id':'S001','start':4000,'end':4100,'text_sha256':h,'content_sha256':'a'*64}
  a=p.make_passages(sources,[w]);self.assertTrue(any(x['start']==4000 and x['end']==4100 for x in a));self.assertFalse(any(x['start']>=2000 for x in p.make_passages(sources,[{**w,'text_sha256':'b'*64}])));self.assertFalse(any(x['start']>=2000 for x in p.make_passages(sources,[{**w,'content_sha256':'c'*64}])))
 def test_overlapping_windows_do_not_duplicate_selectors(self):
  text=TEXT*3;h=hashlib.sha256(text.encode()).hexdigest();w={'source_id':'S001','start':0,'end':2500,'text_sha256':h,'content_sha256':'a'*64};a=p.make_passages({'S001':source(text)},[w,w]);self.assertEqual(len({(x['start'],x['end']) for x in a}),len(a))
 def test_catalog_limits_and_inputs_unchanged(self):
  s=copy.deepcopy(self.sources);p.make_passages(s,[]);self.assertEqual(s,self.sources)
  for n in [True,0,-1,97]:
   with self.subTest(n=n),self.assertRaises(ValueError):p.make_passages(s,[],max_items=n)

if __name__=='__main__':unittest.main()
