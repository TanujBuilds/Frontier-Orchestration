"""Deterministic pre-opt-in request fingerprints; executes no providers."""
import copy,json,sys
from pathlib import Path

def fingerprints(scripts=None):
 if scripts:sys.path.insert(0,str(scripts))
 else:sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
 from research_worker import Worker
 from research_review import build_repair_proposal,digest
 from research_passages import resolve_report
 from test_review_protocol import POLICY
 f=json.loads((Path(__file__).parent/'fixtures/repair-context-failures.json').read_text());ref={'operationId':'compat-op','requestSha256':'a'*64,'resultSha256':'b'*64,'offersSha256':'c'*64}
 class Store:
  def operations(self,jid):return []
  def discovery_status(self,jid):return {'requested':True,'state':'satisfied','attempted':1,'satisfied':True,'failed':0,'operations':[]}
 result={}
 for name,policy in [('legacy',None),('policy1',{'version':1,'finish':'selectors_only','discovery':'search_required'}),('policy2',{'version':2,'finish':'selectors_only','discovery':'search_required'}),('policy3',POLICY)]:
  for phase in ('explore','draft','audit','repair'):
   job={'id':'compat-job','manifest':{'question':'Offline context compatibility fixture.','scope':{'seed_urls':['https://sqlite.org/wal.html']},'limits':{'model_calls':18},**({'research_policy':copy.deepcopy(policy)} if policy else {})},'counters':{'model':3,'search':1,'download':6}}
   state={'step':4,'phase':phase,'history':[],'sources':f['sources'],'draft':resolve_report(f['reports']['11'],f['sources'],f['offers'],strict=True),'errors':[],'repair_proposal':build_repair_proposal(f['reports']['10'],f['sources'],f['offers'],ref)}
   worker=Worker(Store(),None,None,None,mode='fixture');result[name+':'+phase]=digest(worker.model_payload(job,state))
 return result
if __name__=='__main__':print(json.dumps(fingerprints(sys.argv[1] if len(sys.argv)>1 else None),indent=2))
