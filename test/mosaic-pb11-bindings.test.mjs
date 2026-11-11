// Fresh portable provider fixtures select their host; literal historical approval fixtures stay unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {Registry,canonical,digest,goalInputSchema,taskInputSchema} from '../src/harness/contracts.mjs';
import {repository,assignment} from './fixtures/mosaic-assignment/repository.mjs';

// Literal baseline captured from released caefdb9 before provider implementation.
const historical={
 collaborative:['9d1f9691ca16db847fdf2ee97a378bca9b76122cff6f152e18c413c4bc0172fa','ae18f51b67d4a6dae07329d26a4feb92f3aea8c29ad026a61da13f71f4a77c9b'],
 deepseek_only:['18f78b97540473a81c3ed1a76e3ad8d868dc56a3328d2260459d8d1f4092d375','65e80d63bfd74e99a051f317edd1c5e4ba8e33ecb6d9893b2f98593eec2c88b6'],
 codex_only:['45c276c8b2e173fd5a3dfa92463856ce31ced060bf0a3571503f6286e44d76c8','eec9c5f9671e87f4a2a0ef5d3b3b6bd12698372de5835ffcdb64e8d43e08e07f'],
 overnight_review:['435d24e947a0c774f2dc6afdbcc5dbfa3e20e808b4c0ac7975b8ba116b7d6166','98cb733dc8321515ab2ec4731c85812ed31c1ba6127c34d51779ccfb03bd6f8c'],
};
function privateProfile(id='worker-a',revision='r1',extra={}){return {
 schema:1,id,revision,displayName:id,transport:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',model:'fixture-model',
 roles:['worker'],capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding','consult']},
 maxContextTokens:null,maxOutputTokens:2048,concurrency:1,capacityGroup:'fixture',credentialRef:'fixture-secret-ref',streaming:false,...extra,
};}
const publicProfile=profile=>{const {credentialRef,...snapshot}=profile;return snapshot;};
function policy(profiles=[privateProfile()],extra={}){return {version:1,workers:profiles.map(publicProfile),plannerWorkerId:profiles[0].id,defaultWorkerId:profiles[0].id,maxConcurrentTasks:1,capacityGroups:[{id:'fixture',limit:1}],...extra};}
function rawGoal(extra={}){return {submissionId:'portable-goal',objective:'Exercise approved worker identity',acceptance:['Preserve the exact bound worker'],environment:'fixture',mode:'collaborative',modeVersion:1,...extra};}
const task={submissionId:'portable-task',kind:'consult',objective:'Explain the saved identity',acceptance:['Bound answer']};
const project={repo:'/tmp/pb11-binding-project',baseCommit:'a'.repeat(40),readPaths:['src/'],writePaths:['src/'],checks:[{id:'verify',argv:['node','checks/verify.mjs']}]};
async function fixture(t,{profiles=[privateProfile()],beta=false}={}){
 const {ProviderRegistry}=await import('../src/harness/providers/registry.mjs');
 const root=mkdtempSync(path.join(os.tmpdir(),'pb11-bindings-'));
 const options={root,now:()=>1700000000000,beta,selectedHost:'codex',providerRegistry:new ProviderRegistry({profiles,credentialResolver:()=> 'dummy-private-auth'})};
 let c=new Coordinator(options),d=new Dispatcher({c,config:{beta}});
 t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 return {get c(){return c;},get d(){return d;},root,options,profiles,
  reopen(nextProfiles=profiles){c.close();c=new Coordinator({...options,providerRegistry:nextProfiles===null?undefined:new ProviderRegistry({profiles:nextProfiles,credentialResolver:()=> 'rotated-dummy-private-auth'})});d=new Dispatcher({c,config:{beta}});return c;},
  async prepare(raw=rawGoal({providerPolicy:policy(profiles)})){return d.invoke('goal_prepare',{manifest:raw,idempotencyKey:'prepare'});},
  async activate(g){return d.invoke('goal_activate',{goalId:g.id,hash:g.hash,idempotencyKey:'activate'});},
  async submit(g,spec=task,key='submit'){return d.invoke('task_submit',{goalId:g.id,task:spec,idempotencyKey:key});},
 };
}
const counts=c=>Object.fromEntries(['records','commands','submissions','events','requests'].map(table=>[table,Number(c.store.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n)]));
function expectedBinding(g,profile){return {version:1,providerId:profile.id,revision:profile.revision,profileHash:digest(publicProfile(profile)),policyHash:g.manifest.providerPolicyHash};}

