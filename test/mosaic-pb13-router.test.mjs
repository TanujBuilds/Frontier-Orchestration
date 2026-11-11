import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,digest,Registry} from '../src/harness/contracts.mjs';
import {normalizeProviderPolicy,profileIdentity} from '../src/harness/providers/contracts.mjs';
import {normalizeRoutingPolicy,normalizeTaskRouting} from '../src/harness/routing/contracts.mjs';
import {selectRoute} from '../src/harness/routing/router.mjs';

const observedAt='2026-11-11T20:00:00.000Z';
const registry=new Registry();
const profile=(id,overrides={})=>profileIdentity({schema:1,id,revision:'revision-1',displayName:'Dummy '+id,
 transport:'openai-chat',baseUrl:'https://'+id.toLowerCase()+'.invalid/v1',model:'fixture-model',roles:['worker'],
 capabilities:{workerProtocol:'mosaic-structured-v1',transports:['json'],modelDiscovery:'manual',taskKinds:['coding','consult']},
 maxContextTokens:32768,maxOutputTokens:4096,concurrency:1,capacityGroup:'fixture-service',credentialRef:null,
 streaming:false,...overrides});
function fixture({workers=[profile('workerA'),profile('workerB')],rules=[
 {id:'backend-first',category:'backend',providerId:'workerA'},
 {id:'frontend-first',category:'frontend',providerId:'workerB'}],defaultWorkerId='workerA',
 modeId='deepseek_only',modeVersion=1}={}){
 const providerPolicy=normalizeProviderPolicy({version:1,workers,plannerWorkerId:workers[0].id,
  defaultWorkerId:workers[0].id,capacityGroups:[{id:'fixture-service',limit:1}]});
 const routingPolicy={version:1,rules,defaultWorkerId};
 const mode=registry.mode(modeId,modeVersion),capabilities=registry.snapshot().capabilities
  .filter(capability=>mode.capabilities.includes(capability.id)&&capability.version===1);
 return {mode,capabilities,providerPolicy,providerPolicyHash:digest(providerPolicy),routingPolicy,routingPolicyHash:digest(routingPolicy)};
}
function availability(goal,status='available',remainingModelCalls=5){
 return {providers:goal.providerPolicy.workers.map(worker=>({providerId:worker.id,revision:worker.revision,
  profileHash:digest(worker),status,observedAt,provenance:'fixture bounded availability probe'})),
  budget:{remainingModelCalls}};
}
const task=(routing={})=>({kind:'coding',actor:'deepseek',routing:{version:1,...routing}});
const choose=(goal,assignment=task({category:'backend'}),snapshot=availability(goal))=>
 selectRoute({task:assignment,goal,availability:snapshot});
function freeze(value){
 if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}
 return value;
}

test('routing omission remains absent and defaults apply only inside an explicit versioned routing input',()=>{
 assert.equal(normalizeRoutingPolicy(undefined,undefined),undefined);
 assert.equal(normalizeTaskRouting(undefined),undefined);
 assert.deepEqual(normalizeTaskRouting({version:1}),{version:1,category:'general',requiredCapabilities:[],
  minContextTokens:null,maxOutputTokens:null});
 assert.throws(()=>normalizeTaskRouting({}));
});

test('routing policy preserves ordered repeated categories and returns a detached canonical object',()=>{
 const goal=fixture({rules:[{id:'first',category:'backend',providerId:'workerB'},
  {id:'second',category:'backend',providerId:'workerA'}]}),before=canonical(goal);
 const policy=normalizeRoutingPolicy(freeze(goal.routingPolicy),freeze(goal.providerPolicy));
 assert.deepEqual(policy.rules.map(rule=>rule.id),['first','second']);
 assert.notEqual(policy.rules,goal.routingPolicy.rules);
 assert.equal(canonical(goal),before);
});

