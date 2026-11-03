"""Fault injection stays in disposable test process, never production hooks."""
import json,signal,sys
from pathlib import Path
sys.path[:0]=[str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'),str(Path(__file__).parent)]
from research_state import Store
from research_worker import Worker
from research_review import digest
from test_targeted_repair import fixture
import research_worker
root,point=sys.argv[1:];store=Store(root)
def stop(label):
 if label==point:
  print('READY',flush=True);signal.pause()
original=store.reserve
def reserve(*a,**kw):
 stop('before_reservation');r=original(*a,**kw);stop('after_reservation');return r
store.reserve=reserve
complete=store.complete_operation
def completed(*a,**kw):
 r=complete(*a,**kw);stop('after_result');return r
store.complete_operation=completed
atomic=research_worker.atomic
def write(path,data):
 r=atomic(path,data)
 if Path(path).name.startswith('assembly-'):stop('after_assembly')
 if Path(path).name=='claims.json':stop('after_final_report')
 if Path(path).name=='receipt.json':stop('after_final_receipt')
 return r
research_worker.atomic=write
save=store._save_review
def saved(*a,**kw):
 r=save(*a,**kw)
 if a[4]=='review_submitted':stop('after_review_write')
 stop('after_candidate_write');return r
store._save_review=saved
stage=store.stage_candidate
def staged(*a,**kw):
 r=stage(*a,**kw);stop('after_stage');return r
store.stage_candidate=staged
finish=store.finish
def finished(*a,**kw):
 r=finish(*a,**kw);stop('after_finish');return r
store.finish=finished
class Model:
 model_id='offline-targeted-fixture'
 def complete(self,messages,timeout):
  c=json.loads(messages[-1]['content']);plan=c['targeted_repair']['plan'];hs={r['unit']:r['beforeSha256'] for r in plan['units']};claim=fixture()[4]
  with open(Path(root)/'fixture-call-log','a') as f:f.write('call\n');f.flush()
  p={'action':'repair','base_candidate_hash':plan['baseCandidateHash'],'plan_sha256':digest(plan),'replacements':[{'unit':'claims:C1','before_sha256':hs['claims:C1'],'value':claim|{'text':'Entries remain readable only while their lease is valid.'}}],'checked_units':[{'unit':u,'before_sha256':hs[u]} for u in ['summary:0','recommendations:0']],'cannot_repair':[]}
  return {'content':json.dumps(p)}
if point in ('after_review_write','after_review_submit'):
 j=store.list_jobs()[0];d=store.proposal_export(j['id'])['descriptor'];t=j['checkpoint']['semantic']['tickets'][0]
 finding=fixture()[1]['findings']
 store.review_submit(j['id'],t['id'],d['candidateHash'],d['rubricSha256'],'revise',finding,d['units'],'revise-A')
 stop('after_review_submit')
else:Worker(store,Model(),None,None,mode='fixture').drain()
print('DID_NOT_REACH_POINT',flush=True)
