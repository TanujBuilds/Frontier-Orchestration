import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,rename,access} from 'node:fs/promises';
import {fixture,goal,candidate,accept} from './fixtures/mosaic-pb14-integration/fixture.mjs';
import {digest} from '../src/harness/contracts.mjs';
import {git} from '../src/project/process.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';

async function failedImport(t){
 const f=await fixture(t,{check:'if(a+b>1)process.exit(1);'}),g=goal(f,'controlled-repair'),a=await candidate(f,g,'a'),b=await candidate(f,g,'b');
 await a.finish();await b.finish();const first=await accept(f,a.task);await assert.rejects(accept(f,b.task),/Integrated checks failed/);
 return {...f,g,a,b,first};
}
for(const control of ['expired','stopped','paused'])test(`recorded inverse import restores target after goal ${control}`,{timeout:30000},async t=>{
 const f=await failedImport(t),before=f.c.getTask(f.b.task.id),gBefore=f.c.getGoal(f.g.id);
 if(control==='expired')f.c.now=()=>f.g.deadline+1;else f.c.control({goalId:f.g.id,action:control==='stopped'?'stop':'pause'},'control');
 const dispatcher=new Dispatcher({c:f.c,worker:{integration:f.i}}),input={taskId:before.id,reason:'Restore exact failed import without resuming work',idempotencyKey:'repair'};
 const operation=await dispatcher.invoke('task_integration_repair',input);await dispatcher.whenIdle();
 const saved=f.c.store.get('operation',operation.id);assert.equal(saved.status,'completed',saved.error);const after=saved.result;
 assert.equal(after.status,'blocked');assert.equal(f.c.getGoal(f.g.id).integrationPending,null);assert.equal(f.c.getGoal(f.g.id).deadline,gBefore.deadline);
 assert.equal(await readFile(path.join(f.first.integration.worktree,'src/b.mjs'),'utf8'),'export const b=0;\n');
 assert.equal(await git(f.first.integration.worktree,'rev-parse','HEAD'),f.first.integration.commit);
 assert.equal(after.deadline,before.deadline);assert.deepEqual(after.spent,before.spent);assert.equal(after.reviews,before.reviews);assert.equal(after.attempts,before.attempts);
 assert.equal(f.c.getTask(f.a.task.id).status,'accepted');assert.equal(await readFile(path.join(f.b.started.native.worktree,'src/b.mjs'),'utf8'),'export const b=1;\n');
 const replay=await dispatcher.invoke('task_integration_repair',input);assert.equal(replay.id,operation.id);assert.deepEqual(replay.result,after);
 await assert.rejects(f.i.executionBase(f.g.id),/not active|deadline exceeded/);
 await assert.rejects(accept(f,f.b.task,'expired-accept'),/not active|deadline exceeded/);
});

for(const hazard of ['approval','owner','candidate','import','missing-pin','preimage','missing-worktree','sealed','missing-journal'])test(`controlled repair refuses ${hazard} changes`,{timeout:30000},async t=>{
 const f=await failedImport(t),target=f.first.integration.worktree;
 if(hazard==='preimage')await writeFile(path.join(target,'src/b.mjs'),'export const b=99;\n');
 else if(hazard==='missing-worktree')await rename(target,target+'-preserved');
 else if(hazard==='missing-journal'){const journal=await f.i.integrationJournal(f.c.getGoal(f.g.id));await rename(journal.file,journal.file+'.preserved');}
 else f.c.store.tx(()=>{
  const g=f.c.store.get('goal',f.g.id),task=f.c.store.get('task',f.b.task.id);
  if(hazard==='approval'){g.manifest.objective='Unapproved changed manifest';}
  if(hazard==='owner')task.owner='unreleased-owner';
  if(hazard==='candidate')g.integrationPending.candidateCommit=f.base;
  if(hazard==='import')g.integrationPending.importKey='unrelated-import';
  if(hazard==='missing-pin')delete g.integration;
  if(hazard==='sealed')g.integrationSealed={worktree:target};
  f.c.store.put('goal',g);f.c.store.put('task',task);
 });
 f.c.now=()=>f.g.deadline+1;
 await assert.rejects(f.i.repair({taskId:f.b.task.id,reason:'Refuse changed recovery authority'},'unsafe-repair'));
 assert.ok(f.c.getGoal(f.g.id).integrationPending);assert.equal(f.c.getTask(f.a.task.id).status,'accepted');
 if(hazard==='missing-worktree')await assert.rejects(access(target),{code:'ENOENT'});
 else assert.equal(await readFile(path.join(target,'src/b.mjs'),'utf8'),hazard==='preimage'?'export const b=99;\n':'export const b=1;\n');
});

for(const hazard of ['approval','owner','candidate','import'])test(`repair rechecks ${hazard} after asynchronous journal preparation`,{timeout:30000},async t=>{
 const f=await failedImport(t),original=f.i.integrationJournal.bind(f.i);let changed=false;
 f.i.integrationJournal=async(...args)=>{
  const journal=await original(...args);
  if(!changed){changed=true;f.c.store.tx(()=>{const g=f.c.store.get('goal',f.g.id),task=f.c.store.get('task',f.b.task.id);
   if(hazard==='approval'){g.version++;g.manifest.objective='Later approved version';g.hash=digest(g.manifest);task.goalVersion=g.version;}
   if(hazard==='owner')task.owner='new-owner';
   if(hazard==='candidate')g.integrationPending.candidateCommit=f.base;
   if(hazard==='import')g.integrationPending.importKey='replaced-import';
   f.c.store.put('goal',g);f.c.store.put('task',task);
  });}return journal;
 };
 f.c.now=()=>f.g.deadline+1;
 await assert.rejects(f.i.repair({taskId:f.b.task.id,reason:'Keep original rollback pins across awaits'},'raced-repair'));
 assert.equal(changed,true);assert.ok(f.c.getGoal(f.g.id).integrationPending);assert.equal(await readFile(path.join(f.first.integration.worktree,'src/b.mjs'),'utf8'),'export const b=1;\n');
});


test('expired fresh admission cannot create an integration workspace',async t=>{
 const f=await fixture(t),g=goal(f,'expired-fresh');f.c.now=()=>g.deadline+1;
 await assert.rejects(f.i.executionBase(g.id),/deadline exceeded/);assert.equal(f.c.getGoal(g.id).integration,undefined);
 const journal=await f.i.integrationJournal(f.c.getGoal(g.id));assert.equal(journal.last('workspace.created'),undefined);await assert.rejects(access(path.join(journal.dir,'worktree')),{code:'ENOENT'});
});
