import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Worker} from '../src/harness/worker.mjs';
import {ResearchClient} from '../src/harness/research.mjs';
import {command} from '../src/project/process.mjs';
import {fixture,policy} from '../test-support/research-review-binding.mjs';

for(const recovery of ['queued restart','uncertain reconciliation'])test(`completed real Python research with persisted paused cursor collects after ${recovery}`,async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'review-terminal-restart-'));
 let c=new Coordinator({root:path.join(root,'parent')});
 t.after(async()=>{c.close();await rm(root,{recursive:true,force:true});});
 const config={environment:'fixture',research:{python:process.env.FRONTIER_TEST_PYTHON??'python3',dataDir:path.join(root,'remote'),pollMs:0}};
 const client=new ResearchClient(config.research),g=c.prepareGoal({submissionId:'g',objective:'Offline restart fixture',acceptance:['Exact locally accepted report'],environment:'fixture',researchPolicy:policy},'p');
 c.activateGoal({goalId:g.id,hash:g.hash},'a');
 const task=c.submitTask({goalId:g.id,submissionId:'r',kind:'research',objective:'Offline restart fixture',acceptance:['Exact locally accepted report'],limits:{questions:0}},'t');
 let w=new Worker({c,config,owner:'original-owner'});
 const drive=async action=>{const result=await command([config.research.python,'-B',fileURLToPath(new URL('./research/review_fixture_driver.py',import.meta.url)),config.research.dataDir,c.getTask(task.id).checkpoint.remoteJobId,action]);assert.equal(result.code,0,result.stderr);};
 await w.tick();await w.tick();await drive('initial');await w.tick();
 const waiting=c.getTask(task.id),d=waiting.checkpoint.reviewCandidate,binding={taskId:task.id,candidateHash:d.candidateHash,rubricHash:d.rubricSha256};
 const ticket=await w.adapters.research.review({action:'reserve',...binding},'reserve');
 await w.adapters.research.review({action:'submit',...binding,ticketId:ticket.id,decision:'accept',findings:[],coverage:d.units},'submit');
 // Persist this cursor through production pause/resume controls and adapter polling.
 c.claimNext(w.owner);c.control({taskId:task.id,action:'pause'},'pause');await w.tick();
 assert.equal(c.getTask(task.id).status,'paused');assert.equal(c.getTask(task.id).checkpoint.remotePaused,true);
 c.control({taskId:task.id,action:'resume'},'resume');
 if(recovery==='uncertain reconciliation'){c.claimNext(w.owner);c.markUncertain(task.id,'Saved contact uncertainty',w.owner);}
 const before=c.getTask(task.id),reviewers=c.store.all('reviewer'),remoteBefore=await client.call({command:'status',job:before.checkpoint.remoteJobId});
 assert.equal(remoteBefore.status,'suspended');
 // Finalization runs while the coordinator is unavailable, with no model/retrieval work.
 const jid=before.checkpoint.remoteJobId;c.close();
 const finalized=await command([config.research.python,'-B',fileURLToPath(new URL('./research/review_fixture_driver.py',import.meta.url)),config.research.dataDir,jid,'finalize']);assert.equal(finalized.code,0,finalized.stderr);
 c=new Coordinator({root:path.join(root,'parent')});w=new Worker({c,config,owner:'restarted-owner'});c.acquireWorker(w.owner);
 const calls=[],a=w.adapters.research,rpc=a.rpc;a.rpc=async request=>{calls.push(request.command);return rpc(request);};
 if(recovery==='uncertain reconciliation')await a.reconcile({taskId:task.id},'reconcile');else await w.tick();
 const after=c.getTask(task.id),remoteAfter=await client.call({command:'status',job:jid});
 assert.equal(after.status,'accepted',after.reason);assert.equal(calls.includes('resume'),false);
 assert.equal(after.id,before.id);assert.equal(after.goalId,before.goalId);assert.equal(after.deadline,before.deadline);assert.equal(after.checkpoint.remoteJobId,jid);
 assert.deepEqual(after.spent,before.spent);assert.deepEqual(after.feedback,before.feedback);assert.deepEqual(after.researchReviewAcceptance,before.researchReviewAcceptance);assert.deepEqual(c.store.all('reviewer'),reviewers);
 assert.equal(remoteAfter.deadline,remoteBefore.deadline);assert.deepEqual(remoteAfter.counters,remoteBefore.counters);
 assert.equal(after.checkpoint.remotePaused,false);assert.equal(after.result.checksumsVerified,true);
 assert.equal(c.store.events(0,1000).filter(e=>e.type==='task.result'&&e.data.status==='accepted').length,1);
 await w.tick();assert.deepEqual(c.getTask(task.id),after);
 if(process.env.FRONTIER_RESTART_EVIDENCE)await writeFile(path.join(process.env.FRONTIER_RESTART_EVIDENCE,recovery.replaceAll(' ','-')+'.json'),JSON.stringify({fixture:true,before,after,remoteBefore,remoteAfter,calls,reviewers},null,2)+'\n');
});

