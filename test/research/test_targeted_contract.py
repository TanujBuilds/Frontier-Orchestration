"""Public-safe contract fixtures protect scope, projections and bounded feedback."""
import copy,inspect,json,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_targeted_repair import describe_plan,build_plan,units
from research_review import digest,encoded
import test_targeted_repair as fixtures
fixture=fixtures.fixture

class PresentationTests(unittest.TestCase):
 def view(self,base,plan,offers):
  self.assertIn('correction_offers',inspect.signature(describe_plan).parameters)
  self.assertEqual(inspect.signature(describe_plan).parameters['correction_offers'].kind,inspect.Parameter.KEYWORD_ONLY)
  return describe_plan(base,plan,correction_offers=offers)
 def test_actual_plan_derives_scope_and_keeps_whole_hash_manifest(self):
  base,sub,_,offers,_=fixture()
  for target,allowed in [('claims:C1',['claims:C1','recommendations:0','summary:0']),('recommendations:0',['recommendations:0']),('title',['title'])]:
   with self.subTest(target=target):
    sub['findings'][0]['unit']=target;plan=build_plan(base,sub,'ticket-A');before=digest([base,plan,offers]);v=self.view(base,plan,offers);c=v['output_contract']
    self.assertEqual(c['allowed_units'],allowed);self.assertEqual(v['plan'],plan);self.assertEqual(len(v['plan']['units']),4);self.assertEqual(digest([base,plan,offers]),before)
    self.assertEqual(c['scope_rule'],'replacements_and_checked_units_subset');self.assertEqual(c['checked_units_role'],'unchanged_affected_dependents_only');self.assertEqual(c['global_manifest_role'],'read_only_hash_manifest_not_output_coverage')
    self.assertEqual(c['semantic_review_scope'],'whole_report_after_assembly');self.assertEqual(c['no_op_replacements'],'forbidden');self.assertEqual(c['unchanged_summary_rule'],'check_affected_pointer_or_repair_claim_never_noop')
 def test_different_report_fixture_uses_its_own_claim_and_dependent_closure(self):
  base,sub,_,offers,_=fixture('Durable writes survive only after the commit is acknowledged.')
  report=json.loads(base['canonical']['report']);report['claims'].append(copy.deepcopy(report['claims'][0])|{'id':'C2'});report['summary'].append('C2');report['comparisons']=[{'text':'A distinct dependent for the second claim.','claim_ids':['C2']}]
  base['canonical']['report']=encoded(report);d=base['descriptor'];d.update(reportSha256=digest(report),units=list(units(report)));d['candidateHash']=digest({k:v for k,v in d.items() if k!='candidateHash'})
  sub.update(candidateHash=d['candidateHash'],coverage=d['units']);sub['findings'][0]['unit']='claims:C2';plan=build_plan(base,sub,'ticket-A');v=self.view(base,plan,offers)
  self.assertEqual(v['output_contract']['allowed_units'],['claims:C2','comparisons:0','summary:1']);self.assertEqual(len(v['plan']['units']),7);self.assertEqual(v['plan'],plan)
 def test_valid_raw_projection_keeps_canonical_input_and_before_hash(self):
  base,sub,_,offers,raw=fixture('😀 Entries remain readable only while their lease is valid.');plan=build_plan(base,sub,'ticket-A');v=self.view(base,plan,offers);row=next(r for r in v['values'] if r['unit']=='claims:C1');canonical=json.loads(base['canonical']['report'])['claims'][0]
  self.assertEqual(row['input_role'],'retained_canonical_input_only');self.assertEqual(row['value'],canonical);self.assertEqual(row['before_sha256'],digest(canonical));self.assertEqual(row['output_value'],raw);self.assertEqual(row['output_projection'],'offered')
  self.assertEqual(set(row['output_value']['evidence'][0]),{'source_id','text_sha256','start','end'})
  self.assertEqual(v['output_contract']['claim_evidence_fields'],['source_id','text_sha256','start','end']);self.assertEqual(v['output_contract']['canonical_quote_selection'],'input_only_never_output')
  shapes=v['replacement_value_shapes'];self.assertEqual(set(shapes['claim']),{'id','kind','text','evidence'});self.assertEqual(set(shapes['claim']['evidence'][0]),{'source_id','text_sha256','start','end'});self.assertEqual(set(shapes['synthesis']),{'text','claim_ids'});self.assertIsInstance(shapes['summary'],str)
  self.assertIs(type(shapes['claim']['evidence'][0]['start']),int);self.assertIs(type(shapes['claim']['evidence'][0]['end']),int)
  self.assertIn('vendor_claim',shapes['claim']['kind']);self.assertIn('unknown',shapes['claim']['kind'])
  self.assertIn('unchanged affected',v['action_shape']['checked_units'][0]['unit']);self.assertIn('BOTH replacements and checked_units',v['instruction'])
 def test_missing_stale_duplicate_ambiguous_and_wrong_text_offers_never_grant_projection(self):
  base,sub,_,offers,_=fixture();plan=build_plan(base,sub,'ticket-A')
  variants=[[],[offers[0]|{'text_sha256':'0'*64}],[offers[0]|{'start':1}],[offers[0]|{'text':'incorrect saved text'}],offers+copy.deepcopy(offers),offers+[offers[0]|{'text':'ambiguous text'}]]
  for current in variants:
   with self.subTest(current=current):
    before=digest([base,plan,current]);v=self.view(base,plan,current);r=next(x for x in v['values'] if x['unit']=='claims:C1');self.assertEqual(r['input_role'],'retained_canonical_input_only');self.assertIsNone(r['output_value']);self.assertEqual(r['output_projection'],'unoffered');self.assertEqual(digest([base,plan,current]),before)

