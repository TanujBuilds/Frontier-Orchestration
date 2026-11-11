// Fresh service preparation receives trusted host selection through runtime configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {once} from 'node:events';
import os from 'node:os';
import path from 'node:path';

test('service preparation uses the trusted injected provider catalog', {timeout: 20000}, async t => {
 const root=await mkdtemp(path.join(os.tmpdir(),'mosaic-pb11-service-'));
 const profile={schema:1,id:'service-worker',revision:'r1',displayName:'Fixture worker',
  transport:'openai-chat',baseUrl:'http://127.0.0.1:9/v1',model:'fixture-alias',roles:['worker'],
  capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding','consult']},
  maxContextTokens:null,maxOutputTokens:8000,concurrency:1,capacityGroup:'fixture-group',credentialRef:null,streaming:false};
 const cli=new URL('../src/harness/cli.mjs',import.meta.url).href;
 const registry=new URL('../src/harness/providers/registry.mjs',import.meta.url).href;
 const script=`import {serve} from ${JSON.stringify(cli)};import {ProviderRegistry} from ${JSON.stringify(registry)};await serve({root:process.argv[1],port:0,headless:true,runtimeConfig:{environment:'fixture',hostId:'codex',providerRegistry:new ProviderRegistry({profiles:[${JSON.stringify(profile)}]})}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,root],{stdio:['ignore','pipe','pipe']});
 const closed=once(child,'close');let output='',errors='';
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stderr.on('data',s=>{errors+=s;});
 t.after(async()=>{if(child.exitCode===null)child.kill('SIGTERM');await closed;await rm(root,{recursive:true,force:true});});
 await Promise.race([
  new Promise(resolve=>child.stdout.on('data',s=>{output+=s;if(output.includes('\n'))resolve();})),
  closed.then(()=>{throw Error('Service stopped before readiness: '+errors);}),
 ]);
 const connection=JSON.parse(await readFile(path.join(root,'connection.json'),'utf8'));
 const {credentialRef,...snapshot}=profile;
 const manifest={submissionId:'service-policy',objective:'Prepare through the service catalog',acceptance:['Policy stays approved'],
  environment:'fixture',providerPolicy:{version:1,workers:[snapshot],plannerWorkerId:profile.id,defaultWorkerId:profile.id,maxConcurrentTasks:1,capacityGroups:[{id:profile.capacityGroup,limit:1}]}};
 const input={idempotencyKey:'prepare-policy',manifest};
 const invoke=()=>fetch(connection.url+'/api/invoke',{method:'POST',headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'},body:JSON.stringify({name:'goal_prepare',input})});
 const response=await invoke(),prepared=await response.json();
 assert.equal(response.status,200,JSON.stringify(prepared));
 assert.equal(prepared.manifest.providerPolicy.defaultWorkerId,'service-worker');
 assert.equal(prepared.manifest.workerProfile,undefined);
 assert.equal(JSON.stringify(prepared).includes('credentialRef'),false);
 const replay=await (await invoke()).json();assert.equal(replay.id,prepared.id);assert.equal(replay.hash,prepared.hash);
 child.kill('SIGTERM');const [exitCode]=await closed;assert.equal(exitCode,0,errors);
});
