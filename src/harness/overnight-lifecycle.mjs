import path from 'node:path';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {command} from '../project/process.mjs';
import {Goals} from './goals.mjs';
import {digest} from './contracts.mjs';
import {isOvernightV2,overnightCompletionReady} from './overnight.mjs';

export function deriveOvernightState(g,tasks,planning,now){
 const first=predicate=>tasks.find(predicate),state=(phase,t,reason)=>({phase,taskId:t?.id??null,...(reason?{reason}:{})});
 if(g.status==='completed')return state('completed');if(g.status==='draft')return state('preparation');
 const uncertain=first(t=>t.status==='uncertain');if(uncertain||planning?.status==='uncertain')return state('blocked',uncertain,uncertain?.reason??planning.reason??'Ambiguous inference; reconcile original request');
 if(now>=g.deadline)return state('expired',null,'Original deadline reached');
 if(g.status==='paused')return state('paused');if(g.status==='stopped')return state('stopped');
 const stopped=first(t=>t.status==='stopped'||t.stopRequested);if(stopped)return state('stopped',stopped);
 const paused=first(t=>t.status==='paused'||t.pauseRequested);if(paused)return state('paused',paused);
 const q=first(t=>['awaiting_user','awaiting_supervisor'].includes(t.status));if(q)return state('waiting-answer',q,'An owner answer is required');
 const blocked=first(t=>['blocked','partial','failed'].includes(t.status));if(blocked||planning?.status==='blocked')return state('blocked',blocked,blocked?.reason??blocked?.legacyDecision?.feedback??(planning?.status==='blocked'?planning.reason:undefined)??'Saved execution needs attention');
 if(g.integrationPending)return state('blocked',tasks.find(t=>t.id===g.integrationPending.taskId),'Pending integration requires supported repair');
 if(first(t=>['awaiting_legacy_review','legacy_reviewing'].includes(t.status)))return state('review',first(t=>['awaiting_legacy_review','legacy_reviewing'].includes(t.status)));
 if(first(t=>t.status==='ready_to_integrate'))return state('integration',first(t=>t.status==='ready_to_integrate'));
 if(!tasks.length)return state('planning',null,planning?.reason);
 const runnable=first(t=>t.owner||['queued','suspended','running'].includes(t.status)&&t.spec.dependsOn.every(id=>tasks.some(d=>d.id===id&&d.status==='accepted'&&d.integration)));
 if(runnable)return state('implementation',runnable,runnable.providerWait?'Provider unavailable; bounded reconnect window':undefined);
 if(tasks.every(t=>t.status==='accepted'&&t.integration))return state('integration');
 return state('blocked',null,'No eligible stage; inspect dependencies and saved ownership');
}
export class IdleSleepAssertion{
 constructor({platform=process.platform,spawnProcess=spawn}={}){this.platform=platform;this.spawn=spawnProcess;this.child=null;this.until=0;}
 sync(active,deadline){if(!active||deadline<=Date.now()){this.close();return;}if(this.platform!=='darwin')return;if(this.child&&this.until===deadline)return;this.close();this.until=deadline;const child=this.child=this.spawn('/usr/bin/caffeinate',['-i','-t',String(Math.max(1,Math.ceil((deadline-Date.now())/1000))),'-w',String(process.pid)],{stdio:'ignore'});child.once('error',()=>{if(this.child===child)this.child=null;});child.once('exit',()=>{if(this.child===child)this.child=null;});}
 close(){if(this.child){this.child.kill('SIGTERM');this.child=null;}this.until=0;}
}
const alertText={completion:'Mosaic overnight work is complete. Open Mosaic for the saved report.',blocker:'Mosaic overnight work needs attention. Open Mosaic for the saved blocker and evidence.',decision:'Mosaic overnight work needs your answer. Open Mosaic to review the question.'};
export async function localOvernightAlert(kind){if(process.platform!=='darwin')throw Error('Local macOS alerts unavailable');const text=alertText[kind];if(!text)throw Error('Unsupported alert');const script='on run argv\ndisplay notification (item 1 of argv) with title "Mosaic"\nend run';const result=await command(['/usr/bin/osascript','-e',script,text],{timeoutMs:10000});if(result.code!==0||result.stopped)throw Error('macOS notification delivery failed');return {status:'submitted',visibility:'OS controls presentation; saved report authoritative'};}
async function atomic(file,content){await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.pending';await writeFile(tmp,content,{mode:0o600});await rename(tmp,file);}
export class OvernightLifecycle{
 constructor({c,notify=localOvernightAlert,power=new IdleSleepAssertion()}={}){this.c=c;this.notify=notify;this.power=power;this.inflight=null;}
 tick(){if(this.inflight)return this.inflight;this.inflight=this.update().finally(()=>{this.inflight=null;});return this.inflight;}
 async update(){const c=this.c;let active=false,deadline=0;
  for(const saved of c.store.all('goal').filter(g=>isOvernightV2(g.manifest))){let g=c.store.get('goal',saved.id),tasks=c.store.all('task').filter(t=>t.goalId===g.id),planning=c.store.maybe('planning',g.id),state=deriveOvernightState(g,tasks,planning,c.now());
   const final=tasks.find(t=>t.spec.role==='final');
   if(g.status==='active'&&overnightCompletionReady(c,g,tasks)&&state.phase==='integration'){
    new Goals(c).finalize({goalId:g.id,summary:'All Overnight v2 stages independently reviewed, integrated, and final protected suite passed.'},`overnight-finalize-${g.id}`);g=c.store.get('goal',g.id);state=deriveOvernightState(g,tasks,planning,c.now());
   }
   const old=c.store.maybe('overnight_run',g.id),attention=['blocked','waiting-answer','expired'].includes(state.phase),firstBlocker=old?.firstBlocker??tasks.find(t=>t.firstBlocker)?.firstBlocker??(attention?{at:c.now(),taskId:state.taskId,reason:state.reason??'Original deadline reached',phase:state.phase}:null);
   const reportPath=path.join(c.store.root,'overnight-reports',g.id,'report.json'),markdownPath=path.join(c.store.root,'overnight-reports',g.id,'report.md');
   const run={id:g.id,schema:1,goalId:g.id,approvalHash:g.hash,phase:state.phase,taskId:state.taskId,reason:state.reason??null,firstBlocker,deadline:g.deadline,reportPath,markdownPath,receiptHash:g.receiptHash??null};
   const report={schema:1,goalId:g.id,approvalHash:g.hash,result:state.phase,reason:run.reason,firstBlocker,deadline:g.deadline,branch:g.integration?.branch??null,worktree:g.integration?.worktree??null,launchInstructions:g.manifest.acceptance.filter(line=>/^launch:/i.test(line)),launchNote:'Use only approved project launch instructions. No launch/deployment was inferred or executed.',limits:g.manifest.limits,planning:{status:planning?.status??null,spent:c.store.spent(g.id).model??0,limit:3},tasks:tasks.map(t=>({id:t.id,status:t.status,objective:t.spec.objective,role:t.spec.role,attempts:t.attempts,reviews:t.reviews,spent:c.getTask(t.id).spent,limits:t.spec.limits,deadline:t.deadline,checks:t.integration?.checks??t.result?.checks??[],integration:t.integration??null,review:t.legacyDecision??null,evidence:{journalRoot:t.result?.journalRoot??null,resultHash:digest(t.result)},providerWait:t.providerWait??null})),nativeUsage:'Host token accounting unavailable',receiptHash:g.receiptHash??null,continuation:state.phase==='completed'?'Accepted result; no continuation required.':state.phase==='paused'?'Paused. Service will not advance this work; resume explicitly within the original deadline and remaining limits.':state.phase==='stopped'?'Stopped. Service will not advance this work; an explicitly authorized resume must preserve original deadline, IDs and spending.':state.phase==='preparation'?'Prepared only. Exact owner authorization and successful matching preflight are required before activation.':state.phase==='expired'?'Original deadline expired. Preserve IDs and spent requests; separately authorize a new scope/window through supported controls.':attention?'Inspect saved blocker/question, resolve exact missing input using original task IDs and remaining limits. No automatic code rescue or request resend.':'Service continues independently inside the original authorization. Observation may end without stopping execution.'};
   const reportHash=digest(report);run.reportHash=reportHash;
   if(old?.reportHash!==reportHash){await atomic(reportPath,JSON.stringify(report,null,2)+'\n');const md=['# Mosaic Overnight report',`Result: ${report.result}`,`Goal: ${g.id}`,`Branch: ${report.branch??'not integrated'}`,`Worktree: ${report.worktree??'not integrated'}`,`First blocker: ${firstBlocker?.reason??'none'}`,report.continuation,`Receipt: ${g.receiptHash??'not finalized'}`,'',...report.tasks.map(t=>`- ${t.objective}: ${t.status}; attempts ${t.attempts}; reviews ${t.reviews}; model requests ${t.spent.model}; checks ${t.checks.map(r=>r.id+':'+(r.passed?'pass':'fail')).join(', ')}`),'',`Machine-readable evidence: report.json`].join('\n');await atomic(markdownPath,md+'\n');}
   c.store.tx(()=>c.store.put('overnight_run',{...run,updatedAt:old?.reportHash===reportHash?old.updatedAt:c.now(),serviceObservedAt:c.now(),servicePid:process.pid}));
   if(attention&&!c.store.all('notification').some(n=>n.goalId===g.id&&['blocker','decision'].includes(n.kind)&&!n.resolved)){c.emit('overnight.attention',g.id,state.taskId,{phase:state.phase,reason:run.reason});}
   const executing=['planning','implementation','review','integration'].includes(state.phase)&&g.status==='active';if(executing){active=true;deadline=Math.max(deadline,g.deadline);}
  }
  this.power.sync(active,deadline);
  for(const n of c.store.all('notification').filter(n=>isOvernightV2(c.store.maybe('goal',n.goalId)?.manifest)&&['completion','blocker','decision'].includes(n.kind)&&!c.store.maybe('notification_delivery',n.id))){
   // Reserve BEFORE OS delivery: a crash leaves an honest uncertain attempt, never a duplicate alert.
   const delivery={id:n.id,goalId:n.goalId,status:'uncertain',reservedAt:c.now()};c.store.tx(()=>c.store.put('notification_delivery',delivery));
   try{const result=await this.notify(n.kind);delivery.status='submitted';delivery.result=result??null;}catch{delivery.status='failed';delivery.reason='Local alert delivery failed; saved report remains authoritative';}delivery.finishedAt=c.now();c.store.tx(()=>c.store.put('notification_delivery',delivery));
  }
 }
 close(){this.power.close();}
}