class ScopeFeedbackTests(unittest.TestCase):
 setUpClass=classmethod(fixtures.TargetedTests.setUpClass.__func__)
 setUp=fixtures.TargetedTests.setUp
 patch=fixtures.TargetedTests.patch
 apply=fixtures.TargetedTests.apply
 def message(self,p):
  before=digest([self.base,self.plan,p,self.sources,self.offers])
  with self.assertRaises(ValueError) as cm:self.apply(p)
  message=str(cm.exception);self.assertTrue(message.startswith('foreign/unrelated repair units'));self.assertLessEqual(len(message),450);self.assertIn('plan.affected',message);self.assertIn('BOTH replacements and checked_units',message);self.assertEqual(before,digest([self.base,self.plan,p,self.sources,self.offers]));return message
 def test_both_fields_report_total_counts_and_escaped_bounded_previews(self):
  p=self.patch();foreign=['\x00\n"\\'+'🔥'*40+str(i) for i in range(12)]
  p['replacements'] += [{'unit':u,'before_sha256':'0'*64,'value':'data'} for u in foreign[:6]]
  p['checked_units'] += [{'unit':u,'before_sha256':'0'*64} for u in foreign[6:]]
  m=self.message(p);self.assertIn('total=12',m);self.assertIn('replacements count=6',m);self.assertIn('checked_units count=6',m);self.assertNotIn('\n',m);self.assertNotIn('\x00',m)
  # Each field supplies a complete JSON preview, never a sliced escape sequence.
  import re
  previews=re.findall(r'preview=(\[.*?\]) omitted=(\d+)',m);self.assertEqual(len(previews),2);names=[];omitted=0
  for preview,n in previews:
   rows=json.loads(preview);names+=rows;omitted+=int(n)
   for name in rows:self.assertLessEqual(len(json.dumps(name,ensure_ascii=True)),32)
  self.assertLessEqual(len(names),5);self.assertEqual(len(names)+omitted,12);self.assertEqual(self.message(p),m)
  p['replacements'].reverse();p['checked_units'].reverse();self.assertEqual(self.message(p),m)
 def test_single_field_identifies_checked_units_and_foreign_hash_does_not_help(self):
  p=self.patch();p['checked_units'].append({'unit':'title','before_sha256':digest('Synthetic conditional premise')});m=self.message(p);self.assertIn('checked_units count=1',m);self.assertIn('"title"',m);self.assertIn('omitted=0',m);self.assertNotIn('replacements count=',m)
 def test_250_hostile_names_keep_fixed_rule_and_omission_count(self):
  p=self.patch();p['replacements']=[];p['checked_units']=[{'unit':'🔥'*40+str(i),'before_sha256':'0'*64} for i in range(250)]
  m=self.message(p);self.assertIn('checked_units count=250',m);self.assertIn('omitted=245',m)

import test_targeted_lifecycle as lifecycle
from research_worker import Worker
from research_providers import completion_payload
from unittest.mock import patch

