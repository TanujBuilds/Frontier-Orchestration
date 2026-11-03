"""Standalone @6 fixture driver. No provider clients or external requests."""
import copy,json,sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_state import Store
from research_worker import Worker
from research_review import digest
f=json.loads((Path(__file__).parent/'fixtures/targeted-valid.json').read_text())
store=Store(sys.argv[1]);jid=sys.argv[2];action=sys.argv[3]
sources=json.loads(f['packet']['canonical']['sources']);offers=json.loads(f['packet']['repair']['base']['offers']);raw=json.loads(f['packet']['repair']['base']['report'])
for c in raw['claims']:c['evidence']=[{'source_id':e['source_id'],**e['selection']} for e in c['evidence']]
if action=='initial':
 j=store.claim_next();assert j['id']==jid
 store.checkpoint(jid,{'step':0,'phase':'draft','next':'model','history':[],'sources':sources,'known_urls':[],'draft':None,'errors':[],'limited':False})
 op=store.reserve(jid,'search',{'query':'fixture query'});store.complete_operation(op['id'],{'status':'ok','results':[]})
elif action=='finalize':
 j=store.get(jid);store.accepted_packet(j)
 if j['status']=='suspended':store.resume(jid)
class Model:
 model_id='offline-targeted-fixture'
 def complete(self,messages,timeout):
  assert action!='finalize','No inference after acceptance'
  if action=='initial':return {'content':json.dumps({'action':'finish','report':raw})}
  context=json.loads(messages[-1]['content']);plan=context['targeted_repair']['plan'];hs={r['unit']:r['beforeSha256'] for r in plan['units']}
  p={'action':'repair','base_candidate_hash':plan['baseCandidateHash'],'plan_sha256':digest(plan),'replacements':[{'unit':'claims:C1','before_sha256':hs['claims:C1'],'value':raw['claims'][0]|{'text':'Entries remain readable only while their lease is valid.'}}],'checked_units':[{'unit':u,'before_sha256':hs[u]} for u in ['summary:0','recommendations:0']],'cannot_repair':[]}
  return {'content':json.dumps(p)}
def denied(*a):raise AssertionError('No retrieval allowed')
with patch('research_worker.make_passages',return_value=offers):Worker(store,Model(),denied,denied,mode='fixture').drain()
assert store.get(jid)['status']==('completed' if action=='finalize' else 'awaiting_semantic_review'),store.get(jid)