test('routing policies reject missing pools, unapproved choices, duplicate ids, excess rules and unknown fields',()=>{
 const goal=fixture();
 assert.throws(()=>normalizeRoutingPolicy(goal.routingPolicy,undefined));
 for(const patch of [{version:2},{defaultWorkerId:'outside'},{extra:true},{rules:null},
  {rules:[{id:'duplicate',category:'docs',providerId:'workerA'},{id:'duplicate',category:'tests',providerId:'workerB'}]},
  {rules:[{id:'wrong',category:'mobile',providerId:'workerA'}]},
  {rules:[{id:'wrong',category:'backend',providerId:'outside'}]},
  {rules:[{id:'wrong',category:'backend',providerId:'workerA',score:100}]},
  {rules:Array.from({length:33},(_,index)=>({id:'r'+index,category:'general',providerId:'workerA'}))}])
  assert.throws(()=>normalizeRoutingPolicy({...goal.routingPolicy,...patch},goal.providerPolicy));
 const nullPolicy={version:1,rules:[],defaultWorkerId:'workerB'};
 assert.deepEqual(normalizeRoutingPolicy(nullPolicy,goal.providerPolicy),nullPolicy);
});

test('task routing bounds categories, capabilities, identifiers and nullable safe positive token counts',()=>{
 for(const patch of [{version:2},{category:'mobile'},{category:null},{preferredProviderId:'invalid/id'},
  {preferredProviderId:null},{requiredCapabilities:['images']},{requiredCapabilities:['coding','coding']},
  {requiredCapabilities:null},{minContextTokens:0},{minContextTokens:Infinity},{minContextTokens:1.5},
  {maxOutputTokens:0},{maxOutputTokens:Number.MAX_SAFE_INTEGER+1},{maxOutputTokens:undefined},{imageInput:true}])
  assert.throws(()=>normalizeTaskRouting({version:1,...patch}));
 const raw={version:1,category:'design',requiredCapabilities:['consult','coding'],minContextTokens:500,
  maxOutputTokens:100,preferredProviderId:'workerB'},before=canonical(raw);
 assert.deepEqual(normalizeTaskRouting(freeze(raw)),{...raw,requiredCapabilities:['coding','consult']});
 assert.equal(canonical(raw),before);
 const symbolic={version:1};symbolic[Symbol('hidden')]='x';
 assert.throws(()=>normalizeTaskRouting(symbolic));
});

test('backend and frontend categories choose configured workers and return exact approved binding hashes',()=>{
 const goal=fixture();
 for(const [category,providerId,ruleId]of [['backend','workerA','backend-first'],['frontend','workerB','frontend-first']]){
  const route=choose(goal,task({category})),worker=goal.providerPolicy.workers.find(row=>row.id===providerId);
  assert.equal(route.status,'selected');assert.equal(route.reasonCode,'selected_by_rule');
  assert.deepEqual(route.binding,{version:1,providerId,revision:'revision-1',profileHash:digest(worker),policyHash:goal.providerPolicyHash});
  assert.deepEqual(route.matchedRule,{id:ruleId,category,providerId});
  assert.match(route.explanation,new RegExp(ruleId));assert.match(route.explanation,new RegExp(providerId));
 }
});

test('strict explicit preference wins over category and default and never selects an outside profile',()=>{
 const goal=fixture();
 const route=choose(goal,task({category:'backend',preferredProviderId:'workerB'}));
 assert.equal(route.status,'selected');assert.equal(route.binding.providerId,'workerB');
 assert.equal(route.reasonCode,'selected_by_explicit');assert.equal(route.matchedRule,null);
 const rejected=choose(goal,task({category:'backend',preferredProviderId:'outside'}));
 assert.equal(rejected.status,'ineligible');assert.equal(rejected.reasonCode,'provider_not_approved');
 assert.equal(rejected.binding,null);assert.match(rejected.explanation,/explicit/i);
});

test('first matching category rule wins ties and blocks when ineligible without trying rule two',()=>{
 const goal=fixture({workers:[profile('workerA',{maxContextTokens:1024}),profile('workerB')],rules:[
  {id:'first',category:'backend',providerId:'workerA'},{id:'second',category:'backend',providerId:'workerB'}]});
 assert.equal(choose(goal).binding.providerId,'workerA');
 const blocked=choose(goal,task({category:'backend',minContextTokens:2048}));
 assert.equal(blocked.status,'ineligible');assert.equal(blocked.reasonCode,'context_limit_insufficient');
 assert.equal(blocked.binding,null);assert.equal(blocked.matchedRule.id,'first');
 assert.match(blocked.explanation,/first/);
});

