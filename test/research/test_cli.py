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

class RemoteDiagnosticTests(unittest.TestCase):
    def test_remote_application_error_is_preserved_without_executing_its_text(self):
        from unittest.mock import patch
        sys.path.insert(0,str(SCRIPTS))
        from research_cli import remote
        response=subprocess.CompletedProcess([],1,b'{"error":"limits.model_calls must allow at least four calls","type":"StateError"}',b'')
        with patch('research_cli.subprocess.run',return_value=response) as run:
            with self.assertRaisesRegex(RuntimeError,'limits.model_calls must allow at least four calls'):
                remote({'ssh_host':'fixture.invalid','python':'/fixture/python','script':'/fixture/cli.py','data_dir':'/fixture/state'},{'command':'status'})
            self.assertEqual(run.call_count,1)
    def test_remote_diagnostic_remains_bounded_and_falls_back_to_stderr(self):
        from unittest.mock import patch
        sys.path.insert(0,str(SCRIPTS))
        from research_cli import remote
        cfg={'ssh_host':'fixture.invalid','python':'/fixture/python','script':'/fixture/cli.py','data_dir':'/fixture/state'}
        for stdout,stderr,expected in [(b'{"error":'+json.dumps('x'*4000).encode()+b'}',b'', 'x'),(b'not JSON',b'connection refused','connection refused'),(b'{"error":["not a diagnostic"]}',b'bad packet','bad packet')]:
            with patch('research_cli.subprocess.run',return_value=subprocess.CompletedProcess([],1,stdout,stderr)):
                with self.assertRaises(RuntimeError) as caught:remote(cfg,{'command':'status'})
                self.assertIn(expected,str(caught.exception));self.assertLessEqual(len(str(caught.exception)),1525)

if __name__=='__main__':unittest.main()
