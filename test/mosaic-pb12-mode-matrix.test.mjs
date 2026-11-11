import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {Integration} from '../src/harness/integration.mjs';
const reviewer={schema:1,id:'reviewer',revision:'r1',displayName:'Fixture reviewer',transport:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',model:'fixture-reviewer',roles:['reviewer'],capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]},maxContextTokens:null,maxOutputTokens:1024,concurrency:1,capacityGroup:'fixture',credentialRef:null,streaming:false};
const project={repo:'/fixture/matrix',baseCommit:'a'.repeat(40),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'unit',argv:['node','checks/unit.mjs']}]};
const matrix=[
 ['collaborative','codex','default',true],['collaborative','codex','host',true],['collaborative','codex','api',true],
 ['codex_only','codex','default',true],['codex_only','codex','host',true],['codex_only','codex','api',false],
 ['deepseek_only','deepseek','default',true],['deepseek_only','deepseek','host',false],['deepseek_only','deepseek','api',false],
 ['overnight_review','deepseek','default',true],['overnight_review','deepseek','host',true],['overnight_review','deepseek','api',true],
];
for(const beta of [false,true])for(const [mode,planner,source,allowed]of matrix)test(`public policy/authority matrix ${beta?'beta':'core'} ${mode} ${source}`,async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'pb12-matrix-'));
 const providers=ProviderRegistry({profiles:[reviewer]});
 const c=new Coordinator({root,beta,selectedHost:'cursor',providerRegistry:providers,workerProfile:{baseUrl:'http://127.0.0.1:1/v1',model:'fixture-worker',displayName:'Fixture',revision:'r1',streaming:false}});
 t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 const policy=source==='host'?{version:1,source:'host',hostId:'cursor',fallback:'wait'}:source==='api'?{version:1,source:'api',reviewer:providers.get('reviewer','r1'),fallback:'wait'}:undefined;
 const raw={submissionId:'matrix',objective:'Verify approved roles',acceptance:['Preserve role authority'],mode,modeVersion:1,environment:'fixture',project,...(policy?{reviewPolicy:policy}:{})};
 if(!allowed){assert.throws(()=>c.preparePortableGoal(raw,'prepare'),/Mode prohibits/i);assert.equal(c.store.all('goal').length,0);return;}
 const draft=c.preparePortableGoal(raw,'prepare');assert.equal(draft.manifest.mode.planner,planner);
 assert.equal(draft.manifest.reviewPolicy?.source,mode==='deepseek_only'?undefined:source==='default'?'host':source);
 const g=c.activateGoal({goalId:draft.id,hash:draft.hash},'activate');
 const task={goalId:g.id,submissionId:'code',kind:'coding',actor:'deepseek',objective:'Do approved work',acceptance:['Pass unit']};
 if(mode==='codex_only')assert.throws(()=>c.submitTask(task,'task'),/mode|actor/i);
 else{
  const workerTask=c.submitTask(task,'task');
  if(mode==='overnight_review'||mode==='deepseek_only')await assert.rejects(()=>new Integration({c}).beginNative(workerTask.id),/Mode prohibits native/i);
 }
 assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n,0,'Preparing roles and rejecting prohibited dispatch spends no provider request');
});
