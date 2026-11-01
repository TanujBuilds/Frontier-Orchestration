"""Real HTTP adapter and process-death integration, with no public/model access."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'))
from research_state import Store,manifest_hash
from research_providers import DeepSeek
from research_worker import Worker
from test_worker import URL,TEXT,report

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.gets+=1
        self.send_response(200);self.end_headers()
        self.wfile.write(json.dumps({'data':[{'id':self.server.model_id}]}).encode())
    def do_POST(self):
        raw=self.rfile.read(int(self.headers['Content-Length']))
        self.server.raw_bodies.append(raw)
        payload=json.loads(raw)
        self.server.posts.append(payload)
        action=self.server.actions.pop(0)
        self.send_response(200);self.end_headers()
        self.wfile.write(json.dumps({'model':self.server.model_id,'choices':[{'message':{'content':json.dumps(action)}}],'usage':{'total_tokens':11}}).encode())
    def log_message(self,*args):pass

class HTTPRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=Store(self.tmp.name)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.model_id='fixture-http';self.server.gets=0;self.server.posts=[];self.server.raw_bodies=[]
        self.server.actions=[{'action':'read','url':URL},{'action':'finish','report':report()},{'action':'finish','report':report()}]
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
        self.base=f'http://127.0.0.1:{self.server.server_port}/v1'
    def submit(self):
        m={'submission_id':'crash','question':'A queue comparison','mode':'fixture','scope':{'seed_urls':[URL]}}
        return self.store.submit(m,manifest_hash(m))
    def read(self,url,**kwargs):return {'ok':True,'url':url,'finalUrl':url,'text':TEXT,'contentSha256':'a'*64,'fetchedAt':'fixture'}
    def test_context_bound_matches_actual_unicode_http_body(self):
        job=self.submit();job=self.store.claim_next()
        model=DeepSeek(self.base,'fixture-http')
        worker=Worker(self.store,model,lambda q:{},self.read,mode='fixture')
        c={'step':0,'phase':'draft','sources':{},'history':[],'draft':None,'errors':[]}
        for i in range(25):c['sources']['S'+str(i+1).zfill(3)]={'url':URL,'text':'🔥'*50000}
        payload=worker.model_payload(job,c)
        model.complete(payload['messages'],5)
        actual_bytes=len(self.server.raw_bodies[-1])
        self.assertLessEqual(actual_bytes,196608)
        context=json.loads(payload['messages'][-1]['content'])
        self.assertTrue(context['context_bounds']['omissions'])
        evidence=__import__('os').environ.get('RESEARCH_CONTEXT_EVIDENCE_DIR')
        if evidence:
            Path(evidence,'unicode-http.json').write_text(json.dumps({'fixture':True,
                'actual_http_body_bytes':actual_bytes,'limit':196608,'request_count':len(self.server.posts),
                'body_sha256':__import__('hashlib').sha256(self.server.raw_bodies[-1]).hexdigest()}))

    def test_model_id_mismatch_never_sends_completion(self):
        with self.assertRaises(ValueError):DeepSeek(self.base,'wrong').complete([],2)
        self.assertEqual(self.server.posts,[])
    def test_process_death_after_saved_model_response_reuses_it(self):
        job=self.submit()
        scripts=Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'
        code='''import sys,os
sys.path.insert(0,sys.argv[1])
from research_state import Store
from research_worker import Worker
from research_providers import DeepSeek
s=Store(sys.argv[2])
original=s.complete_operation
def completed(opid,result):
    r=original(opid,result)
    if r['kind']=='model':os._exit(77)
    return r
s.complete_operation=completed
Worker(s,DeepSeek(sys.argv[3],'fixture-http'),lambda q:{},lambda u,**k:{},mode='fixture').drain()
'''
        child=subprocess.run([sys.executable,'-c',code,str(scripts),self.tmp.name,self.base],capture_output=True,text=True,timeout=15)
        self.assertEqual(child.returncode,77,child.stderr)
        self.assertEqual(len(self.server.posts),1)
        deadline=self.store.get(job['id'])['deadline']
        Worker(self.store,DeepSeek(self.base,'fixture-http'),lambda q:{},self.read,mode='fixture').drain()
        final=self.store.get(job['id'])
        self.assertEqual(final['status'],'completed')
        self.assertEqual(final['counters']['model'],3)
        self.assertEqual(len(self.server.posts),3)
        self.assertEqual(final['deadline'],deadline)
        self.assertTrue((self.store.job_dir(job['id'])/'receipt.json').exists())

if __name__=='__main__':unittest.main()
