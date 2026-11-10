import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { digest, identifier, integer, keys } from '../contracts.mjs';

const FILTERS = ['goalId', 'projectKey', 'from', 'to', 'limit', 'cursor'];
const ROW_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_BYTES = 24 * 1024 * 1024;
const TASK_SCAN = 10_000;
const GOAL_EVENT_SCAN = 100_000;
const ACTIVITY_ROWS = 10_000;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RECORD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const boundedData = `length(CAST(data AS BLOB)) AS bytes,
  CASE WHEN length(CAST(data AS BLOB)) <= ${ROW_BYTES} THEN data END AS data`;

function utc(value, label) {
  if (value === undefined) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    const ms = Date.parse(value);
    const [, wall, fraction] = /^(.*?)(?:\.(\d{1,3}))?Z$/.exec(value);
    if (Number.isFinite(ms) && new Date(ms).toISOString() === `${wall}.${(fraction ?? '').padEnd(3, '0')}Z`) return ms;
  }
  throw Error(`Invalid ${label}: expected a UTC ISO timestamp`);
}

function parseScope(filters) {
  keys(filters, FILTERS, 'outcome snapshot');
  const { goalId, projectKey, from, to, limit = 100, cursor } = filters;
  if (goalId !== undefined) identifier(goalId, 'goalId');
  if (projectKey !== undefined && (typeof projectKey !== 'string' || !HASH.test(projectKey))) {
    throw Error('Invalid projectKey: expected the persisted project identity digest');
  }
  integer(limit, 'limit', 1, 500);
  const start = utc(from, 'from'), end = utc(to, 'to');
  if (start !== null && end !== null && start >= end) throw Error('Outcome time window requires from earlier than to');
  const scope = {
    goalId: goalId ?? null, projectKey: projectKey ?? null,
    from: start === null ? null : new Date(start).toISOString(),
    to: end === null ? null : new Date(end).toISOString(),
    windowField: 'task.createdAt',
  };
  const cursorScope = digest(scope);
  let after = 0;
  if (cursor !== undefined) {
    const match = typeof cursor === 'string' && /^([a-f0-9]{64})\.([1-9][0-9]{0,15})$/.exec(cursor);
    if (!match || match[1] !== cursorScope || !Number.isSafeInteger(Number(match[2]))) {
      throw Error('Invalid outcome cursor for this scope');
    }
    after = Number(match[2]);
  }
  return { scope: { ...scope, limit, cursor: cursor ?? null }, start, end, cursorScope, after };
}

function ensureSchema(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 1) {
    throw Error('Unsupported outcome state schema: expected harness version 1');
  }
  const tables = db.prepare(`SELECT name, sql FROM sqlite_schema
    WHERE type='table' AND name IN ('records','events','requests')`).all();
  if (tables.length !== 3 || tables.some(row => !/^CREATE TABLE\s/i.test(row.sql ?? ''))) {
    throw Error('Unsupported outcome state schema: missing harness records, events, or requests table');
  }
}