for(const [status,quiescent,wantResume,wantStatus]of [
 ['completed',true,0,'accepted'],['partial',true,0,'partial'],['queued',true,0,'running'],['running',false,0,'running'],
 ['suspended',true,1,'running'],['stopped',true,1,'running'],['blocked',true,1,'running'],['failed',true,1,'running']
])test(`paused cursor observes ${status} lifecycle before considering resume`,async t=>{
 const f=await fixture(t);await f.accept();f.remote.status=status;f.remote.quiescent=quiescent;
 f.c.store.tx(()=>{const task=f.c.store.get('task',f.task.id);task.checkpoint.remotePaused=true;f.c.store.put('task',task);});
 const rpc=f.a.rpc,commands=[];f.a.rpc=async request=>{commands.push(request.command);if(request.command==='resume'){assert.equal(f.remote.quiescent,true);f.remote.status='queued';return {};}return rpc(request);};
 f.c.claimNext('owner');await f.a.step(f.c.getTask(f.task.id),'owner');
 assert.equal(commands[0],'status');assert.equal(commands.filter(x=>x==='resume').length,wantResume);assert.equal(f.c.getTask(f.task.id).status,wantStatus);
});

for(const control of ['pause','stop'])test(`paused cursor cannot resume through requested ${control}`,async t=>{
 const f=await fixture(t);await f.accept();f.remote.status='suspended';f.c.claimNext('owner');f.c.control({taskId:f.task.id,action:control},control);
 f.c.store.tx(()=>{const task=f.c.store.get('task',f.task.id);task.checkpoint.remotePaused=true;f.c.store.put('task',task);});
 const rpc=f.a.rpc,commands=[];f.a.rpc=async request=>{commands.push(request.command);if(['yield','stop'].includes(request.command))return {};return rpc(request);};
 await f.a.step(f.c.getTask(f.task.id),'owner');assert.equal(commands.includes('resume'),false);assert.equal(f.c.getTask(f.task.id).status,control==='pause'?'paused':'stopped');
});

for(const mismatch of ['id','manifest_hash'])test(`paused cursor cannot resume a mismatched remote ${mismatch}`,async t=>{
 const f=await fixture(t);await f.accept();f.remote.status='suspended';f.remote[mismatch]='wrong';
 f.c.store.tx(()=>{const task=f.c.store.get('task',f.task.id);task.checkpoint.remotePaused=true;f.c.store.put('task',task);});
 f.c.claimNext('owner');await f.a.step(f.c.getTask(f.task.id),'owner');assert.equal(f.calls.some(x=>x.command==='resume'),false);assert.equal(f.c.getTask(f.task.id).status,'uncertain');
});

