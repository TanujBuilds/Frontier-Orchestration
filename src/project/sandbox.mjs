import { createServer } from 'node:net';
import { mkdir, writeFile, readFile, copyFile, rm, chmod, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { Pause, digest } from './contracts.mjs';
import { createBackend, createPolicy, validateBackend } from './check-backends/contracts.mjs';
import { nativeInputInventory } from './check-backends/darwin-seatbelt-v2.mjs';

export class CheckRunner {
  constructor(workspace, { codex = 'codex', backend = 'codex-sandbox', backendRevision = 1, backendOptions = {}, backendFactory } = {}) {
    this.workspace = workspace;
    // Fixture injection is only a JavaScript option. Manifest/model data never
    // supplies a factory, executable implementation or verification result.
    if (backendFactory !== undefined && typeof backendFactory !== 'function') throw new Pause('Sandbox backendFactory must be an explicit JavaScript function', 'isolation');
    const factory = backendFactory ?? createBackend;
    this.backend = validateBackend(factory({ id: backend, revision: backendRevision, workspace, options: { codex, ...backendOptions } }));
    this.backendIdentity = Object.freeze(structuredClone(this.backend.identity()));
    this.codex = this.backendIdentity.executable;
    this.nativeV2 = this.backendIdentity.id === 'darwin-seatbelt' && this.backendIdentity.revision === 2;
    this.probeExecutable = this.nativeV2 ? this.backendIdentity.runtime.runtime.executable : process.execPath;
  }
  async stageInputs(){
    const inventory=this.nativeV2 ? await nativeInputInventory(this.workspace) : await this.workspace.inventory();
    const evidence=this.nativeV2 ? inventory.map(({realPath,...file})=>file) : inventory;
    const version=digest(evidence).slice(0,20),relative='.overnight-output/approved-inputs-'+version,root=await this.workspace.file(relative);await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
    if(this.nativeV2 && (await realpath(root)!==root || (await lstat(root)).isSymbolicLink()))throw new Pause('Native staging root is aliased','isolation');
    for(const entry of inventory){const source=await this.workspace.file(entry.path),destination=await this.workspace.file(relative+'/'+entry.path);await mkdir(path.dirname(destination),{recursive:true});await copyFile(source,destination);
      if(this.nativeV2){await chmod(destination,entry.mode==='100755'?0o755:0o644);const stat=await lstat(destination);if(await realpath(destination)!==destination||stat.isSymbolicLink()||digest(await readFile(source))!==entry.hash||digest(await readFile(destination))!==entry.hash||(stat.mode&0o7777)!==(entry.mode==='100755'?0o755:0o644))throw new Pause('Native staged bytes or executable mode changed','isolation');}
    }
    if(this.nativeV2 && digest((await nativeInputInventory(this.workspace)).map(({realPath,...file})=>file))!==digest(evidence))throw new Pause('Native source changed while staging','isolation');
    this.stagedInputRoot=root;this.stagedInputs=this.nativeV2?[{root,inventoryHash:digest(evidence)}]:undefined;return {root,files:inventory.map(f=>f.path),inventoryHash:digest(evidence)};
  }
  async execute(argv, timeoutMs, signal) {
    const root = this.workspace.root;
    const scratch = path.join(root, '.overnight-output', 'tmp');
    await mkdir(scratch, { recursive: true });
    const permissions = await createPolicy(this.workspace);
    return this.backend.execute({
      argv, cwd: root, timeoutMs, signal, permissions, ...(this.nativeV2?{stagedInputs:this.stagedInputs??[]}:{}),
      env: {
        PATH: `${path.dirname(this.probeExecutable)}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
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
        const result={${this.nativeV2?'nativeGroupProbe,':''}};
        try{fs.readFileSync(${JSON.stringify(canary)});result.readDenied=false}catch(e){result.readDenied=['EPERM','EACCES'].includes(e.code)}
        try{fs.writeFileSync('unapproved-sandbox-probe','x');result.writeDenied=false}catch(e){result.writeDenied=['EPERM','EACCES'].includes(e.code)}
        try{fs.writeFileSync('.overnight-output/probe','ok');result.outputWorks=true}catch{result.outputWorks=false}
        const socket=net.connect(${server.address().port},'127.0.0.1');
        socket.once('connect',()=>{result.networkDenied=false;socket.destroy();console.log(JSON.stringify(result))});
        socket.once('error',e=>{result.networkDenied=['EPERM','EACCES'].includes(e.code);console.log(JSON.stringify(result))});
        socket.setTimeout(2000,()=>{socket.destroy();result.networkDenied=false;console.log(JSON.stringify(result))});
      `;
      const childProbe = this.nativeV2 ? `
        const cp=require('node:child_process');
        const nativeControl=cp.spawnSync(${JSON.stringify(this.backendIdentity.runtime?.supervisor?.executable)},['--probe',process.execPath],{encoding:'utf8',timeout:5000});
        if(nativeControl.status!==0)process.exit(93);
        const nativeGroupProbe=JSON.parse(nativeControl.stdout);
        const sync=cp.spawnSync(process.execPath,['-e','process.stdout.write("sync-native")'],{encoding:'utf8'});
        const child=cp.spawn(process.execPath,['-e','process.stdout.write("async-native")']);
        let captured='';child.stdout.on('data',b=>captured+=b);child.on('error',()=>process.exit(91));
        child.on('close',code=>{if(sync.status!==0||sync.stdout!=='sync-native'||code!==0||captured!=='async-native')process.exit(92)});
      ` : '';
      const run = await this.execute([this.probeExecutable, '-e', childProbe + probe], 15_000, signal);
      let result;
      try { result = JSON.parse(run.stdout.trim()); } catch {}
      if (run.code !== 0 || run.stopped || !result || !['readDenied', 'writeDenied', 'networkDenied', 'outputWorks'].every(key => result[key] === true)) {
        throw new Pause(`Sandbox enforcement probe failed: ${run.stderr.slice(-1000) || run.stdout}`, 'isolation');
      }
      if(this.nativeV2){
        const p=result.nativeGroupProbe,leader=run.quiescence?.leaderPid;
        if(!p||p.schema!==1||p.pid===p.beforePgid||p.beforePgid!==leader||p.pgid!==leader||p.sid!==leader||p.setsid?.rc!==-1||p.setsid?.errno!==1||p.setpgid?.rc!==-1||p.setpgid?.errno!==1||p.spawn?.rc!==78||p.spawnDetached?.rc!==78)throw new Pause('Native kernel process-group containment control probe failed','isolation');
      }
      return { ...result, ...(this.nativeV2?{childProcessWorks:true,quiescence:run.quiescence,provenance:run.provenance}:{}), backend: this.backendIdentity };
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