test('historical approval, frozen schemas and exact command/submission replay retain released bytes',async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'pb11-legacy-')),c=new Coordinator({root,now:()=>1700000000000});
 t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 assert.equal(digest(goalInputSchema),'91e373bbbeef14e4e2e9b4cfaa4ef4ebf819512b4064150473b67801bdd40e2f');
 assert.equal(digest(taskInputSchema),'eace7c0828a853cb0eb93b43b4afbd671257e39890ee7087ece890bceb17f2f1');
 assert.equal(digest(new Registry().snapshot().capabilities),'cb1642eb91123b46c02376a40e55ebd17c1430c1a04651827719d4d79a9d98d8');
 for(const [mode,[hash,commandHash]] of Object.entries(historical)){
  const raw={submissionId:'pb11-legacy-'+mode,objective:'Preserve original approvals',acceptance:['Same bytes and authority'],mode,modeVersion:1,environment:'fixture'};
  const g=c.prepareGoal(raw,'prepare-'+mode);assert.equal(g.hash,hash);
  assert.equal(c.store.db.prepare('SELECT hash FROM commands WHERE key=?').get('prepare-'+mode).hash,commandHash);
  const before=counts(c);assert.deepEqual(c.prepareGoal(raw,'prepare-'+mode),g);assert.deepEqual(counts(c),before);
  assert.equal(Object.hasOwn(g.manifest,'providerPolicy'),false);assert.equal(Object.hasOwn(g.manifest,'providerPolicyHash'),false);
  if(mode==='collaborative'){
   c.activateGoal({goalId:g.id,hash:g.hash},'activate-legacy');
   const input={goalId:g.id,submissionId:'legacy-command-task',kind:'consult',objective:'Preserve task replay',acceptance:['Same saved task']};
   const saved=c.submitTask(input,'legacy-task');assert.equal(saved.hash,'581c9d61c24c0d8f59a24151c824ea247bb6045ffd3653f1bce34d29f2ebc479');
   const state=counts(c);assert.deepEqual(c.submitTask(input,'legacy-task'),saved);assert.deepEqual(c.submitTask(input,'legacy-task-other-key'),saved);
   assert.equal(counts(c).records,state.records);assert.equal(counts(c).submissions,state.submissions);assert.equal(counts(c).events,state.events);
  }
 }
 const revision=c.store.revision();c.snapshot();assert.equal(c.store.revision(),revision,'historical reads must not migrate saved rows');
});

test('public prepare activation submit claim and reserve pin credential-free default identity exactly once',async t=>{
 const f=await fixture(t,{beta:true}),g=await f.prepare();await f.activate(g);
 assert.deepEqual(g.manifest.providerPolicy,policy());assert.equal(g.manifest.providerPolicyHash,digest(policy()));
 assert.equal(Object.hasOwn(g.manifest,'plannerBinding'),false,'host planner must retain host authority');
 const submitted=await f.submit(g),pin=expectedBinding(g,f.profiles[0]);assert.deepEqual(submitted.providerBinding,pin);
 const before=counts(f.c);assert.deepEqual(await f.submit(g),submitted);assert.deepEqual(await f.submit(g,task,'second-submission-key'),submitted);
 assert.equal(counts(f.c).records,before.records);assert.equal(counts(f.c).submissions,before.submissions);assert.equal(counts(f.c).events,before.events);
 const claimed=f.c.claimNext('fixture-owner');assert.deepEqual(claimed.providerBinding,pin);
 const reserved=f.c.reserve(claimed.id,{key:'consult-1',kind:'model'},'fixture-owner');assert.deepEqual(reserved.providerBinding,pin);
 assert.equal(reserved.workerProfile,undefined,'portable receipts use portable identity');
 const publicData=canonical({g,submitted,claimed,reserved,events:f.c.store.events()});
 for(const secret of ['credentialRef','fixture-secret-ref','dummy-private-auth'])assert.equal(publicData.includes(secret),false);
 assert.equal(f.c.store.all('task').length,1);assert.equal(f.c.getTask(claimed.id).spent.model,1);
});

