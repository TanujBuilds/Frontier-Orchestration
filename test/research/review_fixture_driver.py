"""Local simulated model driver; never constructs provider clients."""
import json,sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_state import Store
from research_worker import Worker
f=json.loads((Path(__file__).parent/'fixtures/review-malformed-draft.json').read_text())
r=json.loads((Path(__file__).parent/'fixtures/review-final-negative.json').read_text())
store=Store(sys.argv[1]);jid=sys.argv[2];action=sys.argv[3]
if action=='initial':
 j=store.claim_next();assert j['id']==jid
 store.checkpoint(jid,{'step':0,'phase':'explore','next':'model','history':[],'sources':f['sources'],'known_urls':[],'draft':None,'errors':[],'limited':False})
 op=store.reserve(jid,'search',{'query':'fixture query'});store.complete_operation(op['id'],{'query':'fixture query','status':'ok','results':[]})
elif action=='finalize':
 # Stopping the disposable coordinator can yield its accepted queued backend.
 # Resume only the already accepted local finalization, never infer to recover.
 j=store.get(jid);store.accepted_packet(j)
 if j['status']=='suspended':store.resume(jid)
elif action=='correct':
 r['claims']=[c for c in r['claims'] if c['id'] not in ['C4','C8']];r['summary']=[c['id'] for c in r['claims']];r['comparisons']=[];r['recommendations']=[{'text':'Inference: consider Temporal if durable workflow recovery is needed; external effects require separate design.','claim_ids':['C7']}];r['unanswered']=['Untested fixture design assumptions remain.']
class Model:
 def complete(self,*a):
  assert action!='finalize','No inference after acceptance'
  return {'content':json.dumps({'action':'finish','report':r})}
def denied(*a):raise AssertionError('No retrieval allowed')
with patch('research_worker.make_passages',return_value=f['offers']):Worker(store,Model(),denied,denied,mode='fixture').drain()
assert store.get(jid)['status']==('completed' if action=='finalize' else 'awaiting_semantic_review'),store.get(jid)
