import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Registry,normalizeGoal,normalizeTask,digest,goalInputSchema,taskInputSchema} from '../src/harness/contracts.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {ResearchAdapter} from '../src/harness/research.mjs';

const policy={version:1,finish:'selectors_only',discovery:'search_required'};
const brief={submissionId:'legacy-selectors-hash',objective:'Keep prior research authority',acceptance:['Legacy hashes unchanged'],mode:'deepseek_only',environment:'fixture'};
const assignment={submissionId:'legacy-r',kind:'research',objective:'Read primary evidence',acceptance:['Cited report']};
const invalidPolicies=[null,[],true,{}, {...policy,version:3},{...policy,version:true},{...policy,version:'1'}, {...policy,finish:'quotes'}, {...policy,discovery:'optional'}, {...policy,extra:true}, {version:1,finish:'selectors_only'}, {version:1,discovery:'search_required'}];

test('absent research policy preserves literal legacy goal, capability and task hashes',()=>{
 const goal=normalizeGoal(brief),task=normalizeTask(assignment,goal);
 assert.equal(digest(goal),'87d423b53127ee3ff265b15c3a743542b697be11751bdd737f757a3dfcab6297');
 assert.equal(digest(goal.capabilities),'3838336054169f15f54714cd82427de2e36a403ecd5c60ef85c4431f597c2efc');
 assert.equal(digest(task),'57712a028dcfb305f292b24349f4417e77721842238169330d58ea374cc2e1f5');
 assert.equal(Object.hasOwn(goal,'researchPolicy'),false);assert.equal(Object.hasOwn(task,'researchPolicy'),false);
 assert.equal(goal.capabilities.find(c=>c.id==='research').version,1);
});
test('strict research policy binds goal approval and an independent inherited task pin',()=>{
 const raw={...brief,researchPolicy:{...policy}},goal=normalizeGoal(raw),task=normalizeTask(assignment,goal);
 assert.deepEqual(goal.researchPolicy,policy);assert.deepEqual(task.researchPolicy,policy);
 assert.equal(goal.capabilities.find(c=>c.id==='research').version,2);
 assert.notEqual(digest(goal),digest(normalizeGoal(brief)));assert.notEqual(digest(task),digest(normalizeTask(assignment,normalizeGoal(brief))));
 assert.deepEqual(normalizeTask(task,goal),task);
 raw.researchPolicy.finish='quotes';task.researchPolicy.discovery='optional';assert.deepEqual(goal.researchPolicy,policy);
 assert.deepEqual(normalizeTask({...assignment,researchPolicy:{...policy}},goal).researchPolicy,policy);
});
test('closed policy rejects malformed and unsupported input without granting task policy authority',()=>{
 for(const researchPolicy of invalidPolicies){
  assert.throws(()=>normalizeGoal({...brief,researchPolicy}),/research|policy|field/i);
  assert.throws(()=>normalizeTask({...assignment,researchPolicy},normalizeGoal(brief)),/research|policy|field/i);
 }
 assert.throws(()=>normalizeTask({...assignment,researchPolicy:policy},normalizeGoal(brief)),/approved|policy/i);
 const goal=normalizeGoal({...brief,researchPolicy:policy});
 for(const researchPolicy of invalidPolicies)assert.throws(()=>normalizeTask({...assignment,researchPolicy},goal),/research|policy|field/i);
 assert.throws(()=>normalizeGoal({...brief,researchPolicy:undefined}),/research|policy|object/i);
});
test('policy is autonomous research only and never applies to operator or other task kinds',()=>{
 assert.throws(()=>normalizeGoal({...brief,mode:'codex_only',researchPolicy:policy}),/research|actor|autonomous/i);
 assert.throws(()=>normalizeGoal({...brief,mode:'overnight_review',researchPolicy:policy}),/research|capability/i);
 const goal=normalizeGoal({...brief,mode:'collaborative',researchPolicy:policy});
 assert.throws(()=>normalizeTask({...assignment,actor:'codex'},goal),/research|actor|autonomous/i);
 for(const kind of ['consult','learning']){
  const raw={...assignment,kind};assert.equal(Object.hasOwn(normalizeTask(raw,goal),'researchPolicy'),false);
  assert.throws(()=>normalizeTask({...raw,researchPolicy:policy},goal),/research|policy/i);
 }
});
test('discovery exposes policy on goal/task and new capability without editing legacy capability schema',()=>{
 for(const schema of [goalInputSchema,taskInputSchema]){
  const pin=schema.properties.researchPolicy;assert.ok(pin);assert.equal(pin.additionalProperties,false);
  assert.deepEqual(pin.required,['version','finish','discovery']);assert.deepEqual(pin.properties.version.enum,[1,2]);
  assert.deepEqual(pin.properties.finish.enum,['selectors_only']);assert.deepEqual(pin.properties.discovery.enum,['search_required']);
 }
 const research=new Registry().snapshot().capabilities.filter(c=>c.id==='research');
 assert.equal(research.find(c=>c.version===1).inputSchema.properties.researchPolicy,undefined);
 assert.deepEqual(research.find(c=>c.version===2).inputSchema.properties.researchPolicy,{...goalInputSchema.properties.researchPolicy,properties:{...goalInputSchema.properties.researchPolicy.properties,version:{type:'integer',enum:[1]}}});
});