test('worker planning persists a separate planner pin and profile changes change approval hashes',async t=>{
 const a=privateProfile(),b=privateProfile('worker-b','r1',{baseUrl:'http://127.0.0.1:2/v1',model:'planner-model'});
 const f=await fixture(t,{profiles:[a,b]}),p=policy([a,b],{plannerWorkerId:b.id});
 const g=await f.prepare(rawGoal({mode:'deepseek_only',providerPolicy:p}));
 assert.deepEqual(g.manifest.plannerBinding,expectedBinding(g,b));assert.equal(g.manifest.mode.planner,'deepseek');
 const changed=privateProfile('worker-a','r2',{model:'changed-model'}),other=await fixture(t,{profiles:[changed,b]});
 const next=await other.prepare(rawGoal({mode:'deepseek_only',providerPolicy:policy([changed,b],{plannerWorkerId:b.id})}));
 assert.notEqual(g.hash,next.hash);assert.notEqual(g.manifest.providerPolicyHash,next.manifest.providerPolicyHash);
});

test('dispatch schema rejects private fields and stage11 rejects concurrency before creating state',async t=>{
 const f=await fixture(t);const initial=counts(f.c);
 for(const [providerPolicy,reason] of [[policy(undefined,{maxConcurrentTasks:2}),/concurrent|sequential/i],[{...policy(),workers:[privateProfile()]},/credential|profile/i],[policy(undefined,{secret:'dummy'}),/unknown|policy/i]]){
  await assert.rejects(f.d.invoke('goal_prepare',{manifest:rawGoal({providerPolicy}),idempotencyKey:'invalid'}),reason);
  assert.deepEqual(counts(f.c),initial);
 }
});

test('codex_only remains usable without a pool and rejects autonomous API assignments',async t=>{
 const f=await fixture(t,{beta:true}),g=await f.prepare(rawGoal({mode:'codex_only'}));await f.activate(g);
 assert.equal(Object.hasOwn(g.manifest,'providerPolicy'),false);
 const native=await f.submit(g);assert.equal(native.spec.actor,'codex');assert.equal(Object.hasOwn(native,'providerBinding'),false);assert.equal(f.c.claimNext('owner'),null);
 await assert.rejects(f.submit(g,{...task,submissionId:'forbidden',actor:'deepseek'},'forbidden'),/mode prohibits actor/i);
 const pooled=await f.d.invoke('goal_prepare',{manifest:rawGoal({mode:'codex_only',submissionId:'host-pool',providerPolicy:policy()}),idempotencyKey:'host-pool'});
 assert.deepEqual(pooled.manifest.providerPolicy,policy());assert.equal(Object.hasOwn(pooled.manifest,'plannerBinding'),false);
 await f.d.invoke('goal_activate',{goalId:pooled.id,hash:pooled.hash,idempotencyKey:'activate-host-pool'});
 const pooledNative=await f.d.invoke('task_submit',{goalId:pooled.id,task:{...task,submissionId:'pooled-native'},idempotencyKey:'pooled-native'});
 assert.equal(pooledNative.spec.actor,'codex');assert.equal(Object.hasOwn(pooledNative,'providerBinding'),false);assert.equal(f.c.claimNext('owner'),null);
 await assert.rejects(f.d.invoke('task_submit',{goalId:pooled.id,task:{...task,submissionId:'forbidden-with-pool',actor:'deepseek'},idempotencyKey:'forbidden-with-pool'}),/mode prohibits actor/i);
 assert.equal(counts(f.c).requests,0);
});