test('completion between observed suspension and resume is recollected without renewed work',async t=>{
 const f=await fixture(t);await f.accept();const before=f.c.getTask(f.task.id);f.remote.status='suspended';
 f.c.store.tx(()=>{const task=f.c.store.get('task',f.task.id);task.checkpoint.remotePaused=true;f.c.store.put('task',task);});
 const rpc=f.a.rpc,commands=[];f.a.rpc=async request=>{commands.push(request.command);if(request.command==='resume'){f.remote.status='completed';throw Error('only stopped, blocked, or failed jobs can resume');}return rpc(request);};
 f.c.claimNext('owner');await f.a.step(f.c.getTask(f.task.id),'owner');const after=f.c.getTask(f.task.id);
 assert.equal(after.status,'accepted',after.reason);assert.equal(commands[0],'status');assert.equal(commands.filter(x=>x==='resume').length,1);assert.equal(commands.filter(x=>x==='status').length,2);assert.deepEqual(after.spent,before.spent);assert.equal(after.reviews,before.reviews);assert.equal(after.deadline,before.deadline);
});

for(const quiescent of [false,true])test(`unknown execution cannot be resumed despite quiescent=${quiescent}`,async t=>{
 const f=await fixture(t);await f.accept();f.remote.status='suspended';f.remote.quiescent=quiescent;f.remote.execution={status:'uncertain'};
 f.c.store.tx(()=>{const task=f.c.store.get('task',f.task.id);task.checkpoint.remotePaused=true;f.c.store.put('task',task);});
 f.c.claimNext('owner');await f.a.step(f.c.getTask(f.task.id),'owner');assert.equal(f.calls.some(x=>x.command==='resume'),false);assert.equal(f.c.getTask(f.task.id).status,'uncertain');
});

test('paused cursor does not authorize resume after the original deadline',async t=>{
 let now=Date.now();const f=await fixture(t,{now:()=>now});await f.accept();f.remote.status='suspended';
 f.c.store.tx(()=>{const task=f.c.store.get('task',f.task.id);task.checkpoint.remotePaused=true;f.c.store.put('task',task);});
 f.c.claimNext('owner');const deadline=f.c.getTask(f.task.id).deadline;now=deadline;
 await f.a.step(f.c.getTask(f.task.id),'owner');assert.equal(f.calls.some(x=>x.command==='resume'),false);assert.equal(f.c.getTask(f.task.id).status,'partial');assert.equal(f.c.getTask(f.task.id).deadline,deadline);
});

test('a terminal status observed after a failed resume cannot override uncertain execution',async t=>{
 const f=await fixture(t);await f.accept();f.remote.status='suspended';
 f.c.store.tx(()=>{const task=f.c.store.get('task',f.task.id);task.checkpoint.remotePaused=true;f.c.store.put('task',task);});
 const rpc=f.a.rpc;f.a.rpc=async request=>{if(request.command==='resume'){f.remote.status='completed';f.remote.execution={status:'uncertain'};throw Error('Resume reply lost');}return rpc(request);};
 f.c.claimNext('owner');await f.a.step(f.c.getTask(f.task.id),'owner');assert.equal(f.c.getTask(f.task.id).status,'uncertain');
});

for(const control of ['pause','stop','yield'])test(`${control} arriving during status observation takes effect before resume`,async t=>{
 const f=await fixture(t);await f.accept();f.remote.status='suspended';
 f.c.store.tx(()=>{const task=f.c.store.get('task',f.task.id);task.checkpoint.remotePaused=true;f.c.store.put('task',task);});
 f.c.claimNext('owner');const before=f.c.getTask(f.task.id),rpc=f.a.rpc,commands=[];let first=true;
 f.a.rpc=async request=>{
  commands.push(request.command);
  if(request.command==='status'&&first){first=false;if(control==='yield')f.c.submitTask({goalId:f.g.id,submissionId:'blocking',kind:'consult',objective:'Fixture priority yield only',acceptance:['Never dispatch'],priority:'blocking'},'blocking');else f.c.control({taskId:f.task.id,action:control},control);}
  if(request.command==='resume'){f.remote.status='queued';return {};}
  return rpc(request);
 };
 await f.a.step(before,'owner');const after=f.c.getTask(f.task.id);
 assert.equal(after.status,{pause:'paused',stop:'stopped',yield:'suspended'}[control],after.reason);assert.equal(after.owner,null);assert.equal(commands.includes('resume'),false);assert.equal(f.remote.status,'suspended');assert.equal(after.checkpoint.remotePaused,true);
 assert.deepEqual(after.spent,before.spent);assert.equal(after.deadline,before.deadline);assert.deepEqual(after.researchReviewAcceptance,before.researchReviewAcceptance);
 if(control!=='yield'){f.c.control({taskId:f.task.id,action:'resume'},'manual-resume');assert.equal(f.c.getTask(f.task.id).status,'queued');}
});

