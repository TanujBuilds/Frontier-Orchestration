#!/usr/bin/env python3
"""Fixed JSON bridge used by the local harness; never executes model commands."""
import argparse
import json
import sys
from pathlib import Path
from research_cli import rpc, remote, collect, MAX_PACKET
from research_state import Store

def main():
    p=argparse.ArgumentParser();p.add_argument('--remote-config');p.add_argument('--data-dir');p.add_argument('--collect-output');args=p.parse_args()
    raw=sys.stdin.buffer.read(MAX_PACKET+1)
    if len(raw)>MAX_PACKET:raise ValueError('harness packet exceeds limit')
    request=json.loads(raw)
    if args.collect_output:result=collect(request,args.collect_output)
    elif args.remote_config:result=remote(json.loads(Path(args.remote_config).read_text()),request)
    elif args.data_dir:result=rpc(Store(args.data_dir),request)
    else:raise ValueError('private backend configuration required')
    sys.stdout.write(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'error':str(e)}));sys.exit(1)
