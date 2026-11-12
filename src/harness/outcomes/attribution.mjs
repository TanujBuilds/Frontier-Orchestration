import {digest,providerBinding} from '../contracts.mjs';
import {selectRoute} from '../routing/router.mjs';

const same=(a,b)=>a!==undefined&&b!==undefined&&digest(a)===digest(b);
const short=value=>typeof value==='string'?value.slice(0,2000):null;

// Saved provider pins are execution identity. Preferences and readiness choices
// are deliberately not inputs to attribution, including for old unrouted work.
export function workerAttribution(task,approval,approvalForVersion=()=>null) {
 if(!task?.providerBinding)return null;
 const unknown={providerId:null,revision:null,profileHash:null,policyHash:null,displayName:null,requestedModel:null,
  resolvedModel:short(task.providerModel),reportedModel:short(task.result?.model),bindingProvenance:'unverified',
  routeHash:null,routeReasonCode:null,routeExplanation:null,matchedRule:null,routeProvenance:'unverified'};
 try {
  const binding=task.providerBinding;
  if(!approval||digest(approval.manifest)!==approval.hash||!same(binding,providerBinding(approval.manifest,binding.providerId)))return unknown;
  const profile=approval.manifest.providerPolicy.workers.find(row=>row.id===binding.providerId);
  const row={...unknown,...binding,displayName:short(profile.displayName),requestedModel:short(profile.model),bindingProvenance:'pinned'};
  delete row.version;
  if(!task.route&&!task.routeHash){row.routeProvenance='legacy_binding';return row;}
  const route=task.route,origin=route?.goalVersion===approval.version?approval:approvalForVersion(route?.goalVersion);
  const original=route?.taskHash===task.hash?task:task.history?.find(entry=>entry.hash===route?.taskHash);
  if(route?.version!==1||!origin||origin.hash!==route.goalHash||digest(origin.manifest)!==route.goalHash||
     task.routeHash!==digest(route)||route.decision?.status!=='selected'||!same(route.decision.binding,binding)||
     !original||digest(original.spec)!==route.taskHash||!same(original.spec.routing,task.spec.routing)||
     !same(binding,providerBinding(origin.manifest,binding.providerId)))return row;
  const selected=selectRoute({task:original,goal:origin,availability:{budget:{remainingModelCalls:1}}});
  const reason=original.spec.routing?.preferredProviderId?'selected_by_explicit':selected.matchedRule?'selected_by_rule':'selected_by_default';
  if(!same(selected.binding,binding)||route.decision.reasonCode!==reason||!same(route.decision.matchedRule,selected.matchedRule))return row;
  return {...row,routeHash:task.routeHash,routeReasonCode:short(route.decision.reasonCode),
   routeExplanation:short(route.decision.explanation),matchedRule:route.decision.matchedRule??null,routeProvenance:'recorded'};
 }catch{return unknown;}
}

export function storedWorkerAttribution(store,task) {
 const goal=store.maybe('goal',task.goalId);
 const history=version=>store.maybe('goal_history',`${task.goalId}-${version}`);
 return workerAttribution(task,task.goalVersion===goal?.version?goal:history(task.goalVersion),history);
}
