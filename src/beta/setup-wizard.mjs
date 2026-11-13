import {normalizeSettings} from './settings.mjs';
import {getHost,HOST_IDS} from './hosts/index.mjs';

const yes=value=>/^y(es)?$/i.test(value);
const integer=(raw,min,max,label)=>{const n=Number(raw);if(!/^\d+$/.test(String(raw))||!Number.isSafeInteger(n)||n<min||n>max)throw Error('Invalid '+label);return n;};

function profile({id,displayName,baseUrl,model,roles=['worker'],transport='openai-chat',credentialRef=null}){
 return {schema:1,id,revision:'r1',displayName,transport,baseUrl,model,roles,
  capabilities:{workerProtocol:roles.includes('worker')?'mosaic-structured-v1':null,transports:['json'],modelDiscovery:'manual',taskKinds:roles.includes('worker')?['coding','consult']:[]},
  maxContextTokens:null,maxOutputTokens:12000,concurrency:1,capacityGroup:id,credentialRef,streaming:false};
}
async function configureProfile(ask,index,roles){
 const id=await ask(`Profile ${index} identifier: `),displayName=await ask('Display name: '),baseUrl=await ask('Already-running server API base URL (local or explicit remote): '),model=await ask('Model ID (manual, no discovery required): '),
  transport=roles.includes('worker')?'openai-chat':['openai-chat','openai-responses','anthropic-messages'][integer(await ask('Reviewer API protocol: 1. OpenAI Chat  2. OpenAI Responses  3. Anthropic Messages [1]: ')||'1',1,3,'reviewer API protocol')-1],
  needsKey=yes(await ask('Does this endpoint require an API bearer key? [y/N] ')),credentialRef=needsKey?id+'-key':null,secret=needsKey?await ask('Bearer key (hidden): ',{secret:true}):null;
 return {profile:profile({id,displayName,baseUrl,model,roles,transport,credentialRef}),secret};
}
async function advanced(ask,hostId,{execution,nativeCheckRuntime}){
 const count=integer(await ask('Number of already-running API worker profiles [0]: ')||'0',0,15,'worker count'),providers=[],entries={};
 for(let i=0;i<count;i++){const configured=await configureProfile(ask,i+1,['worker']);providers.push(configured.profile);if(configured.secret)entries[configured.profile.credentialRef]=configured.secret;}
 let workerId=providers[0]?.id??null,plannerWorkerId=workerId,review={source:'host',hostId},routing;
 // User-entered identifiers may equal a private key. Never echo them in prompts.
 if(count>1){workerId=await ask('Default worker identifier (Enter for first worker): ')||workerId;plannerWorkerId=await ask('Planner worker identifier (Enter for default worker): ')||workerId;const rules=[];while(yes(await ask('Add an explicit specialty route? [y/N] '))){const category=await ask('Category (general/backend/frontend/tests/docs/design): '),providerId=await ask('Worker identifier: ');rules.push({id:'rule-'+(rules.length+1),category,providerId});}routing={version:1,rules,defaultWorkerId:workerId};}
 if(count&&yes(await ask('Use a separately configured API reviewer instead of the selected host? [y/N] '))){const configured=await configureProfile(ask,'reviewer',['reviewer']);providers.push(configured.profile);if(configured.secret)entries[configured.profile.credentialRef]=configured.secret;review={source:'api',reviewer:{id:configured.profile.id,revision:configured.profile.revision}};}
 const concurrency=integer(await ask('Service maximum concurrent tasks [1]: ')||'1',1,4,'service concurrency');for(const p of providers)p.concurrency=concurrency;
 // Existing endpoint aliases share physical capacity, including reviewer aliases.
 const endpointGroups=new Map();for(const p of providers){let endpoint;try{endpoint=new URL(p.baseUrl).href.replace(/\/+$/,'');}catch{throw Error('Invalid API base URL');}p.capacityGroup=endpointGroups.get(endpoint)??p.id;endpointGroups.set(endpoint,p.capacityGroup);}
 return {settings:normalizeSettings({schema:2,host:{id:hostId,options:{}},providers,defaults:{workerId,plannerWorkerId,review,...(routing?{routing}:{})},execution,nativeCheckRuntime,serviceMaxConcurrentTasks:concurrency,capacityGroups:[...new Set(providers.map(p=>p.capacityGroup))].map(id=>({id,limit:concurrency}))}),entries,presentation:'advanced',workerLocation:null};
}

