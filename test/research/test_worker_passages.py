import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_state import Store,manifest_hash
from research_worker import Worker
from research_protocol import validate_report

URL='https://www.sqlite.org/wal.html'
TEXT='The official fixture stores exact\nline breaks with Unicode 🔥 for citation provenance.'
def report(evidence):return {'title':'FIXTURE selector result','complete':True,'claims':[{'id':'C1','kind':'fact','text':'A fixture tests provenance only.','evidence':[evidence]}],'summary':['C1'],'comparisons':[],'recommendations':[{'text':'Fixture inference only.','claim_ids':['C1']}],'contradictions':[],'unanswered':[]}

class WorkerPassageTests(unittest.TestCase):
 def setup_store(self,limit=20):
  t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);s=Store(t.name);m={'submission_id':'passage-fixture','mode':'fixture','question':'Read saved evidence and finish early.','scope':{'seed_urls':[URL]},'limits':{'model_calls':limit}};return s,s.submit(m,manifest_hash(m))
 def worker(self,store,model):return Worker(store,model,lambda q:{'results':[]},lambda url,**k:{'ok':True,'url':url,'text':TEXT,'contentSha256':'a'*64},mode='fixture')
 def test_selector_is_resolved_against_actual_prompt_raw_result_preserved(self):
  store,job=self.setup_store();contexts=[]
  class Model:
   def complete(inner,messages,timeout):
    c=json.loads(messages[-1]['content']);contexts.append(c)
    if len(contexts)==1:return {'content':json.dumps({'action':'read','url':URL})}
    chosen=c['citation_passages'][0];e={k:v for k,v in chosen.items() if k!='text'}
    return {'content':json.dumps({'action':'finish','report':report(e)})}
  self.worker(store,Model()).drain();final=store.get(job['id']);self.assertEqual(final['status'],'completed');self.assertEqual(final['counters']['model'],3);self.assertFalse(final['checkpoint']['limited'])
  output=json.loads((store.job_dir(job['id'])/'claims.json').read_text());e=output['claims'][0]['evidence'][0];self.assertEqual(e['quote'],TEXT);self.assertEqual(e['selection']['text_sha256'],hashlib.sha256(TEXT.encode()).hexdigest());self.assertEqual(validate_report(output,final['checkpoint']['sources']),[])
  model_ops=[o for o in store.operations(job['id']) if o['kind']=='model'];raw=json.loads(model_ops[1]['result']['content']);self.assertNotIn('quote',raw['report']['claims'][0]['evidence'][0]);self.assertEqual(raw['report']['claims'][0]['evidence'][0]['start'],0)
  self.assertIn('budget',contexts[0]);self.assertEqual(contexts[0]['budget']['reserved_final_calls'],3)
 def test_valid_but_unoffered_range_cannot_be_invented(self):
  store,job=self.setup_store(4);calls=[]
  class Model:
   def complete(inner,messages,timeout):
    c=json.loads(messages[-1]['content']);calls.append(c)
    if len(calls)==1:return {'content':json.dumps({'action':'read','url':URL})}
    e={'source_id':'S001','text_sha256':hashlib.sha256(TEXT.encode()).hexdigest(),'start':1,'end':30}
    return {'content':json.dumps({'action':'finish','report':report(e)})}
  self.worker(store,Model()).drain();final=store.get(job['id']);self.assertEqual(final['status'],'partial');out=json.loads((store.job_dir(job['id'])/'claims.json').read_text());self.assertEqual(out['claims'],[]);self.assertLessEqual(final['counters']['model'],4)
 def test_existing_reserved_payload_is_not_augmented_with_new_passages(self):
  store,job=self.setup_store(4);job=store.claim_next();checkpoint={'step':0,'phase':'explore','next':'model','history':[],'sources':{'S001':{'url':URL,'text':TEXT,'contentSha256':'a'*64}},'known_urls':[URL],'draft':None,'errors':[],'limited':False};store.checkpoint(job['id'],checkpoint)
  legacy={'phase':'explore','messages':[{'role':'user','content':'legacy unchanged payload'}]};opid=job['id']+':0:model';store.reserve(job['id'],'model',legacy,op_id=opid)
  e={'source_id':'S001','text_sha256':hashlib.sha256(TEXT.encode()).hexdigest(),'start':0,'end':len(TEXT)};store.complete_operation(opid,{'content':json.dumps({'action':'finish','report':report(e)})})
  from test_worker import Model
  empty={'title':'Incomplete fixture','complete':False,'claims':[],'summary':[],'comparisons':[],'recommendations':[],'contradictions':[],'unanswered':['No old offered selections.']}
  self.worker(store,Model([{'action':'finish','report':empty}]*4)).drain();self.assertEqual(store.operations(job['id'])[0]['payload'],legacy);self.assertEqual(store.get(job['id'])['status'],'partial')

if __name__=='__main__':unittest.main()