function readSnapshot(db, { scope, start, end, cursorScope, after }) {
  ensureSchema(db);
  const generatedAt = new Date().toISOString();
  const tasks = [], events = [], requests = [], evidence = [], diagnostics = [];
  const goalCache = new Map(), selectedGoals = new Map(), evidenceKeys = new Map();
  let bytes = 0, diagnosticCount = 0, resumeAfter = null;

  const note = (code, source, id = null) => {
    diagnosticCount++;
    if (diagnostics.length < 100) diagnostics.push({ code, source, id });
  };
  const decode = (row, source, id) => {
    if (!Number.isSafeInteger(row.bytes) || row.bytes > ROW_BYTES || row.data === null) {
      note('row_size_limit', source, id);
      return null;
    }
    bytes += row.bytes;
    if (bytes > SNAPSHOT_BYTES) {
      note('snapshot_byte_limit', source, id);
      return null;
    }
    try {
      const data = JSON.parse(row.data);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch {
      // Continue with independently readable rows.
    }
    note('malformed_row', source, id);
    return null;
  };
  const record = db.prepare(`SELECT ${boundedData} FROM records WHERE kind=? AND id=?`);
  const load = (kind, id) => {
    const row = record.get(kind, id);
    if (!row) return null;
    const data = decode(row, kind, id);
    if (data && data.id !== id) {
      note('record_identity_mismatch', kind, id);
      return null;
    }
    return data;
  };
  const goalFor = id => {
    if (!goalCache.has(id)) {
      const goal = load('goal', id);
      if (!goal) note('goal_record_unavailable', 'goal', id);
      goalCache.set(id, goal);
    }
    return goalCache.get(id);
  };
  const matchesProject = goal => {
    if (!scope.projectKey) return true;
    if (!goal) return false;
    const projectIdentity = goal.manifest?.project?.repo ?? goal.id;
    if (typeof projectIdentity !== 'string') {
      note('invalid_project_identity', 'goal', goal.id);
      return false;
    }
    return digest(projectIdentity) === scope.projectKey;
  };

  if (scope.goalId) {
    if (!db.prepare("SELECT 1 FROM records WHERE kind='goal' AND id=?").get(scope.goalId)) throw Error(`Unknown outcome goal ${scope.goalId}`);
    const goal = goalFor(scope.goalId);
    if (goal && matchesProject(goal)) selectedGoals.set(goal.id, goal);
  }

  const taskRows = db.prepare(`SELECT rowid, id, ${boundedData} FROM records
    WHERE kind='task' AND rowid>? ORDER BY rowid LIMIT ?`);
  let lastRow = after;
  let scanned = 0;
  for (const row of taskRows.iterate(after, TASK_SCAN + 1)) {
    const exceedsBytes = bytes > SNAPSHOT_BYTES || row.bytes <= ROW_BYTES && bytes + row.bytes > SNAPSHOT_BYTES;
    if (++scanned > TASK_SCAN || exceedsBytes) {
      note(scanned > TASK_SCAN ? 'task_scan_limit' : 'snapshot_byte_limit', 'task');
      resumeAfter = lastRow;
      break;
    }
    const task = decode(row, 'task', row.id);
    if (task) {
      if (typeof task.id !== 'string' || task.id !== row.id || !RECORD_ID.test(task.id) || typeof task.goalId !== 'string' || !RECORD_ID.test(task.goalId)) {
        note('record_identity_mismatch', 'task', row.id);
      } else if (!scope.goalId || task.goalId === scope.goalId) {
        if ((start !== null || end !== null) && !Number.isSafeInteger(task.createdAt)) {
          note('unknown_task_creation_time', 'task', row.id);
        } else if ((start === null || task.createdAt >= start) && (end === null || task.createdAt < end)) {
          const goal = goalFor(task.goalId);
          if (matchesProject(goal)) {
            if (tasks.length >= scope.limit) {
              resumeAfter = lastRow;
              break;
            }
            tasks.push(task);
            if (goal) selectedGoals.set(goal.id, goal);
          }
        }
      }
    }
    lastRow = row.rowid;
  }

  const includePlanning = selectedGoals.has(scope.goalId) && start === null && end === null && !after && resumeAfter === null && !diagnosticCount;
  const goals = [...selectedGoals.values()];
  const addEvidence = (kind, id) => {
    if (typeof id !== 'string' || !RECORD_ID.test(id)) return null;
    const key = `${kind}:${id}`;
    if (!evidenceKeys.has(key)) {
      const data = load(kind, id);
      evidenceKeys.set(key, data);
      if (data) evidence.push({ kind, id, data });
    }
    return evidenceKeys.get(key);
  };
  const commits = new Set(goals.map(goal => goal.manifest?.project?.baseCommit));
  for (const task of tasks) {
    if (bytes > SNAPSHOT_BYTES) break;
    const goal = selectedGoals.get(task.goalId);
    const version = task.goalVersion;
    if (!goal || !Number.isSafeInteger(version) || version < 1 || version > goal.version) {
      commits.add(null);
    } else if (version < goal.version) {
      const history = addEvidence('goal_history', `${task.goalId}-${version}`);
      commits.add(history?.goalId === task.goalId && history.version === version ? history.manifest?.project?.baseCommit : null);
    }
    if (task.spec?.kind === 'research') {
      if (version > 1) addEvidence('goal_history', `${task.goalId}-${version - 1}`);
      addEvidence('reviewer', task.researchReviewAcceptance?.nativeReservationId);
      if (Array.isArray(task.researchReviewTickets)) {
        for (const ticket of task.researchReviewTickets.slice(0, 2)) addEvidence('reviewer', ticket?.nativeReservationId);
      }
    }
  }

  const taskEvents = db.prepare(`SELECT seq,at,goal_id,task_id,type,${boundedData} FROM events
    WHERE task_id=? AND type!='model.output' ORDER BY seq LIMIT ?`);
  const requestRows = db.prepare(`SELECT id,task_id,key,kind,status,${boundedData} FROM requests
    WHERE task_id=? ORDER BY key LIMIT ?`);
  let eventCount = 0, requestCount = 0;
  const addEvent = (row, goalId) => {
    if (++eventCount > ACTIVITY_ROWS || bytes > SNAPSHOT_BYTES) return false;
    if (row.goal_id !== goalId) {
      note('event_goal_mismatch', 'events', row.seq);
      return true;
    }
    const { bytes: _bytes, ...event } = row;
    const data = decode(row, 'events', row.seq);
    if (data) events.push({ ...event, data });
    return true;
  };
  const addRequests = id => {
    for (const row of requestRows.iterate(id, ACTIVITY_ROWS - requestCount + 1)) {
      if (++requestCount > ACTIVITY_ROWS || bytes > SNAPSHOT_BYTES) return false;
      const { bytes: _bytes, ...request } = row;
      const data = decode(row, 'requests', row.id);
      requests.push({ ...request, data: data && {
        reservedAt: data.reservedAt, savedAt: data.savedAt,
        startedAt: data.startedAt, requestOutcome: data.requestOutcome,
        error: typeof data.error === 'string' ? data.error.slice(0, 1000) : undefined,
        result: data.result && { model: data.result.model, usage: data.result.usage },
      } });
    }
    return true;
  };
  for (const task of tasks) {
    for (const row of taskEvents.iterate(task.id, ACTIVITY_ROWS - eventCount + 1)) {
      if (!addEvent(row, task.goalId)) break;
    }
    if (eventCount > ACTIVITY_ROWS || bytes > SNAPSHOT_BYTES) {
      note('event_coverage_limit', 'events');
      break;
    }
  }
  if (eventCount <= ACTIVITY_ROWS && bytes <= SNAPSHOT_BYTES && goals.length) {
    const latest = db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM events').get().seq;
    const earliest = Math.max(0, latest - GOAL_EVENT_SCAN);
    if (earliest > 0) note('goal_event_scan_limit', 'events');
    const placeholders = goals.map(() => '?').join(',');
    const rows = db.prepare(`SELECT seq,at,goal_id,task_id,type,${boundedData} FROM events
      WHERE seq>? AND task_id IS NULL AND goal_id IN (${placeholders}) AND type!='model.output'
      ORDER BY seq LIMIT ?`).iterate(earliest, ...goals.map(goal => goal.id), ACTIVITY_ROWS - eventCount + 1);
    for (const row of rows) {
      if (!addEvent(row, row.goal_id)) {
        note('event_coverage_limit', 'events');
        break;
      }
    }
  }
  const requestTaskIds = tasks.map(task => task.id);
  if (includePlanning && !requestTaskIds.includes(scope.goalId)) requestTaskIds.push(scope.goalId);
  for (const id of requestTaskIds) {
    if (!addRequests(id)) {
      note('request_coverage_limit', 'requests');
      break;
    }
  }

  const nextCursor = resumeAfter > 0 ? `${cursorScope}.${resumeAfter}` : null;
  const [commit] = commits;
  return {
    schemaVersion: 1,
    generatedAt,
    sourceRevision: bytes <= SNAPSHOT_BYTES && commits.size === 1 && typeof commit === 'string' && COMMIT.test(commit) ? commit : null,
    scope: { ...scope, planningRequestsIncluded: includePlanning },
    coverage: {
      complete: !after && resumeAfter === null && diagnosticCount === 0,
      nextCursor,
      taskRowsScanned: Math.min(scanned, TASK_SCAN),
      diagnosticCount,
    },
    diagnostics,
    goals,
    tasks,
    events: events.sort((a, b) => a.seq - b.seq),
    requests,
    evidence,
  };
}

/** The Coordinator owns this connection. Use a deferred read transaction only. */
export function readOutcomeSnapshotFromDatabase(db, filters = {}) {
  const options = parseScope(filters);
  if (db.isTransaction) throw Error('Outcome database is busy with an existing transaction; retry the report');
  let begun = false;
  try {
    db.exec('BEGIN DEFERRED');
    begun = true;
    return readSnapshot(db, options);
  } catch (error) {
    if ([5, 6].includes(error.errcode & 255)) throw Error('Outcome database is busy or locked; retry the report');
    throw error;
  } finally {
    if (begun) db.exec('ROLLBACK');
  }
}

function quiescentDatabase(root) {
  const database = path.join(root, 'harness.sqlite3');
  const stat = lstatSync(database, { bigint: true, throwIfNoEntry: false });
  if (!stat) throw Error('Missing outcome database harness.sqlite3 at the selected state root');
  if (!stat.isFile()) throw Error('Unsafe outcome database: harness.sqlite3 must be a regular file');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (lstatSync(database + suffix, { throwIfNoEntry: false })) {
      throw Error('Outcome database has active or retained WAL/journal sidecars; use the coordinator report or a checkpointed state root');
    }
  }
  return { database, stamp: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') };
}

export function readOutcomeSnapshot(input) {
  keys(input, ['stateRoot', ...FILTERS], 'outcome snapshot');
  const { stateRoot, ...filters } = input;
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || stateRoot.length > 4096 || /[\x00-\x1f\x7f]/.test(stateRoot)) {
    throw Error('Outcome state root must be an explicit absolute directory path');
  }
  let root;
  try {
    root = realpathSync(stateRoot);
  } catch (error) {
    if (error.code === 'ENOENT') throw Error('Missing outcome state root; select an existing directory');
    throw error;
  }
  if (!lstatSync(root).isDirectory()) throw Error('Outcome state root must be a directory');
  const { database, stamp } = quiescentDatabase(root);
  // A regular read-only SQLite connection can create WAL/SHM files or update
  // reader marks. Immutable mode leaves the original files untouched. Accept
  // it only for checkpointed data, and reject observed concurrent changes.
  const url = pathToFileURL(database);
  url.searchParams.set('immutable', '1');
  const db = new DatabaseSync(url, { readOnly: true });
  let snapshot;
  try {
    snapshot = readOutcomeSnapshotFromDatabase(db, filters);
  } finally {
    db.close();
  }
  if (quiescentDatabase(root).stamp !== stamp) throw Error('Outcome database changed during the report; retry against a checkpointed state root');
  return snapshot;
}
