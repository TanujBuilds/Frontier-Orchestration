import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { Agents } from './agents.mjs';
import { Journal } from '../project/journal.mjs';
import { Workspace } from '../project/workspace.mjs';
import { git } from '../project/process.mjs';
import { digest, text } from './contracts.mjs';
import { normalizeNativeCandidate } from './collaboration-contracts.mjs';

// The host confirms finish/release. Reported progress never proves quiescence.
export class NativeCandidates {
 constructor(integration){this.i=integration;this.c=integration.c;this.agents=new Agents({c:this.c,config:integration.config});}
 async open(task){
  if(task.native?.layout!=='candidate_v1')throw Error('Native candidate layout required');
  const journal=await new Journal(path.join(this.c.store.root,'native-candidates'),task.id).load();
  const manifest=task.native.manifest,workspace=new Workspace(manifest,journal);
  // A distinct branch also prevents collision with this task's original coding journal.
  workspace.branch=`orchestrator/native-${task.id}`;
  return {journal,workspace,manifest};
 }
 async start(taskId,extra={},registration=null){
  let t=this.c.getTask(taskId),g=this.c.store.get('goal',t.goalId);
  this.c.liveTask(t,{allowStopped:!!extra.takeoverReason});
  if(!g.manifest.mode.actors.includes('codex')||t.spec.kind!=='coding')throw Error('Mode prohibits native Codex execution');
  if(t.native&&t.native.layout!=='candidate_v1')throw Error('Existing native layout cannot be changed');
  if(t.owner||!['codex_ready','codex_active','stopped','blocked'].includes(t.status))throw Error('Worker must be quiescent before native execution');
  if(t.spec.actor!=='codex'&&!extra.takeoverReason&&!t.native)throw Error('Explicit takeover required for DeepSeek task');
  if(!t.spec.dependsOn.every(id=>this.c.getTask(id).status==='accepted'))throw Error('Dependencies are incomplete');
  if(t.native?.writerActive&&t.status!=='codex_active')throw Error('Existing native writer requires explicit host completion or release');
  if(t.native?.status==='partial')throw Error('Preserved partial candidate cannot restart without explicit rebind');
  if(t.native&&t.status==='blocked')throw Error('Native revision budget exhausted');
  // The committed base is resolved once, never from a dirty source fallback.
  const base=t.native?.baseCommit??await this.i.executionBase(g.id);
  if(registration&&(registration.taskId!==t.id||registration.actor!=='codex'))throw Error('Native registration task/actor mismatch');
  const agentId=registration?this.agents.register(registration,`native-agent-${t.id}`).id:t.native?.agentId??this.agents.register({version:1,taskId:t.id,role:'implementer',actor:'codex'},`native-agent-${t.id}`).id;
  this.c.store.tx(()=>{
   const current=this.c.liveTask(t,{allowStopped:!!extra.takeoverReason});
   if(current.owner)throw Error('Worker ownership changed');
   if(!current.native){
    const p=g.manifest.project,manifest={repo:p.repo,baseCommit:base,permissions:{readPaths:current.spec.permissions.readPaths,writePaths:current.spec.permissions.writePaths,checks:p.checks.filter(x=>current.spec.permissions.checks.includes(x.id))}};
    current.native={layout:'candidate_v1',agentId,baseCommit:base,manifest,round:1,status:'starting',writerActive:true,...extra};
   }else if(current.status==='codex_ready'){
    current.native.round++;current.native.status='starting';current.native.writerActive=true;
   }
   current.status='codex_active';current.executionActor='codex';current.stopRequested=false;current.startedAt??=this.c.now();current.deadline??=Math.min(g.deadline,current.startedAt+current.spec.limits.seconds*1000);
   this.c.store.put('task',current);
  });
  t=this.c.getTask(taskId);const target=await this.open(t),release=await target.journal.lock();
  try{
   if(!target.journal.last('harness.manifest'))await target.journal.append('harness.manifest',target.manifest);
   await target.workspace.initialize();
   // Replayed start cannot discard a writer's unreported edits.
   if(t.native.status==='starting')await target.workspace.recover();
   this.c.store.tx(()=>{
    const current=this.c.liveTask(t);if(current.status!=='codex_active')throw Error('Native ownership changed');
    current.native={...current.native,worktree:target.workspace.root,branch:target.workspace.branch,status:'active'};
    this.c.store.put('task',current);this.c.learning.pin(t.id);this.c.emit('task.native_started',g.id,t.id,{layout:'candidate_v1',baseCommit:base,worktree:target.workspace.root});
   });
   return this.c.getTask(t.id);
  }finally{await release();}
 }
 async frozen(t){
  if(!t.native.workerSnapshot)return;
  const source=await this.i.candidate(t,{original:true}),release=await source.journal.lock();
  try{if(digest(await source.workspace.snapshot())!==digest(t.native.workerSnapshot))throw Error('Frozen worker checkout changed after takeover');}finally{await release();}
 }
 async finish(input){
  let t=this.c.getTask(input.taskId);text(input.summary,'summary');
  if(['awaiting_review','ready_to_integrate','accepted'].includes(t.status)&&!t.native.writerActive)return t;
  this.c.liveTask(t);if(t.status!=='codex_active'||!t.native.writerActive)throw Error('Native task ownership mismatch');
  const target=await this.open(t),release=await target.journal.lock();
  try{
   await this.frozen(t);
   const {workspace,journal}=target;
   // Validate the complete base diff before adopting any manual changes.
   const changes=await this.i.changes(workspace,t.native.baseCommit,t.spec.permissions.writePaths);
   // Also reject unexpected commits: manual file writes are allowed, arbitrary Git history is not.
   const expected=journal.last('stage.accepted')?.commit??t.native.baseCommit,head=await git(workspace.root,'rev-parse','HEAD');
   const stage=`native-${t.native.round}`;
   if(head!==expected){
    const pending=journal.events.some(e=>e.type==='operation.started'&&e.data.key===`${stage}/checkpoint`);
    if(!pending||await git(workspace.root,'log','-1','--format=%s')!==`Orchestrator ${journal.id} stage ${stage}`||await git(workspace.root,'rev-parse','HEAD^')!==expected)throw Error('Native candidate HEAD changed outside recorded checkpoints');
   }
   const snapshot=await workspace.snapshot();await journal.append('native.adopted',{taskId:t.id,snapshot,round:t.native.round});
   const runner=this.i.checks(workspace),sandbox=await runner.verify(),results=await runner.run(target.manifest.permissions.checks,stage);
   await workspace.assertSnapshot(snapshot);
   await journal.append('native.checks',{round:t.native.round,checks:results,sandbox});
   if(!results.every(r=>r.passed))throw Error('Native checks failed');
   this.c.liveTask(t);
   const checkpoint=await journal.memo(`${stage}/checkpoint`,()=>workspace.checkpoint({id:stage,writePaths:t.spec.permissions.writePaths}));
   if(!journal.events.some(e=>e.type==='stage.accepted'&&e.data.stageId===stage))await journal.append('stage.accepted',{stageId:stage,...checkpoint});
   return this.c.store.tx(()=>{
    const current=this.c.liveTask(t);if(current.status!=='codex_active')throw Error('Native ownership changed');
    const candidate=normalizeNativeCandidate({version:1,taskId:t.id,baseCommit:t.native.baseCommit,worktree:workspace.root,commit:checkpoint.commit,status:'awaiting_review',checks:results});
    current.native={...current.native,...candidate,writerActive:false};current.status='awaiting_review';
    current.result={summary:input.summary,changes,checks:results,sandbox,baseCommit:t.native.baseCommit,worktree:workspace.root,journalRoot:journal.root,accounting:'Native host usage unavailable'};
    this.c.store.put('task',current);this.c.emit('task.native_finished',t.goalId,t.id,{status:current.status,commit:checkpoint.commit});return this.c.getTask(t.id);
   });
  }finally{await release();}
 }
 async release(input){
  const t=this.c.getTask(input.taskId);text(input.reason,'release reason');
  if(t.status==='partial'&&t.result?.savedNative)return t;
  if(t.status!=='stopped'||!t.native.writerActive||t.owner)throw Error('Stop native editing before explicit host-confirmed release');
  const target=await this.open(t),release=await target.journal.lock();
  try{
   let initialized=true;try{await lstat(target.workspace.root);}catch(error){if(error.code!=='ENOENT')throw error;initialized=false;}
   const snapshot=initialized?await target.workspace.snapshot():null,head=initialized?await git(target.workspace.root,'rev-parse','HEAD'):null;
   const savedNative={worktree:target.workspace.root,initialized,head,snapshot,snapshotHash:initialized?digest(snapshot):null,reason:input.reason};
   await target.journal.append('native.released',{taskId:t.id,...savedNative});
   return this.c.store.tx(()=>{
    const current=this.c.getTask(t.id);if(current.status!=='stopped'||!current.native.writerActive)throw Error('Native ownership changed');
    current.status='partial';current.native.status='partial';current.native.writerActive=false;current.result={summary:input.reason,savedNative};
    this.c.store.put('task',current);this.c.emit('task.native_released',t.goalId,t.id,{snapshotHash:savedNative.snapshotHash,reason:input.reason});return this.c.getTask(t.id);
   });
  }finally{await release();}
 }
}