for(const stage of ['queued observation','resume reply'])for(const control of ['pause','stop','yield'])test(`${control} during ${stage} durably suspends remote work before releasing ownership`,async t=>{
 const f=await fixture(t);await f.accept();f.remote.status=stage==='queued observation'?'queued':'suspended';
 f.c.store.tx(()=>{const task=f.c.store.get('task',f.task.id);task.checkpoint.remotePaused=true;f.c.store.put('task',task);});
 f.c.claimNext('owner');const before=f.c.getTask(f.task.id),rpc=f.a.rpc,commands=[];let injected=false;
 const inject=()=>{injected=true;if(control==='yield')f.c.submitTask({goalId:f.g.id,submissionId:'blocking',kind:'consult',objective:'Fixture priority yield only',acceptance:['Never dispatch'],priority:'blocking'},'blocking');else f.c.control({taskId:f.task.id,action:control},control);};
 f.a.rpc=async request=>{
  commands.push(request.command);
  if(request.command==='status'&&!injected&&stage==='queued observation')inject();
  if(request.command==='resume'){f.remote.status='queued';inject();return {};}
  if(request.command==='yield'||request.command==='stop'){f.remote.status=request.command==='stop'?'stopped':'suspended';return {};}
  return rpc(request);
 };
 await f.a.step(before,'owner');const after=f.c.getTask(f.task.id);
 assert.equal(after.status,{pause:'paused',stop:'stopped',yield:'suspended'}[control],after.reason);assert.equal(after.owner,null);
 assert.equal(f.remote.status,control==='stop'?'stopped':'suspended');assert.equal(after.checkpoint.remotePaused,true);assert.equal(commands.includes(control==='stop'?'stop':'yield'),true);
 assert.deepEqual(after.spent,before.spent);assert.equal(after.deadline,before.deadline);assert.deepEqual(after.researchReviewAcceptance,before.researchReviewAcceptance);
});

test('paused identity verification survives cursor clearing before a late control response',async t=>{
 const f=await fixture(t);await f.accept();f.remote.status='queued';
 f.c.store.tx(()=>{const task=f.c.store.get('task',f.task.id);task.checkpoint.remotePaused=true;f.c.store.put('task',task);});
 f.c.claimNext('owner');const rpc=f.a.rpc;let first=true;
 f.a.rpc=async request=>{if(request.command==='status'&&first){first=false;f.c.control({taskId:f.task.id,action:'pause'},'pause');}if(request.command==='yield'){f.remote.status='suspended';f.remote.id='wrong-job';return {};}return rpc(request);};
 await f.a.step(f.c.getTask(f.task.id),'owner');assert.equal(f.c.getTask(f.task.id).status,'uncertain');
});

test('uncertain execution retains newly observed spending before failing closed',async t=>{
 const f=await fixture(t);await f.accept();const before=f.c.getTask(f.task.id);f.remote.status='suspended';f.remote.quiescent=false;f.remote.execution={status:'uncertain'};f.remote.counters.model=3;
 f.c.store.tx(()=>{const task=f.c.store.get('task',f.task.id);task.checkpoint.remotePaused=true;f.c.store.put('task',task);});
 f.c.claimNext('owner');await f.a.step(f.c.getTask(f.task.id),'owner');const after=f.c.getTask(f.task.id);
 assert.equal(after.status,'uncertain');assert.equal(after.remoteSpent.model,3);assert.equal(after.spent.model,3);assert.equal(after.deadline,before.deadline);assert.deepEqual(after.researchReviewAcceptance,before.researchReviewAcceptance);assert.equal(f.calls.some(x=>x.command==='resume'),false);
});
