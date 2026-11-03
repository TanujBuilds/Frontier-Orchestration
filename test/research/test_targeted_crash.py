"""Parent SIGKILL probes exercise actual SQLite/filesystem process recovery."""
import json,subprocess,sys,unittest,select
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
import test_targeted_lifecycle as life
from research_state import Store

class TargetedCrashTests(unittest.TestCase):
 setUp=life.TargetedLifecycleTests.setUp
 initial=life.TargetedLifecycleTests.initial
 run_actions=life.TargetedLifecycleTests.run_actions
 repair=life.TargetedLifecycleTests.repair
 def kill_at(self,point):
  child=subprocess.Popen([sys.executable,'-B',str(Path(__file__).with_name('targeted_crash_driver.py')),self.tmp.name,point],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  self.addCleanup(lambda:child.kill() if child.poll() is None else None)
  ready=select.select([child.stdout],[],[],10)[0];self.assertTrue(ready,'child fault point timeout')
  line=child.stdout.readline().strip();self.assertEqual(line,'READY',line+(child.stderr.read() if child.poll() is not None else ''));child.kill();child.communicate(timeout=5);self.assertEqual(child.returncode,-9)
 def test_kills_around_reserve_result_assembly_and_staging_preserve_identity(self):
  for point in ['before_reservation','after_reservation','after_result','after_assembly','after_candidate_write','after_stage']:
   with self.subTest(point=point):
    self.setUp();self.initial();self.kill_at(point);self.store=Store(self.tmp.name);before=self.store.get(self.id);ops=self.store.operations(self.id);calls=self.run_actions([self.repair]);j=self.store.get(self.id)
    self.assertEqual(j['deadline'],self.deadline);self.assertEqual(j['id'],self.id)
    if point=='after_reservation':
     self.assertEqual(calls,[]);self.assertEqual(j['counters']['model'],2);self.assertEqual(self.store.execution_status(self.id)['execution']['status'],'uncertain');self.assertEqual(self.store.operations(self.id),ops)
    else:
     self.assertEqual(len(calls),1 if point=='before_reservation' else 0);self.assertEqual(j['status'],'awaiting_semantic_review',j.get('reason'));self.assertTrue(self.store.execution_status(self.id)['quiescent']);p=self.store.proposal_export(self.id);self.assertEqual(p['descriptor']['version'],2);self.assertEqual(j['counters']['model'],2)
 def test_kills_around_finalization_never_repeat_model_or_extend_deadline(self):
  for point in ['after_final_report','after_final_receipt','after_finish']:
   with self.subTest(point=point):
    self.setUp();self.initial();self.run_actions([self.repair]);d=self.store.proposal_export(self.id)['descriptor'];t=self.store.review_reserve(self.id,d['candidateHash'],d['rubricSha256'],'B');self.store.review_submit(self.id,t['id'],d['candidateHash'],d['rubricSha256'],'accept',[],d['units'],'accept-B');self.kill_at(point);self.store=Store(self.tmp.name);self.assertEqual(self.run_actions([]),[]);j=self.store.get(self.id);self.assertEqual(j['status'],'completed');self.assertEqual(j['deadline'],self.deadline);self.assertEqual(j['counters']['model'],2);self.assertTrue(self.store.execution_status(self.id)['quiescent']);receipt=json.loads((self.store.job_dir(self.id)/'receipt.json').read_text());self.assertEqual(receipt['quality']['accepted_candidate_hash'],d['candidateHash'])
 def test_review_snapshot_and_commit_kills_replay_one_genuine_revise(self):
  for point in ['after_review_write','after_review_submit']:
   with self.subTest(point=point):
    self.setUp();raw=json.loads(self.base['canonical']['report']);raw['claims']=[self.raw];self.run_actions([{'action':'finish','report':raw}]);d=self.store.proposal_export(self.id)['descriptor'];t=self.store.review_reserve(self.id,d['candidateHash'],d['rubricSha256'],'A');self.kill_at(point);self.store=Store(self.tmp.name)
    self.store.review_submit(self.id,t['id'],d['candidateHash'],d['rubricSha256'],'revise',self.sub['findings'],d['units'],'revise-A');j=self.store.get(self.id);self.assertEqual(j['checkpoint']['semantic']['revisions'],1);self.assertEqual(j['counters']['model'],1);self.assertEqual(j['deadline'],self.deadline);self.run_actions([self.repair]);self.assertEqual(self.store.get(self.id)['status'],'awaiting_semantic_review')
