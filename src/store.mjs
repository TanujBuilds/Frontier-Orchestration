import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class JsonlJobStore {
  constructor(directory) {
    this.directory = directory;
  }

  async append(jobId, event) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${jobId}.jsonl`);
    await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}