test('unmatched category and omitted new routing input use the routing default independently of provider default',()=>{
 const goal=fixture({defaultWorkerId:'workerB'});
 const route=choose(goal,task({category:'docs'}));
 assert.equal(route.binding.providerId,'workerB');assert.equal(route.reasonCode,'selected_by_default');
 assert.equal(route.matchedRule,null);
 assert.equal(choose(goal,{kind:'coding',actor:'deepseek'}).binding.providerId,'workerB');
 const legacy={providerPolicy:goal.providerPolicy,providerPolicyHash:goal.providerPolicyHash};
 assert.equal(choose(legacy).reasonCode,'routing_policy_missing');
 assert.equal(Object.hasOwn(legacy,'routingPolicy'),false);
});

test('unknown categories reject before selecting and corrupted approved policy hashes reject',()=>{
 const goal=fixture();
 assert.equal(choose(goal,task({category:'mobile'})).reasonCode,'task_routing_invalid');
 const policyChanged=structuredClone(goal);policyChanged.routingPolicy.defaultWorkerId='workerB';
 assert.equal(choose(policyChanged).reasonCode,'routing_policy_changed');
 const profileChanged=structuredClone(goal);profileChanged.providerPolicy.workers[0].model='different';
 assert.equal(choose(profileChanged).reasonCode,'provider_policy_changed');
});

test('explicitly invalid routing metadata cannot use the absent-input default',()=>{
 const goal=fixture();
 for(const routing of [null,undefined,false,{},[]]){
  const route=choose(goal,{kind:'coding',actor:'deepseek',routing});
  assert.equal(route.status,'ineligible');assert.equal(route.reasonCode,'task_routing_invalid');
 }
});

test('actual coding kind is mandatory even when requiredCapabilities is empty',()=>{
 const goal=fixture({workers:[profile('workerA',{capabilities:{workerProtocol:'mosaic-structured-v1',
  transports:['json'],modelDiscovery:'manual',taskKinds:['consult']}}),profile('workerB')]});
 const blocked=choose(goal,task({requiredCapabilities:[]}));
 assert.equal(blocked.status,'ineligible');assert.equal(blocked.reasonCode,'capability_unsupported');
 assert.match(blocked.explanation,/coding/);
});

test('actual consult kind and all additional required capabilities are checked',()=>{
 const goal=fixture({workers:[profile('workerA',{capabilities:{workerProtocol:'mosaic-structured-v1',
  transports:['json'],modelDiscovery:'manual',taskKinds:['coding']}}),profile('workerB')]});
 assert.equal(choose(goal,{kind:'consult',actor:'deepseek',routing:{version:1,requiredCapabilities:[]}}).reasonCode,'capability_unsupported');
 assert.equal(choose(goal,task({requiredCapabilities:['consult']})).reasonCode,'capability_unsupported');
 assert.equal(choose(goal,{kind:'research',actor:'deepseek',routing:{version:1}}).reasonCode,'task_kind_unsupported');
});

test('permitted worker tasks retain selected and waiting bindings under their canonical pinned modes',()=>{
 for(const [modeId,modeVersion,kinds]of [['collaborative',1,['coding','consult']],
  ['deepseek_only',1,['coding','consult']],['overnight_review',1,['coding']],['overnight_review',2,['coding']]]){
  const goal=fixture({modeId,modeVersion});
  for(const kind of kinds){
   const assignment={...task(),kind};
   assert.equal(choose(goal,assignment).status,'selected',modeId+' '+kind);
   const waiting=selectRoute({task:assignment,goal});
   assert.equal(waiting.status,'waiting');assert.equal(waiting.binding.providerId,'workerA');
  }
 }
});

test('host-only modes and host execution tasks reject API worker routing even before health is known',()=>{
 for(const [modeId,actor,reasonCode]of [['codex_only','codex','mode_worker_prohibited'],
  ['codex_only','deepseek','mode_worker_prohibited'],['collaborative','codex','task_actor_prohibited']]){
  const goal=fixture({modeId}),assignment={...task({category:'backend'}),actor};
  for(const snapshot of [availability(goal),undefined]){
   const route=selectRoute({task:assignment,goal,availability:snapshot});
   assert.equal(route.status,'ineligible');assert.equal(route.reasonCode,reasonCode);
   assert.equal(route.binding,null);assert.equal(route.matchedRule.id,'backend-first');
  }
 }
});

