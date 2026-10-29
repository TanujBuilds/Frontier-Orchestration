import path from 'node:path';
import { NativeCandidates } from './native-candidates.mjs';
import { Journal } from '../project/journal.mjs';
import { Workspace,inspectRepository } from '../project/workspace.mjs';
import { CheckRunner } from '../project/sandbox.mjs';
import { matches,protectedPath,digest as fileDigest } from '../project/contracts.mjs';
import { git } from '../project/process.mjs';
import { CodingAdapter } from './coding.mjs';
import { digest,identifier,text } from './contracts.mjs';

export class Integration {
 constructor({c,checksFactory,config={}}){this.c=c;this.checksFactory=checksFactory;this.config=config;this.inflight=new Map();this.nativeCandidates=new NativeCandidates(this);}
 async effect(key,input,action){
  identifier(key,'idempotencyKey');const hash=digest(input),old=this.c.store.maybe('effect',key);
  if(old&&old.hash!==hash)throw Error('Idempotency key conflict');if(old?.status==='completed')return old.result;
  if(this.inflight.has(key))return this.inflight.get(key);
  if(!old)this.c.store.tx(()=>this.c.store.put('effect',{id:key,hash,status:'pending',input,at:this.c.now()}));
  const run=(async()=>{const result=await action();this.c.store.tx(()=>this.c.store.put('effect',{id:key,hash,status:'completed',result,at:this.c.now()}));return result;})();
  this.inflight.set(key,run);try{return await run;}catch(error){if(error.code==='locked')error.retryable=true;throw error;}finally{this.inflight.delete(key);}
 }
 async goalWorkspace(goalId,{native=false,journal:lockedJournal}={}){
  const g=this.c.store.get('goal',goalId);if(g.integrationSealed)throw Error('Preserved partial integration workspace is retired; use a separately approved goal');if(!g.manifest.project)throw Error('Goal has no coding project');
  const journal=lockedJournal??await new Journal(path.join(this.c.store.root,'integration'),g.id).load();
  const p=g.manifest.project,manifest={repo:p.repo,baseCommit:p.baseCommit,permissions:p};
  if(!journal.last('workspace.created')){const inspected=await inspectRepository(p.repo,p);if(inspected.baseCommit!==p.baseCommit)throw Error('Approved source revision changed');}
  const workspace=new Workspace(manifest,journal);await workspace.initialize();
  if(!native)await workspace.recover();
  if(!g.integration)this.c.store.tx(()=>{const current=this.c.store.get('goal',g.id);current.integration={worktree:workspace.root,branch:workspace.branch,baseCommit:p.baseCommit};this.c.store.put('goal',current);});
  return {journal,workspace,g:this.c.store.get('goal',goalId)};
 }
 checks(workspace){return this.checksFactory?.(workspace)??new CheckRunner(workspace,{codex:this.config.codexPath??'codex'});}
 async lockedGoal(goalId,{native=false,refuseLegacy=false,integrationTaskId=null}={}){
  const journal=await new Journal(path.join(this.c.store.root,'integration'),goalId).load(),release=await journal.lock();
  try{const g=this.c.store.get('goal',goalId);if(g.integrationPending&&g.integrationPending.taskId!==integrationTaskId)throw Error('Another pending integration must be recovered first');if(refuseLegacy&&g.integrationOwner)throw Error('Native legacy owner holds integration workspace');return {...await this.goalWorkspace(goalId,{native,journal}),release};}catch(error){await release();throw error;}
 }
 async executionBase(goalId){
  const target=await this.lockedGoal(goalId,{refuseLegacy:true});
  try{await target.workspace.recover();if(await git(target.workspace.root,'diff','HEAD','--name-only'))throw Error('Integration has uncommitted imported edits; recover integration first');return await git(target.workspace.root,'rev-parse','HEAD');}finally{await target.release();}
 }
 async candidate(task,{original=false}={}){return !original&&task.native?.layout==='candidate_v1'?this.nativeCandidates.open(task):new CodingAdapter({c:this.c,config:this.config}).open(task);}
 async changes(workspace,base,writePaths){
  const files=new Set((await git(workspace.root,'diff','--no-renames','--name-only','-z',base,'--')).split('\0').filter(Boolean));
  for(const f of (await git(workspace.root,'ls-files','--others','--exclude-standard','-z')).split('\0').filter(Boolean))if(!f.startsWith('dist/')&&!f.startsWith('.overnight-output/'))files.add(f);
  const edits=[];
  for(const file of files){
   if(protectedPath(file)||!matches(file,writePaths))throw Error('Candidate change outside approved scope');
   const listed=await git(workspace.root,'ls-tree','--name-only',base,'--',file);
   // git() trims non-NUL output; read the exact blob through Workspace content's
   // hashing convention by retrieving bytes in a NUL-preserving command.
   const beforeExact=listed?await git(workspace.root,'show',`${base}:${file}`,'--format=','-z'):null;
   const current=await workspace.content(file);
   edits.push({path:file,action:current.content===null?'delete':'write',content:current.content,beforeHash:listed?fileDigest(beforeExact):null,afterHash:current.hash});
  }
  return edits;
 }
 async prepareChanges(workspace,changes){
  const edits=[];
  for(const change of changes){const current=await workspace.content(change.path);if(current.hash===change.afterHash)continue;if(current.hash!==change.beforeHash)throw Error(`Integration conflict for ${change.path}`);edits.push({path:change.path,action:change.action,content:change.content,baseHash:current.hash});}
  return edits;
 }
 async applyChanges(workspace,changes,key,writePaths){await workspace.apply(key,{writePaths},await this.prepareChanges(workspace,changes));}
 async accept(input,key){return this.effect(key,{op:'integration.accept',...input},async()=>{
  let t=this.c.getTask(input.taskId),g=this.c.store.get('goal',t.goalId);
  if(t.status==='accepted'&&t.integration)return t;
  this.c.liveGoal(g);
  this.c.liveTask(t);
  if(!['awaiting_review','ready_to_integrate'].includes(t.status))throw Error('Candidate is not ready for integration');
  if(g.manifest.mode.review==='legacy'&&t.legacyDecision?.decision!=='accept')throw Error('Passing legacy review required');
  if(g.integrationOwner&&g.integrationOwner!==t.id)throw Error('Native Codex task owns integration workspace');
  const candidate=await this.candidate(t),releaseCandidate=await candidate.journal.lock();
  try{
   await candidate.workspace.recover();const checks=this.checks(candidate.workspace);await checks.verify();const candidateChecks=await checks.run(candidate.manifest.permissions.checks,`accept-${t.id}`);
   if(!candidateChecks.every(x=>x.passed))throw Error('Candidate checks no longer pass');
   const checkpoint=t.native?.layout==='candidate_v1'?{commit:t.native.commit,snapshot:await candidate.workspace.snapshot()}:await candidate.journal.memo('candidate/checkpoint',()=>candidate.workspace.checkpoint({id:'candidate',writePaths:t.spec.permissions.writePaths}));
   if(!candidate.journal.last('stage.accepted'))await candidate.journal.append('stage.accepted',{stageId:'candidate',...checkpoint});
   const target=await this.lockedGoal(g.id,{refuseLegacy:true,integrationTaskId:t.id}),release=target.release;
   try{
    this.c.liveTask(t);await target.workspace.recover();const changes=await this.changes(candidate.workspace,candidate.manifest.baseCommit,t.spec.permissions.writePaths);
    await this.prepareChanges(target.workspace,changes);
    if(t.status==='awaiting_review'){this.c.review({taskId:t.id,decision:'accept',feedback:text(input.feedback,'review feedback')},`review-${key}`);t=this.c.getTask(t.id);}
    this.c.store.tx(()=>{const goal=this.c.store.get('goal',g.id);if(goal.integrationPending&&goal.integrationPending.taskId!==t.id)throw Error('Another pending integration owns target');goal.integrationPending??={taskId:t.id,candidateCommit:checkpoint.commit,at:this.c.now()};if(goal.integrationPending.candidateCommit!==checkpoint.commit)throw Error('Pending integration candidate changed');this.c.store.put('goal',goal);});
    await this.applyChanges(target.workspace,changes,`import-${t.id}`,t.spec.permissions.writePaths);
    const runner=this.checks(target.workspace);await runner.verify();const results=await runner.run(g.manifest.project.checks,`integrate-${t.id}`);
    if(!results.every(x=>x.passed))throw Error('Integrated checks failed');
    this.c.liveTask(t);
    const stage=`task-${t.id}`,imported=await target.journal.memo(`${stage}/checkpoint`,()=>target.workspace.checkpoint({id:stage,writePaths:t.spec.permissions.writePaths}));
    if(!target.journal.events.some(e=>e.type==='stage.accepted'&&e.data.stageId===stage))await target.journal.append('stage.accepted',{stageId:stage,...imported});
    this.c.store.tx(()=>{const current=this.c.liveTask(t);current.status='accepted';if(current.native?.layout==='candidate_v1')current.native.status='integrated';current.integration={commit:imported.commit,candidateCommit:checkpoint.commit,worktree:target.workspace.root,checks:results,review:g.manifest.mode.review==='checks'?'none':g.manifest.mode.review==='legacy'?'codex_legacy':'codex_operator'};this.c.store.put('task',current);const goal=this.c.store.get('goal',g.id);goal.integrationPending=null;this.c.store.put('goal',goal);this.c.emit('task.integrated',g.id,t.id,current.integration);});
    return this.c.getTask(t.id);
   }finally{await release();}
  }finally{await releaseCandidate();}
 });}
 async startNative(input,key){return this.effect(key,{op:'native.start',...input},()=>input.layout==='candidate_v1'?this.nativeCandidates.start(input.taskId,{},input.registration):this.beginNative(input.taskId));}
 async beginNative(taskId,extra={}){
  const t=this.c.getTask(taskId),g=this.c.store.get('goal',t.goalId);this.c.liveGoal(g);
  this.c.liveTask(t,{allowStopped:!!extra.takeoverReason});
  if(!g.manifest.mode.actors.includes('codex')||t.spec.kind!=='coding')throw Error('Mode prohibits native Codex execution');
  if(t.native?.layout==='candidate_v1')throw Error('Existing native candidate requires explicit candidate_v1 layout');
  if(t.status==='codex_active')return t;
  if(!['codex_ready','blocked','stopped','awaiting_review','ready_to_integrate'].includes(t.status)||t.owner)throw Error('Worker must be quiescent before native execution');
  if(!t.spec.dependsOn.every(id=>this.c.getTask(id).status==='accepted'))throw Error('Dependencies are incomplete');
  if(g.integrationOwner&&g.integrationOwner!==t.id)throw Error('Another native task owns integration workspace');
  const target=await this.lockedGoal(g.id),unlock=target.release;try{
   const snapshot=await target.workspace.snapshot();
   this.c.store.tx(()=>{const current=this.c.liveTask(t,{allowStopped:!!extra.takeoverReason});current.status='codex_active';current.executionActor='codex';current.stopRequested=false;current.startedAt??=this.c.now();current.deadline??=Math.min(g.deadline,current.startedAt+t.spec.limits.seconds*1000);current.native={worktree:target.workspace.root,startSnapshot:snapshot,...extra};const goal=this.c.store.get('goal',g.id);if(goal.integrationOwner&&goal.integrationOwner!==t.id)throw Error('Another native task owns integration workspace');goal.integrationOwner=t.id;this.c.store.put('goal',goal);this.c.store.put('task',current);this.c.learning.pin(t.id);this.c.emit('task.native_started',g.id,t.id,{worktree:target.workspace.root});});
  }finally{await unlock();}return this.c.getTask(t.id);
 }
 async takeover(input,key){return this.effect(key,{op:'native.takeover',...input},async()=>{
  const t=this.c.getTask(input.taskId);text(input.reason,'takeover reason');
  if(t.owner||['running','uncertain'].includes(t.status))throw Error('Stop and verify worker quiescence before takeover');
  const g=this.c.store.get('goal',t.goalId);if(!g.manifest.mode.actors.includes('codex'))throw Error('Mode prohibits takeover');
  const source=await this.candidate(t,{original:true}),release=await source.journal.lock();try{
   await source.workspace.recover();const frozen=await source.workspace.snapshot(),changes=await this.changes(source.workspace,source.manifest.baseCommit,t.spec.permissions.writePaths);
   const extra={workerWorktree:source.workspace.root,workerSnapshot:frozen,takeoverReason:input.reason};
   const native=input.layout==='candidate_v1'?await this.nativeCandidates.start(t.id,extra,input.registration):await this.beginNative(t.id,extra);
   const target=input.layout==='candidate_v1'?await this.candidate(native):await this.goalWorkspace(g.id,{native:true}),unlock=await target.journal.lock();try{await this.applyChanges(target.workspace,changes,`takeover-${t.id}`,t.spec.permissions.writePaths);}finally{await unlock();}
   this.c.emit('task.taken_over',g.id,t.id,{reason:input.reason,workerSnapshot:frozen});return this.c.getTask(native.id);
  }finally{await release();}
 });}
 async finishNative(input,key){return this.effect(key,{op:'native.finish',...input},async()=>{
  const t=this.c.getTask(input.taskId),g=this.c.store.get('goal',t.goalId);text(input.summary,'summary');
  if(t.native?.layout==='candidate_v1')return this.nativeCandidates.finish(input);
  if(t.status==='accepted'&&t.integration?.review==='codex_native')return t;
  this.c.liveGoal(g);if(t.status!=='codex_active'||g.integrationOwner!==t.id)throw Error('Native task ownership mismatch');
  this.c.liveTask(t);
  const target=await this.goalWorkspace(g.id,{native:true}),release=await target.journal.lock();try{
   if(t.native.workerSnapshot){const source=await this.candidate(t),unlock=await source.journal.lock();try{if(digest(await source.workspace.snapshot())!==digest(t.native.workerSnapshot))throw Error('Frozen worker checkout changed after takeover');}finally{await unlock();}}
   const snapshot=await target.workspace.snapshot(),before=t.native.startSnapshot;
   for(const f of new Set([...Object.keys(snapshot),...Object.keys(before)]))if(snapshot[f]!==before[f]&&(protectedPath(f)||!matches(f,t.spec.permissions.writePaths)))throw Error('Native change outside approved scope or protected checks');
   await target.journal.append('native.adopted',{taskId:t.id,snapshot});
   const runner=this.checks(target.workspace);await runner.verify();const results=await runner.run(g.manifest.project.checks,`native-${t.id}`);if(!results.every(x=>x.passed))throw Error('Native checks failed');
   this.c.liveTask(t);
   const stage=`native-${t.id}`,checkpoint=await target.journal.memo(`${stage}/checkpoint`,()=>target.workspace.checkpoint({id:stage,writePaths:t.spec.permissions.writePaths}));
   if(!target.journal.events.some(e=>e.type==='stage.accepted'&&e.data.stageId===stage))await target.journal.append('stage.accepted',{stageId:stage,...checkpoint});
   this.c.store.tx(()=>{const current=this.c.liveTask(t);const goal=this.c.store.get('goal',g.id);if(current.status!=='codex_active'||goal.integrationOwner!==t.id)throw Error('Native task ownership changed');current.status='accepted';current.result={summary:input.summary,checks:results};current.integration={commit:checkpoint.commit,worktree:target.workspace.root,checks:results,review:'codex_native'};this.c.store.put('task',current);goal.integrationOwner=null;this.c.store.put('goal',goal);this.c.emit('task.native_finished',g.id,t.id,current.integration);});return this.c.getTask(t.id);
  }finally{await release();}
 });}
 async releaseNative(input,key){return this.effect(key,{op:'native.release',...input},async()=>{
  const t=this.c.getTask(input.taskId);text(input.reason,'release reason');
  if(t.native?.layout==='candidate_v1')return this.nativeCandidates.release(input);
  if(t.status==='partial'&&t.result?.savedNative)return t;
  const g=this.c.store.get('goal',t.goalId);
  if(t.spec.kind!=='coding'||t.executionActor!=='codex'||t.status!=='stopped'||t.owner||g.integrationOwner!==t.id)throw Error('Stop native editing and retain its ownership before explicit release');
  const target=await this.goalWorkspace(g.id,{native:true}),unlock=await target.journal.lock();
  try{
   const snapshot=await target.workspace.snapshot(),head=await git(target.workspace.root,'rev-parse','HEAD');
   const savedNative={worktree:target.workspace.root,head,snapshot,snapshotHash:digest(snapshot),reason:input.reason};
   await target.journal.append('native.released',{taskId:t.id,...savedNative});
   return this.c.store.tx(()=>{
    const current=this.c.store.get('task',t.id),goal=this.c.store.get('goal',g.id);
    if(current.status!=='stopped'||goal.integrationOwner!==t.id)throw Error('Native ownership changed before release');
    current.status='partial';current.result={summary:input.reason,savedNative};current.reason='Native partial preserved; integration workspace retired';goal.integrationOwner=null;goal.integrationSealed=savedNative;
    this.c.store.put('task',current);this.c.store.put('goal',goal);this.c.emit('task.native_released',g.id,t.id,{snapshotHash:savedNative.snapshotHash,reason:input.reason});return this.c.getTask(t.id);
   });
  }finally{await unlock();}
 });}
}
