import {canonical,digest,identifier} from '../contracts.mjs';
import {workerProfile} from '../worker-profile.mjs';
import {STRUCTURED_WORKER_PROTOCOL} from '../provider-capabilities.mjs';

const fields=['schema','id','revision','displayName','transport','baseUrl','model','roles','capabilities',
 'maxContextTokens','maxOutputTokens','concurrency','capacityGroup','credentialRef','streaming'];
const publicFields=fields.filter(field=>field!=='credentialRef');
const transports=['openai-chat','openai-responses','anthropic-messages'];

function object(raw,allowed,label,required=allowed){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(raw))||
    Reflect.ownKeys(raw).some(key=>typeof key!=='string'||!allowed.includes(key)||!Object.prototype.propertyIsEnumerable.call(raw,key))||
    required.some(key=>!Object.hasOwn(raw,key)))throw Error('Invalid '+label);
}
function integer(value,label,min=1,max=Number.MAX_SAFE_INTEGER){
 if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('Invalid '+label);
 return value;
}
function subset(raw,allowed,label,{empty=false}={}){
 if(!Array.isArray(raw)||(!empty&&!raw.length)||raw.length>allowed.length||
    Array.from(raw).some(value=>!allowed.includes(value))||new Set(raw).size!==raw.length)
  throw Error('Invalid '+label);
 return allowed.filter(value=>raw.includes(value));
}
function normalize(raw,isPublic){
 object(raw,isPublic?publicFields:fields,'provider profile');
 if(raw.schema!==1||!transports.includes(raw.transport))throw Error('Invalid provider profile transport or schema');
 const roles=subset(raw.roles,['worker','reviewer'],'provider roles');
 if(roles.includes('worker')&&raw.transport!=='openai-chat')throw Error('Worker role requires openai-chat transport');
 object(raw.capabilities,['workerProtocol','transports','modelDiscovery','taskKinds'],'provider capabilities');
 const capabilities={workerProtocol:raw.capabilities.workerProtocol,
  transports:subset(raw.capabilities.transports,['json','sse'],'provider response transports'),
  modelDiscovery:raw.capabilities.modelDiscovery,
  taskKinds:subset(raw.capabilities.taskKinds,['coding','consult'],'provider task kinds',{empty:!roles.includes('worker')})};
 if(!['manual','advertised'].includes(capabilities.modelDiscovery)||
    capabilities.workerProtocol!==(roles.includes('worker')?STRUCTURED_WORKER_PROTOCOL:null)||
    !roles.includes('worker')&&capabilities.taskKinds.length)
  throw Error('Invalid provider capabilities');
 if(!roles.includes('worker')&&(raw.streaming!==false||capabilities.transports.length!==1||capabilities.transports[0]!=='json'))
  throw Error('Reviewer-only profiles require nonstreaming JSON');
 // Reuse historical field, endpoint and configured response-mode validation without
 // passing new capability keys to its strict capability normalizer.
 const validated=workerProfile({baseUrl:raw.baseUrl,model:raw.model,displayName:raw.displayName,
  revision:raw.revision,streaming:raw.streaming,capabilities:{protocol:STRUCTURED_WORKER_PROTOCOL,
   transports:capabilities.transports,modelDiscovery:capabilities.modelDiscovery}});
 const profile={schema:1,id:identifier(raw.id,'provider id'),revision:validated.revision,
  displayName:validated.displayName,transport:raw.transport,baseUrl:validated.baseUrl,model:validated.model,roles,capabilities,
  maxContextTokens:raw.maxContextTokens===null?null:integer(raw.maxContextTokens,'provider context tokens'),
  maxOutputTokens:integer(raw.maxOutputTokens,'provider output tokens'),
  concurrency:integer(raw.concurrency,'provider concurrency',1,4),
  capacityGroup:identifier(raw.capacityGroup,'provider capacity group'),streaming:validated.streaming};
 if(!isPublic)profile.credentialRef=raw.credentialRef===null?null:identifier(raw.credentialRef,'credential reference');
 return profile;
}

/** Private settings profile; never persist this object in an approval or receipt. */
export function normalizeProfile(raw){return normalize(raw,false);}

/** Canonical public identity object. Its profileHash is the existing digest(identity). */
export function profileIdentity(raw){
 const profile=normalize(raw,!Object.hasOwn(raw??{},'credentialRef'));
 const {credentialRef,...identity}=profile;
 return identity;
}

/** Explicit schema1 settings adapter. The caller supplies new portable identifiers;
 * credential bytes are neither returned nor copied into the portable identity. */
