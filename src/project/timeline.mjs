import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

function operation(key) {
  if (key.endsWith('/assignment')) return 'assignment';
  if (/\/response-\d+$/.test(key)) return 'response';
  if (/\/files-\d+$/.test(key)) return 'files';
  if (key.endsWith('/checks')) return 'checks';
  if (key.endsWith('/review')) return 'review';
  if (key.endsWith('/checkpoint')) return 'checkpoint';
  return null;
}

function stageOf(key) { const parts = key.split('/'); return /^v\d+$/.test(parts[0]) ? parts[1] : parts[0]; }
function short(value, max = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatTimelineEvent(event, { mode } = {}) {
  const { type, data = {} } = event;
  const prefix = `${event.at}  #${event.sequence}${mode === 'fake' ? '  [FAKE]' : ''}`;
  if (type === 'project.created') return `${prefix}  PLAN v${data.planVersion}: ${data.plan?.stages?.map(stage => stage.id).join(' → ') ?? 'created'}`;
  if (type === 'project.approved') return `${prefix}  APPROVED plan v${data.planVersion}`;
  if (type === 'run.started') return `${prefix}  RUN started`;
  if (type === 'attempt.started') return `${prefix}  ${data.stageId}  ${data.role === 'rescue' ? 'Codex rescue' : 'DeepSeek attempt'} ${data.number}`;
  if (type === 'provider.waiting') return `${prefix}  WAIT ${data.key}: ${short(data.reason)}; retry in ${Math.ceil(data.waitMs / 1000)}s`;
  if (type === 'edits.intent') return `${prefix}  EDIT proposed: ${data.changes?.map(change => `${change.content === null ? 'delete' : 'write'} ${change.path}`).join(', ') || 'none'}`;
  if (type === 'edits.applied') return `${prefix}  EDIT applied: ${data.key}`;
  if (type === 'attempt.finished') return `${prefix}  ${data.stageId}  ${data.accepted ? 'ACCEPTED' : 'REVISE'}: ${short(data.feedback)}${data.checks?.length ? ` | checks ${data.checks.map(check => `${check.id}:${check.passed ? 'pass' : 'fail'}`).join(', ')}` : ''}`;
  if (type === 'stage.accepted') return `${prefix}  CHECKPOINT ${data.stageId}: ${data.commit ?? 'saved'}`;
  if (type === 'run.finished') return `${prefix}  FINAL ${data.status}: ${short(data.reason)}`;
  if (type === 'operation.started') {
    const kind = operation(data.key);
    if (kind === 'response') {
      const input = data.input ?? {};
      return `${prefix}  Codex → ${data.key.includes('/rescue-') ? 'Codex rescue' : 'DeepSeek'} [${stageOf(data.key)}]: ${short(input.assignment?.instructions)}${input.priorAttempts?.length ? ` | earlier feedback: ${short(input.priorAttempts.at(-1)?.feedback, 120)}` : ''}`;
    }
    if (kind === 'review') return `${prefix}  Evidence → Codex review [${stageOf(data.key)}]: ${short(data.input?.workerSummary)} | ${data.input?.evidence?.checks?.length ?? 0} checks`;
    if (kind === 'assignment') return `${prefix}  Codex preparing assignment [${stageOf(data.key)}]`;
    return null;
  }
  if (type === 'operation.completed') {
    const kind = operation(data.key), value = data.value;
    if (kind === 'assignment') return `${prefix}  Codex assignment [${stageOf(data.key)}]: ${short(value?.instructions)}`;
    if (kind === 'response') {
      const reply = value?.reply ?? value;
      const usage = value?.usage?.total_tokens ? ` | ${value.usage.total_tokens} local tokens` : '';
      if (value?.protocolError) return `${prefix}  ${data.key.includes('/rescue-') ? 'Codex rescue' : 'DeepSeek'} protocol error: ${short(value.protocolError)}${usage}`;
      if (reply?.type === 'read_files') return `${prefix}  ${data.key.includes('/rescue-') ? 'Codex rescue' : 'DeepSeek'} → files requested: ${reply.paths?.join(', ') || 'none'}${usage}`;
      if (reply?.type === 'submit_changes') return `${prefix}  ${data.key.includes('/rescue-') ? 'Codex rescue' : 'DeepSeek'} → edits: ${reply.edits?.map(edit => `${edit.action} ${edit.path}`).join(', ') || 'none'} | ${short(reply.summary)}${usage}`;
      return `${prefix}  ${data.key.includes('/rescue-') ? 'Codex rescue' : 'DeepSeek'} → ${reply?.type ?? 'unrecognized reply'}`;
    }
    if (kind === 'files') return `${prefix}  Files supplied to worker [${stageOf(data.key)}]: ${Array.isArray(value) ? value.map(file => file.path).join(', ') : 'recorded'}`;
    if (kind === 'checks') return `${prefix}  Checks [${stageOf(data.key)}]: ${value?.map(check => `${check.id}:${check.passed ? 'pass' : 'fail'}`).join(', ') || 'none'}`;
    if (kind === 'review') return `${prefix}  Codex review [${stageOf(data.key)}]: ${value?.decision ?? 'unknown'} — ${short(value?.feedback)}`;
    return null;
  }
  return null;
}

// Read only complete JSONL records. A partial final write stays buffered until its newline arrives.
export async function* watchJournal(file, { once = false, intervalMs = 500, signal } = {}) {
  let offset = 0, pending = Buffer.alloc(0), lastSequence = 0, finished = false;
  while (true) {
    let handle;
    try { handle = await open(file, 'r'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (handle) {
      try {
        const { size } = await handle.stat();
        if (size < offset) { offset = 0; pending = Buffer.alloc(0); }
        while (offset < size) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, size - offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
          let newline;
          while ((newline = pending.indexOf(10)) !== -1) {
            const line = pending.subarray(0, newline).toString('utf8');
            pending = pending.subarray(newline + 1);
            if (!line) continue;
            const event = JSON.parse(line);
            if (event.sequence <= lastSequence) continue;
            if (event.sequence !== lastSequence + 1) throw new Error(`Job log skips event ${lastSequence + 1}`);
            lastSequence = event.sequence;
            finished = event.type === 'run.finished';
            yield event;
          }
        }
      } finally { await handle.close(); }
    }
    if (once || (finished && pending.length === 0)) return;
    await delay(intervalMs, undefined, { signal });
  }
}
