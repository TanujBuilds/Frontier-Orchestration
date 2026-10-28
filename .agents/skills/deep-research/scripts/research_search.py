"""Fixed-engine SearXNG client. Search snippets are discovery, not page evidence."""
import datetime
import http.client
import ipaddress
import json
import socket
import time
from urllib.parse import urlencode, urlsplit
from research_reader import _ResponseSocket, ReaderError


def public_url(url):
    if not isinstance(url,str): return False
    try:
        p = urlsplit(url)
        if (not isinstance(url,str) or any(ord(c)<=32 or ord(c)==127 for c in url)
                or p.scheme!='https' or not p.hostname or p.username is not None
                or p.password is not None or p.port not in (None,443) or '\\' in p.netloc):
            return False
        try:
            a=ipaddress.ip_address(p.hostname)
            if not a.is_global or a.is_reserved or a.is_multicast: return False
        except ValueError:
            if '.' not in p.hostname or p.hostname.endswith(('.local','.localhost','.internal','.lan')): return False
        return True
    except (ValueError,TypeError): return False


class SearxSearch:
    def __init__(self,base_url='http://127.0.0.1:8091/search',engines=('duckduckgo','brave'),min_interval=5,timeout=25):
        p=urlsplit(base_url)
        if p.scheme!='http' or p.hostname!='127.0.0.1' or p.path!='/search' or p.query or p.fragment or p.username is not None:
            raise ValueError('SearXNG must be a fixed 127.0.0.1 HTTP /search endpoint')
        if not engines or len(set(engines))!=len(engines) or set(engines)-{'duckduckgo','brave'}:
            raise ValueError('unapproved engines')
        if not 0<=min_interval<=60 or not 0<timeout<=25: raise ValueError('invalid transport bounds')
        self.port=p.port or 80
        self.engines=tuple(engines)
        self.interval,self.timeout,self.last=min_interval,timeout,0

    def search(self,query):
        if (not isinstance(query,str) or not 1<=len(query.strip())<=1000 or any(ord(c)<32 for c in query)
                or any(x.startswith(('!','?')) for x in query.split())):
            raise ValueError('invalid query or engine override syntax')
        time.sleep(max(0,self.interval-(time.monotonic()-self.last)))
        start=self.last=time.monotonic()
        result={'query':query,'fetched_at':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),
                'elapsed':0,'results':[],'unresponsive_engines':[],'status':'error','error':None}
        sock=None
        try:
            data=urlencode({'q':query,'format':'json','engines':','.join(self.engines),'categories':'general','language':'en','pageno':1}).encode()
            sock=socket.create_connection(('127.0.0.1',self.port),self.timeout)
            sock.sendall((f'POST /search HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n').encode()+data)
            response=http.client.HTTPResponse(_ResponseSocket(sock,start+self.timeout))
            response.begin()
            if response.status!=200:
                result['error']={'code':'http_error','http_status':response.status,'retry_after':response.getheader('Retry-After')}
                return result
            raw=response.read(2*1024*1024+1)
            try: obj=json.loads(raw)
            except (ValueError,UnicodeError):
                result['error']={'code':'invalid_json'}; return result
            if not isinstance(obj,dict) or not isinstance(obj.get('results'),list) or not isinstance(obj.get('unresponsive_engines',[]),list):
                result['error']={'code':'invalid_schema'}; return result
            result['unresponsive_engines']=obj.get('unresponsive_engines',[])[:30]
            for row in obj['results']:
                if not isinstance(row,dict) or not public_url(row.get('url')): continue
                result['results'].append({'url':row['url'][:8192], 'title':str(row.get('title',''))[:500],
                    'content':str(row.get('content',''))[:8000], 'engines':[x for x in row.get('engines',[]) if x in self.engines] if isinstance(row.get('engines',[]),list) else []})
                if len(result['results'])==20: break
            result['status']=('partial' if result['unresponsive_engines'] else 'ok') if result['results'] else 'empty'
            if not result['results']: result['error']={'code':'no_usable_results'}
        except ReaderError as e:
            result['error']={'code':'response_too_large' if e.code=='size_limit' else 'transport_error','message':str(e)}
        except (OSError,ValueError,http.client.HTTPException) as e:
            result['error']={'code':'transport_error','message':str(e)[:300]}
        finally:
            if sock: sock.close()
            result['elapsed']=time.monotonic()-start
        return result
