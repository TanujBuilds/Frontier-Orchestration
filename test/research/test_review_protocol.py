import copy,json,sys,time,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_state import normalize_manifest,manifest_hash,StateError

REVIEW={'version':1,'role':'independent_operator','maxRounds':2,'maxRevisions':1,'maxCorrectionModelCalls':2,'rubricSha256':'a'*64}
POLICY={'version':3,'finish':'selectors_only','discovery':'search_required','review':REVIEW}
def manifest():
 return {'schema':2,'submission_id':'review-fixture','question':'Compare sources','mode':'fixture','scope':{'seed_urls':['https://fixture.invalid/source']},'not_after':time.time()+7200,'collaboration':{'supervisor':'codex','max_questions':0},'research_policy':copy.deepcopy(POLICY)}
class ReviewContractTests(unittest.TestCase):
 def test_v3_is_opt_in_and_binds_review_rubric(self):
  m=normalize_manifest(manifest());self.assertEqual(m['research_policy'],POLICY)
  n=copy.deepcopy(m);n['research_policy']['review']['rubricSha256']='b'*64;self.assertNotEqual(manifest_hash(m),manifest_hash(n))
 def test_closed_limits_and_no_operator_or_user_mode_fallback(self):
  normalize_manifest(manifest())
  for field,value in [('maxRounds',3),('maxRevisions',2),('maxCorrectionModelCalls',3),('verified',True)]:
   m=manifest();m['research_policy']['review'][field]=value
   with self.assertRaises((StateError,ValueError)):normalize_manifest(m)
  for change in [{'executor':'operator'},{'collaboration':{'supervisor':'user','max_questions':0}},{'limits':{'model_calls':21}}]:
   with self.assertRaises((StateError,ValueError)):normalize_manifest(manifest()|change)
 def test_explicit_context_mapping(self):
  import research_review
  self.assertEqual(research_review.policy_parameters(POLICY),{'strict':True,'support':True,'catalog_version':2,'requires_review':True})
  self.assertFalse(research_review.policy_parameters(None)['requires_review'])
