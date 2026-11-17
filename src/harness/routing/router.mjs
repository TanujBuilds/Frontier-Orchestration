import {digest,identifier} from '../contracts.mjs';
import {normalizeProviderPolicy,profileIdentity} from '../providers/contracts.mjs';
import {normalizeRoutingPolicy,normalizeTaskRouting} from './contracts.mjs';

function subset(value,allowed){
 return Array.isArray(value)&&value.length>0&&value.length<=allowed.length&&
  Array.from(value).every(item=>allowed.includes(item))&&new Set(value).size===value.length;
}
function plain(value){
 return value&&typeof value==='object'&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));
}
function workerEligibility(manifest,spec){
 const unknown={code:'mode_eligibility_unknown',explanation:'Trusted pinned mode, actor and task capability metadata are required for worker eligibility.'};
 const mode=manifest.mode,fields=['id','version','planner','actors','review','capabilities'];
 try{
  // Match Registry.registerMode's contract, including custom registered modes.
  // Approval integrity is checked by the coordinator; names imply no authority.
  if(!plain(mode)||Reflect.ownKeys(mode).length!==fields.length||
     fields.some(field=>!Object.hasOwn(mode,field))||
     Reflect.ownKeys(mode).some(field=>typeof field!=='string'||!fields.includes(field)))return unknown;
  identifier(mode.id,'pinned mode id');
  if(!Number.isSafeInteger(mode.version)||mode.version<1||mode.version>10000||
     !subset(mode.actors,['codex','deepseek'])||!mode.actors.includes(mode.planner)||
     !['operator','checks','legacy'].includes(mode.review)||
     !subset(mode.capabilities,['coding','research','consult','learning'])||
     mode.review==='operator'&&!mode.actors.includes('codex')||
     mode.review==='legacy'&&(mode.actors.join()!=='deepseek'||mode.capabilities.join()!=='coding')||
     !['codex','deepseek'].includes(spec.actor))return unknown;
  if(!mode.actors.includes('deepseek'))return {code:'mode_worker_prohibited',explanation:'The pinned mode does not permit API worker execution.'};
  // These are historical execution-channel aliases, never model/provider brands.
  if(spec.actor!=='deepseek'||!mode.actors.includes(spec.actor))return {code:'task_actor_prohibited',explanation:'This task uses host execution rather than the permitted worker channel.'};
  if(!mode.capabilities.includes(spec.kind))return {code:'mode_capability_prohibited',explanation:'The pinned mode does not permit '+spec.kind+' tasks.'};
  if(!Array.isArray(manifest.capabilities)||manifest.capabilities.length>100)return unknown;
  const pinned=Array.from(manifest.capabilities).filter(capability=>capability?.id===spec.kind);
  if(pinned.length!==1)return unknown;
  const capability=pinned[0];
  if(!plain(capability)||!['id','version','actors','handler'].every(field=>Object.hasOwn(capability,field))||
     !Number.isSafeInteger(capability.version)||capability.version<1||capability.version>10000||
     capability.handler!==spec.kind||!subset(capability.actors,['codex','deepseek']))return unknown;
  if(!capability.actors.includes(spec.actor))return {code:'mode_capability_prohibited',explanation:'The pinned task capability does not permit the worker execution actor.'};
  return null;
 }catch{return unknown;}
}

function observationFor(availability,profile,profileHash){
 const rows=availability?.providers;
 if(!Array.isArray(rows)||rows.length>16)return null;
 const matching=Array.from(rows).filter(row=>row?.providerId===profile.id);
 if(matching.length!==1)return null;
 const row=matching[0];
 if(row.revision!==profile.revision||row.profileHash!==profileHash||
    !['available','busy','offline','unknown','eligible'].includes(row.status)||
    row.status==='eligible'&&profile.capabilities.modelDiscovery!=='manual'||
    typeof row.observedAt!=='string'||row.observedAt.length>40||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(row.observedAt)||
    !Number.isFinite(Date.parse(row.observedAt))||
    typeof row.provenance!=='string'||!row.provenance.trim()||row.provenance.length>200)return null;
 const instant=new Date(Date.parse(row.observedAt)).toISOString();
 if(instant!==(row.observedAt.includes('.')?row.observedAt:row.observedAt.replace('Z','.000Z')))return null;
 return row;
}

/** Pure preview/claim decision over approved snapshots; no provider or clock is consulted.
 * Waiting carries the statically eligible identity, allowing the caller to probe only
 * that selected provider. Persisting it still requires the coordinator's atomic claim. */
