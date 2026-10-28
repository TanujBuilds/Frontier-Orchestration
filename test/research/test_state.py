"""Offline state invariants: approvals, crash accounting, and exclusive work."""
import concurrent.futures
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest

SCRIPT_DIR = Path(__file__).resolve().parents[2] / '.agents/skills/deep-research/scripts'


def child_code(body):
    return "import sys; sys.path.insert(0, sys.argv[1]); from research_state import *; " + body


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        path = SCRIPT_DIR / 'research_state.py'
        if not path.exists():
            self.fail('research state module is not implemented')
        spec = importlib.util.spec_from_file_location('research_state', path)
        self.state = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.state)
        self.store = self.state.Store(self.root)

    def manifest(self, submission='one', **limits):
        raw = {'submission_id': submission, 'question': 'Which evidence supports this claim?'}
        if limits:
            raw['limits'] = limits
        return self.state.normalize_manifest(raw)

    def submit(self, submission='one', **limits):
        manifest = self.manifest(submission, **limits)
        return self.store.submit(manifest, self.state.manifest_hash(manifest))

    def run_child(self, body, *args):
        return subprocess.run([sys.executable, '-c', child_code(body), str(SCRIPT_DIR), *map(str, args)],
                              text=True, capture_output=True, timeout=20)

    def test_normalization_defaults_and_hash_ignore_json_key_order(self):
        normalized = self.manifest()
        self.assertEqual(normalized, {
            'schema': 1, 'mode': 'live', 'submission_id': 'one', 'question': 'Which evidence supports this claim?',
            'scope': {'seed_urls': [], 'include_domains': [], 'exclude_domains': []},
            'limits': {'seconds': 7200, 'searches': 30, 'downloads': 50, 'model_calls': 20}})
        reversed_manifest = dict(reversed(list(normalized.items())))
        self.assertEqual(self.state.manifest_hash(normalized), self.state.manifest_hash(reversed_manifest))
        self.assertEqual(len(self.state.manifest_hash(normalized)), 64)

    def test_fixture_approval_cannot_become_live_approval(self):
        raw = {'submission_id': 'fixture', 'question': 'A test', 'mode': 'fixture'}
        fixture = self.state.normalize_manifest(raw)
        live = self.state.normalize_manifest({**raw, 'mode': 'live'})
        self.assertNotEqual(self.state.manifest_hash(fixture), self.state.manifest_hash(live))
        with self.assertRaises(self.state.StateError):
            self.store.submit(live, self.state.manifest_hash(fixture))

    def test_invalid_manifest_rejects_ambiguous_or_unbounded_values(self):
        changes = [
            {'schema': 2}, {'submission_id': '../escape'}, {'submission_id': 'x' * 81},
            {'question': ''}, {'question': 'x' * 20001}, {'question': 9},
            {'limits': {'seconds': 0}}, {'limits': {'searches': True}},
            {'limits': {'model_calls': 3}}, {'scope': {'seed_urls': 'https://example.org'}},
            {'scope': {'include_domains': [1]}}, {'unapproved_setting': 'ignored?'}]
        for change in changes:
            with self.subTest(change=change):
                raw = {'submission_id': 'one', 'question': 'question'}
                raw.update(change)
                with self.assertRaises(self.state.StateError):
                    self.state.normalize_manifest(raw)

    def test_approval_binds_exact_manifest_and_duplicate_submission_is_idempotent(self):
        manifest = self.manifest(searches=2)
        approved = self.state.manifest_hash(manifest)
        with self.assertRaises(self.state.StateError):
            self.store.submit(manifest, '0' * 64)
        first = self.store.submit(manifest, approved)
        second = self.store.submit(json.loads(json.dumps(manifest)), approved)
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(len(self.store.list_jobs()), 1)
        manifest['limits']['searches'] = 3
        with self.assertRaises(self.state.StateError):
            self.store.submit(manifest, approved)
        with self.assertRaises(self.state.StateError):
            self.store.submit(manifest, self.state.manifest_hash(manifest))
        self.assertEqual(self.store.get(first['id'])['manifest']['limits']['searches'], 2)
        self.assertEqual(len(self.store.events(first['id'])), 1)

    def test_claim_resumes_running_before_fifo_queue_without_reset(self):
        first = self.submit('first')
        second = self.submit('second')
        running = self.store.claim_next(now=1000)
        self.assertEqual(running['id'], first['id'])
        self.assertEqual(running['deadline'], 8200)
        self.store.reserve(first['id'], 'search', {'query': 'first'}, now=1001)
        self.store.checkpoint(first['id'], {'phase': 'reading', 'cursor': 2})
        rebuilt = self.state.Store(self.root)
        resumed = rebuilt.claim_next(now=1100)
        self.assertEqual(resumed['id'], first['id'])
        self.assertEqual(resumed['started_at'], 1000)
        self.assertEqual(resumed['deadline'], 8200)
        self.assertEqual(resumed['counters']['search'], 1)
        self.assertEqual(resumed['checkpoint'], {'phase': 'reading', 'cursor': 2})
        rebuilt.finish(first['id'], 'completed')
        self.assertEqual(rebuilt.claim_next(now=1200)['id'], second['id'])

    def test_reservation_is_spent_after_abrupt_process_exit_and_cached_by_id(self):
        job = self.submit(searches=1)
        self.store.claim_next(now=1000)
        code = "import os; s=Store(sys.argv[2]); s.reserve(sys.argv[3], 'search', {'query':'q'}, op_id='spent', now=1001); os._exit(23)"
        child = self.run_child(code, self.root, job['id'])
        self.assertEqual(child.returncode, 23, child.stderr)
        rebuilt = self.state.Store(self.root)
        self.assertEqual(rebuilt.get(job['id'])['counters']['search'], 1)
        pending = rebuilt.reserve(job['id'], 'search', {'query': 'q'}, op_id='spent', now=1002)
        self.assertEqual(pending['status'], 'pending')
        with self.assertRaises(self.state.BudgetExceeded):
            rebuilt.reserve(job['id'], 'search', {'query': 'another'}, now=1002)
        rebuilt.complete_operation('spent', {'hits': ['https://example.org']})
        cached = rebuilt.reserve(job['id'], 'search', {'query': 'q'}, op_id='spent', now=99999)
        self.assertEqual(cached['status'], 'completed')
        self.assertEqual(cached['result'], {'hits': ['https://example.org']})
        self.assertEqual(len(rebuilt.operations(job['id'])), 1)

    def test_operation_identity_cannot_be_reused_for_other_payload_or_job(self):
        first = self.submit('one')
        second = self.submit('two')
        self.store.claim_next(now=1000)
        self.store.reserve(first['id'], 'model', {'prompt': 'one'}, op_id='identity', now=1001)
        for job_id, kind, payload in [
            (first['id'], 'model', {'prompt': 'other'}),
            (first['id'], 'search', {'prompt': 'one'}),
            (second['id'], 'model', {'prompt': 'one'})]:
            with self.subTest(job=job_id, kind=kind, payload=payload):
                with self.assertRaises(self.state.StateError):
                    self.store.reserve(job_id, kind, payload, op_id='identity', now=1002)
        self.assertEqual(self.store.get(first['id'])['counters']['model'], 1)

    def test_terminal_operation_results_are_immutable_and_failures_stay_spent(self):
        job = self.submit(downloads=1)
        self.store.claim_next(now=1000)
        self.store.reserve(job['id'], 'download', {'url': 'https://example.org'}, op_id='download', now=1001)
        self.store.fail_operation('download', 'connection lost after request')
        self.store.fail_operation('download', 'connection lost after request')
        with self.assertRaises(self.state.StateError):
            self.store.complete_operation('download', {'text': 'late overwrite'})
        with self.assertRaises(self.state.StateError):
            self.store.fail_operation('download', 'different failure')
        saved = self.store.operations(job['id'])[0]
        self.assertEqual(saved['status'], 'failed')
        self.assertEqual(saved['error'], 'connection lost after request')
        self.assertEqual(self.store.get(job['id'])['counters']['download'], 1)

    def test_stop_wins_over_finish_and_resume_preserves_original_budget(self):
        job = self.submit(searches=2)
        self.store.claim_next(now=1000)
        self.store.reserve(job['id'], 'search', {'query': 'q'}, now=1001)
        self.store.stop(job['id'])
        self.store.finish(job['id'], 'completed')
        self.assertEqual(self.store.get(job['id'])['status'], 'stopped')
        with self.assertRaises(self.state.StateError):
            self.store.reserve(job['id'], 'search', {}, now=1002)
        self.store.resume(job['id'], now=1003)
        resumed = self.store.claim_next(now=1004)
        self.assertEqual(resumed['deadline'], 8200)
        self.assertEqual(resumed['counters']['search'], 1)
        self.store.reserve(job['id'], 'search', {'query': 'q2'}, now=1005)
        self.store.stop(job['id'])
        self.store.resume(job['id'], now=1006)
        self.store.claim_next(now=1006)
        with self.assertRaises(self.state.BudgetExceeded):
            self.store.reserve(job['id'], 'search', {'query':'no refunded budget'}, now=1007)
        self.assertEqual(self.store.get(job['id'])['counters']['search'], 2)

    def test_queued_stop_can_resume_but_terminal_results_cannot(self):
        queued = self.submit()
        self.store.stop(queued['id'])
        self.assertIsNone(self.store.claim_next(now=1000))
        self.store.resume(queued['id'], now=1001)
        self.assertEqual(self.store.claim_next(now=1002)['started_at'], 1002)
        for status in ('completed', 'partial'):
            self.store.finish(queued['id'], status)
            with self.assertRaises(self.state.StateError):
                self.store.resume(queued['id'], now=1003)

    def test_deadline_blocks_reservations_and_resume_without_reset(self):
        job = self.submit(seconds=10)
        self.store.claim_next(now=1000)
        with self.assertRaises(self.state.BudgetExceeded):
            self.store.reserve(job['id'], 'model', {}, now=1010)
        self.assertEqual(self.store.get(job['id'])['counters']['model'], 0)
        self.store.stop(job['id'])
        with self.assertRaises(self.state.BudgetExceeded):
            self.store.resume(job['id'], now=1011)
        self.assertEqual(self.store.get(job['id'])['deadline'], 1010)

    def test_claim_rejects_tampered_approved_manifest(self):
        job = self.submit()
        # On-disk changes must fail closed before any external dispatch.
        db_path = next(self.root.glob('*.sqlite*'))
        with sqlite3.connect(db_path) as db:
            columns = [row[1] for row in db.execute('PRAGMA table_info(jobs)')]
            manifest_column = 'manifest_json' if 'manifest_json' in columns else 'manifest'
            changed = dict(job['manifest'], question='changed after approval')
            db.execute(f'UPDATE jobs SET {manifest_column}=? WHERE id=?', (json.dumps(changed), job['id']))
        with self.assertRaises(self.state.StateError):
            self.store.claim_next(now=1000)

    def test_worker_lock_rejects_contender_and_recovers_after_owner_dies(self):
        code = "s=Store(sys.argv[2]); lock=s.worker_lock(); lock.__enter__(); print('locked', flush=True); sys.stdin.read()"
        owner = subprocess.Popen([sys.executable, '-c', child_code(code), str(SCRIPT_DIR), str(self.root)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: owner.poll() is None and owner.kill())
        self.assertEqual(owner.stdout.readline().strip(), 'locked')
        with self.assertRaises(self.state.WorkerBusy):
            with self.store.worker_lock():
                pass
        owner.terminate()
        owner.communicate(timeout=10)
        with self.store.worker_lock():
            with self.assertRaises(self.state.WorkerBusy):
                with self.state.Store(self.root).worker_lock():
                    pass
        with self.state.Store(self.root).worker_lock():
            pass

    def test_simultaneous_submissions_create_only_one_job(self):
        manifest = self.manifest()
        approved = self.state.manifest_hash(manifest)
        barrier = threading.Barrier(8)
        def submit_once(_):
            store = self.state.Store(self.root)
            barrier.wait(timeout=10)
            return store.submit(manifest, approved)['id']
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            identifiers = list(pool.map(submit_once, range(8)))
        self.assertEqual(len(set(identifiers)), 1)
        self.assertEqual(len(self.store.list_jobs()), 1)

    def test_concurrent_reservations_cannot_overspend_counter(self):
        job = self.submit(searches=1)
        self.store.claim_next(now=1000)
        barrier = threading.Barrier(8)
        def reserve_once(index):
            store = self.state.Store(self.root)
            barrier.wait(timeout=10)
            try:
                store.reserve(job['id'], 'search', {'query': str(index)}, now=1001)
                return 'reserved'
            except self.state.BudgetExceeded:
                return 'capped'
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(reserve_once, range(8)))
        self.assertEqual(results.count('reserved'), 1)
        self.assertEqual(results.count('capped'), 7)
        self.assertEqual(self.store.get(job['id'])['counters']['search'], 1)
        self.assertEqual(len(self.store.operations(job['id'])), 1)

    def test_paths_stay_inside_root_and_events_capture_durable_transitions(self):
        job = self.submit()
        self.assertTrue(self.store.job_dir(job['id']).is_relative_to(self.root))
        with self.assertRaises(self.state.StateError):
            self.store.job_dir('../outside')
        self.store.claim_next(now=1000)
        self.store.checkpoint(job['id'], {'phase': 'research'})
        self.store.finish(job['id'], 'blocked', reason='provider unavailable')
        self.assertEqual(self.state.Store(self.root).get(job['id'])['reason'], 'provider unavailable')
        self.assertEqual([event['type'] for event in self.store.events(job['id'])],
                         ['submitted', 'started', 'checkpoint', 'finished'])


if __name__ == '__main__':
    unittest.main()