test('restart preserves task and request pins and exact replay without rewriting saved goals',async t=>{
 const f=await fixture(t),g=await f.prepare();await f.activate(g);const original=await f.submit(g);f.c.claimNext('owner');
 const r=f.c.reserve(original.id,{key:'consult-1',kind:'model'},'owner');f.c.saveRequest(r.id,{content:'Saved fixture answer'},'owner');
 f.reopen();const revision=f.c.store.revision();
 assert.deepEqual(f.c.getTask(original.id).providerBinding,original.providerBinding);assert.equal(f.c.getGoal(g.id).hash,g.hash);assert.equal(f.c.store.revision(),revision);
 const replay=await f.submit(g);assert.deepEqual(replay,original);
 const cached=f.c.reserve(original.id,{key:'consult-1',kind:'model'},'owner');assert.equal(cached.cached,true);assert.deepEqual(cached.providerBinding,original.providerBinding);assert.equal(f.c.getTask(original.id).spent.model,1);
});

for(const phase of ['claim','reservation'])test('changed catalog identity blocks '+phase+' without new spend',async t=>{
 const a=privateProfile(),b=privateProfile('worker-b','r1',{baseUrl:'http://127.0.0.1:2/v1'}),f=await fixture(t,{profiles:[a,b]});
 const g=await f.prepare();await f.activate(g);const submitted=await f.submit(g);
 if(phase==='reservation')f.c.claimNext('owner');
 // The changed pool member is not the default: every approved pool member must still match.
 f.reopen([a,{...b,revision:'r2',model:'changed-model'}]);const before=counts(f.c);
 if(phase==='claim'){
  assert.equal(f.c.claimNext('owner'),null);const blocked=f.c.getTask(submitted.id);
  assert.equal(blocked.status,'blocked');assert.match(blocked.reason,/approved.*binding|provider.*configuration/i);
  assert.deepEqual(blocked.providerBinding,submitted.providerBinding);assert.equal(blocked.startedAt,null);assert.equal(blocked.deadline,null);assert.equal(blocked.owner,null);
  const after=counts(f.c),revision=f.c.store.revision();assert.equal(f.c.claimNext('owner'),null);assert.deepEqual(counts(f.c),after);assert.equal(f.c.store.revision(),revision);
  assert.equal(f.c.store.events().filter(event=>event.type==='task.blocked'&&event.task_id===submitted.id).length,1);
 }else{
  assert.throws(()=>f.c.reserve(submitted.id,{key:'consult-1',kind:'model'},'owner'),/provider|profile|catalog|approved|revision/i);assert.deepEqual(counts(f.c),before);
 }
 assert.equal(f.c.getTask(submitted.id).spent.model,0);
});

test('started tasks cannot rebind to the default from an explicitly approved policy revision',async t=>{
 const f=await fixture(t),raw=rawGoal({providerPolicy:policy()}),g=await f.prepare(raw);await f.activate(g);const submitted=await f.submit(g);f.c.claimNext('owner');
 f.c.control({taskId:submitted.id,action:'stop'},'stop');f.c.boundary(submitted.id,{},'owner');
 const saved=f.c.getTask(submitted.id),changed=privateProfile('worker-a','r2',{model:'new-model'});f.reopen([changed]);
 const revision=await f.d.invoke('goal_revision_prepare',{goalId:g.id,expectedHash:g.hash,manifest:{...raw,providerPolicy:policy([changed])},idempotencyKey:'revision'});
 await f.d.invoke('goal_revision_activate',{revisionId:revision.id,hash:revision.hash,idempotencyKey:'revision-activate'});
 await assert.rejects(f.d.invoke('task_rebind',{taskId:submitted.id,idempotencyKey:'rebind'}),/started|retain|provider|binding/i);
 assert.deepEqual(f.c.getTask(submitted.id),saved);assert.equal(f.c.getGoal(g.id).deadline,1700000000000+8*3600000);
});

