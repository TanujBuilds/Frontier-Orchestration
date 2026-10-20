import { mkdir, open, readFile, writeFile, rename, unlink, truncate } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pause } from './contracts.mjs';

export async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
}
export class Journal {
  constructor(root, id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job ID');
    this.id = id; this.root = root;
    this.file = path.join(root, 'jobs', `${id}.jsonl`);
    this.dir = path.join(root, 'artifacts', id);
    this.events = [];
  }
  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let content;
    try { content = await readFile(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return this; throw e; }
    const end = content.lastIndexOf('\n') + 1;
    this.tail = content.slice(end);
    this.validBytes = Buffer.byteLength(content.slice(0, end));
    this.events = content.slice(0, end).split('\n').filter(Boolean).map(JSON.parse);
    this.events.forEach((event, index) => {
      if (event.jobId !== this.id || event.sequence !== index + 1) throw new Pause('Job log sequence is corrupt', 'log');
    });
    return this;
  }
  async append(type, data = {}) {
    if (this.tail) throw new Pause('Incomplete log tail requires locked recovery', 'log');
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const event = { jobId: this.id, sequence: this.events.length + 1, at: new Date().toISOString(), type, data };
    const handle = await open(this.file, 'a', 0o600);
    try { await handle.write(`${JSON.stringify(event)}\n`); await handle.sync(); } finally { await handle.close(); }
    this.events.push(event);
    return event;
  }
  last(type) { return this.events.findLast(event => event.type === type)?.data; }
  completed(key) { return this.events.findLast(event => event.type === 'operation.completed' && event.data.key === key)?.data; }
  async memo(key, action, input = undefined) {
    const saved = this.completed(key);
    if (saved) return saved.value;
    await this.append('operation.started', { key, ...(input === undefined ? {} : { input }) });
    const value = await action();
    await this.append('operation.completed', { key, value });
    return value;
  }
  async lock() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, 'lock.json');
    const token = randomUUID();
    const create = async () => {
      const handle = await open(file, 'wx', 0o600);
      await handle.write(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
    };
    try { await create(); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const recoveryFile = path.join(this.dir, 'lock-recovery');
      let recovery;
      try { recovery = await open(recoveryFile, 'wx', 0o600); }
      catch { throw new Pause('Another process is recovering the lock; inspect it before retrying', 'locked'); }
      try {
        let existing;
        try { existing = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Pause('Incomplete lock; inspect the previous runner before recovery', 'locked'); }
        if (!Number.isInteger(existing.pid) || existing.pid <= 0) throw new Pause('Invalid runner lock', 'locked');
        try { process.kill(existing.pid, 0); throw new Pause('A runner already owns this job', 'locked'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        await unlink(file); await create();
      } finally { await recovery.close(); await unlink(recoveryFile); }
    }
    const release = async () => {
      const current = JSON.parse(await readFile(file, 'utf8'));
      if (current.token === token) await unlink(file);
    };
    try {
      await this.load();
      if (this.tail) {
        await writeFile(path.join(this.dir, `interrupted-log-${Date.now()}.txt`), this.tail, { mode: 0o600 });
        await truncate(this.file, this.validBytes);
        this.tail = '';
        await this.append('log.recovered');
      }
    } catch (error) { await release(); throw error; }
    return release;
  }
}
