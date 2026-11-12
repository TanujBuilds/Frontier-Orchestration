import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {Registry,normalizeGoal,digest,canonical,providerBinding} from '../src/harness/contracts.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {WorkflowRecipes} from '../src/harness/workflow-recipes/service.mjs';
import {compileRecipe} from '../src/harness/workflow-recipes/compile.mjs';
import {builtins} from '../src/harness/workflow-recipes/catalog.mjs';
import {summarizeOutcomes} from '../src/harness/outcomes/aggregate.mjs';
import {readOutcomeSnapshotFromDatabase} from '../src/harness/outcomes/snapshot.mjs';
import {actorRows} from '../src/beta/observer.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {runComposition} from './fixtures/mosaic-pb13/composition.mjs';

const project={repo:'/tmp/legacy-recipe',baseCommit:'a'.repeat(40),readPaths:['src/'],writePaths:['src/'],checks:[{id:'verify',argv:['node','checks/verify.mjs']}]};
const profile=id=>({schema:1,id:'worker-'+id,revision:'r1',displayName:'Fixture '+id,transport:'openai-chat',baseUrl:'http://127.0.0.1:'+(id==='a'?1:2)+'/v1',model:'model-'+id,roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding','consult']},maxContextTokens:32000,maxOutputTokens:2048,concurrency:1,capacityGroup:'group-'+id,credentialRef:null,streaming:false});
const taskRouting={backend:{version:1,category:'backend'},frontend:{version:1,category:'frontend'}};
const recipe={schemaVersion:1,id:'two-parts',version:1,title:'Two fixture parts',mode:'collaborative',parameters:{},tasks:[
 {key:'backend',kind:'coding',objective:'Implement checked backend',acceptance:['Backend passes'],dependsOn:[],permissions:{readPaths:['src/'],writePaths:['src/backend.mjs'],checks:['verify']}},
 {key:'frontend',kind:'coding',objective:'Implement checked frontend',acceptance:['Frontend passes'],dependsOn:['backend'],permissions:{readPaths:['src/'],writePaths:['src/frontend.mjs'],checks:['verify']}},
],provenance:{source:'Offline fixture',description:'Trusted two-task composition fixture'}};
const counts=c=>Object.fromEntries(['records','commands','submissions','events','requests'].map(table=>[table,c.store.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n]));
function fixture(t,{beta=false,routing=true,defaultWorkerId='worker-a'}={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'pb13-composition-unit-'));
 const registry=ProviderRegistry({profiles:[profile('a'),profile('b')]});
 const c=new Coordinator({root,beta,selectedHost:'cursor',providerRegistry:registry});
 t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 const workers=registry.snapshot([{id:'worker-a',revision:'r1'},{id:'worker-b',revision:'r1'}]);
 const raw={submissionId:'composition',objective:'Implement two checked parts',acceptance:['Both pass'],environment:'fixture',mode:'collaborative',project,limits:{maxTasks:10},providerPolicy:{version:1,workers,plannerWorkerId:'worker-a',defaultWorkerId,maxConcurrentTasks:1,capacityGroups:[{id:'group-a',limit:1},{id:'group-b',limit:1}]},...(routing?{routingPolicy:{version:1,rules:[{id:'backend-rule',category:'backend',providerId:'worker-a'},{id:'frontend-rule',category:'frontend',providerId:'worker-b'}],defaultWorkerId:'worker-a'}}:{})};
 const draft=c.preparePortableGoal(raw,'prepare'),g=c.activateGoal({goalId:draft.id,hash:draft.hash},'activate');
 const d=new Dispatcher({c,config:{beta}}),recipes=new WorkflowRecipes({c});recipes.register(recipe);
 const preview=()=>recipes.preview({goalId:g.id,recipeId:recipe.id,version:1,parameters:{},taskRouting});
 const input=p=>({goalId:g.id,recipeId:recipe.id,version:1,parameters:{},taskRouting,expectedGoalHash:p.goalHash,definitionDigest:p.definitionDigest,parameterDigest:p.parameterDigest,previewDigest:p.previewDigest,submissionId:'parts'});
 return {c,d,g,raw,recipes,preview,input,root};
}

test('absent recipe routing preserves the exact historical built-in compilation identities',()=>{
 const registry=new Registry(),manifest=normalizeGoal({submissionId:'legacy',objective:'Preserve recipe bytes',acceptance:['Checked'],environment:'fixture',mode:'collaborative',project});
 const hashes={bugfix:'79e03f59038a8aee05847dddf3ad39d58a69eb37f108edd7a03e36e9f4bd7baa',feature:'010e54856cfaab0f0b38e549da42ad52a8cf6a57510e94e3a6e30dcd88f68140'};
 for(const definition of builtins.filter(x=>Object.hasOwn(hashes,x.id))){
  const parameters={...(definition.id==='feature'?{brief:'Add a value',acceptance:'Value is checked'}:{issue:'Fix a value',context:'Preserve inputs'}),readPaths:['src/'],writePaths:['src/value.mjs'],checks:['verify']};
  assert.equal(digest(compileRecipe({definition,parameters,goal:{manifest},registry})),hashes[definition.id]);
 }
});

test('two-task recipe previews normalized strict routes without writes and submits atomically with replay conflicts',t=>{
 const f=fixture(t),before=counts(f.c),p=f.preview();
 assert.equal(p.launchable,true,JSON.stringify(p.diagnostics));
 assert.deepEqual(p.requirements.tasks.map(x=>[x.key,x.route.binding.providerId,x.routing.category,x.route.status]),[['backend','worker-a','backend','waiting'],['frontend','worker-b','frontend','waiting']]);
 assert.deepEqual(counts(f.c),before);assert.equal(p.requirements.tasks[0].route.reasonCode,'availability_unknown');
 const reordered={frontend:{category:'frontend',version:1},backend:{category:'backend',version:1}};
 assert.deepEqual(f.recipes.preview({goalId:f.g.id,recipeId:recipe.id,version:1,parameters:{},taskRouting:reordered}),p);
 const input=f.input(p),run=f.recipes.submit(input,'submit');assert.equal(run.tasks.length,2);
 assert.deepEqual(f.recipes.submit(input,'submit'),run);assert.deepEqual(f.recipes.submit(input,'replay'),run);
 const restored=new WorkflowRecipes({c:f.c});assert.deepEqual(restored.submit(input,'catalog-free-replay'),run);
 const tasks=run.tasks.map(id=>f.c.getTask(id));assert.deepEqual(tasks.map(x=>x.spec.routing.category),['backend','frontend']);assert.deepEqual(tasks[1].spec.dependsOn,[tasks[0].id]);assert.equal(tasks[0].providerBinding,undefined);
 const changed={...input,taskRouting:{...taskRouting,frontend:{version:1,category:'backend'}}};
 assert.throws(()=>f.recipes.submit(changed,'changed'),/conflict/i);
 assert.equal(f.c.registry.workflows.size,0);
});

test('recipe map is optional in public tools and cannot add tasks or permission fields',async t=>{
 const f=fixture(t),parameters={issue:'Fix a value',readPaths:['src/'],writePaths:['src/backend.mjs'],checks:['verify']};
 const base={goalId:f.g.id,recipeId:'bugfix',version:1,parameters};
 const ordinary=await f.d.invoke('workflow_recipe_preview',base);assert.equal(ordinary.launchable,true);
 const mapped=await f.d.invoke('workflow_recipe_preview',{...base,taskRouting:{fix:{version:1,category:'backend'}}});
 assert.equal(mapped.requirements.tasks[0].route.binding.providerId,'worker-a');
 for(const map of [{outside:{version:1}}, {fix:{version:1,permissions:{writePaths:['/']}}}, {fix:{version:1,category:'unknown'}}]){
  await assert.rejects(f.d.invoke('workflow_recipe_preview',{...base,taskRouting:map}),/task|routing|field|categor/i);
 }
 const before=counts(f.c),bad=f.recipes.preview({goalId:f.g.id,recipeId:recipe.id,version:1,parameters:{},taskRouting:{...taskRouting,frontend:{version:1,preferredProviderId:'outside'}}});
 assert.equal(bad.launchable,false);assert.throws(()=>f.recipes.submit({...f.input(bad),taskRouting:{...taskRouting,frontend:{version:1,preferredProviderId:'outside'}}},'bad'),/approved|routing/i);assert.deepEqual(counts(f.c),before);
});

test('a new recipe preview cannot inherit an unrelated started task pin whose submissionId equals a local recipe key',t=>{
 const f=fixture(t),{key,...spec}=recipe.tasks[0],saved=f.c.submitTask({goalId:f.g.id,...spec,submissionId:key,routing:taskRouting.backend},'unrelated-task');
 // Complete saved pin fixture, followed by an ordinary approved preference change.
 const task=f.c.getTask(saved.id),binding=providerBinding(f.g.manifest,'worker-a');task.startedAt=Date.now();task.providerBinding=binding;task.route={version:1,goalHash:f.g.hash,goalVersion:1,taskHash:task.hash,decision:{status:'selected',binding,reasonCode:'selected_by_rule',explanation:'Original backend rule chose worker-a.',matchedRule:{id:'backend-rule',category:'backend',providerId:'worker-a'}}};task.routeHash=digest(task.route);f.c.store.put('task',task);
 const goals=new Goals(f.c),revision=goals.prepareRevision({goalId:f.g.id,expectedHash:f.g.hash,manifest:{...f.raw,routingPolicy:{...f.raw.routingPolicy,rules:[{id:'backend-new',category:'backend',providerId:'worker-b'}]}}},'new-recipe-preference');goals.activateRevision({revisionId:revision.id,hash:revision.hash},'new-recipe-active');goals.rebind({taskId:task.id},'old-task-keeps-pin');
 const before=counts(f.c),p=f.preview();assert.equal(p.requirements.tasks[0].route.binding.providerId,'worker-b');assert.equal(f.c.getTask(task.id).providerBinding.providerId,'worker-a');assert.deepEqual(counts(f.c),before);
});

test('workflow registration normalizes routing and preserves legacy definition bytes',t=>{
 const f=fixture(t),legacy={id:'legacy',version:1,mode:'collaborative',tasks:[{key:'one',kind:'coding',objective:'Keep behavior',acceptance:['Checked']}]};
 assert.equal(canonical(f.c.registry.registerWorkflow(legacy)),canonical(legacy));
 const definition={id:'routed',version:1,mode:'collaborative',tasks:recipe.tasks.map(x=>({...x,routing:taskRouting[x.key]}))};
 const registered=f.c.registry.registerWorkflow(definition);assert.equal(registered.tasks[0].routing.minContextTokens,null);
 const run=f.c.submitWorkflow({goalId:f.g.id,workflowId:'routed',version:1,submissionId:'workflow'},'workflow-submit');assert.deepEqual(run.tasks.map(id=>f.c.getTask(id).spec.routing.category),['backend','frontend']);
 assert.throws(()=>f.c.registry.registerWorkflow({...definition,id:'bad',tasks:[{...definition.tasks[0],routing:{version:1,command:'unsafe'}}]}),/routing/i);
 const inherited=Object.assign(Object.create({untrusted:true}),{version:1,category:'backend'});
 assert.throws(()=>f.c.registry.registerWorkflow({...definition,id:'prototype',tasks:[{...definition.tasks[0],routing:inherited}]}),/routing/i);
});

test('backlog preview and saved wait projection distinguish proposed route from an execution pin',async t=>{
 const f=fixture(t),input={goalId:f.g.id,expectedGoalHash:f.g.hash,expectedGoalVersion:f.g.version,submissionId:'backlog',items:recipe.tasks.map(({key,dependsOn,...task})=>({key,dependsOnKeys:dependsOn,task:{...task,routing:taskRouting[key]}}))};
 const before=counts(f.c),p=await f.d.invoke('backlog_preview',input);assert.equal(p.valid,true);
 assert.deepEqual(p.routes.map(x=>[x.key,x.route.binding.providerId]),[['backend','worker-a'],['frontend','worker-b']]);assert.deepEqual(counts(f.c),before);
 const run=await f.d.invoke('backlog_submit',{...input,idempotencyKey:'backlog'}),id=run.items[0].taskId,task=f.c.getTask(id);
 task.routingWait={retryAt:Date.now()+1000,goalHash:f.g.hash,goalVersion:f.g.version,taskHash:task.hash,decision:{status:'waiting',binding:providerBinding(f.g.manifest,'worker-a'),reasonCode:'provider_offline',explanation:'Selected worker-a is offline; wait without fallback.',matchedRule:{id:'backend-rule',category:'backend',providerId:'worker-a'}}};f.c.store.put('task',task);
 const view=await f.d.invoke('backlog_inspect',{groupId:run.id});const item=view.groups[0].items[0];assert.equal(item.status,'waiting_provider');assert.equal(item.reasonCode,'provider_offline');assert.equal(item.worker,null);assert.equal(item.routingWait.decision.binding.providerId,'worker-a');assert.equal(f.c.store.spent(id).model??0,0);
});

test('outcomes and beta observer attribute the actual legacy pin without inventing current-rule provenance',async t=>{
 const f=fixture(t,{beta:true,routing:false,defaultWorkerId:'worker-b'}),saved=f.c.submitTask({goalId:f.g.id,submissionId:'legacy-pin',kind:'coding',objective:'Legacy bound work',acceptance:['Checked']},'legacy-task');
 // Pure saved-record projection fixture: there is deliberately no routing decision.
 const task=f.c.getTask(saved.id);task.providerBinding=providerBinding(f.g.manifest,'worker-b');f.c.store.put('task',task);
 const report=await f.d.invoke('outcomes_report',{goalId:f.g.id});assert.equal(report.tasks[0].worker.providerId,'worker-b');assert.equal(report.tasks[0].worker.routeReasonCode,null);assert.equal(report.tasks[0].worker.routeProvenance,'legacy_binding');
 const snapshot=await f.d.invoke('observer_snapshot',{goalId:f.g.id});assert.equal(snapshot.tasks[0].worker.providerId,'worker-b');assert.equal(actorRows({snapshot,goalId:f.g.id})[0].actor,'Fixture b');
 const corrupt=readOutcomeSnapshotFromDatabase(f.c.store.db,{goalId:f.g.id});corrupt.tasks[0].providerBinding.profileHash='0'.repeat(64);const invalid=summarizeOutcomes(corrupt);assert.equal(invalid.tasks[0].worker.providerId,null);assert.equal(invalid.tasks[0].worker.bindingProvenance,'unverified');
 task.startedAt=Date.now();f.c.store.put('task',task);
 const goals=new Goals(f.c),revision=goals.prepareRevision({goalId:f.g.id,expectedHash:f.g.hash,manifest:{...f.raw,routingPolicy:{version:1,rules:[{id:'new-default',category:'general',providerId:'worker-a'}],defaultWorkerId:'worker-a'}}},'adopt-routing');goals.activateRevision({revisionId:revision.id,hash:revision.hash},'adopt-active');
 const rebound=goals.rebind({taskId:task.id},'legacy-rebind');assert.equal(rebound.spec.routing,undefined);assert.equal(rebound.route,undefined);
 const adopted=await f.d.invoke('outcomes_report',{goalId:f.g.id});assert.equal(adopted.tasks[0].worker.providerId,'worker-b');assert.equal(adopted.tasks[0].worker.routeProvenance,'legacy_binding');
 assert.equal((await f.d.invoke('observer_snapshot',{goalId:f.g.id})).tasks[0].worker.providerId,'worker-b');
});

test('recorded route and request pins survive outcome projection with honest token coverage and conflicting-pin diagnostics',async t=>{
 const f=fixture(t,{beta:true}),saved=f.c.submitTask({goalId:f.g.id,submissionId:'pinned',kind:'coding',objective:'Pinned route fixture',acceptance:['Checked'],routing:{version:1,category:'frontend'}},'pinned-task');
 const task=f.c.getTask(saved.id),binding=providerBinding(f.g.manifest,'worker-b');
 task.providerBinding=binding;task.providerModel='model-b';task.route={version:1,goalHash:f.g.hash,goalVersion:1,taskHash:task.hash,decision:{status:'selected',binding,reasonCode:'selected_by_rule',explanation:'Rule frontend-rule chose worker-b.',matchedRule:{id:'frontend-rule',category:'frontend',providerId:'worker-b'}}};task.routeHash=digest(task.route);f.c.store.put('task',task);
 for(const [id,usage] of [['known',{prompt_tokens:9,completion_tokens:4}],['missing',undefined]]){
  const data={providerBinding:binding,routeHash:task.routeHash,reservedAt:1,savedAt:2,result:{model:'reported-b',...(usage?{usage}:{})}};
  f.c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(id,task.id,id,'model','completed',JSON.stringify(data));
 }
 const report=await f.d.invoke('outcomes_report',{goalId:f.g.id});assert.equal(report.tasks[0].worker.providerId,'worker-b');assert.equal(report.tasks[0].worker.routeReasonCode,'selected_by_rule');
 assert.equal(report.tasks[0].worker.reportedModel,null,'A pre-dispatch resolved model is not a provider-reported response identity');assert.equal(report.tasks[0].worker.resolvedModel,'model-b');
 const request=report.usage.requests.find(x=>x.id==='known');assert.deepEqual(request.providerBinding,binding);assert.equal(request.routeHash,task.routeHash);assert.equal(request.requestedModel,'model-b');assert.equal(request.reportedModel,'reported-b');assert.equal(request.role,'worker');
 assert.equal(report.usage.input.knownTokens,9);assert.equal(report.usage.input.knownRequests,1);assert.equal(report.usage.input.eligibleRequests,2);assert.equal(report.usage.requests.find(x=>x.id==='missing').knownInputTokens,null);assert.equal(report.usage.nativeHost.tokens,null);
 const snapshot=readOutcomeSnapshotFromDatabase(f.c.store.db,{goalId:f.g.id});const duplicate=structuredClone(snapshot.requests[0]);duplicate.data.providerBinding=providerBinding(f.g.manifest,'worker-a');snapshot.requests.push(duplicate);
 const conflict=summarizeOutcomes(snapshot);assert.ok(conflict.diagnostics.some(x=>x.code==='conflicting_request_rows'));assert.equal(conflict.usage.requests.find(x=>x.id===duplicate.id).providerBinding,null);
 const broken=readOutcomeSnapshotFromDatabase(f.c.store.db,{goalId:f.g.id});broken.tasks[0].route.goalHash='0'.repeat(64);broken.tasks[0].routeHash=digest(broken.tasks[0].route);assert.equal(summarizeOutcomes(broken).tasks[0].worker.routeProvenance,'unverified');
 const mislabeled=readOutcomeSnapshotFromDatabase(f.c.store.db,{goalId:f.g.id});mislabeled.tasks[0].route.decision.reasonCode='selected_by_default';mislabeled.tasks[0].routeHash=digest(mislabeled.tasks[0].route);assert.equal(summarizeOutcomes(mislabeled).tasks[0].worker.routeProvenance,'unverified');
 const malformed=readOutcomeSnapshotFromDatabase(f.c.store.db,{goalId:f.g.id});malformed.requests[0].data.providerBinding.profileHash=Infinity;assert.doesNotThrow(()=>summarizeOutcomes(malformed));
 task.startedAt=Date.now();f.c.store.put('task',task);
 const goals=new Goals(f.c),revision=goals.prepareRevision({goalId:f.g.id,expectedHash:f.g.hash,manifest:{...f.raw,routingPolicy:{...f.raw.routingPolicy,rules:[]}}},'changed-preference');goals.activateRevision({revisionId:revision.id,hash:revision.hash},'changed-active');
 goals.rebind({taskId:task.id,spec:{...task.spec,permissions:{...task.spec.permissions,writePaths:['src/frontend.mjs']}}},'narrow-pinned-scope');
 const narrowed=await f.d.invoke('outcomes_report',{goalId:f.g.id});assert.equal(narrowed.tasks[0].worker.providerId,'worker-b');assert.equal(narrowed.tasks[0].worker.routeProvenance,'recorded');assert.equal(narrowed.tasks[0].worker.routeReasonCode,'selected_by_rule');assert.equal(narrowed.usage.requests[0].providerBinding.providerId,'worker-b');
 const view=await f.d.invoke('observer_snapshot',{goalId:f.g.id});assert.equal(view.tasks[0].worker.routeReasonCode,'selected_by_rule');assert.equal(view.tasks[0].worker.providerId,'worker-b');
});

for(const [review,beta] of [['host',true],['api',false]])test(`two sequential routed workers compose protected failed-check repair, ${review} review, restart and exactly-once useful integration`,{timeout:120000},async t=>{
 const parent=mkdtempSync(path.join(os.tmpdir(),'pb13-routed-integration-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));
 const result=await runComposition({root:path.join(parent,'composition'),review,beta});
 assert.equal(result.usefulAccepted,2);assert.deepEqual(result.tasks.map(task=>task.worker.providerId),['worker-a','worker-b']);assert.deepEqual(result.tasks.map(task=>task.attemptCount),[2,1]);assert.equal(result.usage.known,result.usage.eligible-1);assert.equal(result.maxSimultaneousFixtureRequests,1);
});
