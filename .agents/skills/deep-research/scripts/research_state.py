"""Durable offline coordination for bounded research jobs.

Only the worker performs external calls. It must reserve each operation before
calling a provider, and treat an existing pending operation as spent and
ambiguous rather than dispatching it again.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
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
    _keys(raw, ('schema', 'mode', 'submission_id', 'question', 'scope', 'limits'), 'manifest')
    mode = raw.get('mode', 'live')
    if mode not in ('live', 'fixture'):
        raise StateError('mode must be live or fixture')
    if type(raw.get('schema', 1)) is not int or raw.get('schema', 1) != 1:
        raise StateError('manifest schema must be 1')
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
    if normalized_limits['model_calls'] < 4:
        raise StateError('limits.model_calls must allow at least four calls')
    return {'schema': 1, 'mode': mode, 'submission_id': submission, 'question': question,
            'scope': normalized_scope, 'limits': normalized_limits}


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
                                ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,created_at,rowid LIMIT 1''').fetchone()
            if row is None:
                return None
            job = self._decode_job(row)
            if job['status'] == 'queued':
                started = job['started_at'] if job['started_at'] is not None else now
                deadline = job['deadline'] if job['deadline'] is not None else started + job['manifest']['limits']['seconds']
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
            if job['status'] not in ('stopped', 'blocked', 'failed'):
                raise StateError('only stopped, blocked, or failed jobs can resume')
            if job['deadline'] is not None and now >= job['deadline']:
                raise BudgetExceeded('the original research deadline has been reached')
            # Resume may only need cached-result replay or local finalization.
            # Every new external request still passes the per-kind reserve cap.
            db.execute("UPDATE jobs SET status='queued',reason=NULL,updated_at=? WHERE id=?", (now, job_id))
            self._event(db, job_id, 'resumed', {}, now)
            return self._get(db, job_id)

    def events(self, job_id):
        with self._db() as db:
            self._get(db, job_id)
            events = []
            for row in db.execute('SELECT * FROM events WHERE job_id=? ORDER BY id', (job_id,)):
                event = dict(row)
                event['data'] = json.loads(event.pop('data_json'))
                events.append(event)
            return events
