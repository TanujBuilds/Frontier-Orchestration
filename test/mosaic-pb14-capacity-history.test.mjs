import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';
import {digest} from '../src/harness/contracts.mjs';
import {profile} from './fixtures/mosaic-pb13/public-fixture.mjs';
import {capacitySnapshot,inferenceWait,inferenceResource} from '../src/harness/scheduling/capacity.mjs';

function fixture(t){
 const root=mkdtempSync(path.join(os.tmpdir(),'pb14-capacity-history-'));
 const a={...profile('a','http://127.0.0.1:1/v1'),roles:['worker','reviewer'],concurrency:2},b={...profile('b','http://127.0.0.1:2/v1'),concurrency:2};
 const registry=ProviderRegistry({profiles:[a,b]}),c=new Coordinator({root,providerRegistry:registry,selectedHost:'codex',serviceMaxConcurrentTasks:4});
 t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 const workers=registry.snapshot([a,b].map(p=>({id:p.id,revision:p.revision})));
 const raw=(id,limit=2,api=false)=>({submissionId:id,objective:'Preserve capacity provenance',acceptance:['Bounded independent work'],environment:'fixture',mode:'collaborative',providerPolicy:{version:1,workers,plannerWorkerId:a.id,defaultWorkerId:a.id,maxConcurrentTasks:4,capacityGroups:[{id:a.capacityGroup,limit},{id:b.capacityGroup,limit:2}]},...(api?{reviewPolicy:{version:1,source:'api',reviewer:workers[0],fallback:'wait'}}:{})});
 const goal=(id,limit=2,api=false)=>{const g=c.prepareGoal(raw(id,limit,api),'prepare-'+id);return c.activateGoal({goalId:g.id,hash:g.hash},'activate-'+id);};
 const task=(g,id)=>c.submitTask({goalId:g.id,submissionId:id,kind:'consult',objective:'Answer bounded fixture',acceptance:['Answer']},id);
 const close=g=>{const prior=task(g,'close-'+g.id);c.control({taskId:prior.id,action:'stop'},'stop-'+g.id);new Goals(c).finalize({goalId:g.id,partial:true,summary:'Closed prior approval'},'final-'+g.id);return prior;};
 const insert=(taskId,data,kind='model',id='held')=>c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(id,taskId,id,kind,'reserved',JSON.stringify(data));
 return {c,a,b,workers,raw,goal,task,close,insert};
}

test('quiescent group widening allows two real reservations despite narrower terminal history',t=>{
 const f=fixture(t),old=f.goal('old',1);f.close(old);const oldBytes=JSON.stringify(f.c.getGoal(old.id));
 const g=f.goal('fresh',2),a=f.task(g,'fresh-a'),b=f.task(g,'fresh-b');f.c.claimNext('a');f.c.claimNext('b');
 f.c.reserve(a.id,{key:'consult-1',kind:'model'},'a');
 assert.equal(inferenceWait(f.c,g,f.c.providerBinding(g,f.b.id)),null,'unrelated physical group remains usable');
 assert.doesNotThrow(()=>f.c.reserve(b.id,{key:'consult-1',kind:'model'},'b'));
 assert.equal(capacitySnapshot(f.c).requests.length,2);assert.equal(inferenceWait(f.c,g,f.c.providerBinding(g,f.a.id)).reasonCode,'capacity_group_busy');
 assert.equal(JSON.stringify(f.c.getGoal(old.id)),oldBytes);
});

for(const role of ['planner','reviewer'])test(`${role} receipts use their owning goal after group widening`,t=>{
 const f=fixture(t),old=f.goal('old-'+role,1,true);f.close(old);const g=f.goal('fresh-'+role,2,true),task=f.task(g,'fresh-'+role+'-task');
 const binding=role==='planner'?f.c.providerBinding(g,f.a.id):{version:1,providerId:f.a.id,revision:f.a.revision,profileHash:digest(f.workers[0]),policyHash:g.manifest.reviewPolicyHash};
 f.insert(role==='planner'?g.id:task.id,{[role==='planner'?'providerBinding':'reviewerBinding']:binding,capacityResource:inferenceResource(f.c,g,binding)},role==='planner'?'model':'apiReview');
 assert.equal(inferenceWait(f.c,g,f.c.providerBinding(g,f.a.id)),null);
 assert.equal(inferenceWait(f.c,g,f.c.providerBinding(g,f.b.id)),null);
 assert.equal(capacitySnapshot(f.c).requests[0].resource.groupLimit,2);
});

