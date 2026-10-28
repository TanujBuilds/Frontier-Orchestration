import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS=Path(__file__).resolve().parents[2]/'.agents/skills/deep-research/scripts'

class CLITests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((SCRIPTS/'research_cli.py').exists(),'research CLI not implemented')
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
    def cli(self,*args,ok=True):
        p=subprocess.run([sys.executable,str(SCRIPTS/'research_cli.py'),'--data-dir',str(self.root/'state'),*args],capture_output=True,text=True,timeout=30)
        if ok:self.assertEqual(p.returncode,0,p.stderr)
        return json.loads(p.stdout) if ok else p
    def test_real_cli_submit_drain_collect_and_idempotent_repeat(self):
        fixture={'source_url':'https://www.sqlite.org/wal.html','text':'All processes must be on the same host computer.'}
        (self.root/'fixture.json').write_text(json.dumps(fixture))
        (self.root/'config.json').write_text(json.dumps({'mode':'fixture','fixture_file':str(self.root/'fixture.json')}))
        (self.root/'brief.txt').write_text('Compare durable queue approaches.')
        prepared=self.cli('prepare','--brief',str(self.root/'brief.txt'),'--submission-id','test','--mode','fixture','--output',str(self.root/'manifest.json'))
        job=self.cli('submit','--manifest',str(self.root/'manifest.json'),'--approve-hash',prepared['manifest_hash'])
        self.assertEqual(self.cli('submit','--manifest',str(self.root/'manifest.json'),'--approve-hash',prepared['manifest_hash'])['id'],job['id'])
        self.cli('worker','--config',str(self.root/'config.json'))
        self.assertEqual(self.cli('status','--job',job['id'])['status'],'completed')
        out=self.cli('collect','--job',job['id'],'--output',str(self.root/'collected'))
        report=Path(out['directory'])/'report.md'
        self.assertIn('FIXTURE',report.read_text())
        receipt=json.loads((report.parent/'receipt.json').read_text())
        for name,digest in receipt['artifacts'].items(): self.assertEqual(hashlib.sha256((report.parent/name).read_bytes()).hexdigest(),digest)
        before=report.read_bytes();self.cli('worker','--config',str(self.root/'config.json'))
        self.cli('collect','--job',job['id'],'--output',str(self.root/'collected'))
        self.assertEqual(before,report.read_bytes())
    def test_wrong_hash_never_queues_and_failure_is_json(self):
        path=self.root/'manifest.json';path.write_text(json.dumps({'submission_id':'bad','question':'Research something'}))
        p=self.cli('submit','--manifest',str(path),'--approve-hash','wrong',ok=False)
        self.assertNotEqual(p.returncode,0);self.assertIn('error',json.loads(p.stdout))
        self.assertEqual(self.cli('status'),[])

if __name__=='__main__':unittest.main()
