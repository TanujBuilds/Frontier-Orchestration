import {createHash} from 'node:crypto';
import {canonical,digest,identifier} from '../contracts.mjs';
import {LocalProvider} from '../provider.mjs';
import {normalizeProfile,profileIdentity} from './contracts.mjs';
import {createReviewTransport} from '../review/transports/factory.mjs';

const clients=new WeakSet();
const hashPattern=/^[a-f0-9]{64}$/;
const key=(id,revision)=>JSON.stringify([id,revision]);
const fingerprint=value=>createHash('sha256').update(value??'').digest('hex');
function failure(message){const error=Error(message);error.requestOutcome='not_dispatched';return error;}
async function resolveCredential(resolver,reference,signal){
 if(!signal)return resolver(reference);
 if(signal.aborted)throw failure('Provider call interrupted before credential resolution');
 let abort;
 const interrupted=new Promise((_,reject)=>{
  abort=()=>reject(failure('Provider call interrupted during credential resolution'));
  signal.addEventListener('abort',abort,{once:true});
 });
 try{
  // Race locally even when a resolver cannot cancel its own lookup. A late
  // credential must never resume this invocation or reach the HTTP transport.
  return await Promise.race([Promise.resolve().then(()=>{
   if(signal.aborted)throw failure('Provider call interrupted before credential resolution');
   return resolver(reference,{signal});
  }),interrupted]);
 }finally{signal.removeEventListener('abort',abort);}
}
function adapterOptions(profile){
 return {baseUrl:profile.baseUrl,model:profile.model,openAICompatible:true,streaming:profile.streaming,
  capabilities:{protocol:profile.capabilities.workerProtocol,transports:profile.capabilities.transports,
   modelDiscovery:profile.capabilities.modelDiscovery}};
}

