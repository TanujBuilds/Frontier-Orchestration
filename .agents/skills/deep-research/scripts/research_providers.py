"""Existing DeepSeek HTTP service or explicitly labelled offline fixtures."""
import hashlib
import http.client
import json
import os
import socket
import ssl
import time
from urllib.parse import urlsplit
from research_reader import _ResponseSocket, read_url
from research_search import SearxSearch
from research_worker import atomic

class DeepSeek:
    def __init__(self,base_url,model_id,api_key_env=None):
        self.url=urlsplit(base_url.rstrip('/'))
        if self.url.scheme not in ('http','https') or not self.url.hostname or self.url.username or self.url.query or self.url.fragment:
            raise ValueError('invalid configured model URL')
        if not isinstance(model_id,str) or not model_id:raise ValueError('model_id required')
        self.model_id=model_id;self.key=os.environ.get(api_key_env,'') if api_key_env else '';self.verified=False
    def request(self,method,path,payload,timeout):
        start=time.monotonic();port=self.url.port or (443 if self.url.scheme=='https' else 80)
        sock=socket.create_connection((self.url.hostname,port),timeout)
        try:
            if self.url.scheme=='https':sock=ssl.create_default_context().wrap_socket(sock,server_hostname=self.url.hostname)
            raw=json.dumps(payload).encode() if payload is not None else b''
            headers=f'{method} {self.url.path}{path} HTTP/1.1\r\nHost: {self.url.netloc}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {len(raw)}\r\n'
            if self.key:headers+='Authorization: Bearer '+self.key+'\r\n'
            sock.sendall(headers.encode()+b'\r\n'+raw)
            response=http.client.HTTPResponse(_ResponseSocket(sock,start+timeout));response.begin()
            if response.status!=200:raise RuntimeError('DeepSeek HTTP status '+str(response.status))
            return json.loads(response.read(2*1024*1024+1))
        finally:sock.close()
    def complete(self,messages,timeout):
        start=time.monotonic()
        if not self.verified:
            data=self.request('GET','/models',None,min(10,timeout))
            if self.model_id not in [m.get('id') for m in data.get('data',[])]:raise ValueError('configured model_id was not advertised by the server')
            self.verified=True
        remaining=timeout-(time.monotonic()-start)
        if remaining<=0:raise TimeoutError('model request deadline expired')
        obj=self.request('POST','/chat/completions',{'model':self.model_id,'messages':messages,'stream':False,'temperature':0.2,'max_tokens':8192},remaining)
        content=obj['choices'][0]['message']['content']
        if not isinstance(content,str) or not content.strip():raise ValueError('DeepSeek returned no answer content')
        return {'content':content,'model':obj.get('model',self.model_id),'usage':obj.get('usage',{})}

class Fixture:
    model_id='fixture-no-model'
    def __init__(self,path):
        self.data=json.loads(open(path).read())
        if not isinstance(self.data.get('source_url'),str) or not isinstance(self.data.get('text'),str) or len(self.data['text'])<20:
            raise ValueError('fixture needs source_url and >=20 characters of text')
    def search(self,query):
        return {'status':'ok','query':query,'results':[{'url':self.data['source_url'],'title':'Fixture evidence','content':'Discovery snippet, not source evidence.'}]}
    def read(self,url,artifact_dir=None,**kwargs):
        if url!=self.data['source_url']:return {'ok':False,'error':{'code':'unknown_fixture_url'}}
        raw=self.data['text'].encode();digest=hashlib.sha256(raw).hexdigest()
        record={'ok':True,'url':url,'finalUrl':url,'text':self.data['text'],'contentSha256':digest,'fetchedAt':'fixture','truncated':False,'contentType':'text/plain'}
        if artifact_dir:
            from pathlib import Path
            path=Path(artifact_dir)/(digest+'.source');atomic(path,raw);record['sourcePath']=str(path)
        return record
    def complete(self,messages,timeout):
        context=json.loads(messages[-1]['content']);sources=context['sources']
        if sources or context['phase']!='explore':
            report=self.data.get('report') or {'title':'Fixture research result','complete':bool(sources),
                'claims':[{'id':'C1','kind':'fact','text':self.data['text'][:200],'evidence':[{'source_id':'S001','quote':self.data['text'][:120]}]}] if sources else [],
                'summary':['C1'] if sources else [],'comparisons':[],'recommendations':[], 'contradictions':[], 'unanswered':[]}
            action={'action':'finish','report':report}
        elif any(x.get('content',{}).get('results') for x in context['prior_messages'] if isinstance(x.get('content'),dict)):
            action={'action':'read','url':self.data['source_url']}
        else:action={'action':'search','query':'fixture durable queue evidence'}
        return {'content':json.dumps(action),'model':self.model_id,'usage':{}}

def providers(config):
    mode=config.get('mode','live')
    if mode=='fixture':
        f=Fixture(config['fixture_file']);return f,f.search,f.read,mode
    if mode!='live':raise ValueError('invalid configured provider mode')
    model=DeepSeek(config['model_base_url'],config['model_id'],config.get('api_key_env'))
    search=SearxSearch(config.get('search_url','http://127.0.0.1:8091/search'),tuple(config.get('engines',['duckduckgo','brave'])))
    return model,search.search,read_url,mode

def deterministic_providers(config):
    mode=config.get('mode','live')
    if mode=='fixture':
        f=Fixture(config['fixture_file']);return f.search,f.read,mode
    if mode!='live':raise ValueError('invalid configured provider mode')
    search=SearxSearch(config.get('search_url','http://127.0.0.1:8091/search'),tuple(config.get('engines',['duckduckgo','brave'])))
    return search.search,read_url,mode
