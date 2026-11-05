import { createServer } from 'node:net';
import { mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { accessSync, constants } from 'node:fs';
import { command } from './process.mjs';
import { Pause, secretPath, matches, digest } from './contracts.mjs';

export class CheckRunner {
  constructor(workspace, { codex = 'codex' } = {}) {
    this.workspace = workspace;
    this.codex = codex.includes('/') ? codex : (process.env.PATH ?? '').split(path.delimiter)
      .map(dir => path.join(dir, codex)).find(file => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } });
    if (!this.codex) throw new Pause('Codex CLI is not on PATH; sandbox unavailable', 'isolation');
  }
  async stageInputs(){
    const inventory=await this.workspace.inventory(),version=digest(inventory).slice(0,20),relative='.overnight-output/approved-inputs-'+version,root=await this.workspace.file(relative);await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
    for(const entry of inventory){const source=await this.workspace.file(entry.path),destination=await this.workspace.file(relative+'/'+entry.path);await mkdir(path.dirname(destination),{recursive:true});await copyFile(source,destination);}
    this.stagedInputRoot=root;return {root,files:inventory.map(f=>f.path),inventoryHash:digest(inventory)};
  }
  async execute(argv, timeoutMs, signal) {
    if (process.platform !== 'darwin') throw new Pause('Unattended checks currently require the verified Mac sandbox', 'isolation');
    const root = this.workspace.root;
    const scratch = path.join(root, '.overnight-output', 'tmp');
    await mkdir(scratch, { recursive: true });
    const fs = {
      ':root': 'deny', ':minimal': 'read', '/System': 'read', '/usr': 'read', '/bin': 'read',
      '/sbin': 'read', '/opt/homebrew': 'read', '/Library/Fonts': 'read',
      [root]: 'read', [path.join(root, '.git')]: 'deny',
      [path.join(root, '.overnight-output')]: 'write', [path.join(root, 'dist')]: 'write',
    };
    // A check executes worker-controlled source. Do not let that source read
    // undisclosed tracked files or secrets and smuggle them into check output.
    const permissions = this.workspace.manifest?.permissions;
    if (permissions) {
      for (const file of Object.keys(await this.workspace.snapshot())) {
        if (secretPath(file) || !matches(file, permissions.readPaths)) fs[path.join(root, file)] = 'deny';
      }
    }
    for (const name of ['.env', '.aws', '.ssh', '.codex', '.agents', '.data', '.npmrc', '.netrc', '.pypirc', '.git-credentials']) fs[path.join(root, name)] = 'deny';
    const fields = Object.entries(fs).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',');
    const config = `permissions.overnight={filesystem={${fields}},network={enabled=false}}`;
    return command([this.codex, 'sandbox', '-P', 'overnight', '-c', config, '-C', root, '--', ...argv], {
      cwd: root, timeoutMs, signal,
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
        TMPDIR: scratch, CI: '1', LANG: 'en_US.UTF-8',
        HOME: scratch,...(this.stagedInputRoot?{MOSAIC_APPROVED_INPUTS:this.stagedInputRoot}:{}),
        PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'node_modules', '.cache', 'ms-playwright'),
      },
    });
  }
  async verify(signal) {
    const canary = path.join(this.workspace.journal.dir, 'sandbox-private-canary');
    await writeFile(canary, 'private-canary', { mode: 0o600 });
    const server = createServer(socket => socket.end('network-access'));
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const probe = `
        const fs=require('node:fs'), net=require('node:net');
        const result={};
        try{fs.readFileSync(${JSON.stringify(canary)});result.readDenied=false}catch(e){result.readDenied=['EPERM','EACCES'].includes(e.code)}
        try{fs.writeFileSync('unapproved-sandbox-probe','x');result.writeDenied=false}catch(e){result.writeDenied=['EPERM','EACCES'].includes(e.code)}
        try{fs.writeFileSync('.overnight-output/probe','ok');result.outputWorks=true}catch{result.outputWorks=false}
        const socket=net.connect(${server.address().port},'127.0.0.1');
        socket.once('connect',()=>{result.networkDenied=false;socket.destroy();console.log(JSON.stringify(result))});
        socket.once('error',()=>{result.networkDenied=true;console.log(JSON.stringify(result))});
        socket.setTimeout(2000,()=>{socket.destroy();result.networkDenied=true;console.log(JSON.stringify(result))});
      `;
      const run = await this.execute([process.execPath, '-e', probe], 15_000, signal);
      let result;
      try { result = JSON.parse(run.stdout.trim()); } catch {}
      if (run.code !== 0 || !result || !result.readDenied || !result.writeDenied || !result.networkDenied || !result.outputWorks) {
        throw new Pause(`Sandbox enforcement probe failed: ${run.stderr.slice(-1000) || run.stdout}`, 'isolation');
      }
      return result;
    } finally { server.close(); }
  }
  async run(checks, key, signal) {
    if(this.workspace.manifest?.overnightV2)await this.stageInputs();
    const results = [];
    for (const check of checks) {
      for (const file of check.screenshots ?? []) await rm(await this.workspace.file(file), { force: true });
      const result = await this.execute(check.argv, check.timeoutMs ?? 120_000, signal);
      if (signal?.aborted) throw new Pause('Check interrupted; it will rerun on resume', 'stopped');
      await this.workspace.assertSnapshot();
      const screenshots = [];
      if (result.code === 0 && !result.stopped) {
        for (const file of check.screenshots ?? []) {
          const absolute = await this.workspace.file(file);
          let bytes;
          try { bytes = await readFile(absolute); } catch { throw new Pause(`Check did not produce screenshot ${file}`, 'evidence'); }
          if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Pause('Screenshot is not a PNG', 'evidence');
          const destination = path.join(this.workspace.journal.dir, `${key.replaceAll('/', '-')}-${check.id}-${path.basename(file)}`);
          await copyFile(absolute, destination);
          screenshots.push(destination);
        }
      }
      results.push({ id: check.id, argv: check.argv, ...result, passed: result.code === 0 && !result.stopped, screenshots });
    }
    return results;
  }
}
