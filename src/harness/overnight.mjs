import {keys,integer,digest} from './contracts.mjs';
export const isOvernightV2=manifest=>manifest?.mode?.id==='overnight_review'&&manifest.mode.version===2;
export function normalizeOvernightPolicy(raw,project){
 keys(raw,['preflightCheckIds','finalOnlyCheckIds','maxBatches','maxExchanges','maxCorrections','reconnectMs','launchCheckIds'],'overnight policy');
 if(!project)throw Error('Overnight v2 requires a coding project');
 const p={maxBatches:20,maxExchanges:40,maxCorrections:2,reconnectMs:1800000,...raw};
 for(const name of ['preflightCheckIds','finalOnlyCheckIds']){const ids=p[name];if(!Array.isArray(ids)||name==='preflightCheckIds'&&!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!project.checks.some(c=>c.id===id)))throw Error('Invalid overnight '+name);}
 if(Object.hasOwn(raw,'launchCheckIds')){if(!Array.isArray(raw.launchCheckIds)||new Set(raw.launchCheckIds).size!==raw.launchCheckIds.length||raw.launchCheckIds.some(id=>!project.checks.some(c=>c.id===id)))throw Error('Invalid launch check IDs');if(raw.launchCheckIds.some(id=>!p.finalOnlyCheckIds.includes(id)))throw Error('Launch checks must be final-only');}
 if(p.preflightCheckIds.some(id=>p.finalOnlyCheckIds.includes(id)))throw Error('Preflight cannot require future final-only checks');
 for(const [k,max]of Object.entries({maxBatches:20,maxExchanges:40,maxCorrections:2,reconnectMs:1800000}))integer(p[k],k,k==='maxCorrections'?0:1,max);
 return p;
}
export function validateOvernightGraph(tasks,manifest){
 if(!isOvernightV2(manifest))return;
 if(tasks.length>10)throw Error('Overnight v2 allows at most ten stages');
 const finals=tasks.filter(t=>t.spec.role==='final');if(finals.length!==1||tasks.at(-1)!==finals[0])throw Error('Exactly one final stage must be last');
 const byKey=new Map(tasks.map(t=>[t.key,t.spec]));
 for(let n=0;n<tasks.length;n++){const s=tasks[n].spec;if(n&& !s.dependsOn.includes(tasks[n-1].key))throw Error('Overnight stages must be sequential');if(s.role!=='final'&&s.permissions.checks.some(id=>manifest.overnightPolicy.finalOnlyCheckIds.includes(id)))throw Error('Intermediate stage requests final-only gate');}
 const reached=new Set(),visit=k=>{for(const dep of byKey.get(k).dependsOn){if(!reached.has(dep)){reached.add(dep);visit(dep);}}};visit(finals[0].key);
 if(tasks.slice(0,-1).some(t=>!reached.has(t.key)))throw Error('Final stage must transitively depend on every earlier stage');
}
export function effectiveIntegrationChecks(c,task,manifest){
 if(!isOvernightV2(manifest)||task.spec.role==='final')return manifest.project.checks;
 const ids=new Set([...manifest.overnightPolicy.preflightCheckIds,...task.spec.permissions.checks]);
 for(const t of c.store.all('task'))if(t.goalId===task.goalId&&t.status==='accepted'&&t.integration)for(const id of t.spec.permissions.checks)ids.add(id);
 return manifest.project.checks.filter(check=>ids.has(check.id));
}
export const preflightIdentity=(g,runtimeIdentity,inventory,dependencies)=>digest({goalId:g.id,hash:g.hash,manifest:g.manifest,runtimeIdentity,inventory,dependencies});

function commonReviewAccepted(c,g,t){
 const acceptance=t.reviewAcceptance,ticket=acceptance?c.store.maybe('review_ticket',acceptance.ticketId):null;
 return !!(acceptance&&ticket?.status==='completed'&&ticket.verdict?.decision==='accept'&&ticket.verdictHash===acceptance.verdictHash&&ticket.binding.goalHash===g.hash&&ticket.binding.goalVersion===g.version&&ticket.binding.taskId===t.id&&ticket.binding.checksHash===digest(t.result.checks)&&digest(ticket.binding)===digest(acceptance.binding)&&digest(t.integration.reviewAcceptance)===digest(acceptance)&&t.integration.review===(acceptance.source==='host'?'host_review':'api_review'));
}
export function overnightCompletionReady(c,g,tasks){
 const plan=c.store.maybe('overnight_plan',g.id),final=tasks.find(t=>t.spec.role==='final');
 return !!(plan&&plan.approvalHash===g.hash&&plan.tasks.length===tasks.length&&plan.tasks.every((id,n)=>tasks.some(t=>t.id===id&&t.hash===plan.specHashes[n]))&&final&&tasks.every(t=>t.status==='accepted'&&(g.manifest.reviewPolicy?commonReviewAccepted(c,g,t):t.integration?.review==='codex_legacy'&&t.legacyDecision?.decision==='accept'))&&g.manifest.project.checks.every(check=>final.integration.checks.some(r=>r.id===check.id&&r.passed))&&!g.integrationPending);
}

export function infrastructureCheckFailure(results){return results.find(r=>!r.passed&&(r.stopped||r.code===null||/EACCES|EPERM|Operation not permitted|permission denied|spawn.*ENOENT|Cannot find package/i.test(r.stderr??'')));}
