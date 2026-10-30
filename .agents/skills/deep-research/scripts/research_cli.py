#!/usr/bin/env python3
"""Local or authenticated-SSH research control. No shell/model-generated commands."""
import argparse
import base64
import hashlib
import json
import re
import shlex
import subprocess
import sys
# Supported script entrypoints must not mutate the checksummed runtime on import.
sys.dont_write_bytecode = True
import time
from pathlib import Path
from research_state import Store, normalize_manifest, manifest_hash
from research_worker import Worker, atomic

MAX_PACKET=32*1024*1024
FILES=('report.md','claims.json','sources.json','manifest.json','receipt.json')

def brief_job(job):
    return {k:v for k,v in job.items() if k!='checkpoint'}

def export(store,job_id):
    job=store.get(job_id)
    if job['status'] not in ('completed','partial'):raise ValueError('collect requires a finalized report')
    directory=store.job_dir(job_id)
    raw={}
    for name in FILES:
        p=directory/name
        if p.is_symlink() or not p.is_file():raise ValueError('missing or unsafe artifact: '+name)
        raw[name]=p.read_bytes()
    receipt=json.loads(raw['receipt.json'])
    if receipt['status']!=job['status'] or receipt['manifest_hash']!=job['manifest_hash']:raise ValueError('receipt/state mismatch')
    for name,digest in receipt['artifacts'].items():
        if name not in raw or hashlib.sha256(raw[name]).hexdigest()!=digest:raise ValueError('artifact checksum mismatch')
    packet={'job':brief_job(job),'files':{n:base64.b64encode(b).decode() for n,b in raw.items()}}
    if len(json.dumps(packet))>MAX_PACKET:raise ValueError('collection packet exceeds limit')
    return packet

def collect(packet,output):
    job=packet['job'];job_id=job['id']
    import uuid
    if str(uuid.UUID(job_id))!=job_id:raise ValueError('invalid collected job ID')
    if set(packet['files'])!=set(FILES):raise ValueError('unexpected artifact inventory')
    raw={n:base64.b64decode(b,validate=True) for n,b in packet['files'].items()}
    receipt=json.loads(raw['receipt.json']);manifest=json.loads(raw['manifest.json'])
    if receipt['job_id']!=job_id or receipt['manifest_hash']!=manifest_hash(manifest) or receipt['manifest_hash']!=job['manifest_hash'] or receipt['mode']!=manifest['mode']:
        raise ValueError('collection approval identity mismatch')
    if set(receipt['artifacts'])!=set(FILES)-{'receipt.json'}:raise ValueError('incomplete checksum inventory')
    for name,digest in receipt['artifacts'].items():
        if hashlib.sha256(raw[name]).hexdigest()!=digest:raise ValueError('collection checksum mismatch')
    base=Path(output).expanduser().resolve();directory=base/job_id
    if directory.is_symlink():raise ValueError('collection destination may not be a symlink')
    directory.mkdir(parents=True,exist_ok=True)
    for name,data in raw.items():
        p=directory/name
        if p.is_symlink() or (p.exists() and p.read_bytes()!=data):raise ValueError('local collection conflict: '+name)
        atomic(p,data)
    atomic(directory/'collected.json',json.dumps({'job_id':job_id,'verified_artifacts':list(raw),'remote_sources_retained':True}))
    return {'job_id':job_id,'status':job['status'],'directory':str(directory),'checksums_verified':True}

def rpc(store,request,config=None):
    command=request['command']
    if command=='prepare_manifest':
        manifest=normalize_manifest(request['manifest']);return {'manifest':manifest,'hash':manifest_hash(manifest)}
    if command=='operator_action':
        if config is None:raise ValueError('operator research requires private deterministic provider configuration')
        from research_providers import deterministic_providers
        from research_operator import Operator
        search,reader,mode=deterministic_providers(config)
        return Operator(store,search,reader,mode).action(request['job'],request['action'],request['idempotency_key'])
    if command=='submit':return brief_job(store.submit(request['manifest'],request['approved_hash']))
    if command=='status':
        def status(j):return {**brief_job(j),**store.execution_status(j['id'])}
        return status(store.get(request['job'])) if request.get('job') else [status(j) for j in store.list_jobs()]
    if command=='yield':return {**brief_job(store.request_yield(request['job'])),**store.execution_status(request['job'])}
    if command=='answer':return brief_job(store.answer(request['job'],request['answer'],request['responder'],question_id=request.get('question_id')))
    if command=='questions':return [e['data'] for e in store.events(request['job']) if e['type']=='question']
    if command in ('stop','resume'):return brief_job(getattr(store,command)(request['job']))
    if command=='export':return export(store,request['job'])
    raise ValueError('unsupported RPC command')

