"""Durable offline coordination for bounded research jobs.

Only the worker performs external calls. It must reserve each operation before
calling a provider, and treat an existing pending operation as spent and
ambiguous rather than dispatching it again.
"""
from research_review import normalize_review_policy
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid


class StateError(RuntimeError):
    """The requested state transition or approved manifest is invalid."""


class BudgetExceeded(StateError):
    """An original deadline or operation limit has been reached."""


class WorkerBusy(StateError):
    """Another process already holds the worker lock."""


DEFAULT_LIMITS = {'seconds': 7200, 'searches': 30, 'downloads': 50, 'model_calls': 20}
COUNTER_LIMITS = {'search': 'searches', 'download': 'downloads', 'model': 'model_calls'}
RESEARCH_POLICY = {'version': 1, 'finish': 'selectors_only', 'discovery': 'search_required'}


def strict_policy(manifest):
    return 'research_policy' in manifest



def _json(value):
    try:
        return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise StateError('value must be JSON serializable') from error


def _keys(value, allowed, label):
    if not isinstance(value, dict) or set(value) - set(allowed):
        raise StateError(f'{label} must be an object containing only {", ".join(allowed)}')


def normalize_manifest(raw):
    """Validate a manifest and materialize defaults before approval hashing."""
    _keys(raw, ('schema', 'mode', 'submission_id', 'question', 'scope', 'limits', 'not_after', 'collaboration', 'executor', 'research_policy'), 'manifest')
    mode = raw.get('mode', 'live')
    if mode not in ('live', 'fixture'):
        raise StateError('mode must be live or fixture')
    schema = raw.get('schema', 1)
    if type(schema) is not int or schema not in (1, 2):
        raise StateError('manifest schema must be 1 or 2')
    extension = {}
    if schema == 1 and ('not_after' in raw or 'collaboration' in raw or 'executor' in raw):
        raise StateError('harness fields require manifest schema 2')
    if schema == 2:
        deadline = raw.get('not_after')
        if type(deadline) not in (int, float) or not math.isfinite(deadline) or deadline <= 0:
            raise StateError('schema 2 requires an absolute not_after deadline')
        policy = raw.get('collaboration')
        _keys(policy, ('supervisor', 'max_questions'), 'collaboration')
        if policy.get('supervisor') not in ('codex', 'user', 'none') or type(policy.get('max_questions')) is not int or not 0 <= policy['max_questions'] <= 3:
            raise StateError('invalid collaboration policy')
        extension = {'not_after': deadline, 'collaboration': policy}
        if 'executor' in raw:
            if raw['executor'] not in ('deepseek','operator'):raise StateError('invalid research executor')
            extension['executor']=raw['executor']
    if 'research_policy' in raw:
        policy = raw['research_policy']
        if isinstance(policy,dict) and policy.get('version') == 3:
            try: policy=normalize_review_policy(policy)
            except ValueError as error: raise StateError(str(error)) from error
            if schema != 2 or extension.get('collaboration',{}).get('supervisor') != 'codex':
                raise StateError('reviewed research requires explicit Codex collaboration')
        else:
            _keys(policy, tuple(RESEARCH_POLICY), 'research_policy')
            if (type(policy.get('version')) is not int or policy.get('version') not in (1,2)
                    or policy != {**RESEARCH_POLICY,'version':policy['version']}):
                raise StateError('unsupported research_policy; require closed version1 or version2 selector-only/search-required contract')
        if extension.get('executor') == 'operator':
            raise StateError('operator research cannot select autonomous research_policy')
        extension['research_policy'] = dict(policy)
    submission = raw.get('submission_id')
    if not isinstance(submission, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', submission):
        raise StateError('submission_id must contain 1 to 80 letters, numbers, underscores, or hyphens')
    question = raw.get('question')
    if not isinstance(question, str) or not question.strip() or len(question) > 20000:
        raise StateError('question must contain 1 to 20000 characters')
    scope = raw.get('scope', {})
    _keys(scope, ('seed_urls', 'include_domains', 'exclude_domains'), 'scope')
    normalized_scope = {}
    for name in ('seed_urls', 'include_domains', 'exclude_domains'):
        values = scope.get(name, [])
        if not isinstance(values, list) or any(not isinstance(value, str) or not value.strip() for value in values):
            raise StateError(f'scope.{name} must be a list of nonempty strings')
        normalized_scope[name] = list(values)
    limits = raw.get('limits', {})
    _keys(limits, tuple(DEFAULT_LIMITS), 'limits')
    normalized_limits = dict(DEFAULT_LIMITS, **limits)
    for name, value in normalized_limits.items():
        if type(value) is not int or value <= 0:
            raise StateError(f'limits.{name} must be a positive integer')
    if extension.get('research_policy',{}).get('version')==3 and normalized_limits['model_calls']>20:
        raise StateError('reviewed research cannot exceed twenty model calls')
    # Autonomous research reserves draft/audit/repair calls; operator jobs never
    # dispatch a model and retain the exact positive limit approved by the host.
    if extension.get('executor','deepseek') != 'operator' and normalized_limits['model_calls'] < 4:
        raise StateError('limits.model_calls must allow at least four calls')
    return {'schema': schema, 'mode': mode, 'submission_id': submission, 'question': question,
            'scope': normalized_scope, 'limits': normalized_limits, **extension}


def manifest_hash(normalized):
    """Bind approval to the complete normalized manifest, including overrides."""
    return hashlib.sha256(_json(normalize_manifest(normalized)).encode('utf-8')).hexdigest()


class Store:
    """SQLite state with one durable transaction per externally visible change."""

    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db_path = self.root / 'research.sqlite3'
        with self._db() as db:
            db.execute('PRAGMA journal_mode=WAL')
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise StateError('unsupported research state database version')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    submission_id TEXT NOT NULL UNIQUE,
                    manifest_json TEXT NOT NULL,
                    manifest_hash TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    started_at REAL,
                    deadline REAL,
                    counters_json TEXT NOT NULL,
                    checkpoint_json TEXT NOT NULL,
                    reason TEXT
                );
                CREATE TABLE IF NOT EXISTS operations (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    id TEXT NOT NULL UNIQUE,
                    job_id TEXT NOT NULL REFERENCES jobs(id),
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    result_json TEXT,
                    error_json TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL REFERENCES jobs(id),
                    type TEXT NOT NULL,
                    time REAL NOT NULL,
                    data_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS executions (
                    job_id TEXT PRIMARY KEY REFERENCES jobs(id), token TEXT NOT NULL,
                    pid INTEGER NOT NULL, status TEXT NOT NULL, updated_at REAL NOT NULL
                );
                PRAGMA user_version=1;
            ''')

    @contextmanager
    def _db(self, transaction=False):
        db = sqlite3.connect(str(self.db_path), timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('PRAGMA synchronous=FULL')
            if transaction:
                db.execute('BEGIN IMMEDIATE')
            yield db
            if transaction:
                db.commit()
        except BaseException:
            if transaction:
                db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _event(db, job_id, kind, data=None, now=None):
        db.execute('INSERT INTO events(job_id,type,time,data_json) VALUES(?,?,?,?)',
                   (job_id, kind, time.time() if now is None else now, _json(data or {})))

    @staticmethod
    def _decode_job(row):
        if row is None:
            raise StateError('research job does not exist')
        job = dict(row)
        job['manifest'] = json.loads(job.pop('manifest_json'))
        job['counters'] = json.loads(job.pop('counters_json'))
        job['checkpoint'] = json.loads(job.pop('checkpoint_json'))
        if manifest_hash(job['manifest']) != job['manifest_hash']:
            raise StateError('saved manifest does not match its approved hash')
        return job

    def _get(self, db, job_id):
        return self._decode_job(db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone())

    @staticmethod
    def _decode_operation(row):
        if row is None:
            raise StateError('research operation does not exist')
        operation = dict(row)
        operation.pop('sequence', None)
        operation['op_id'] = operation['id']
        for name in ('payload', 'result', 'error'):
            encoded = operation.pop(f'{name}_json')
            operation[name] = json.loads(encoded) if encoded is not None else None
        return operation

    def submit(self, manifest, approved_hash):
        manifest = normalize_manifest(manifest)
        digest = manifest_hash(manifest)
        if not isinstance(approved_hash, str) or approved_hash != digest:
            raise StateError('approval must match the exact normalized manifest hash')
        with self._db(transaction=True) as db:
            existing = db.execute('SELECT * FROM jobs WHERE submission_id=?', (manifest['submission_id'],)).fetchone()
            if existing is not None:
                job = self._decode_job(existing)
                if job['manifest_hash'] != digest:
                    raise StateError('submission_id already belongs to a different approved manifest')
                return job
            identifier, now = str(uuid.uuid4()), time.time()
            db.execute('''INSERT INTO jobs(id,submission_id,manifest_json,manifest_hash,status,created_at,
                          updated_at,counters_json,checkpoint_json) VALUES(?,?,?,?,?,?,?,?,?)''',
                       (identifier, manifest['submission_id'], _json(manifest), digest, 'queued', now, now,
                        _json({'search': 0, 'download': 0, 'model': 0}), '{}'))
            self._event(db, identifier, 'submitted', {'manifest_hash': digest}, now)
            return self._get(db, identifier)

    def get(self, job_id):
        with self._db() as db:
            return self._get(db, job_id)

    def list_jobs(self):
        with self._db() as db:
            return [self._decode_job(row) for row in db.execute('SELECT * FROM jobs ORDER BY created_at,rowid')]

    def job_dir(self, job_id):
        try:
            if str(uuid.UUID(job_id)) != job_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError) as error:
            raise StateError('invalid job ID') from error
        self.get(job_id)
        destination = (self.root / 'jobs' / job_id).resolve()
        if not destination.is_relative_to(self.root):
            raise StateError('job directory must remain inside the state root')
        destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        return destination

    @contextmanager
    def worker_lock(self):
        # Never unlink this inode: contenders must all lock the same file.
        lock = (self.root / 'worker.lock').open('a+')
        acquired = False
        try:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except BlockingIOError as error:
                raise WorkerBusy('another research worker holds the state lock') from error
            yield
        finally:
            if acquired:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
            lock.close()

    def claim_next(self, now=None):
        now = time.time() if now is None else now
        with self._db(transaction=True) as db:
            row = db.execute('''SELECT * FROM jobs WHERE status IN ('running','queued')
                                AND COALESCE(json_extract(manifest_json,'$.executor'),'deepseek')='deepseek'
                                ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,created_at,rowid LIMIT 1''').fetchone()
            if row is None:
                return None
            job = self._decode_job(row)
            if job['status'] == 'queued':
                started = job['started_at'] if job['started_at'] is not None else now
                deadline = job['deadline'] if job['deadline'] is not None else started + job['manifest']['limits']['seconds']
                deadline = min(deadline, job['manifest'].get('not_after', deadline))
                db.execute("UPDATE jobs SET status='running',started_at=?,deadline=?,updated_at=? WHERE id=?",
                           (started, deadline, now, job['id']))
                self._event(db, job['id'], 'started' if job['started_at'] is None else 'claimed', {}, now)
            return self._get(db, job['id'])

    def reserve(self, job_id, kind, payload, op_id=None, now=None):
        if kind not in COUNTER_LIMITS:
            raise StateError('operation kind must be search, download, or model')
        if op_id is None:
            op_id = str(uuid.uuid4())
        if not isinstance(op_id, str) or not op_id or len(op_id) > 200:
            raise StateError('operation ID must be a nonempty string of at most 200 characters')
        encoded = _json(payload)
        now = time.time() if now is None else now
        with self._db(transaction=True) as db:
            job = self._get(db, job_id)
            if kind=='model' and job['manifest'].get('executor')=='operator':
                raise StateError('operator research prohibits model requests')
            row = db.execute('SELECT * FROM operations WHERE id=?', (op_id,)).fetchone()
            if row is not None:
                if row['job_id'] != job_id or row['kind'] != kind or row['payload_json'] != encoded:
                    raise StateError('operation ID already belongs to a different request')
                return self._decode_operation(row)
            if job['status'] != 'running':
                raise StateError('new operations require a running job')
            if job['deadline'] is None or now >= job['deadline']:
                raise BudgetExceeded('research deadline has been reached')
            if job['counters'][kind] >= job['manifest']['limits'][COUNTER_LIMITS[kind]]:
                raise BudgetExceeded(f'{kind} request budget has been reached')
            counters = dict(job['counters'])
            counters[kind] += 1
            db.execute('UPDATE jobs SET counters_json=?,updated_at=? WHERE id=?', (_json(counters), now, job_id))
            db.execute('''INSERT INTO operations(id,job_id,kind,status,payload_json,created_at,updated_at)
                          VALUES(?,?,?,'pending',?,?,?)''', (op_id, job_id, kind, encoded, now, now))
            self._event(db, job_id, 'reserved', {'op_id': op_id, 'kind': kind}, now)
            return self._decode_operation(db.execute('SELECT * FROM operations WHERE id=?', (op_id,)).fetchone())

    def _finish_operation(self, op_id, status, value):
        encoded, now = _json(value), time.time()
        column = 'result_json' if status == 'completed' else 'error_json'
        with self._db(transaction=True) as db:
            row = db.execute('SELECT * FROM operations WHERE id=?', (op_id,)).fetchone()
            if row is None:
                raise StateError('research operation does not exist')
            if row['status'] != 'pending':
                if row['status'] == status and row[column] == encoded:
                    return self._decode_operation(row)
                raise StateError('saved terminal operation outcomes are immutable')
            db.execute(f'UPDATE operations SET status=?,{column}=?,updated_at=? WHERE id=?',
                       (status, encoded, now, op_id))
            self._event(db, row['job_id'], f'operation_{status}', {'op_id': op_id}, now)
            return self._decode_operation(db.execute('SELECT * FROM operations WHERE id=?', (op_id,)).fetchone())

    def complete_operation(self, op_id, result):
        return self._finish_operation(op_id, 'completed', result)

    def fail_operation(self, op_id, error):
        return self._finish_operation(op_id, 'failed', error)

    def operations(self, job_id):
        with self._db() as db:
            self._get(db, job_id)
            return [self._decode_operation(row) for row in db.execute(
                'SELECT * FROM operations WHERE job_id=? ORDER BY sequence', (job_id,))]

    def _discovery_status(self, db, job):
        """Derive discovery from reserved operations, never checkpoint/model flags.

        Empty successful search satisfies performing discovery, not useful coverage.
        Upstream blocked/partial engines, malformed results and ambiguous requests
        remain spent and unproven. Queries are retained for independent assessment.
        """
        requested = strict_policy(job['manifest'])
        records = []
        for row in db.execute("SELECT * FROM operations WHERE job_id=? AND kind='search' ORDER BY sequence", (job['id'],)):
            op = self._decode_operation(row)
            payload, result = op['payload'], op['result']
            query = payload.get('query') if isinstance(payload, dict) else None
            valid_query = (isinstance(query, str) and 1 <= len(query.strip()) <= 1000
                           and not any(ord(c) < 32 for c in query)
                           and not any(x.startswith(('!', '?')) for x in query.split()))
            within_deadline = (job['started_at'] is not None and job['deadline'] is not None
                               and job['started_at'] <= op['created_at'] < job['deadline']
                               and op['updated_at'] <= job['deadline'])
            success = False
            if op['status'] == 'completed' and valid_query and within_deadline and isinstance(result, dict):
                error = result.get('error')
                empty = (result.get('status') == 'empty' and result.get('results') == []
                         and isinstance(error, dict) and error.get('code') == 'no_usable_results')
                success = (isinstance(result.get('results'), list)
                           and result.get('status') in (None, 'ok', 'empty')
                           and (not error or empty) and not result.get('unresponsive_engines')
                           and result.get('query', query) == query)
            records.append({'id': op['id'], 'status': op['status'], 'query': query,
                            'satisfied': success, 'error': op['error'] if op['status'] == 'failed' else
                            result.get('error') if isinstance(result, dict) else None})
        satisfied = any(r['satisfied'] for r in records)
        failed = sum(r['status'] != 'pending' and not r['satisfied'] for r in records)
        status = ('not_requested' if not requested else 'satisfied' if satisfied else
                  'attempted' if any(r['status'] == 'pending' for r in records) else
                  'failed' if failed else 'requested')
        return {'requested': requested, 'state': status, 'attempted': len(records),
                'satisfied': satisfied, 'failed': failed, 'operations': records}

    def discovery_status(self, job_id):
        with self._db() as db:
            return self._discovery_status(db, self._get(db, job_id))

    def checkpoint(self, job_id, state):
        if not isinstance(state, dict):
            raise StateError('checkpoint must be an object')
        encoded, now = _json(state), time.time()
        with self._db(transaction=True) as db:
            self._get(db, job_id)
            db.execute('UPDATE jobs SET checkpoint_json=?,updated_at=? WHERE id=?', (encoded, now, job_id))
            self._event(db, job_id, 'checkpoint', {}, now)
            return self._get(db, job_id)

    def finish(self, job_id, status, reason=None):
        if status not in ('completed', 'partial', 'blocked', 'failed'):
            raise StateError('finish requires completed, partial, blocked, or failed status')
        if reason is not None and not isinstance(reason, str):
            raise StateError('finish reason must be a string')
        now = time.time()
        with self._db(transaction=True) as db:
            job = self._get(db, job_id)
            if job['status'] in ('stopped', 'completed', 'partial'):
                return job
            if status == 'completed' and strict_policy(job['manifest']) and not self._discovery_status(db, job)['satisfied']:
                raise StateError('required discovery search is not satisfied by durable operation evidence')
            db.execute('UPDATE jobs SET status=?,reason=?,updated_at=? WHERE id=?', (status, reason, now, job_id))
            self._event(db, job_id, 'finished', {'status': status, 'reason': reason}, now)
            return self._get(db, job_id)

    def stop(self, job_id):
        now = time.time()
        with self._db(transaction=True) as db:
            job = self._get(db, job_id)
            if job['status'] in ('stopped', 'completed', 'partial'):
                return job
            db.execute("UPDATE jobs SET status='stopped',updated_at=? WHERE id=?", (now, job_id))
            self._event(db, job_id, 'stopped', {}, now)
            return self._get(db, job_id)

    def resume(self, job_id, now=None):
        now = time.time() if now is None else now
        with self._db(transaction=True) as db:
            job = self._get(db, job_id)
            if job['status'] not in ('stopped', 'blocked', 'failed', 'suspended'):
                raise StateError('only stopped, blocked, or failed jobs can resume')
            if job['deadline'] is not None and now >= job['deadline']:
                raise BudgetExceeded('the original research deadline has been reached')
            # Resume may only need cached-result replay or local finalization.
            # Every new external request still passes the per-kind reserve cap.
            db.execute("UPDATE jobs SET status='queued',reason=NULL,updated_at=? WHERE id=?", (now, job_id))
            self._event(db, job_id, 'resumed', {}, now)
            return self._get(db, job_id)

    def execution_start(self, job_id, token):
        with self._db(transaction=True) as db:
            job = self._get(db, job_id)
            previous = db.execute('SELECT * FROM executions WHERE job_id=?', (job_id,)).fetchone()
            pending = db.execute("SELECT 1 FROM operations WHERE job_id=? AND kind='model' AND status='pending'", (job_id,)).fetchone()
            if job['manifest']['schema'] == 2 and previous and (previous['status'] == 'uncertain' or (previous['status'] == 'active' and pending)):
                db.execute("UPDATE executions SET status='uncertain',updated_at=? WHERE job_id=?", (time.time(),job_id))
                raise StateError('Ambiguous remote inference requires operator reconciliation')
            db.execute('INSERT INTO executions VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET token=excluded.token,pid=excluded.pid,status=excluded.status,updated_at=excluded.updated_at',
                       (job_id,token,os.getpid(),'active',time.time()))

    def execution_end(self, job_id, token):
        with self._db(transaction=True) as db:
            db.execute("UPDATE executions SET status='quiescent',updated_at=? WHERE job_id=? AND token=? AND status='active'", (time.time(),job_id,token))

    def execution_uncertain(self, job_id):
        with self._db(transaction=True) as db:
            db.execute("UPDATE executions SET status='uncertain',updated_at=? WHERE job_id=?", (time.time(),job_id))

    def execution_status(self, job_id):
        with self._db() as db:
            job = self._get(db, job_id)
            row = db.execute('SELECT * FROM executions WHERE job_id=?', (job_id,)).fetchone()
            return {'quiescent': row['status']=='quiescent' if row else job['status']!='running',
                    'execution': dict(row) if row else None}

    def request_yield(self, job_id):
        with self._db(transaction=True) as db:
            job=self._get(db,job_id)
            if job['status']=='queued':
                db.execute("UPDATE jobs SET status='suspended' WHERE id=?",(job_id,))
            elif job['status']=='running':
                db.execute("UPDATE jobs SET reason='yield_requested' WHERE id=?",(job_id,))
            self._event(db,job_id,'yield_requested')
            return self._get(db,job_id)

    def yield_boundary(self, job_id):
        with self._db(transaction=True) as db:
            job=self._get(db,job_id)
            if job['status']=='running' and job['reason']=='yield_requested':
                db.execute("UPDATE jobs SET status='suspended',reason=NULL,updated_at=? WHERE id=?",(time.time(),job_id))
                self._event(db,job_id,'yielded')
                return True
            return False

    def ask(self, job_id, question):
        if not isinstance(question,str) or not 1 <= len(question.strip()) <= 8000:
            raise StateError('invalid supervisor question')
        with self._db(transaction=True) as db:
            job=self._get(db,job_id);policy=job['manifest'].get('collaboration',{})
            if job['status']!='running' or policy.get('supervisor','none')=='none':
                raise StateError('approved manifest does not allow questions')
            count=db.execute("SELECT COUNT(*) FROM events WHERE job_id=? AND type='question'",(job_id,)).fetchone()[0]
            if count>=policy['max_questions']:raise BudgetExceeded('clarification budget reached')
            status='awaiting_user' if policy['supervisor']=='user' else 'awaiting_supervisor'
            db.execute('UPDATE jobs SET status=?,updated_at=? WHERE id=?',(status,time.time(),job_id))
            self._event(db,job_id,'question',{'id':str(uuid.uuid4()),'question':question})
            return self._get(db,job_id)

    def answer(self, job_id, answer, responder, question_id=None):
        if not isinstance(answer,str) or not 1 <= len(answer.strip()) <= 8000:raise StateError('invalid answer')
        with self._db(transaction=True) as db:
            job=self._get(db,job_id)
            if question_id is not None:
                events=[(row['type'],json.loads(row['data_json'])) for row in db.execute("SELECT type,data_json FROM events WHERE job_id=? AND type IN ('question','answered') ORDER BY id",(job_id,))]
                for kind,data in events:
                    if kind=='answered' and data.get('question_id')==question_id:
                        if data['answer']!=answer or data['responder']!=responder:raise StateError('answer idempotency conflict')
                        return job
                questions=[data for kind,data in events if kind=='question']
                if not questions or questions[-1]['id']!=question_id:raise StateError('answer question identity mismatch')
            if job['status'] not in ('awaiting_user','awaiting_supervisor'):raise StateError('job is not waiting for an answer')
            if responder not in ('user','codex') or (job['status']=='awaiting_user' and responder!='user'):raise StateError('this mode requires a user answer')
            if job['deadline'] is not None and time.time()>=job['deadline']:raise BudgetExceeded('original deadline reached')
            state=job['checkpoint'];state.setdefault('history',[]).append({'role':'user','content':{'supervisor_answer':answer}})
            db.execute("UPDATE jobs SET status='queued',checkpoint_json=?,updated_at=? WHERE id=?",(_json(state),time.time(),job_id))
            self._event(db,job_id,'answered',{'answer':answer,'responder':responder,**({'question_id':question_id} if question_id is not None else {})})
            return self._get(db,job_id)

    def events(self, job_id):
        with self._db() as db:
            self._get(db, job_id)
            events = []
            for row in db.execute('SELECT * FROM events WHERE job_id=? ORDER BY id', (job_id,)):
                event = dict(row)
                event['data'] = json.loads(event.pop('data_json'))
                events.append(event)
            return events