test('coding-only overnight mode rejects consult without falling through or returning a probeable binding',()=>{
 const goal=fixture({modeId:'overnight_review'}),assignment={...task({preferredProviderId:'workerB'}),kind:'consult'};
 for(const snapshot of [availability(goal),undefined]){
  const route=selectRoute({task:assignment,goal,availability:snapshot});
  assert.equal(route.status,'ineligible');assert.equal(route.reasonCode,'mode_capability_prohibited');
  assert.equal(route.binding,null);assert.equal(route.matchedRule,null);assert.match(route.explanation,/explicit/i);
 }
});

test('approved registered custom mode snapshots preserve worker authority without using a built-in mode name',()=>{
 registry.registerMode({id:'custom-worker-policy',version:7,planner:'codex',actors:['codex','deepseek'],
  review:'operator',capabilities:['coding']});
 const goal=fixture({modeId:'custom-worker-policy',modeVersion:7});
 assert.equal(choose(goal).status,'selected');
 assert.equal(choose(goal,{...task(),actor:'codex'}).reasonCode,'task_actor_prohibited');
 assert.equal(choose(goal,{...task(),kind:'consult'}).reasonCode,'mode_capability_prohibited');
});

test('a pinned capability excluding the worker actor rejects a mode-permitted worker task',()=>{
 const goal=fixture();goal.capabilities.find(capability=>capability.id==='coding').actors=['codex'];
 const route=choose(goal);
 assert.equal(route.status,'ineligible');assert.equal(route.reasonCode,'mode_capability_prohibited');
 assert.equal(route.binding,null);
});

test('missing or untrusted pinned mode, actor and capability metadata cannot imply worker authority',()=>{
 const cases=[
  goal=>{delete goal.mode;},goal=>{goal.mode=null;},goal=>{goal.mode={id:'deepseek_only'};},
  goal=>{goal.mode.id='invalid/id';},goal=>{goal.mode.version=0;},
  goal=>{goal.mode.actors=['api-worker'];},goal=>{goal.mode.review='operator';},
  goal=>{delete goal.capabilities;},goal=>{goal.capabilities=[];},
  goal=>{goal.capabilities.find(capability=>capability.id==='coding').actors=[];},
  goal=>{goal.capabilities.find(capability=>capability.id==='coding').version=0;}
 ];
 for(const change of cases){
  const goal=fixture();change(goal);
  const route=choose(goal);
  assert.equal(route.status,'ineligible');assert.equal(route.reasonCode,'mode_eligibility_unknown');
  assert.equal(route.binding,null);
 }
 for(const actor of [undefined,null,'api-worker']){
  const goal=fixture(),route=choose(goal,{...task(),actor});
  assert.equal(route.status,'ineligible');assert.equal(route.reasonCode,'mode_eligibility_unknown');
  assert.equal(route.binding,null);
 }
});

test('unknown context cannot satisfy an explicit minimum but does not invent a minimum for other tasks',()=>{
 const goal=fixture({workers:[profile('workerA',{maxContextTokens:null}),profile('workerB')]});
 assert.equal(choose(goal).status,'selected');
 const unknown=choose(goal,task({minContextTokens:1}));
 assert.equal(unknown.status,'ineligible');assert.equal(unknown.reasonCode,'context_limit_unknown');
 assert.equal(choose(fixture(),task({minContextTokens:32768})).status,'selected');
});

test('output requirement at the configured ceiling is allowed and excess blocks without fallback',()=>{
 const goal=fixture();
 assert.equal(choose(goal,task({maxOutputTokens:4096})).status,'selected');
 assert.equal(choose(goal,task({maxOutputTokens:4097})).reasonCode,'output_limit_insufficient');
});

test('busy and offline selected workers wait on that binding without trying another worker',()=>{
 const goal=fixture();
 for(const status of ['busy','offline']){
  const snapshot=availability(goal);snapshot.providers[0].status=status;
  const route=choose(goal,task({category:'backend'}),snapshot);
  assert.equal(route.status,'waiting');assert.equal(route.binding.providerId,'workerA');
  assert.equal(route.reasonCode,'provider_'+status);assert.equal(route.matchedRule.id,'backend-first');
  assert.match(route.explanation,/backend-first/);
 }
});

