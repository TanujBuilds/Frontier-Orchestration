import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdir,writeFile,appendFile,readFile} from 'node:fs/promises';
import {buildFixtureArtifact,hash} from './artifact.mjs';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Worker} from '../../../src/harness/worker.mjs';
import {ProviderRegistry} from '../../../src/harness/providers/registry.mjs';
import {git} from '../../../src/project/process.mjs';

const root=process.argv[2],variant=process.argv[3];
let c,worker,goal,posts=0,reason;
const server=http.createServer(async(req,res)=>{for await(const _ of req){}posts++;res.writeHead(500).end('Unexpected fixture inference');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 await mkdir(root,{mode:0o700});
 if(variant==='stock-node')assert.notEqual(hash(await readFile(process.execPath)),hash(await readFile(process.env.MOSAIC_NATIVE_TEST_NODE)),'Run this negative probe with the ordinary coordinator Node, separately from the fork-only check Node');
 const artifact=await buildFixtureArtifact(root,variant==='stock-node'?{builtNode:process.execPath}:{});
 const nativeCheckRuntime={...artifact.config},executionPolicy={...artifact.policy};
 const repo=path.join(root,'repo');await mkdir(path.join(repo,'checks'),{recursive:true});await mkdir(path.join(repo,'src'));
 await writeFile(path.join(repo,'src/value.mjs'),'export const value=0;\n');
 await writeFile(path.join(repo,'checks/check.mjs'),"require('node:fs').writeFileSync('dist/must-not-run','bad');\n");
 await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Base');
 const profile={schema:1,id:'worker',revision:'r1',displayName:'Loopback worker',transport:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding']},maxContextTokens:32000,maxOutputTokens:2048,concurrency:1,capacityGroup:'fixture',credentialRef:null,streaming:false};
 const reviewer={...profile,id:'reviewer',roles:['reviewer'],capabilities:{workerProtocol:null,transports:['json'],modelDiscovery:'manual',taskKinds:[]}};
 const providers=ProviderRegistry({profiles:[profile,reviewer]});
 if(variant==='missing-manifest')nativeCheckRuntime.artifactManifestPath=path.join(root,'missing-manifest.json');
 if(variant==='changed-node')await appendFile(path.join(artifact.root,'node'),'changed runtime');
 if(variant==='wrong-fingerprint')executionPolicy.runtimeFingerprint='0'.repeat(64);
 try{
  c=new Coordinator({root:path.join(root,'state'),selectedHost:'cursor',providerRegistry:providers,nativeCheckRuntime,executionPolicy});
  worker=new Worker({c,config:{environment:'fixture',nativeCheckRuntime}});
  goal=c.preparePortableGoal({submissionId:'prerequisite',objective:'Reject unavailable native prerequisite before inference',acceptance:['No POST and no protected command'],mode:'collaborative',environment:'fixture',executionPolicy,reviewPolicy:{version:1,source:'api',reviewer:providers.get('reviewer','r1'),fallback:'wait'},project:{repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'check',argv:[path.join(artifact.root,'node'),'checks/check.mjs'],timeoutMs:1000}]}},'prepare');
  const receipt=await c.preflightExecution({goalId:goal.id,hash:goal.hash},{config:{nativeCheckRuntime}});
  if(receipt?.passed!==true)throw Error(receipt?.reason??'Native preflight did not pass');
  assert.fail('Invalid artifact must not pass real isolation preflight');
 }catch(error){if(error.code==='ERR_ASSERTION')throw error;reason=String(error.message);}
 assert.ok(reason,'Prerequisite must reject');
 if(goal){assert.throws(()=>c.activateGoal({goalId:goal.id,hash:goal.hash},'activate'),/preflight|isolation|runtime|artifact|quiescen/i);await worker.drain();assert.equal(c.getGoal(goal.id).status,'draft');assert.equal(c.store.spent(goal.id).model??0,0);}
 assert.equal(posts,0);
 console.log(JSON.stringify({variant,blocked:true,reason,posts,goalStatus:goal?c.getGoal(goal.id).status:null,workerPosts:0,plannerPosts:0,reviewerPosts:0}));
}finally{if(worker)await worker.close();c?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
