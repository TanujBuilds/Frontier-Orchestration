import path from 'node:path';
import { Journal } from '../project/journal.mjs';
import { Workspace,inspectRepository } from '../project/workspace.mjs';
import { CheckRunner } from '../project/sandbox.mjs';
import { matches,protectedPath,digest as fileDigest } from '../project/contracts.mjs';
import { git } from '../project/process.mjs';
import { CodingAdapter } from './coding.mjs';
import { digest,identifier,text } from './contracts.mjs';

export class Integration {
 constructor({c,checksFactory,config={}}){this.c=c;this.checksFactory=checksFactory;this.config=config;this.inflight=new Map();}
 async effect(key,input,action){
  identifier(key,'idempotencyKey');const hash=digest(input),old=this.c.store.maybe('effect',key);
  if(old&&old.hash!==hash)throw Error('Idempotency key conflict');if(old?.status==='completed')return old.result;
  if(this.inflight.has(key))return this.inflight.get(key);
  if(!old)this.c.store.tx(()=>this.c.store.put('effect',{id:key,hash,status:'pending',input,at:this.c.now()}));
  const run=(async()=>{const result=await action();this.c.store.tx(()=>this.c.store.put('effect',{id:key,hash,status:'completed',result,at:this.c.now()}));return result;})();
  this.inflight.set(key,run);try{return await run;}finally{this.inflight.delete(key);}
 }
 async goalWorkspace(goalId,{native=false}={}){
  const g=this.c.store.get('goal',goalId);if(!g.manifest.project)throw Error('Goal has no coding project');
  const journal=await new Journal(path.join(this.c.store.root,'integration'),g.id).load();
  const p=g.manifest.project,manifest={repo:p.repo,baseCommit:p.baseCommit,permissions:p};
  if(!journal.last('workspace.created')){const inspected=await inspectRepository(p.repo,p);if(inspected.baseCommit!==p.baseCommit)throw Error('Approved source revision changed');}
  const workspace=new Workspace(manifest,journal);await workspace.initialize();
  if(!native)await workspace.recover();
  if(!g.integration)this.c.store.tx(()=>{const current=this.c.store.get('goal',g.id);current.integration={worktree:workspace.root,branch:workspace.branch,baseCommit:p.baseCommit};this.c.store.put('goal',current);});
  return {journal,workspace,g:this.c.store.get('goal',goalId)};
 }
 checks(workspace){return this.checksFactory?.(workspace)??new CheckRunner(workspace,{codex:this.config.codexPath??'codex'});}
 async candidate(task){return new CodingAdapter({c:this.c,config:this.config}).open(task);}
 async changes(workspace,base,writePaths){
  const files=new Set((await git(workspace.root,'diff','--name-only','-z',base,'--')).split('\0').filter(Boolean));
  for(const f of (await git(workspace.root,'ls-files','--others','--exclude-standard','-z')).split('\0').filter(Boolean))if(!f.startsWith('dist/')&&!f.startsWith('.overnight-output/'))files.add(f);
  const edits=[];
  for(const file of files){
   if(protectedPath(file)||!matches(file,writePaths))throw Error('Candidate change outside approved scope');
   const listed=await git(workspace.root,'ls-tree','--name-only',base,'--',file);
   const before=listed?await git(workspace.root,'show',`${base}:${file}`):null;
   // git() trims non-NUL output; read the exact blob through Workspace content's
   // hashing convention by retrieving bytes in a NUL-preserving command.
   const beforeExact=listed?await git(workspace.root,'show',`${base}:${file}`,'--format=','-z'):null;
   const current=await workspace.content(file);
   edits.push({path:file,action:current.content===null?'delete':'write',content:current.content,beforeHash:listed?fileDigest(beforeExact):null,afterHash:current.hash});
  }
  return edits;
 }
 async applyChanges(workspace,changes,key,writePaths){
  const edits=[];
  for(const change of changes){const current=await workspace.content(change.path);if(current.hash===change.afterHash)continue;if(current.hash!==change.beforeHash)throw Error(`Integration conflict for ${change.path}`);edits.push({path:change.path,action:change.action,content:change.content,baseHash:current.hash});}
  await workspace.apply(key,{writePaths},edits);
 }
 async accept(input,key){return this.effect(key,{op:'integration.accept',...input},async()=>{
  let t=this.c.getTask(input.taskId),g=this.c.store.get('goal',t.goalId);this.c.liveGoal(g);
  if(t.status==='accepted'&&t.integration)return t;
  if(!['awaiting_review','ready_to_integrate'].includes(t.status))throw Error('Candidate is not ready for integration');
  if(g.integrationOwner&&g.integrationOwner!==t.id)throw Error('Native Codex task owns integration workspace');
  const candidate=await this.candidate(t),releaseCandidate=await candidate.journal.lock();
  try{
   await candidate.workspace.recover();const checks=this.checks(candidate.workspace);await checks.verify();const candidateChecks=await checks.run(candidate.manifest.permissions.checks,`accept-${t.id}`);
   if(!candidateChecks.every(x=>x.passed))throw Error('Candidate checks no longer pass');
   if(t.status==='awaiting_review'){this.c.review({taskId:t.id,decision:'accept',feedback:text(input.feedback,'review feedback')},`review-${key}`);t=this.c.getTask(t.id);}
   const checkpoint=await candidate.journal.memo('candidate/checkpoint',()=>candidate.workspace.checkpoint({id:'candidate',writePaths:t.spec.permissions.writePaths}));
   if(!candidate.journal.last('stage.accepted'))await candidate.journal.append('stage.accepted',{stageId:'candidate',...checkpoint});
   const target=await this.goalWorkspace(g.id),release=await target.journal.lock();
   try{
    await target.workspace.recover();const changes=await this.changes(candidate.workspace,candidate.manifest.baseCommit,t.spec.permissions.writePaths);
    await this.applyChanges(target.workspace,changes,`import-${t.id}`,t.spec.permissions.writePaths);
    const runner=this.checks(target.workspace);await runner.verify();const results=await runner.run(g.manifest.project.checks,`integrate-${t.id}`);
    if(!results.every(x=>x.passed))throw Error('Integrated checks failed');
    const stage=`task-${t.id}`,imported=await target.journal.memo(`${stage}/checkpoint`,()=>target.workspace.checkpoint({id:stage,writePaths:t.spec.permissions.writePaths}));
    if(!target.journal.events.some(e=>e.type==='stage.accepted'&&e.data.stageId===stage))await target.journal.append('stage.accepted',{stageId:stage,...imported});
    this.c.store.tx(()=>{const current=this.c.store.get('task',t.id);current.status='accepted';current.integration={commit:imported.commit,candidateCommit:checkpoint.commit,worktree:target.workspace.root,checks:results,review:g.manifest.mode.review==='checks'?'none':'codex_operator'};this.c.store.put('task',current);this.c.emit('task.integrated',g.id,t.id,current.integration);});
    return this.c.getTask(t.id);
   }finally{await release();}
  }finally{await releaseCandidate();}
 });}
 async startNative(input,key){return this.effect(key,{op:'native.start',...input},()=>this.beginNative(input.taskId));}
 async beginNative(taskId,extra={}){
  const t=this.c.getTask(taskId),g=this.c.store.get('goal',t.goalId);this.c.liveGoal(g);
  if(!g.manifest.mode.actors.includes('codex')||t.spec.kind!=='coding')throw Error('Mode prohibits native Codex execution');
  if(t.status==='codex_active')return t;
  if(!['codex_ready','blocked','stopped','awaiting_review','ready_to_integrate'].includes(t.status)||t.owner)throw Error('Worker must be quiescent before native execution');
  if(!t.spec.dependsOn.every(id=>this.c.getTask(id).status==='accepted'))throw Error('Dependencies are incomplete');
  if(g.integrationOwner&&g.integrationOwner!==t.id)throw Error('Another native task owns integration workspace');
  const target=await this.goalWorkspace(g.id);
  this.c.store.tx(()=>{const current=this.c.store.get('task',t.id);current.status='codex_active';current.executionActor='codex';current.startedAt??=this.c.now();current.deadline??=Math.min(g.deadline,current.startedAt+t.spec.limits.seconds*1000);current.native={worktree:target.workspace.root,startSnapshot:null,...extra};const goal=this.c.store.get('goal',g.id);goal.integrationOwner=t.id;this.c.store.put('goal',goal);this.c.store.put('task',current);});
  const snapshot=await target.workspace.snapshot();this.c.store.tx(()=>{const current=this.c.store.get('task',t.id);current.native.startSnapshot=snapshot;this.c.store.put('task',current);this.c.emit('task.native_started',g.id,t.id,{worktree:target.workspace.root});});return this.c.getTask(t.id);
 }
 async takeover(input,key){return this.effect(key,{op:'native.takeover',...input},async()=>{
  const t=this.c.getTask(input.taskId);text(input.reason,'takeover reason');
  if(t.owner||['running','uncertain'].includes(t.status))throw Error('Stop and verify worker quiescence before takeover');
  const g=this.c.store.get('goal',t.goalId);if(!g.manifest.mode.actors.includes('codex'))throw Error('Mode prohibits takeover');
  const source=await this.candidate(t),release=await source.journal.lock();try{
   await source.workspace.recover();const frozen=await source.workspace.snapshot(),changes=await this.changes(source.workspace,source.manifest.baseCommit,t.spec.permissions.writePaths);
   const native=await this.beginNative(t.id,{workerWorktree:source.workspace.root,workerSnapshot:frozen,takeoverReason:input.reason});
   const target=await this.goalWorkspace(g.id,{native:true}),unlock=await target.journal.lock();try{await this.applyChanges(target.workspace,changes,`takeover-${t.id}`,t.spec.permissions.writePaths);}finally{await unlock();}
   this.c.emit('task.taken_over',g.id,t.id,{reason:input.reason,workerSnapshot:frozen});return this.c.getTask(native.id);
  }finally{await release();}
 });}
 async finishNative(input,key){return this.effect(key,{op:'native.finish',...input},async()=>{
  const t=this.c.getTask(input.taskId),g=this.c.store.get('goal',t.goalId);this.c.liveGoal(g);text(input.summary,'summary');if(t.status!=='codex_active'||g.integrationOwner!==t.id)throw Error('Native task ownership mismatch');
  const target=await this.goalWorkspace(g.id,{native:true}),release=await target.journal.lock();try{
   const snapshot=await target.workspace.snapshot(),before=t.native.startSnapshot;
   for(const f of new Set([...Object.keys(snapshot),...Object.keys(before)]))if(snapshot[f]!==before[f]&&(protectedPath(f)||!matches(f,t.spec.permissions.writePaths)))throw Error('Native change outside approved scope or protected checks');
   await target.journal.append('native.adopted',{taskId:t.id,snapshot});
   const runner=this.checks(target.workspace);await runner.verify();const results=await runner.run(g.manifest.project.checks,`native-${t.id}`);if(!results.every(x=>x.passed))throw Error('Native checks failed');
   const stage=`native-${t.id}`,checkpoint=await target.journal.memo(`${stage}/checkpoint`,()=>target.workspace.checkpoint({id:stage,writePaths:t.spec.permissions.writePaths}));
   if(!target.journal.events.some(e=>e.type==='stage.accepted'&&e.data.stageId===stage))await target.journal.append('stage.accepted',{stageId:stage,...checkpoint});
   this.c.store.tx(()=>{const current=this.c.store.get('task',t.id);current.status='accepted';current.result={summary:input.summary,checks:results};current.integration={commit:checkpoint.commit,worktree:target.workspace.root,checks:results,review:'codex_native'};this.c.store.put('task',current);const goal=this.c.store.get('goal',g.id);goal.integrationOwner=null;this.c.store.put('goal',goal);this.c.emit('task.native_finished',g.id,t.id,current.integration);});return this.c.getTask(t.id);
  }finally{await release();}
 });}
}