test('missing, unknown, mismatched or unproven observations never prove availability',()=>{
 const goal=fixture();
 for(const patch of [null,{status:'unknown'},{revision:'revision-2'},{profileHash:'0'.repeat(64)},
  {observedAt:null},{observedAt:'not-a-date'},{observedAt:'2026-02-30T20:00:00.000Z'},{provenance:''}]){
  const snapshot=availability(goal);
  if(patch===null)snapshot.providers=[];else Object.assign(snapshot.providers[0],patch);
  const route=choose(goal,task({category:'backend'}),snapshot);
  assert.equal(route.status,'waiting');assert.equal(route.reasonCode,'availability_unknown');
  assert.equal(route.binding.providerId,'workerA');
 }
 const route=selectRoute({task:task(),goal});
 assert.equal(route.status,'waiting');assert.equal(route.binding.providerId,'workerA');
});

test('duplicate observations for the chosen identity are ambiguous and wait without fallback',()=>{
 const goal=fixture(),snapshot=availability(goal);
 snapshot.providers.push({...snapshot.providers[0],status:'offline'});
 const route=choose(goal,task(),snapshot);
 assert.equal(route.status,'waiting');assert.equal(route.reasonCode,'availability_unknown');
 assert.equal(route.binding.providerId,'workerA');
});

test('spent model-call budget blocks even a busy or unknown selected worker without a request',()=>{
 const goal=fixture();
 for(const status of ['available','busy','offline','unknown']){
  const route=choose(goal,task(),availability(goal,status,0));
  assert.equal(route.status,'ineligible');assert.equal(route.reasonCode,'budget_exhausted');
  assert.equal(route.binding,null);
 }
});

test('unknown budget is not treated as permission for an inference request',()=>{
 const goal=fixture();
 for(const budget of [null,{}, {remainingModelCalls:null},{remainingModelCalls:-1},{remainingModelCalls:Infinity}]){
  const snapshot=availability(goal);snapshot.budget=budget;
  const route=choose(goal,task(),snapshot);
  assert.equal(route.status,'waiting');assert.equal(route.reasonCode,'budget_unknown');
  assert.equal(route.binding.providerId,'workerA');
 }
});

test('design category is only a preference and cannot introduce image or tool capability',()=>{
 const goal=fixture({rules:[{id:'design-choice',category:'design',providerId:'workerB'}]});
 const route=choose(goal,task({category:'design'}));
 assert.equal(route.status,'selected');assert.equal(route.binding.providerId,'workerB');
 assert.equal(Object.hasOwn(route.binding,'imageInput'),false);
 assert.equal(choose(goal,task({category:'design',requiredCapabilities:['images']})).status,'ineligible');
});

test('record wrappers work and selector neither mutates nor retains input objects',()=>{
 const goal=fixture(),assignment=task({category:'frontend'}),snapshot=availability(goal);
 const inputs=freeze({task:{spec:assignment},goal:{manifest:goal},availability:snapshot}),before=canonical(inputs);
 const route=selectRoute(inputs);
 assert.equal(route.status,'selected');assert.equal(route.binding.providerId,'workerB');
 route.matchedRule.providerId='workerA';route.binding.providerId='outside';
 assert.equal(canonical(inputs),before);
});

test('selector uses provided observations without reading time or invoking inference',()=>{
 const goal=fixture(),snapshot=availability(goal),before=canonical({goal,snapshot});
 const originalFetch=globalThis.fetch,originalNow=Date.now;
 let inferenceRequests=0;
 globalThis.fetch=()=>{inferenceRequests++;throw Error('routing must not perform HTTP');};
 Date.now=()=>{throw Error('routing must not read wall clock');};
 try{
  const first=choose(goal,task(),snapshot),second=choose(goal,task(),snapshot);
  assert.equal(first.status,'selected');assert.deepEqual(first,second);
  assert.equal(inferenceRequests,0);assert.equal(canonical({goal,snapshot}),before);
 }finally{globalThis.fetch=originalFetch;Date.now=originalNow;}
});
