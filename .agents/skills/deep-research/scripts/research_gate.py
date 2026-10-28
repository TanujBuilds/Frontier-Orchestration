"""Reproducible two-pass search gate; semantic relevance requires human review."""
import argparse
import datetime
import json
from pathlib import Path
from urllib.parse import urlsplit
from research_search import SearxSearch

QUERIES=[{'id':str(i+1),'query':q,'expected_domains':[d]} for i,(q,d) in enumerate([
 ('SQLite WAL durable queue crash recovery','sqlite.org'),
 ('Redis Streams consumer groups pending messages','redis.io'),
 ('Python sqlite3 transaction control','docs.python.org'),
 ('PostgreSQL SKIP LOCKED job queue','postgresql.org'),
 ('Celery tasks late acknowledgement idempotency','docs.celeryq.dev'),
 ('RQ Python workers retries','python-rq.org'),
 ('Temporal durable workflow execution','temporal.io'),
 ('SearXNG JSON search API settings','docs.searxng.org'),
 ('vLLM OpenAI compatible server API','docs.vllm.ai'),
 ('Hugging Face Text Embeddings Inference deployment','huggingface.co')])]
READER_URLS=['https://www.sqlite.org/wal.html','https://docs.python.org/3/library/sqlite3.html',
 'https://www.postgresql.org/docs/current/sql-select.html','https://redis.io/docs/latest/develop/data-types/streams/',
 'https://docs.celeryq.dev/en/stable/userguide/tasks.html','https://python-rq.org/docs/workers/',
 'https://docs.temporal.io/workflow-execution','https://docs.searxng.org/dev/search_api.html',
 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
 'https://raw.githubusercontent.com/python/cpython/main/README.rst']

def capture_pass(search):
    return {'schema_version':1,'kind':'searxng_gate_pass',
      'captured_at':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),
      'live_gate_status':'pending','human_relevance':'not_reviewed',
      'queries':[{**q,'search':search.search(q['query'])} for q in QUERIES]}

def assess_pass(record):
    rows=record.get('queries',[])
    qualified=0
    valid=len(rows)==10 and {str(r.get('id')) for r in rows}=={q['id'] for q in QUERIES}
    for case in QUERIES:
        matches=[r for r in rows if r.get('id')==case['id']]
        if len(matches)!=1: continue
        row=matches[0]
        if row.get('query')!=case['query']: valid=False; continue
        results=row.get('search',{}).get('results',[])
        domains={urlsplit(x.get('url','')).hostname for x in results}
        primary=any(any((urlsplit(x.get('url','')).hostname or '')==d or (urlsplit(x.get('url','')).hostname or '').endswith('.'+d) for d in case['expected_domains']) for x in results[:5])
        if len(domains-{None})>=3 and primary: qualified+=1
    return {'qualified_queries':qualified,'structural_pass':valid and qualified>=8}

def compare_passes(first,second):
    passes=[assess_pass(x) for x in (first,second)]
    try:
        dates=[datetime.datetime.fromisoformat(x['captured_at'].replace('Z','+00:00')) for x in (first,second)]
        gap=(dates[1]-dates[0]).total_seconds()
    except (ValueError,KeyError,TypeError): gap=-1
    return {'structural_pass':gap>=1800 and all(p['structural_pass'] for p in passes),
        'passes':passes,'gap_seconds':gap,'reader_urls':READER_URLS,
        'live_gate_pass':False,'live_gate_status':'pending','human_relevance':'not_reviewed'}

def main():
    parser=argparse.ArgumentParser()
    sub=parser.add_subparsers(dest='command',required=True)
    a=sub.add_parser('capture'); a.add_argument('--output',required=True)
    a=sub.add_parser('compare'); a.add_argument('first'); a.add_argument('second')
    a=sub.add_parser('readers'); a.add_argument('--output',required=True)
    args=parser.parse_args()
    if args.command=='capture':
        result=capture_pass(SearxSearch()); Path(args.output).write_text(json.dumps(result,indent=2))
    elif args.command=='readers':
        from research_reader import read_url
        result={'pages':[read_url(u) for u in READER_URLS]}
        Path(args.output).write_text(json.dumps(result,indent=2))
    else: result=compare_passes(json.loads(Path(args.first).read_text()),json.loads(Path(args.second).read_text()))
    print(json.dumps(result,indent=2))

if __name__=='__main__': main()