test('backlog and recipe submission share atomic default binding and retain their replay receipts',async t=>{
 const f=await fixture(t),g=await f.prepare(rawGoal({project,providerPolicy:policy()}));await f.activate(g);
 const backlog={goalId:g.id,expectedGoalHash:g.hash,expectedGoalVersion:g.version,submissionId:'bound-backlog',items:[{key:'first',dependsOnKeys:[],task:{kind:'consult',objective:'Check the first identity',acceptance:['Saved identity']}}],idempotencyKey:'backlog'};
 const group=await f.d.invoke('backlog_submit',backlog);assert.deepEqual(await f.d.invoke('backlog_submit',backlog),group);
 const parameters={issue:'Preserve rows',context:'Bound fixture',readPaths:['src/rows.mjs'],writePaths:['src/rows.mjs'],checks:['verify']};
 const p=await f.d.invoke('workflow_recipe_preview',{goalId:g.id,recipeId:'bugfix',version:1,parameters});assert.equal(p.launchable,true);
 const input={goalId:g.id,recipeId:'bugfix',version:1,expectedGoalHash:g.hash,definitionDigest:p.definitionDigest,parameterDigest:p.parameterDigest,previewDigest:p.previewDigest,parameters,submissionId:'bound-recipe',idempotencyKey:'recipe'};
 const recipe=await f.d.invoke('workflow_recipe_submit',input);assert.deepEqual(await f.d.invoke('workflow_recipe_submit',input),recipe);
 const tasks=f.c.store.all('task');assert.equal(tasks.length,2);for(const bound of tasks)assert.deepEqual(bound.providerBinding,expectedBinding(g,f.profiles[0]));
 const before=counts(f.c);f.reopen();assert.deepEqual(await f.d.invoke('backlog_submit',backlog),group);assert.deepEqual(await f.d.invoke('workflow_recipe_submit',input),recipe);assert.deepEqual(counts(f.c),before);
});


