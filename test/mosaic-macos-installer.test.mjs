import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const repo=fileURLToPath(new URL('../',import.meta.url));
const builder=path.join(repo,'scripts','package-macos-installer.mjs');
const mac=process.platform==='darwin'&&process.arch==='arm64'&&process.getuid()!==0;
if(process.env.MOSAIC_REQUIRE_NATIVE==='1'&&!mac)throw Error('Required macOS Installer verification needs a non-root Apple Silicon account.');
const version='0.1.0-beta.451';
const name='mosaic-beta-'+version+'-darwin-arm64';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

async function fixture(t){
 const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'Mosaic macOS fixture ')));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const bundle=path.join(directory,name),native=path.join(bundle,'payload','runtime','check-artifact');
 await mkdir(native,{recursive:true});
 await writeFile(path.join(native,'artifact-manifest.json'),'fixture manifest\n',{mode:0o600});
 await writeFile(path.join(native,'node'),'fixture binary\n',{mode:0o755});
 // This fixture writes only to the disposable HOME supplied below. It never
 // calls the real installer.
 await writeFile(path.join(bundle,'install'),`#!/bin/sh
set -eu
CDPATH= cd -- "$(dirname -- "$0")"
test "$PWD" = "$(pwd -P)"
printf 'Activated %s from %s\n' "$*" "$PWD"
stat -f '%Lp:%u' payload/runtime/check-artifact/artifact-manifest.json payload/runtime/check-artifact/node
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/mosaic" <<'MOCK'
#!/bin/sh
printf 'Opened Mosaic %s\n' "$*"
MOCK
chmod 700 "$HOME/.local/bin/mosaic"
`,{mode:0o755});
 const archive=path.join(directory,name+'.tar.gz'),output=path.join(directory,'output'),home=path.join(directory,'Test Home');
 await mkdir(home);
 await exec('/usr/bin/tar',['-czf',archive,'-C',directory,name]);
 const bytes=await readFile(archive);
 return {directory,archive,bytes,output,home,build:hash=>exec(process.execPath,[builder,'--version',version,'--archive',archive,'--sha256',hash,'--output',output])};
}

const terminalDriver=String.raw`
import errno, os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:2])
output = bytearray()
answered = False
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    if select.select([fd], [], [], .05)[0]:
        try:
            output.extend(os.read(fd, 1024))
        except OSError as error:
            if error.errno != errno.EIO:
                raise
        if not answered and b'Open Mosaic setup now?' in output:
            answered = True
            os.write(fd, (sys.argv[2] + '\n').encode())
    child, status = os.waitpid(pid, os.WNOHANG)
    if child:
        sys.stdout.buffer.write(output)
        sys.exit(os.waitstatus_to_exitcode(status))
os.killpg(pid, signal.SIGKILL)
os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(124)
`;

async function activateInTerminal(launcher,env,answer){
 const {stdout}=await exec('/usr/bin/python3',['-c',terminalDriver,launcher,answer],{env,timeout:10000});
 return stdout;
}

test('macOS Installer stages a verified archive at a user-only destination, and the user launcher preserves its modes', {skip:!mac},async t=>{
 const f=await fixture(t);
 await f.build(sha(f.bytes));
 const packagePath=path.join(f.output,name+'.pkg'),expanded=path.join(f.directory,'expanded');
 const domains=await exec('/usr/sbin/installer',['-dominfo','-pkg',packagePath],{timeout:10000});
 assert.match(domains.stdout,/CurrentUserHomeDirectory/);
 assert.doesNotMatch(domains.stdout,/LocalSystem/);
 await exec('/usr/sbin/pkgutil',['--expand-full',packagePath,expanded]);
 const distribution=await readFile(path.join(expanded,'Distribution'),'utf8');
 assert.match(distribution,/<domains\s+enable_anywhere="false"\s+enable_currentUserHome="true"\s+enable_localSystem="false"\s*\/>/);
 assert.match(distribution,/hostArchitectures="arm64"/);
 const component=(await readdir(expanded)).find(entry=>entry.endsWith('.pkg'));
 assert.ok(component);
 const entries=await readdir(path.join(expanded,component));
 assert.ok(entries.includes('Payload'));
 assert.ok(!entries.includes('Scripts'));
 const payloadRoot=path.join(expanded,component,'Payload');
 assert.deepEqual(await readdir(payloadRoot),['Mosaic Setup']);
 const staged=path.join(payloadRoot,'Mosaic Setup',version);
 assert.deepEqual((await readdir(staged)).sort(),['Finish Installing Mosaic.command',name+'.tar.gz']);
 const stagedArchive=path.join(staged,name+'.tar.gz');
 assert.equal(sha(await readFile(stagedArchive)),sha(f.bytes));
 const launcher=path.join(staged,'Finish Installing Mosaic.command');
 assert.equal((await lstat(launcher)).mode&0o777,0o755);
 const env={...process.env,HOME:f.home,TMPDIR:f.directory};
 const activated=await exec(launcher,[],{env});
 assert.ok(activated.stdout.includes('Activated --no-path from '+f.directory+'/'));
 assert.ok(activated.stdout.includes('600:'+process.getuid()+'\n755:'+process.getuid()));
 assert.ok(!(await readdir(f.directory)).some(entry=>entry.startsWith('mosaic-setup.')));
 assert.doesNotMatch(activated.stdout,/Open(?:ed)? Mosaic setup/);
 const interactiveHome=path.join(f.directory,'Interactive Home');
 await mkdir(interactiveHome);
 const interactiveEnv={...env,HOME:interactiveHome};
 const first=await activateInTerminal(launcher,interactiveEnv,'y');
 assert.match(first,/Open Mosaic setup now\?/);
 assert.match(first,/Opened Mosaic setup/);
 const update=await activateInTerminal(launcher,interactiveEnv,'y');
 assert.doesNotMatch(update,/Open(?:ed)? Mosaic setup/);
 await writeFile(stagedArchive,'tampered archive');
 await assert.rejects(exec(launcher,[],{env}),error=>{
  assert.doesNotMatch(error.stdout,/Activated/);
  assert.match(error.stderr,/checksum/i);
  return true;
 });
});

test('macOS package builder refuses a mismatched checksum and existing package output', {skip:!mac},async t=>{
 const f=await fixture(t);
 await assert.rejects(f.build('0'.repeat(64)),/checksum/i);
 const packagePath=path.join(f.output,name+'.pkg');
 await mkdir(f.output,{recursive:true});
 await writeFile(packagePath,'retain me');
 await assert.rejects(f.build(sha(f.bytes)),/already exists/i);
 assert.equal(await readFile(packagePath,'utf8'),'retain me');
});