// Only this wrapper and request-local transports can enter the registry's client
// set. No credential bytes, resolved aliases or callbacks are stored on wrappers.
class RegistryClient extends LocalProvider {
 #invoke;
 constructor(profile,invoke){
  super(adapterOptions(profile));
  this.maxContextTokens=profile.maxContextTokens;this.maxOutputTokens=profile.maxOutputTokens;
  this.#invoke=invoke;clients.add(this);Object.freeze(this);
 }
 complete(messages,options={}){return this.#invoke('complete',[messages,options]);}
 listModels(signal,options){return this.#invoke('listModels',[signal,options]);}
 availability(signal){return this.#invoke('availability',[signal]);}
 // Portable profiles always pin an explicit alias; no discovery or credential
 // read is needed just to retrieve that configured identity.
 async resolveModel(signal){if(signal?.aborted)throw failure('Provider call interrupted');return this.model;}
 execute(input){return this.#invoke('execute',[input]);}
 request(){throw failure('Direct registry provider requests are unsupported');}
}
Object.freeze(RegistryClient.prototype);

/** Positive transport provenance used by runtime's pre-POST outcome fencing. */
export function isRegistryClient(value){return clients.has(value)&&value.complete===RegistryClient.prototype.complete;}

/** An immutable catalog of private settings. Public reads return detached identities. */
export function ProviderRegistry({profiles,credentialResolver}={}){
 if(!Array.isArray(profiles)||!profiles.length||profiles.length>16||
    credentialResolver!==undefined&&typeof credentialResolver!=='function')throw Error('Invalid provider registry');
 const records=new Map(),endpoints=new Map(),cache=new Map(),reviewers=new Map(),active=new Map();
 for(const input of Array.from(profiles)){
  const profile=normalizeProfile(input),identity=profileIdentity(profile),id=key(profile.id,profile.revision);
  if(records.has(id))throw Error(digest(records.get(id).identity)===digest(identity)?
   'Duplicate provider id and revision':'Provider id and revision has conflicting immutable identity');
  if(endpoints.has(profile.baseUrl)&&endpoints.get(profile.baseUrl)!==profile.capacityGroup)
   throw Error('Providers sharing an endpoint must share a capacity group');
  endpoints.set(profile.baseUrl,profile.capacityGroup);records.set(id,{profile,identity});
 }
 const record=(id,revision)=>{
  identifier(id,'provider id');
  const found=records.get(key(id,revision));if(!found)throw Error('Configured provider revision is unavailable');
  return found;
 };
 const registry={
  get(id,revision){return structuredClone(record(id,revision).identity);},
  snapshot(refs){
   if(!Array.isArray(refs)||!refs.length||refs.length>16)throw Error('Invalid provider snapshot references');
   const seen=new Set();
   return Array.from(refs,ref=>{
    if(!ref||typeof ref!=='object'||Array.isArray(ref)||Reflect.ownKeys(ref).some(key=>!['id','revision'].includes(key))||
       !Object.hasOwn(ref,'id')||!Object.hasOwn(ref,'revision'))throw Error('Invalid provider snapshot reference');
    const id=key(ref.id,ref.revision);if(seen.has(id))throw Error('Duplicate provider snapshot reference');seen.add(id);
    return registry.get(ref.id,ref.revision);
   });
  },
  createReviewer(binding){
   const fields=['version','providerId','revision','profileHash','policyHash'];
   if(!binding||typeof binding!=='object'||Array.isArray(binding)||Reflect.ownKeys(binding).length!==fields.length||
      !fields.every(field=>Object.hasOwn(binding,field))||binding.version!==1||
      !hashPattern.test(binding.profileHash)||!hashPattern.test(binding.policyHash))throw Error('Invalid reviewer binding');
   const {profile,identity}=record(binding.providerId,binding.revision);
   if(binding.profileHash!==digest(identity))throw Error('Reviewer binding differs from configured identity');
   if(!profile.roles.includes('reviewer')||!profile.capabilities.transports.includes('json'))throw Error('Reviewer client requires reviewer role and JSON transport');
   const cacheKey=canonical(binding);if(reviewers.has(cacheKey))return reviewers.get(cacheKey);
   const profileKey=key(profile.id,profile.revision);
   const client=Object.freeze({review:async(input={})=>{
    // Credential lookup is bounded even when the caller has no cancellation signal.
    const timeout=AbortSignal.timeout(300000),signal=input.signal?AbortSignal.any([input.signal,timeout]):timeout;
    let apiKey;
    try{
     if(signal.aborted)throw Error();
     if(profile.credentialRef!==null){
      if(!credentialResolver)throw Error();
      apiKey=await resolveCredential(credentialResolver,profile.credentialRef,signal);
      if(typeof apiKey!=='string'||!apiKey||apiKey.length>2048||/[^\x21-\x7e]/.test(apiKey))throw Error();
     }
     if(signal.aborted)throw Error();
    }catch{throw failure('Reviewer credentials are unavailable, invalid or interrupted');}
    const credentialHash=fingerprint(apiKey),prior=active.get(profileKey);
    if(prior&&prior.credentialHash!==credentialHash)throw failure('Provider credential rotation is forbidden while a request is in flight');
    const state=prior??{credentialHash,count:0};state.count++;active.set(profileKey,state);
    try{return await createReviewTransport({profile,apiKey}).review({...input,signal});}
    finally{if(--state.count===0)active.delete(profileKey);}
   }});
   reviewers.set(cacheKey,client);return client;
  },
  createClient(binding){
   const fields=['version','providerId','revision','profileHash','policyHash'];
   if(!binding||typeof binding!=='object'||Array.isArray(binding)||Reflect.ownKeys(binding).length!==fields.length||
      !fields.every(field=>Object.hasOwn(binding,field))||binding.version!==1||
      !hashPattern.test(binding.profileHash)||!hashPattern.test(binding.policyHash))throw Error('Invalid provider binding');
   const {profile,identity}=record(binding.providerId,binding.revision);
   if(binding.profileHash!==digest(identity))throw Error('Provider binding differs from configured identity');
   if(!profile.roles.includes('worker')||profile.transport!=='openai-chat')throw Error('Provider client requires openai-chat worker role');
   const cacheKey=canonical(binding);if(cache.has(cacheKey))return cache.get(cacheKey);
   const profileKey=key(profile.id,profile.revision);
   const invoke=async(method,args)=>{
    const signal=method==='complete'?args[1]?.signal:method==='execute'?args[0]?.signal:args[0];
    let apiKey;
    try{
     if(signal?.aborted)throw Error();
     if(profile.credentialRef!==null){
      if(!credentialResolver)throw Error();
      apiKey=await resolveCredential(credentialResolver,profile.credentialRef,signal);
      if(typeof apiKey!=='string'||!apiKey||apiKey.length>2048||/[^\x21-\x7e]/.test(apiKey))throw Error();
     }
    }catch{throw failure('Provider credentials are unavailable or invalid');}
    const credentialHash=fingerprint(apiKey),prior=active.get(profileKey);
    if(prior&&prior.credentialHash!==credentialHash)throw failure('Provider credential rotation is forbidden while a request is in flight');
    const state=prior??{credentialHash,count:0};state.count++;active.set(profileKey,state);
    try{
     let transport;
     try{
      // Reject accidental secret inclusion in any public field before HTTP. The
      // existing adapter additionally checks decoded URL bytes and model IDs.
      if(apiKey&&canonical(identity).includes(apiKey))throw Error();
      transport=new LocalProvider({...adapterOptions(profile),apiKey});
     }catch{throw failure('Provider request configuration is invalid');}
     return await transport[method](...args);
    }finally{if(--state.count===0)active.delete(profileKey);}
   };
   const client=new RegistryClient(profile,invoke);cache.set(cacheKey,client);return client;
  },
 };
 return Object.freeze(registry);
}