test('assignment intake prepares the same canonical pool and replays before rereading the checkout',async t=>{
 const f=await fixture(t,{beta:true}),repo=await repository({root:f.root,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
 const manifest={...assignment(repo),environment:'fixture',providerPolicy:policy()};
 const input={manifest,idempotencyKey:'assignment-intake'};
 const result=await f.d.invoke('assignment_prepare',input);assert.equal(result.status,'prepared',JSON.stringify(result));
 const g=f.c.getGoal(result.goalId);assert.deepEqual(g.manifest.providerPolicy,policy());assert.equal(g.hash,result.hash);assert.deepEqual(g.manifest.plannerBinding,expectedBinding(g,f.profiles[0]));
 const before=counts(f.c);await repo.git('commit','--allow-empty','-m','Move checkout after preparation');
 assert.deepEqual(await f.d.invoke('assignment_prepare',input),result);assert.deepEqual(counts(f.c),before);
 assert.equal(f.c.store.all('task').length,0);assert.equal(counts(f.c).requests,0);
});

test('unsupported default task capability rejects the entire submission before task or receipt creation',async t=>{
 const p=privateProfile('worker-a','r1',{capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding']}});
 const f=await fixture(t,{profiles:[p]}),g=await f.prepare();await f.activate(g);const before=counts(f.c);
 for(const kind of ['consult','learning','research']){
  await assert.rejects(f.submit(g,{...task,submissionId:'unsupported-'+kind,kind},'unsupported-'+kind),/provider|capabilit|task kind/i);
  assert.deepEqual(counts(f.c),before);
 }
 const group={goalId:g.id,expectedGoalHash:g.hash,expectedGoalVersion:g.version,submissionId:'unsupported-group',items:[{key:'bad',dependsOnKeys:[],task:{kind:'consult',objective:'Unsupported',acceptance:['Response']}}],idempotencyKey:'unsupported-backlog'};
 await assert.rejects(f.d.invoke('backlog_submit',group),/provider|capabilit|task kind/i);assert.deepEqual(counts(f.c),before);
});

test('an unstarted task can explicitly rebind after exact revised policy approval without refreshing limits',async t=>{
 const f=await fixture(t),raw=rawGoal({providerPolicy:policy()}),g=await f.prepare(raw);await f.activate(g);const submitted=await f.submit(g);
 const changed=privateProfile('worker-a','r2',{model:'new-model'});f.reopen([changed]);
 const revision=await f.d.invoke('goal_revision_prepare',{goalId:g.id,expectedHash:g.hash,manifest:{...raw,providerPolicy:policy([changed])},idempotencyKey:'prepare-revision'});
 const approved=await f.d.invoke('goal_revision_activate',{revisionId:revision.id,hash:revision.hash,idempotencyKey:'approve-revision'});
 const rebound=await f.d.invoke('task_rebind',{taskId:submitted.id,idempotencyKey:'explicit-rebind'});
 assert.deepEqual(rebound.providerBinding,expectedBinding(approved,changed));assert.notDeepEqual(rebound.providerBinding,submitted.providerBinding);
 assert.deepEqual(rebound.spec.limits,submitted.spec.limits);assert.equal(rebound.startedAt,null);assert.equal(rebound.deadline,null);assert.equal(rebound.spent.model,0);assert.equal(rebound.goalVersion,2);
 assert.equal(f.c.claimNext('owner').id,submitted.id);
});

for(const [catalog,nextProfiles] of [
 ['replaced revision',[privateProfile('worker-a','r2',{model:'replacement-model'})]],
 ['removed worker',[privateProfile('other-worker')]],
 ['changed identity',[privateProfile('worker-a','r1',{model:'replacement-model'})]],
 ['unavailable registry',null],
])test('saved portable preparation replays with '+catalog+' and grants no fresh authority',async t=>{
 const f=await fixture(t,{beta:true}),raw=rawGoal({providerPolicy:policy()}),g=await f.prepare(raw);
 // A different operation can return a goal-shaped result; its command hash must
 // still prevent goal_prepare from treating that result as preparation authority.
 f.c.store.command('other-operation',{op:'fixture.other'},()=>g);
 const command=()=>f.c.store.db.prepare('SELECT hash,result FROM commands WHERE key=?').get('prepare');
 const goalBytes=()=>f.c.store.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get('goal',g.id).data;
 const originalCommand=command(),originalGoal=goalBytes();
 f.reopen(nextProfiles);const before=counts(f.c),revision=f.c.store.revision();
 assert.deepEqual(await f.prepare(raw),g);
 assert.deepEqual(command(),originalCommand);assert.equal(goalBytes(),originalGoal);
 const {providerPolicy,...withoutPolicy}=raw;
 const changedPolicy=structuredClone(providerPolicy);changedPolicy.workers[0].model='changed-input-model';
 for(const manifest of [{...raw,objective:'A changed objective'},{...raw,providerPolicy:changedPolicy},withoutPolicy]){
  await assert.rejects(f.d.invoke('goal_prepare',{manifest,idempotencyKey:'prepare'}),/idempotency key conflict/i);
  assert.deepEqual(counts(f.c),before);assert.equal(f.c.store.revision(),revision);
 }
 await assert.rejects(f.d.invoke('goal_prepare',{manifest:raw,idempotencyKey:'other-operation'}),/idempotency key conflict/i);
 // A fresh command, even for the original submission, still validates the
 // current catalog. Replaying the receipt does not re-approve stale settings.
 for(const submissionId of [raw.submissionId,'fresh-stale-goal']){
  await assert.rejects(f.d.invoke('goal_prepare',{manifest:{...raw,submissionId},idempotencyKey:'fresh-prepare'}),/provider|profile|registry|catalog/i);
 }
 await assert.rejects(f.d.invoke('goal_activate',{goalId:g.id,hash:g.hash,idempotencyKey:'activate-stale'}),/provider|profile|registry|catalog/i);
 assert.deepEqual(command(),originalCommand);assert.equal(goalBytes(),originalGoal);assert.deepEqual(counts(f.c),before);assert.equal(f.c.store.revision(),revision);
 assert.equal(f.c.getGoal(g.id).status,'draft');assert.equal(counts(f.c).requests,0);
});