export function selectRoute({task,goal,availability}={}){
 const manifest=goal?.manifest??goal,spec=task?.spec??task;
 let matchedRule=null,selection='';
 const result=(status,reasonCode,explanation,binding=null)=>({status,binding,reasonCode,
  explanation:selection+explanation,matchedRule:matchedRule?{...matchedRule}:null});
 if(manifest?.routingPolicy===undefined)return result('ineligible','routing_policy_missing','An approved routing policy is required.');
 let providers,policy,routing;
 try{providers=normalizeProviderPolicy(manifest.providerPolicy);}
 catch{return result('ineligible','provider_policy_invalid','The approved provider policy is invalid.');}
 if(!providers)return result('ineligible','provider_policy_invalid','An approved worker pool is required.');
 if(digest(providers)!==manifest.providerPolicyHash)
  return result('ineligible','provider_policy_changed','The provider policy differs from its approved hash.');
 try{policy=normalizeRoutingPolicy(manifest.routingPolicy,providers);}
 catch{return result('ineligible','routing_policy_invalid','The approved routing policy is invalid.');}
 if(manifest.routingPolicyHash!==undefined&&digest(policy)!==manifest.routingPolicyHash)
  return result('ineligible','routing_policy_changed','The routing policy differs from its approved hash.');
 try{
  routing=normalizeTaskRouting(Object.hasOwn(spec??{},'routing')?spec.routing:{version:1});
  if(!routing)throw Error('Explicit routing must be a versioned object');
 }
 catch{return result('ineligible','task_routing_invalid','The task routing requirements are invalid.');}

 let providerId,selectedBy;
 if(routing.preferredProviderId!==undefined){
  providerId=routing.preferredProviderId;selectedBy='explicit';
  selection='Explicit preference chose '+providerId+'. ';
 }else{
  matchedRule=policy.rules.find(rule=>rule.category===routing.category)??null;
  providerId=matchedRule?.providerId??policy.defaultWorkerId;
  selectedBy=matchedRule?'rule':'default';
  selection=matchedRule?'Rule '+matchedRule.id+' for '+routing.category+' chose '+providerId+'. ':
   'Routing default chose '+providerId+' for '+routing.category+'. ';
 }
 const profile=providers.workers.find(worker=>worker.id===providerId);
 if(!profile)return result('ineligible','provider_not_approved','The chosen provider is outside the approved worker pool.');
 if(!profile.roles.includes('worker')||profile.transport!=='openai-chat')
  return result('ineligible','worker_role_unsupported','The chosen profile does not support the worker transport and role.');
 if(!['coding','consult'].includes(spec?.kind))
  return result('ineligible','task_kind_unsupported','Routing supports only coding and consult tasks.');
 const eligibility=workerEligibility(manifest,spec);
 if(eligibility)return result('ineligible',eligibility.code,eligibility.explanation);
 // A proposer may add requirements, but can never erase the actual task kind.
 const required=new Set([spec.kind,...routing.requiredCapabilities]);
 const unsupported=[...required].filter(kind=>!profile.capabilities.taskKinds.includes(kind));
 if(unsupported.length)return result('ineligible','capability_unsupported','The chosen worker lacks '+unsupported.join(', ')+' capability.');
 if(routing.minContextTokens!==null){
  if(profile.maxContextTokens===null)return result('ineligible','context_limit_unknown','Unknown context capacity cannot satisfy an explicit minimum.');
  if(profile.maxContextTokens<routing.minContextTokens)return result('ineligible','context_limit_insufficient','The chosen worker cannot satisfy the minimum context tokens.');
 }
 if(routing.maxOutputTokens!==null&&profile.maxOutputTokens<routing.maxOutputTokens)
  return result('ineligible','output_limit_insufficient','The chosen worker cannot satisfy the output token requirement.');

 const binding={version:1,providerId:profile.id,revision:profile.revision,
  profileHash:digest(profileIdentity(profile)),policyHash:manifest.providerPolicyHash};
 const remaining=availability?.budget?.remainingModelCalls;
 if(remaining===0)return result('ineligible','budget_exhausted','The original model-call budget is exhausted.');
 const observation=observationFor(availability,profile,binding.profileHash);
 if(!observation||observation.status==='unknown')return result('waiting','availability_unknown',
  'No usable availability observation proves the chosen provider available.',binding);
 if(!['available','eligible'].includes(observation.status))return result('waiting','provider_'+observation.status,
  'The chosen provider was '+observation.status+' at '+observation.observedAt+' ('+observation.provenance+'); wait without fallback.',binding);
 if(!Number.isSafeInteger(remaining)||remaining<0)return result('waiting','budget_unknown',
  'The remaining original model-call budget is unknown.',binding);
 return result('selected','selected_by_'+selectedBy,
  (observation.status==='eligible'?'Eligible under the configured manual-model eligibility check at ':'Eligible under the supplied availability observation at ')+observation.observedAt+' ('+observation.provenance+').',binding);
}