export function normalizeLegacyWorkerProfile(raw,options={}){
 if(!raw||raw.schema!==1||!raw.worker||typeof raw.worker!=='object'||Array.isArray(raw.worker))
  throw Error('Expected legacy schema1 worker settings');
 object(options,['id','capacityGroup','credentialRef','maxContextTokens','maxOutputTokens','concurrency'],
  'legacy provider adapter options',['id','capacityGroup']);
 const apiKey=raw.worker.apiKey;
 if(apiKey!==undefined&&(typeof apiKey!=='string'||!apiKey||apiKey.length>2048||/[^\x21-\x7e]/.test(apiKey)))
  throw Error('Invalid legacy worker credential');
 const old=workerProfile(raw.worker.profile);
 const profile=normalizeProfile({schema:1,id:options.id,...old,transport:'openai-chat',roles:['worker'],
  capabilities:{workerProtocol:STRUCTURED_WORKER_PROTOCOL,
   transports:old.capabilities?.transports??[old.streaming?'sse':'json'],
   modelDiscovery:old.capabilities?.modelDiscovery??'manual',taskKinds:['coding','consult']},
  maxContextTokens:Object.hasOwn(options,'maxContextTokens')?options.maxContextTokens:null,
  maxOutputTokens:Object.hasOwn(options,'maxOutputTokens')?options.maxOutputTokens:12000,
  concurrency:Object.hasOwn(options,'concurrency')?options.concurrency:1,capacityGroup:options.capacityGroup,
  credentialRef:Object.hasOwn(options,'credentialRef')?options.credentialRef:null});
 if(apiKey){
  // Validate before returning a profile or publishing a snapshot. Include new
  // identifiers, JSON-escaped copies and URL path bytes that URL preserves encoded.
  const encoded=canonical(profile),jsonKey=JSON.stringify(apiKey).slice(1,-1);
  const decoded=encoded.replace(/%([a-f0-9]{2})/gi,(_match,hex)=>String.fromCharCode(Number.parseInt(hex,16)));
  if([encoded,decoded].some(value=>value.includes(apiKey)||value.includes(jsonKey)))
   throw Error('Legacy worker credential must appear only in its private credential field');
 }
 return profile;
}

/** Public approval policy. Omission deliberately remains omission for legacy goals. */
export function normalizeProviderPolicy(raw,catalog){
 if(raw===undefined)return undefined;
 object(raw,['version','workers','plannerWorkerId','defaultWorkerId','maxConcurrentTasks','capacityGroups'],
  'provider policy',['version','workers','plannerWorkerId','defaultWorkerId','capacityGroups']);
 if(raw.version!==1||!Array.isArray(raw.workers)||raw.workers.length<1||raw.workers.length>16)
  throw Error('Invalid provider policy worker pool');
 const workers=Array.from(raw.workers,worker=>normalize(worker,true));
 const ids=new Set();const endpoints=new Map();
 for(const worker of workers){
  if(!worker.roles.includes('worker'))throw Error('Provider policy requires worker role');
  if(ids.has(worker.id))throw Error('Duplicate provider policy worker id');
  ids.add(worker.id);
  if(endpoints.has(worker.baseUrl)&&endpoints.get(worker.baseUrl)!==worker.capacityGroup)
   throw Error('Providers sharing an endpoint must share a capacity group');
  endpoints.set(worker.baseUrl,worker.capacityGroup);
  if(catalog){
   const current=typeof catalog.get==='function'?catalog.get(worker.id,worker.revision):
    Array.isArray(catalog)?catalog.find(profile=>profile.id===worker.id&&profile.revision===worker.revision):undefined;
   if(!current||digest(profileIdentity(current))!==digest(worker))throw Error('Provider identity differs from configured catalog');
  }
 }
 if(!Array.isArray(raw.capacityGroups)||!raw.capacityGroups.length||raw.capacityGroups.length>16)
  throw Error('Invalid provider policy capacity groups');
 const groups=new Set();
 const capacityGroups=Array.from(raw.capacityGroups,group=>{
  object(group,['id','limit'],'provider capacity group');
  const id=identifier(group.id,'capacity group id');
  if(groups.has(id))throw Error('Duplicate provider capacity group');groups.add(id);
  return {id,limit:integer(group.limit,'capacity group limit',1,4)};
 });
 if(workers.some(worker=>!groups.has(worker.capacityGroup)))throw Error('Provider references an unlisted capacity group');
 const plannerWorkerId=identifier(raw.plannerWorkerId,'planner worker id'),defaultWorkerId=identifier(raw.defaultWorkerId,'default worker id');
 if(!ids.has(plannerWorkerId)||!ids.has(defaultWorkerId))throw Error('Provider policy planner/default must belong to worker pool');
 const maxConcurrentTasks=integer(Object.hasOwn(raw,'maxConcurrentTasks')?raw.maxConcurrentTasks:1,'maximum concurrent tasks',1,4);
 return {version:1,workers,plannerWorkerId,defaultWorkerId,maxConcurrentTasks,capacityGroups};
}