async function coordinatorFixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-policy-')),c=new Coordinator({root});
 t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});return c;
}
test('public dispatcher accepts approved policy and rejects open or altered task copies before dispatch',async t=>{
 const c=await coordinatorFixture(t),dispatcher=new Dispatcher({c,config:{environment:'fixture'}});
 const g=await dispatcher.invoke('goal_prepare',{manifest:{...brief,researchPolicy:policy},idempotencyKey:'p'});
 assert.deepEqual(g.manifest.researchPolicy,policy);await dispatcher.invoke('goal_activate',{goalId:g.id,hash:g.hash,idempotencyKey:'a'});
 const saved=await dispatcher.invoke('task_submit',{goalId:g.id,task:assignment,idempotencyKey:'t'});assert.deepEqual(saved.spec.researchPolicy,policy);
 for(const [n,researchPolicy] of invalidPolicies.entries())await assert.rejects(dispatcher.invoke('task_submit',{goalId:g.id,task:{...assignment,submissionId:`bad-${n}`,researchPolicy},idempotencyKey:`bad-${n}`}),/research|policy|field|version|finish|discovery|extra/i);
 assert.equal(c.store.all('task').length,1);assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n,0);
});
test('research bridge forwards the exact policy and preserves legacy manifest absence and reserved replay',async t=>{
 const c=await coordinatorFixture(t),prepared=[];
 const adapter=new ResearchAdapter({c,config:{research:{}}},{rpc:async r=>{prepared.push(structuredClone(r));return r.command==='prepare_manifest'?{manifest:r.manifest,hash:'remote-hash'}:{id:'remote'};}});
 for(const [n,strict] of [false,true].entries()){
  const g=c.prepareGoal({...brief,submissionId:`g-${n}`,...(strict?{researchPolicy:policy}:{})},`p-${n}`);c.activateGoal({goalId:g.id,hash:g.hash},`a-${n}`);
  const task=c.submitTask({goalId:g.id,...assignment},`t-${n}`);c.claimNext(`owner-${n}`);
  await adapter.step(c.getTask(task.id),`owner-${n}`);const preparedTask=c.getTask(task.id),request=prepared.at(-1);
  assert.equal(request.command,'prepare_manifest');assert.equal(request.manifest.schema,2);assert.equal(request.manifest.executor,undefined);
  if(strict)assert.deepEqual(request.manifest.research_policy,policy);else assert.equal(Object.hasOwn(request.manifest,'research_policy'),false);
  assert.deepEqual(request.manifest.limits,{seconds:7200,searches:30,downloads:50,model_calls:20});
  assert.deepEqual(request.manifest.scope,{seed_urls:[],include_domains:[],exclude_domains:[]});assert.equal(request.manifest.not_after,Math.floor(preparedTask.deadline/1000));
  const replay=structuredClone(preparedTask);replay.spec.researchPolicy={version:99};
  await adapter.step(replay,`owner-${n}`);assert.deepEqual(prepared.at(-1),{command:'submit',manifest:preparedTask.checkpoint.manifest,approved_hash:'remote-hash'});
  c.completeTask(task.id,{},`owner-${n}`);
 }
});
test('research bridge rejects unapproved or unsupported new policy before any RPC',async t=>{
 const c=await coordinatorFixture(t),g=c.prepareGoal(brief,'p');c.activateGoal({goalId:g.id,hash:g.hash},'a');const task=c.submitTask({goalId:g.id,...assignment},'t');c.claimNext('owner');
 const adapter=new ResearchAdapter({c,config:{research:{}}},{rpc:async()=>assert.fail('Rejected policy reached RPC')});
 for(const researchPolicy of [policy,...invalidPolicies])await assert.rejects(adapter.step({...c.getTask(task.id),spec:{...task.spec,researchPolicy}},'owner'),/research|policy|field/i);
});
