"""Deterministic public-source actions for a native supervisor, with no model API."""
import hashlib
import json
import time
import uuid
from research_state import StateError, BudgetExceeded, _json
from research_protocol import parse_action, validate_report
from research_worker import Worker

class Operator:
 def __init__(self,store,search,reader,mode):
  self.store,self.mode=store,mode
  self.worker=Worker(store,None,search,reader,mode)
  with store._db() as db:
   db.execute('CREATE TABLE IF NOT EXISTS operator_actions(job_id TEXT,key TEXT,payload_hash TEXT,status TEXT,result_json TEXT,PRIMARY KEY(job_id,key))')
 def action(self,job_id,raw,key):
  if not isinstance(key,str) or not 1<=len(key)<=120:raise StateError('operator idempotency key required')
  action=parse_action(json.dumps(raw))
  if action['action'] not in ('search','read','finish'):raise StateError('unsupported operator action')
  digest=hashlib.sha256(_json(action).encode()).hexdigest()
  with self.store.worker_lock():
   with self.store._db(transaction=True) as db:
    job=self.store._get(db,job_id)
    if job['manifest'].get('executor')!='operator' or job['manifest']['mode']!=self.mode:raise StateError('approved operator executor and provider mode required')
    old=db.execute('SELECT * FROM operator_actions WHERE job_id=? AND key=?',(job_id,key)).fetchone()
    if old:
     if old['payload_hash']!=digest:raise StateError('operator idempotency conflict')
     if old['status']=='completed':return json.loads(old['result_json'])
     if old['status']=='failed':raise StateError(json.loads(old['result_json'])['error'])
    elif db.execute("SELECT 1 FROM operator_actions WHERE job_id=? AND status='pending'",(job_id,)).fetchone():raise StateError('replay the interrupted operator action first')
    if job['status']=='queued':
     started=job['started_at'] or time.time();deadline=job['deadline'] or min(started+job['manifest']['limits']['seconds'],job['manifest']['not_after'])
     db.execute("UPDATE jobs SET status='running',started_at=?,deadline=? WHERE id=?",(started,deadline,job_id));job=self.store._get(db,job_id)
    if job['status'] not in ('running','completed','partial'):raise StateError('operator job is not active')
    if not old:db.execute("INSERT INTO operator_actions VALUES(?,?,?,'pending',NULL)",(job_id,key,digest))
   if job['status'] in ('completed','partial'):
    if not old or action['action']!='finish':raise StateError('operator report is already finalized')
    result={'job_id':job_id,'status':job['status']}
   else:
    token=str(uuid.uuid4());self.store.execution_start(job_id,token)
    try:
     c=job['checkpoint'] or {'step':0,'phase':'explore','next':'model','history':[],'sources':{},'known_urls':job['manifest']['scope']['seed_urls'][:],'draft':None,'errors':[],'limited':False}
     remaining=job['deadline']-time.time()
     if remaining<=0:
      c['limited']=True;self.worker.finalize(job,c,'original deadline reached');result={'job_id':job_id,'status':'partial'}
     elif action['action']=='finish':
      errors=validate_report(action['report'],c['sources'])
      if errors:raise StateError('report evidence validation failed: '+'; '.join(errors[:5]))
      c.update(draft=action['report'],phase='audit',errors=[]);self.worker.finalize(job,c);result={'job_id':job_id,'status':self.store.get(job_id)['status']}
     else:
      try:result=self.worker.tool(job,c,action,remaining)
      except BudgetExceeded as error:
       c['limited']=True;self.worker.finalize(job,c,str(error));result={'error':str(error),'status':'partial'}
      c['step']+=1
      if self.store.get(job_id)['status']=='running':self.store.checkpoint(job_id,c)
    except Exception as error:
     with self.store._db(transaction=True) as db:db.execute("UPDATE operator_actions SET status='failed',result_json=? WHERE job_id=? AND key=?",(_json({'error':str(error)[:2000]}),job_id,key))
     raise
    finally:self.store.execution_end(job_id,token)
   with self.store._db(transaction=True) as db:db.execute("UPDATE operator_actions SET status='completed',result_json=? WHERE job_id=? AND key=?",(_json(result),job_id,key))
   return result