export async function collectPortableSetup(ask,output,{execution,nativeCheckRuntime,existingSettings=null}={}){
 output.write('Mosaic coordinates work. Your coding app is the conversation and default review surface; a worker is an existing compatible local or API model server.\nApproved task context goes to the supplied worker endpoint. Remote and hosted endpoints send it off this Mac. Even a local worker does not make app review local: review may use the app\'s cloud service. Separate reviewer APIs are an advanced choice.\nNo automatic server discovery, model installation or inference. Choosing an app does not prove it is connected.\n');
 if(existingSettings)output.write('Existing settings detected: advanced setup will collect an explicit replacement. Cancelling preserves your current workers and review settings; inspect the exact replacement before applying.\n');
 const hostChoice=await ask('Mosaic portable setup\n  1. Codex\n  2. Claude Code\n  3. Cursor\n  4. Antigravity\nChoose host [1]: ')||'1',hostId=HOST_IDS[integer(hostChoice,1,4,'host choice')-1];
 const choice=existingSettings?5:integer(await ask('Worker setup\n  1. Model on this Mac\n  2. Model on another computer (for example a Spark)\n  3. Hosted API\n  4. No worker yet / use the coding app only\n  5. Advanced setup\nChoose worker setup [1]: ')||'1',1,5,'worker setup choice');
 if(choice===5)return advanced(ask,hostId,{execution,nativeCheckRuntime});
 const workerLocation=['local','remote','api','none'][choice-1],providers=[],entries={};
 if(choice!==4){
  output.write('Copy the API base URL and exact model ID from your existing server or API provider configuration. Mosaic uses its supported OpenAI-compatible worker transport; it will not contact the endpoint until you explicitly choose the optional inference test.\n');
  if(choice===2)output.write('For another computer, supply an address reachable from this Mac. localhost means the computer running Mosaic, not the other computer; no particular tunnel is required.\n');
  const baseUrl=await ask('API base URL: '),model=await ask('Model ID: '),needsKey=yes(await ask('Does this endpoint require an API bearer key? [y/N] ')),credentialRef=needsKey?'worker-1-key':null;
  if(needsKey)entries[credentialRef]=await ask('Bearer key (hidden): ',{secret:true});
  providers.push(profile({id:'worker-1',displayName:'Worker 1',baseUrl,model,credentialRef}));
 }
 return {settings:normalizeSettings({schema:2,host:{id:hostId,options:{}},providers,defaults:{workerId:providers.length?'worker-1':null,plannerWorkerId:providers.length?'worker-1':null,review:{source:'host',hostId}},execution,nativeCheckRuntime,serviceMaxConcurrentTasks:1,capacityGroups:providers.length?[{id:'worker-1',limit:1}]:[]}),entries,presentation:'simple',workerLocation};
}

/** Call only after validating settings against the private credential store. */
export function formatPortableSetupSummary(settings,{manualHost,workerLocation=null}={}){
 const host=getHost(settings.host.id),workers=settings.providers.filter(p=>p.roles.includes('worker')),lines=['\nMosaic setup summary',`Coding app: ${host.displayName}.`];
 if(workers.length){
  if(workerLocation)lines.push('Worker location: '+({local:'this Mac',remote:'another computer',api:'hosted API'}[workerLocation]??workerLocation)+'.');
  for(const worker of workers)lines.push(`${worker.displayName}: ${worker.model} at ${worker.baseUrl}; private bearer key ${worker.credentialRef?'configured':'not required'}.`);
  lines.push(`Approved task context goes to the supplied worker endpoint${workerLocation==='remote'||workerLocation==='api'?' off this Mac':''}.`);
  lines.push(`Concurrency: ${settings.serviceMaxConcurrentTasks} service slot${settings.serviceMaxConcurrentTasks===1?'':'s'}; worker slots ${workers.map(p=>p.concurrency).join(', ')}; capacity group slots ${settings.capacityGroups.map(g=>g.limit).join(', ')}.`);
 }else lines.push('No worker configured: local model delegation is not ready; use the coding app only.');
 if(settings.defaults.review.source==='host')lines.push(`Reviewer: ${host.displayName} (selected coding app); review may use its cloud service, even with a local worker.`);
 else {const p=settings.providers.find(p=>p.id===settings.defaults.review.reviewer.id);lines.push(`Reviewer: separate API ${p.displayName}, ${p.model} at ${p.baseUrl} (${p.transport}). Approved review evidence goes to that endpoint.`);}
 lines.push('Host connection: '+(manualHost?'manual registration pending; saving settings does not connect the app.':'fixture-tested registration; actual app connection remains unverified.'));
 lines.push('Inference: untested until the separate optional fixed-message probe; that probe does not prove coding quality or app connection.');
 lines.push('Review delivery is pull-based; closed apps wait durably. No automatic wakeup or fallback.');
 return lines.join('\n')+'\n';
}