for(const owner of ['task','goal'])test(`exact old policy resolves from ${owner} owner history after revision`,t=>{
 const f=fixture(t),g=f.goal('history-'+owner),task=f.task(g,'history-task'),binding=f.c.providerBinding(g,f.a.id),goals=new Goals(f.c);
 const raw=f.raw(g.manifest.submissionId),policy=raw.providerPolicy;
 raw.providerPolicy={...policy,workers:[f.workers[1]],plannerWorkerId:f.b.id,defaultWorkerId:f.b.id,capacityGroups:[policy.capacityGroups[1]]};
 const revision=goals.prepareRevision({goalId:g.id,expectedHash:g.hash,manifest:raw},'history-revision');goals.activateRevision({revisionId:revision.id,hash:revision.hash},'history-activate');
 f.insert(owner==='goal'?g.id:task.id,{providerBinding:binding,capacityResource:inferenceResource(f.c,g,binding)});
 assert.equal(capacitySnapshot(f.c).requests[0].resource?.capacityGroup,f.a.capacityGroup);
 const current=f.c.getGoal(g.id);assert.equal(inferenceWait(f.c,current,f.c.providerBinding(current,f.b.id)),null);
});

for(const mutation of ['unknown-policy','foreign-owner','wrong-version','conflicting-bindings','malformed-resource'])test(`${mutation} receipt stays globally held without rewriting history`,t=>{
 const f=fixture(t),old=f.goal('old-invalid',1),oldTask=f.close(old),g=f.goal('current-invalid',2),task=f.task(g,'invalid-task'),binding=f.c.providerBinding(g,f.a.id);
 let owner=task.id,data={providerBinding:binding};
 if(mutation==='unknown-policy')data.providerBinding={...binding,policyHash:'0'.repeat(64)};
 if(mutation==='foreign-owner')owner=oldTask.id;
 if(mutation==='wrong-version')data.providerBinding={...binding,version:2};
 if(mutation==='conflicting-bindings')data.reviewerBinding={...binding,providerId:f.b.id};
 if(mutation==='malformed-resource')data.capacityResource={capacityGroup:f.a.capacityGroup};
 f.insert(owner,data);const before=f.c.store.db.prepare('SELECT * FROM requests').all();
 assert.equal(capacitySnapshot(f.c).requests[0].resource,null);
 assert.equal(inferenceWait(f.c,g,f.c.providerBinding(g,f.b.id)).reasonCode,'legacy_inference_busy');
 assert.deepEqual(f.c.store.db.prepare('SELECT * FROM requests').all(),before);
});

test('historical exact binding without capacity metadata retains only its known group',t=>{
 const f=fixture(t),g=f.goal('legacy-bound');f.insert('retained-orphan-task',{providerBinding:f.c.providerBinding(g,f.a.id)});
 assert.equal(capacitySnapshot(f.c).requests[0].resource.groupLimit,2);
 assert.equal(inferenceWait(f.c,g,f.c.providerBinding(g,f.b.id)),null);
});

test('historical no-policy reservation remains a global inference hold',t=>{
 const f=fixture(t),g=f.goal('legacy-unbound');f.insert('historic-owner',{owner:'historical-worker'},'codexReview');
 assert.equal(inferenceWait(f.c,g,f.c.providerBinding(g,f.b.id)).reasonCode,'legacy_inference_busy');
});

test('active parallel process lanes exclude legacy claims while portable admission stays available',t=>{
 const f=fixture(t),portable=f.goal('portable-lane'),draft=f.c.prepareLegacyGoal({submissionId:'legacy-lane',objective:'Historical single lane',acceptance:['Sequential'],environment:'fixture',mode:'collaborative'},'legacy-lane-prepare');
 const legacy=f.c.activateGoal({goalId:draft.id,hash:draft.hash},'legacy-lane-activate'),old=f.task(legacy,'legacy-first'),fresh=f.task(portable,'portable-second');
 f.c.autonomousParallelBusy=true;
 const claimed=f.c.claimNext('parallel-owner');assert.equal(claimed?.id,fresh.id);assert.equal(f.c.getTask(old.id).status,'queued');
 f.c.completeTask(fresh.id,{content:'Portable lane completed'},'parallel-owner');
 f.c.autonomousParallelBusy=false;
 assert.equal(f.c.claimNext('legacy-owner')?.id,old.id);
});
