import assert from 'node:assert/strict';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {ProviderRegistry} from '../../../src/harness/providers/registry.mjs';
import {Workspace} from '../../../src/project/workspace.mjs';
import {Journal} from '../../../src/project/journal.mjs';
import {CheckRunner} from '../../../src/project/sandbox.mjs';
import {git} from '../../../src/project/process.mjs';
const root=process.argv[2],repo=path.join(root,'repo'),native={version:1,backend:'darwin-seatbelt',backendRevision:1};
let modelPosts=0,codexPresent=false;for(const dir of process.env.PATH.split(path.delimiter)){try{await access(path.join(dir,'codex'),constants.X_OK);codexPresent=true;}catch{}}
assert.equal(codexPresent,false);
const server=createServer((req,res)=>{if(req.method==='POST')modelPosts++;res.writeHead(500).end('No requests authorized');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let c;
try{
 await mkdir(path.join(repo,'checks'),{recursive:true});await mkdir(path.join(repo,'src'));
 await writeFile(path.join(repo,'src/value.mjs'),'export const value = 1;\n');
 await writeFile(path.join(repo,'checks/check.mjs'),"import {writeFileSync} from 'node:fs'; writeFileSync('.overnight-output/CHECK-MARKER','unexpected');\n");
 await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture base');
 const baseCommit=await git(repo,'rev-parse','HEAD');
 const profile=id=>({schema:1,id,revision:'r1',displayName:id,transport:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',roles:['worker','reviewer'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding','consult']},maxContextTokens:32000,maxOutputTokens:2048,concurrency:1,capacityGroup:'loopback',credentialRef:'fixture',streaming:false});
 const providers=ProviderRegistry({profiles:['worker-a','worker-b','reviewer'].map(profile),credentialResolver:()=>undefined});
 c=new Coordinator({root:path.join(root,'state'),selectedHost:'cursor',providerRegistry:providers});
 const project={repo,baseCommit,readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'check',argv:[process.execPath,'checks/check.mjs'],timeoutMs:1000}]};
 const reasons=[];
 for(const source of ['host','api']){
  const raw={submissionId:source,objective:'Two routed tasks require protected native checks',acceptance:['Checked integrated output'],mode:'collaborative',environment:'fixture',executionPolicy:native,project,providerPolicy:{version:1,workers:providers.snapshot(['worker-a','worker-b'].map(id=>({id,revision:'r1'}))),plannerWorkerId:'worker-a',defaultWorkerId:'worker-a',maxConcurrentTasks:1,capacityGroups:[{id:'loopback',limit:1}]},routingPolicy:{version:1,rules:[{id:'backend',category:'backend',providerId:'worker-a'},{id:'frontend',category:'frontend',providerId:'worker-b'}],defaultWorkerId:'worker-a'},reviewPolicy:source==='host'?{version:1,source,hostId:'cursor',fallback:'wait'}:{version:1,source,reviewer:providers.get('reviewer','r1'),fallback:'wait'}};
  const g=c.preparePortableGoal(raw,'prepare-'+source);
  assert.throws(()=>c.activateGoal({goalId:g.id,hash:g.hash},'activate-'+source),error=>{reasons.push(error.message);return /descendant.*containment|containment.*descendant/i.test(error.message);});
  assert.equal(c.store.spent(g.id).model??0,0);assert.deepEqual(c.getGoal(g.id).tasks,[]);
 }
 const journal=await new Journal(path.join(root,'checks'),'11111111-1111-4111-8111-111111111111').load();
 const workspace=new Workspace({repo,baseCommit,executionPolicy:native,permissions:project},journal);await workspace.initialize();await workspace.recover();
 const runner=new CheckRunner(workspace,{backend:native.backend});assert.equal(runner.backendIdentity.id,native.backend);
 for(const action of [()=>runner.verify(),()=>runner.run(project.checks,'must-not-run'),()=>runner.execute([process.execPath,'checks/check.mjs'],1000)])await assert.rejects(action(),error=>{reasons.push(error.message);return /descendant.*containment|containment.*descendant/i.test(error.message);});
 let checkMarker=false;try{await readFile(path.join(workspace.root,'.overnight-output/CHECK-MARKER'));checkMarker=true;}catch{}
 assert.equal(modelPosts,0);assert.equal(checkMarker,false);
 console.log(JSON.stringify({codexPresent,modelPosts,checkMarker,lifecycle:'BLOCKED',fullNativeLifecycle:'NOT_RUN',twoRoutedTasks:'NOT_RUN',reason:reasons[0],actualNativeBackend:runner.backendIdentity.id,protectedActionsBlocked:3,reviewSourcesPrepared:['host','api']}));
}finally{c?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
