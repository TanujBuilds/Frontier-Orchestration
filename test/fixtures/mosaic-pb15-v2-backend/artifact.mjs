import {mkdtemp,copyFile,readFile,writeFile,chmod,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const hash=b=>createHash('sha256').update(b).digest('hex');
export async function artifact(node=process.execPath){
 const root=await mkdtemp('/private/tmp/mosaic-v2-artifact-');
 await copyFile(node,path.join(root,'node'));await chmod(path.join(root,'node'),0o755);
 execFileSync('/usr/bin/clang',['-std=c11','-O2','-Wall','-Wextra','-Werror',fileURLToPath(new URL('../../../src/project/check-backends/native-supervisor.c',import.meta.url)),'-o',path.join(root,'mosaic-check-supervisor')]);
 await writeFile(path.join(root,'NODE-LICENSE'),'test artifact license\n',{mode:0o644});
 const files=[];for(const name of ['node','mosaic-check-supervisor','NODE-LICENSE']){const bytes=await readFile(path.join(root,name));files.push({path:name,sha256:hash(bytes),bytes:bytes.length,mode:name==='NODE-LICENSE'?'100644':'100755'});}
 const manifest={schema:1,platform:'darwin',arch:'arm64',nodeVersion:'24.22.0',supervisorProtocol:1,files,provenance:{nodeSource:{version:'24.22.0',url:'https://nodejs.org/dist/v24.22.0/node-v24.22.0.tar.xz',sha256:'a'.repeat(64)},nodePatch:{sha256:'b'.repeat(64),description:'test-owned explicit fork-only runtime'},supervisorSourceSha256:hash(await readFile(fileURLToPath(new URL('../../../src/project/check-backends/native-supervisor.c',import.meta.url)))),build:{compiler:'test clang',platform:'darwin-arm64'}}};
 const artifactManifestPath=path.join(root,'artifact-manifest.json');await writeFile(artifactManifestPath,JSON.stringify(manifest)+'\n',{mode:0o644});return {root,config:{schema:1,artifactManifestPath,artifactManifestSha256:hash(await readFile(artifactManifestPath))},manifest};
}
export async function workspace(root,journalDir=path.dirname(root)){
 await mkdir(path.join(root,'src'),{recursive:true});await mkdir(path.join(root,'checks'),{recursive:true});await mkdir(path.join(root,'dist'),{recursive:true});await mkdir(path.join(root,'.overnight-output'),{recursive:true});await writeFile(path.join(root,'src/value.mjs'),'export const value=42;\n');await writeFile(path.join(root,'checks/value.mjs'),'console.log("native-check-ok")\n');
 return {root,manifest:{permissions:{readPaths:['src/','checks/'],writePaths:['src/']},overnightV2:true},journal:{dir:journalDir},file:async f=>path.join(root,f),inventory:async()=>Promise.all(['src/value.mjs','checks/value.mjs'].map(async f=>({path:f,hash:hash(await readFile(path.join(root,f)))}))),fileMode:async()=> '100644',snapshot:async()=>({'src/value.mjs':'a','checks/value.mjs':'b'}),assertSnapshot:async()=>{}};
}