class WorkerContractTests(unittest.TestCase):
 setUp=lifecycle.TargetedLifecycleTests.setUp
 initial=lifecycle.TargetedLifecycleTests.initial
 run_actions=lifecycle.TargetedLifecycleTests.run_actions
 repair=lifecycle.TargetedLifecycleTests.repair
 def test_two_permitted_payloads_have_same_authority_and_actionable_feedback_then_stop(self):
  self.initial();before=self.store.get(self.id);snapshot=self.store.targeted_snapshot(before,before['checkpoint']);calls=[]
  owner=self
  class Model:
   model_id='offline-targeted-fixture'
   def complete(self,messages,timeout):
    content=json.loads(messages[-1]['content']);calls.append(copy.deepcopy(messages));action=owner.repair(content)
    action['checked_units'].append({'unit':'title','before_sha256':digest('Synthetic conditional premise')})
    return {'content':json.dumps(action)}
  Worker(self.store,Model(),None,None,mode='fixture').drain()
  self.assertEqual(len(calls),2)
  for messages in calls:
   content=json.loads(messages[-1]['content']);v=content['targeted_repair'];self.assertEqual(v['plan'],snapshot['plan']);self.assertEqual(v['action_shape']['plan_sha256'],digest(snapshot['plan']));self.assertEqual(v['output_contract']['allowed_units'],['claims:C1','recommendations:0','summary:0'])
   claim=next(r for r in v['values'] if r['unit']=='claims:C1');self.assertEqual(claim['output_projection'],'offered');self.assertEqual(claim['output_value'],self.raw);self.assertEqual(claim['value'],json.loads(snapshot['base']['canonical']['report'])['claims'][0])
   self.assertLessEqual(len(json.dumps(completion_payload(Model.model_id,messages)).encode()),196608)
  self.assertEqual(json.loads(calls[0][-1]['content'])['validation_errors'],[])
  errors=json.loads(calls[1][-1]['content'])['validation_errors'];self.assertEqual(len(errors),1);self.assertIn('checked_units count=1',errors[0]);self.assertIn('"title"',errors[0]);self.assertIn('plan.affected',errors[0]);self.assertLessEqual(len(errors[0]),450)
  after=self.store.get(self.id);self.assertEqual(after['status'],'partial');self.assertEqual(after['counters'],{'model':3,'search':1,'download':0});self.assertEqual(after['deadline'],self.deadline);self.assertEqual(after['checkpoint']['targeted_snapshot'],before['checkpoint']['targeted_snapshot']);self.assertEqual(after['checkpoint']['semantic']['correctionAllowance'],2)
  operations=copy.deepcopy(self.store.operations(self.id));self.assertEqual(self.run_actions([]),[]);self.assertEqual(self.store.operations(self.id),operations);self.assertEqual(self.store.get(self.id)['deadline'],self.deadline)
 def test_no_correction_capacity_finishes_partial_before_build_or_dispatch(self):
  self.initial();job=self.store.claim_next()
  for i in range(2):
   op=self.store.reserve(self.id,'model',{'fixture_spent_slot':i});self.store.complete_operation(op['id'],{'error':'offline spent slot'})
  before=self.store.operations(self.id)
  with patch.object(Worker,'targeted_payload',side_effect=AssertionError('no payload after capacity')):
   Worker(self.store,None,None,None,mode='fixture').run_job(job)
  job=self.store.get(self.id);self.assertEqual(job['status'],'partial');self.assertEqual(job['counters']['model'],3);self.assertEqual(job['deadline'],self.deadline);self.assertEqual(self.store.operations(self.id),before)
 def test_reserved_original_model_payload_returns_exact_bytes_without_reconstruction(self):
  self.initial();job=self.store.claim_next();state=copy.deepcopy(job['checkpoint']);old={'phase':'repair','messages':[{'role':'system','content':'Historical immutable instructions\n'}, {'role':'user','content':'{"old": "retained 😀 bytes"}'}]};opid=self.id+':'+str(state['step'])+':model'
  self.store.reserve(self.id,'model',old,op_id=opid);reserved=next(o['payload'] for o in self.store.operations(self.id) if o['id']==opid);self.assertEqual(reserved,old);state['errors']=['new diagnostics must not rewrite reservation'];worker=Worker(self.store,None,None,None,mode='fixture')
  with patch.object(worker,'targeted_payload',side_effect=AssertionError('must replay instead of rebuild')):
   actual=worker.model_payload(job,state)
  self.assertEqual(json.dumps(actual,ensure_ascii=False).encode(),json.dumps(reserved,ensure_ascii=False).encode());self.assertEqual(digest(actual),digest(old))
 def test_actual_catalog_deficit_is_input_only_in_worker_payload(self):
  self.initial();job=self.store.get(self.id);worker=Worker(self.store,None,None,None,mode='fixture');before=digest(job['checkpoint'])
  with patch('research_worker.make_passages',return_value=[]):payload=worker.model_payload(job,job['checkpoint'])
  content=json.loads(payload['messages'][-1]['content']);self.assertEqual(content['citation_passages'],[]);row=next(r for r in content['targeted_repair']['values'] if r['unit']=='claims:C1');self.assertEqual(row['output_projection'],'unoffered');self.assertIsNone(row['output_value']);self.assertEqual(digest(job['checkpoint']),before)
