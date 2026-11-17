import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Each child owns one fresh directory. Never patch the parent/test runner.
const root = process.env.MOSAIC_STORAGE_FAULT_EVIDENCE_ROOT
  ? path.resolve(process.env.MOSAIC_STORAGE_FAULT_EVIDENCE_ROOT)
  : mkdtempSync(path.join(os.tmpdir(), 'mosaic-storage-faults-'));
mkdirSync(root, {recursive:true, mode:0o700});
const specimen = fileURLToPath(new URL('./fixtures/mosaic-storage-faults/specimen.mjs', import.meta.url));
const bytes = dir => readdirSync(dir, {withFileTypes:true}).reduce((sum, e) => {
  const file = path.join(dir,e.name);
  assert.ok(!e.isSymbolicLink(), 'owned evidence must not contain a symlink');
  return sum + (e.isDirectory() ? bytes(file) : statSync(file).size);
}, 0);

for (const name of ['sqlite-control', 'store-tx', 'store-command', 'coordinator-save',
  'journal-open-enospc', 'journal-open-eacces', 'journal-partial', 'journal-sync',
  'journal-memo-completion', 'atomic-write', 'atomic-rename', 'store-rollback-cleanup']) {
  test(name, () => {
    const dir = path.join(root,name);
    mkdirSync(dir, {mode:0o700}); // Refuse an old run rather than overwrite evidence.
    const argv = [specimen,name,dir];
    writeFileSync(path.join(dir,'command.json'), JSON.stringify({executable:process.execPath,argv,timeoutMs:15000,combinedOutputBytesMax:262144},null,2));
    const result = spawnSync(process.execPath, argv, {encoding:'utf8',timeout:15000,maxBuffer:131072});
    writeFileSync(path.join(dir,'stdout.log'), result.stdout ?? '');
    writeFileSync(path.join(dir,'stderr.log'), result.stderr ?? '');
    writeFileSync(path.join(dir,'exit.json'), JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message ?? null},null,2));
    assert.ok(Buffer.byteLength(result.stdout ?? '') + Buffer.byteLength(result.stderr ?? '') <= 262144);
    assert.ok(bytes(root) <= 64*1024*1024, 'finite retained evidence cap');
    assert.ifError(result.error);
    const report = JSON.parse(readFileSync(path.join(dir,'measurement.json'),'utf8'));
    assert.equal(result.status,0, JSON.stringify({case:name,checks:report.checks,error:report.fatal},null,2));
    assert.deepEqual(report.checks.filter(check => !check.pass),[]);
  });
}
