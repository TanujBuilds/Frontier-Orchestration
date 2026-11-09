import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {startApi} from '../src/harness/api.mjs';
import {observerClient} from '../src/beta/sources.mjs';
import {locations} from '../src/beta/files.mjs';
import {TerminalObserver,renderTerminal} from '../src/beta/observer.mjs';

const exec=promisify(execFile);
async function fixture(t){
 const home=await mkdtemp(path.join(os.tmpdir(),'mosaic-sources-'));
 const services=[];
 t.after(async()=>{for(const s of services){await s.api.close();s.c.close();}await rm(home,{recursive:true,force:true});});
 for(const name of ['Mosaic Beta','Mosaic']){
  const root=path.join(home,'Library','Application Support',name,'state');
  await mkdir(root,{recursive:true,mode:0o700});
  const c=new Coordinator({root,beta:name==='Mosaic Beta'});
  const dispatcher=new Dispatcher({c});
  if(name==='Mosaic')delete dispatcher.definitions.get('observer_timeline').inputSchema.properties.recent;
  const api=await startApi({dispatcher,token:'a'.repeat(64),viewerToken:'b'.repeat(64),headless:true});
  // Only viewer credentials exist: discovery must never need operator access.
  await writeFile(path.join(root,'viewer-connection.json'),JSON.stringify({url:api.url,token:'b'.repeat(64),role:'viewer'}),{mode:0o600});
  services.push({c,api,root});
 }
 const run=(...args)=>exec(process.execPath,['src/beta/cli.mjs','--home',home,'status','--once',...args],{timeout:10000});
 const goal=(c,label)=>{const g=c.prepareGoal({submissionId:label.replaceAll(" ","-"),objective:label,acceptance:['Evidence'],environment:'fixture'},'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');return g;};
 return {home,beta:services[0],core:services[1],run,goal};
}

test('terminal discovers the existing Mosaic run instead of showing an empty beta',async t=>{
 const f=await fixture(t);
 f.goal(f.core.c,'Build the localhost todo app');
 const {stdout}=await f.run();
 assert.match(stdout,/Build the localhost todo app/);
 assert.match(stdout,/frontier-harness/);
 assert.doesNotMatch(stdout,/no saved goals/);
 assert.doesNotMatch(stdout,/Disconnected/);
});

test('explicit core observation does not require or resume beta setup',async t=>{
 const f=await fixture(t);
 f.goal(f.core.c,'Existing installation');
 const config=path.join(f.home,'Library','Application Support','Mosaic Beta','config');
 await mkdir(config,{recursive:true,mode:0o700});
 await writeFile(path.join(config,'setup-intent.json'),'{}',{mode:0o600});
 const {stdout}=await exec(process.execPath,['src/beta/cli.mjs','--home',f.home,'--source','core'],{timeout:10000});
 assert.match(stdout,/Existing installation/);
 assert.doesNotMatch(stdout,/setup|Choose|Apply these/);
});

test('an open idle terminal discovers a new core run and pages legacy handoff history',async t=>{
 const f=await fixture(t),invoke=observerClient(locations(f.home,true)),observer=new TerminalObserver(invoke);
 await observer.poll();assert.equal(observer.state.snapshot.source,'beta');
 for(let n=0;n<2300;n++)f.core.c.emit('test.unrelated',null,null,{});
 const g=f.goal(f.core.c,'Legacy run');
 await observer.poll();
 assert.equal(observer.state.snapshot.source,'core');
 assert.equal(observer.state.stale,false);
 assert.equal(observer.state.historyPending,true);
 assert.match(renderTerminal(observer.state),/Loading saved handoffs/);
 await observer.poll();
 assert.equal(observer.state.historyPending,false);
 assert.ok(observer.state.events.some(e=>e.goalId===g.id&&e.type==='goal.activated'));
 assert.doesNotMatch(renderTerminal(observer.state),/Loading saved handoffs/);
 await assert.rejects(invoke('goal_activate',{goalId:g.id,hash:g.hash}),/read-only/);
 await rm(path.join(f.core.root,'viewer-connection.json'));
 await observer.poll();
 assert.equal(observer.state.stale,true);
 assert.equal(observer.state.snapshot.source,'core');
 assert.equal(observer.state.goalId,g.id);
});

test('explicit observer source keeps beta and core histories separate',async t=>{
 const f=await fixture(t);
 f.goal(f.core.c,'Core assignment');f.goal(f.beta.c,'Beta assignment');
 const beta=await f.run('--source','beta'),core=await f.run('--source','core');
 assert.match(beta.stdout,/Beta assignment/);assert.doesNotMatch(beta.stdout,/Core assignment/);
 assert.match(core.stdout,/Core assignment/);assert.doesNotMatch(core.stdout,/Beta assignment/);
 await assert.rejects(f.run('--source','unknown'));
});

test('changing the active source resets the feed and routes evidence to its owning coordinator',async t=>{
 const f=await fixture(t),invoke=observerClient(locations(f.home,true)),observer=new TerminalObserver(invoke);
 const coreGoal=f.goal(f.core.c,'Core work');
 const task=f.core.c.submitTask({goalId:coreGoal.id,submissionId:'answer',kind:'consult',objective:'Core evidence',acceptance:['Evidence']},'submit');
 await observer.poll();
 const evidence=await invoke('observer_evidence',{reference:'task-'+task.id,length:4096});
 assert.match(evidence.text,/Core evidence/);
 assert.ok(observer.state.events.some(e=>e.goalId===coreGoal.id));
 f.core.c.control({goalId:coreGoal.id,action:'stop'},'stop');
 const betaGoal=f.goal(f.beta.c,'Beta work');
 await observer.poll();
 assert.equal(observer.state.snapshot.source,'beta');
 assert.equal(observer.state.goalId,betaGoal.id);
 assert.ok(observer.state.events.length>0);
 assert.ok(observer.state.events.every(e=>e.goalId===betaGoal.id));
});
