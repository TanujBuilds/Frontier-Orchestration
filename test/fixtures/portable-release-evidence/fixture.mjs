import {mkdtemp,mkdir,writeFile,readFile,chmod,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
export const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
export const digest=v=>sha(canonical(v));
export const gates=['final-source-suite','independent-review','clean-machine','real-host-accounts','live-providers','other-platforms','signing-notarization','authenticated-download','public-source-license-audit','publication'];
export function tar(entries){
 const chunks=[];
 for(const [name,bytes,mode=0o644,type='0'] of entries){
  const h=Buffer.alloc(512),oct=(n,len)=>n.toString(8).padStart(len-1,'0')+'\0';
  let leaf=name,prefix='';if(Buffer.byteLength(name)>100){const i=name.lastIndexOf('/');prefix=name.slice(0,i);leaf=name.slice(i+1);}
  h.write(leaf,0,100);h.write(oct(mode,8),100);h.write(oct(0,8),108);h.write(oct(0,8),116);h.write(oct(bytes.length,12),124);h.write(oct(0,12),136);h.fill(32,148,156);h.write(type,156);h.write('ustar\0',257);h.write('00',263);h.write(prefix,345,155);h.write(h.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);
  chunks.push(h,bytes,Buffer.alloc((512-bytes.length%512)%512));
 }
 return Buffer.concat([...chunks,Buffer.alloc(1024)]);
}
export async function fixture(){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'portable-evidence-'))),source=path.join(root,'source'),evidenceRoot=path.join(root,'evidence'),reportDir=path.join(root,'reports');
 for(const p of [source,evidenceRoot,reportDir])await mkdir(p,{mode:0o700});
 const git=(...args)=>execFileSync('/usr/bin/git',args,{cwd:source,encoding:'utf8',env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
 git('init','-q');const sources={'src/project/check-backends/native-supervisor.c':'/* fixture native source */\n','src/beta/cli.mjs':'export const message="fixture only";\n','package.json':'{"name":"fixture","version":"0.0.0"}\n','package-lock.json':'{"packages":{"node_modules/@modelcontextprotocol/sdk":{"version":"1.32.2"}}}\n','scripts/package-beta.mjs':'// builder input\n','scripts/lib/beta-archive.mjs':'// archive input\n','scripts/lib/beta-candidate.mjs':'// candidate input\n','scripts/lib/beta-candidate.schema.json':'{}\n'};
 for(const [p,b] of Object.entries(sources)){await mkdir(path.dirname(path.join(source,p)),{recursive:true});await writeFile(path.join(source,p),b,{mode:0o644});}
 git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
 const commit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}'),version='0.1.0-beta.1',stem='mosaic-beta-'+version+'-darwin-arm64';
 const payload=new Map([['runtime/node_modules/@modelcontextprotocol/sdk/package.json',Buffer.from('{"version":"1.32.2"}\n')],['runtime/src/project/check-backends/native-supervisor.c',Buffer.from(sources['src/project/check-backends/native-supervisor.c'])],['runtime/src/beta/cli.mjs',Buffer.from(sources['src/beta/cli.mjs'])],['runtime/package-lock.json',Buffer.from(sources['package-lock.json'])],['runtime/package.json',Buffer.from(sources['package.json'])],['runtime/bin/node',Buffer.from('never execute\n')],['runtime/NODE-LICENSE',Buffer.from('Fixture node license\n')]]);
 const files=[...payload].sort(([a],[b])=>a<b?-1:1).map(([p,b])=>({path:p,sha256:sha(b),bytes:b.length,mode:p==='runtime/bin/node'?'100755':'100644'}));
 const manifest={schema:1,layout:'terminal-beta-v1',version,dependenciesInstalled:true,nodeVersion:'24.22.0',fixture:true,stateCompatibility:{settings:[1,2],database:[0,1]},files,contentHash:digest(files)};
 const archive=path.join(root,stem+'.tar.gz'),candidate=path.join(root,'candidate.json'),evidenceIndex=path.join(evidenceRoot,'index.json'),output=path.join(reportDir,'sidecar.json');
 const c={schema:1,kind:'mosaic-portable-beta-candidate',version,platform:'darwin-arm64',fixture:true,source:{commit,tree,dirty:false,closureHash:sha(JSON.stringify(files.filter(f=>f.path.startsWith('runtime/src/'))))},archive:{file:path.basename(archive),sha256:''},inventory:{file:'payload/package-manifest.json',sha256:'',contentHash:manifest.contentHash},versions:{coordinatorNode:'24.22.0',checkNode:null,sdk:'1.32.2',settingsSchemas:[1,2],databaseSchemas:[0,1]},build:{archiveFormat:'ustar-gzip-v1',timestamp:0,owner:0,group:0,inputs:Object.keys(sources).filter(p=>!p.startsWith('src/')&&p!=='package.json').map(p=>({path:p,sha256:sha(sources[p])})),runtimeInputs:files.filter(f=>['runtime/bin/node','runtime/NODE-LICENSE'].includes(f.path))},verification:{references:[],nativePreflight:null},unpassedGates:[...gates]};
 const records=[{path:'acceptance.json',role:'acceptance',scope:'source-fixture',text:JSON.stringify({acceptedCommit:commit,acceptedTree:tree,status:'accepted_locally',verification:{counts:{tests:2208,pass:2208,fail:0}}})},{path:'tests.txt',role:'test-log',scope:'installed-fixture',text:'ok harmless /Users/example is documentation, https://example.invalid and token=DEMONSTRATION are inert examples\n'},{path:'review.json',role:'review',scope:'source-fixture',text:JSON.stringify({candidateCommit:commit,candidateTree:tree,decision:'fixture only'})}];
 const f={root,source,evidenceRoot,reportDir,archive,candidate,evidenceIndex,output,c,manifest,payload,records,stem,git,opts:{candidate,archive,source,evidenceRoot,evidenceIndex,reportDir,output}};
 f.saveIndex=async()=>{const refs=[];for(const r of records){const b=Buffer.from(r.text);await writeFile(path.join(evidenceRoot,r.path),b);refs.push({path:r.path,sha256:sha(b),bytes:b.length,role:r.role,scope:r.scope});}const cb=await readFile(candidate);f.index={schema:1,kind:'mosaic-portable-evidence-index',binding:{candidateSha256:sha(cb),archiveSha256:c.archive.sha256,sourceCommit:commit,sourceTree:tree},records:refs};await writeFile(evidenceIndex,JSON.stringify(f.index));};
 f.saveArchive=async(mutate=entries=>entries)=>{const mb=Buffer.from(JSON.stringify(manifest,null,2)+'\n');c.inventory.sha256=sha(mb);c.inventory.contentHash=manifest.contentHash;const entries=[[stem+'/',Buffer.alloc(0),0o755,'5'],[stem+'/README.md',Buffer.from('fixture archive\n')],[stem+'/install',Buffer.from('must never execute\n'),0o755],...files.map(file=>[stem+'/payload/'+file.path,payload.get(file.path),parseInt(file.mode.slice(3),8)]),[stem+'/payload/package-manifest.json',mb],[stem+'/verify.sha256',Buffer.from([...files,{path:'package-manifest.json',sha256:sha(mb)}].map(file=>file.sha256+'  payload/'+file.path).join('\n')+'\n')]];const dirs=new Set(entries.filter(v=>v[3]==='5').map(v=>v[0]));for(const [n] of [...entries]){let d=path.posix.dirname(n);while(d!=='.'){dirs.add(d+'/');d=path.posix.dirname(d);}}for(const d of dirs)if(!entries.some(v=>v[0]===d))entries.push([d,Buffer.alloc(0),0o755,'5']);entries.sort(([a],[b])=>a<b?-1:1);const bytes=gzipSync(tar(mutate(entries)));c.archive.sha256=sha(bytes);await writeFile(archive,bytes);await writeFile(candidate,JSON.stringify(c));await f.saveIndex();};
 await f.saveArchive();return f;
}