def remote(config,request):
    host=config['ssh_host']
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@:-]{0,250}',host):raise ValueError('invalid SSH host')
    argv=[config['python'],'-B',config['script'],'--data-dir',config['data_dir']]
    if config.get('provider_config'):argv+=['--provider-config',config['provider_config']]
    argv+=['rpc']
    if any(not isinstance(x,str) or '\x00' in x for x in argv):raise ValueError('invalid remote configuration')
    result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,shlex.join(argv)],input=json.dumps(request).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
    if len(result.stdout)>MAX_PACKET:raise ValueError('remote packet exceeds limit')
    if result.returncode:
        detail=result.stderr.decode(errors='replace')
        try:
            failure=json.loads(result.stdout)
            if isinstance(failure,dict) and isinstance(failure.get('error'),str):detail=failure['error']
        except (ValueError,UnicodeError):pass
        raise RuntimeError('SSH operation failed: '+detail[-1500:])
    answer=json.loads(result.stdout)
    if isinstance(answer,dict) and 'error' in answer:raise RuntimeError(answer['error'])
    return answer

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--data-dir',default=str(Path.home()/'.local/share/deep-research'))
    parser.add_argument('--remote-config')
    parser.add_argument('--provider-config')
    sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('prepare');p.add_argument('--brief',required=True);p.add_argument('--submission-id',required=True);p.add_argument('--mode',choices=['live','fixture'],default='live');p.add_argument('--output',required=True);p.add_argument('--scope');p.add_argument('--limits')
    p=sub.add_parser('submit');p.add_argument('--manifest',required=True);p.add_argument('--approve-hash',required=True)
    p=sub.add_parser('status');p.add_argument('--job')
    for name in ('stop','resume'):
        p=sub.add_parser(name);p.add_argument('--job',required=True)
    p=sub.add_parser('collect');p.add_argument('--job',required=True);p.add_argument('--output',required=True)
    p=sub.add_parser('worker');p.add_argument('--config',required=True);p.add_argument('--watch',action='store_true')
    sub.add_parser('rpc')
    args=parser.parse_args()
    try:
        if args.command=='prepare':
            m={'question':Path(args.brief).read_text(),'submission_id':args.submission_id,'mode':args.mode}
            for key in ('scope','limits'):
                if getattr(args,key):m[key]=json.loads(Path(getattr(args,key)).read_text())
            m=normalize_manifest(m);atomic(args.output,json.dumps(m,indent=2))
            result={'manifest':m,'manifest_hash':manifest_hash(m),'file':str(Path(args.output).resolve())}
        elif args.command=='worker':
            if args.remote_config:raise ValueError('start the worker through the Spark service, not SSH forwarding')
            from research_providers import providers
            config=json.loads(Path(args.config).read_text());model,search,reader,mode=providers(config)
            def scout_busy():
                if mode=='fixture' or not config.get('defer_to_scout',True) or sys.platform!='linux':return False
                try:return subprocess.run(['systemctl','--user','is-active','--quiet','startup-scout.service'],timeout=3).returncode==0
                except (OSError,subprocess.TimeoutExpired):return True
            store=Store(args.data_dir)
            while True:
                Worker(store,model,search,reader,mode,scout_busy).drain()
                if not args.watch:break
                time.sleep(15)
            result={'status':'drained','mode':mode}
        elif args.command=='rpc':
            raw=sys.stdin.buffer.read(MAX_PACKET+1)
            if len(raw)>MAX_PACKET:raise ValueError('RPC request too large')
            config=json.loads(Path(args.provider_config).read_text()) if args.provider_config else None
            result=rpc(Store(args.data_dir),json.loads(raw),config)
        else:
            request={'command':'export' if args.command=='collect' else args.command}
            if getattr(args,'job',None):request['job']=args.job
            if args.command=='submit':request.update(manifest=json.loads(Path(args.manifest).read_text()),approved_hash=args.approve_hash)
            result=remote(json.loads(Path(args.remote_config).read_text()),request) if args.remote_config else rpc(Store(args.data_dir),request)
            if args.command=='collect':result=collect(result,args.output)
        print(json.dumps(result,ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error':str(e)[:2000],'type':type(e).__name__}));return 1
    return 0

if __name__=='__main__':sys.exit(main())
