import {identifier} from '../contracts.mjs';
import {normalizeProviderPolicy} from '../providers/contracts.mjs';

const categories=['general','backend','frontend','tests','docs','design'];
const capabilities=['coding','consult'];

function object(raw,allowed,label,required=[]){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(raw))||
    Reflect.ownKeys(raw).some(key=>typeof key!=='string'||!allowed.includes(key)||
     !Object.prototype.propertyIsEnumerable.call(raw,key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(raw,key),'value'))||
    required.some(key=>!Object.hasOwn(raw,key)))throw Error('Invalid '+label);
}
function category(value){
 if(!categories.includes(value))throw Error('Invalid routing category');
 return value;
}
function tokens(value,label){
 if(value===null)return null;
 if(!Number.isSafeInteger(value)||value<1)throw Error('Invalid '+label);
 return value;
}

/** Undefined preserves historical absence. A policy always references its approved pool. */
export function normalizeRoutingPolicy(raw,providerPolicy){
 if(raw===undefined)return undefined;
 object(raw,['version','rules','defaultWorkerId'],'routing policy',['version','rules','defaultWorkerId']);
 if(raw.version!==1||!Array.isArray(raw.rules)||raw.rules.length>32)throw Error('Invalid routing policy version or rules');
 const providers=normalizeProviderPolicy(providerPolicy);
 if(!providers)throw Error('Routing requires an approved provider policy');
 const pool=new Set(providers.workers.map(profile=>profile.id)),seen=new Set();
 const rules=Array.from(raw.rules,rule=>{
  object(rule,['id','category','providerId'],'routing rule',['id','category','providerId']);
  const id=identifier(rule.id,'routing rule id'),providerId=identifier(rule.providerId,'routing provider id');
  if(seen.has(id))throw Error('Duplicate routing rule id');
  if(!pool.has(providerId))throw Error('Routing rule provider must belong to the approved pool');
  seen.add(id);return {id,category:category(rule.category),providerId};
 });
 const defaultWorkerId=identifier(raw.defaultWorkerId,'routing default worker id');
 if(!pool.has(defaultWorkerId))throw Error('Routing default must belong to the approved pool');
 return {version:1,rules,defaultWorkerId};
}

/** Defaults exist only inside an explicitly supplied version1 routing object. */
export function normalizeTaskRouting(raw){
 if(raw===undefined)return undefined;
 object(raw,['version','category','requiredCapabilities','minContextTokens','maxOutputTokens','preferredProviderId'],
  'task routing',['version']);
 if(raw.version!==1)throw Error('Invalid task routing version');
 const required=Object.hasOwn(raw,'requiredCapabilities')?raw.requiredCapabilities:[];
 if(!Array.isArray(required)||required.length>capabilities.length||
    Array.from(required).some(value=>!capabilities.includes(value))||new Set(required).size!==required.length)
  throw Error('Invalid required routing capabilities');
 const normalized={version:1,category:category(Object.hasOwn(raw,'category')?raw.category:'general'),
  requiredCapabilities:capabilities.filter(value=>required.includes(value)),
  minContextTokens:tokens(Object.hasOwn(raw,'minContextTokens')?raw.minContextTokens:null,'minimum context tokens'),
  maxOutputTokens:tokens(Object.hasOwn(raw,'maxOutputTokens')?raw.maxOutputTokens:null,'maximum output tokens')};
 if(Object.hasOwn(raw,'preferredProviderId'))normalized.preferredProviderId=identifier(raw.preferredProviderId,'preferred provider id');
 return normalized;
}
