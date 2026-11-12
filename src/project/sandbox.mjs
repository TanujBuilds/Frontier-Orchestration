import { createServer } from 'node:net';
import { mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Pause, digest } from './contracts.mjs';
import { createBackend, createPolicy, validateBackend } from './check-backends/contracts.mjs';

export class CheckRunner {
  constructor(workspace, { codex = 'codex', backend = 'codex-sandbox', backendOptions = {}, backendFactory } = {}) {
    this.workspace = workspace;
    // Fixture injection is only a JavaScript option. Manifest/model data never
    // supplies a factory, executable implementation or verification result.
    if (backendFactory !== undefined && typeof backendFactory !== 'function') throw new Pause('Sandbox backendFactory must be an explicit JavaScript function', 'isolation');
    const factory = backendFactory ?? createBackend;
    this.backend = validateBackend(factory({ id: backend, workspace, options: { codex, ...backendOptions } }));
    this.backendIdentity = Object.freeze(structuredClone(this.backend.identity()));
    this.codex = this.backendIdentity.executable;
  }
  async stageInputs(){
    const inventory=await this.workspace.inventory(),version=digest(inventory).slice(0,20),relative='.overnight-output/approved-inputs-'+version,root=await this.workspace.file(relative);await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
    for(const entry of inventory){const source=await this.workspace.file(entry.path),destination=await this.workspace.file(relative+'/'+entry.path);await mkdir(path.dirname(destination),{recursive:true});await copyFile(source,destination);}
    this.stagedInputRoot=root;return {root,files:inventory.map(f=>f.path),inventoryHash:digest(inventory)};
  }
  async execute(argv, timeoutMs, signal) {
    const root = this.workspace.root;
    const scratch = path.join(root, '.overnight-output', 'tmp');
    await mkdir(scratch, { recursive: true });
    const permissions = await createPolicy(this.workspace);
    return this.backend.execute({
      argv, cwd: root, timeoutMs, signal, permissions,
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
    const server = createServer(socket => {
      // An unenforced probe connects and immediately destroys its socket.
      // A peer reset is a failed isolation probe, not an unhandled host error.
      socket.on('error', () => {});
      socket.end('network-access');
    });
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
        socket.once('error',e=>{result.networkDenied=['EPERM','EACCES'].includes(e.code);console.log(JSON.stringify(result))});
        socket.setTimeout(2000,()=>{socket.destroy();result.networkDenied=false;console.log(JSON.stringify(result))});
      `;
      const run = await this.execute([process.execPath, '-e', probe], 15_000, signal);
      let result;
      try { result = JSON.parse(run.stdout.trim()); } catch {}
      if (run.code !== 0 || run.stopped || !result || !['readDenied', 'writeDenied', 'networkDenied', 'outputWorks'].every(key => result[key] === true)) {
        throw new Pause(`Sandbox enforcement probe failed: ${run.stderr.slice(-1000) || run.stdout}`, 'isolation');
      }
      return { ...result, backend: this.backendIdentity };
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
      results.push({ id: check.id, argv: check.argv, ...result, passed: result.code === 0 && !result.stopped, screenshots, backend: this.backendIdentity });
    }
    return results;
  }
}
