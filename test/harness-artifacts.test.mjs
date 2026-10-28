import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Artifacts} from '../src/harness/artifacts.mjs';
test('artifact references allow only saved reports, reject tampering and never expose arbitrary files',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-artifacts-')),c=new Coordinator({root});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const g=c.prepareGoal({submissionId:'g',objective:'Report',acceptance:['Evidence']},'g');c.activateGoal({goalId:g.id,hash:g.hash},'a');const task=c.submitTask({goalId:g.id,submissionId:'r',kind:'research',objective:'Research',acceptance:['Report']},'r'),directory=path.join(root,'research-results',task.id);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'report.md'),'# Saved report\n<script>hostile()</script>');await writeFile(path.join(directory,'private.json'),'hidden');
 c.store.tx(()=>{const record=c.store.get('task',task.id);record.result={directory,checksumsVerified:true};c.store.put('task',record);});const artifacts=new Artifacts(c),list=await artifacts.list(task.id);assert.equal(list.length,1);assert.equal(list[0].name,'report.md');assert.equal(list[0].file,undefined);const read=await artifacts.read(list[0].id);assert.match(read.data.toString(),/hostile/);assert.equal(read.type,'text/plain; charset=utf-8');
 await writeFile(path.join(directory,'report.md'),'Changed');await assert.rejects(artifacts.read(list[0].id),/checksum|changed/);await assert.rejects(artifacts.read('../connection.json'),/Unknown|Invalid/);
 await writeFile(path.join(directory,'report.md'),'# Saved report\n<script>hostile()</script>');await symlink(path.join(directory,'private.json'),path.join(directory,'claims.json'));await assert.rejects(artifacts.list(task.id),/symlink|unsafe/i);
});
test('an ancestor symlink cannot turn an artifact record into filesystem access outside state',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-artifact-link-')),outside=await mkdtemp(path.join(os.tmpdir(),'harness-artifact-outside-')),c=new Coordinator({root});t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});});
 await writeFile(path.join(outside,'report.md'),'Outside');await symlink(outside,path.join(root,'linked'));c.store.put('artifact',{id:'bad',taskId:'task',file:path.join(root,'linked/report.md'),name:'report.md',sha256:'fake',bytes:7,type:'text/plain; charset=utf-8'});await assert.rejects(new Artifacts(c).read('bad'),/unsafe|symlink|outside/i);
});
