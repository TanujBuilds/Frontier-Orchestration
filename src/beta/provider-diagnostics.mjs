import {validModelId} from '../adapters/deepseek-http.mjs';

export const SETUP_PROBE_MESSAGE='Mosaic setup connectivity probe. Reply with setup ok.';
const MAX_MODELS=25;
const categories=new Set(['authentication','address','tls','connection','timeout','cancelled','protocol','model_not_advertised','model_not_found','context_length_exceeded','rate_limit','server','http','unknown']);

function decodedIdentity(value){
 return value.replace(/%([a-f0-9]{2})/gi,(_match,hex)=>String.fromCharCode(Number.parseInt(hex,16)))
  .replace(/\\u([a-f0-9]{4})/gi,(_match,hex)=>String.fromCharCode(Number.parseInt(hex,16)))
  .replace(/\\(["\\/])/g,'$1');
}
function containsSecret(value,secrets){
 let decoded=value;
 for(let round=0;round<4;round++){
  if(secrets.some(secret=>typeof secret==='string'&&secret&&(decoded.includes(secret)||decoded.includes(JSON.stringify(secret).slice(1,-1)))))return true;
  const next=decodedIdentity(decoded);if(next===decoded)break;decoded=next;
 }
 return secrets.some(secret=>typeof secret==='string'&&secret&&decoded.includes(secret));
}
function safeIdentity(value,secrets=[]){
 return validModelId(value)&&!/[\p{C}\p{Zl}\p{Zp}]/u.test(value)&&!containsSecret(value,secrets)?value:undefined;
}
function discoveryState(operation='discovery'){
 return {state:'not_checked',selectedModel:'unknown',models:[],operation};
}

/** Transient evidence only. No credential or completion bytes enter this report. */
export function createProviderDiagnostic(profile,{secrets=[]}={}){
 return {providerId:safeIdentity(profile.id,secrets)??'[redacted]',
  configuration:{state:'valid',transport:['openai-chat','openai-responses','anthropic-messages'].includes(profile.transport)?profile.transport:'unknown',model:safeIdentity(profile.model,secrets)??'[redacted]'},
  endpoint:{state:'not_checked',observations:[]},discovery:discoveryState(),inference:{state:'not_checked',operation:'inference'},
  codingQualification:'untested',hostConnection:'unverified',failed:false};
}
function reportFor(profile,{previous,secrets=[]}){
 // Prior reports belong to the same validated snapshot; never retain them across
 // profiles. Clone so a later observation cannot rewrite an already shown one.
 return previous?structuredClone(previous):createProviderDiagnostic(profile,{secrets});
}
function worker(profile){return profile.roles?.includes('worker');}
function advertised(profile){return profile.capabilities?.modelDiscovery==='advertised';}
function deadline(signal,deadlineMs=10000){
 if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>10000)throw Error('Invalid provider diagnostic deadline');
 const timeout=AbortSignal.timeout(deadlineMs);
 return {timeout,signal:signal?AbortSignal.any([signal,timeout]):timeout};
}
function failure(error,{signal,timeout}){
 const status=Number.isInteger(error?.httpStatus)&&error.httpStatus>=300&&error.httpStatus<=599?error.httpStatus:undefined;
 const observed=error?.observedHttpStatus??error?.httpStatus;
 const observedStatus=Number.isInteger(observed)&&observed>=200&&observed<300?observed:undefined;
 let category;
 if(status===401||status===403)category='authentication';
 else if(status===429)category='rate_limit';
 else if(status>=500)category='server';
 else if(['model_not_found','context_length_exceeded'].includes(error?.providerErrorCode))category=error.providerErrorCode;
 else if(status>=400)category='http';
 else if(signal?.aborted)category='cancelled';
 else if(timeout.aborted)category='timeout';
 else if(categories.has(error?.diagnosticCategory))category=error.diagnosticCategory;
 else category='unknown';
 return {category,...(status===undefined?{}:{httpStatus:status}),...(observedStatus===undefined?{}:{observedHttpStatus:observedStatus}),requestOutcome:error?.requestOutcome==='not_dispatched'?'not_dispatched':'unknown'};
}
function endpointFailure(info){
 if(info.httpStatus!==undefined||info.observedHttpStatus!==undefined||info.category==='protocol'||info.category==='model_not_advertised')return {state:'responded',...(info.httpStatus===undefined?{}:{httpStatus:info.httpStatus}),...(info.observedHttpStatus===undefined?{}:{observedHttpStatus:info.observedHttpStatus})};
 if(['address','tls','connection'].includes(info.category))return {state:'transport_failed'};
 return {state:'unknown'};
}
function observeEndpoint(report,operation,observation){
 const observations=[...(report.endpoint.observations??[]),{operation,...observation}].slice(-4);
 // A later failed transport does not erase a prior HTTP response. The operation
 // list keeps the timing and provenance of that limited responder evidence.
 const responded=observations.findLast(value=>value.state==='responded');
 report.endpoint={...(responded?{state:'responded',...(responded.httpStatus===undefined?{}:{httpStatus:responded.httpStatus}),...(responded.observedHttpStatus===undefined?{}:{observedHttpStatus:responded.observedHttpStatus})}:observation),observations};
}
function discoveryFailure(info,operation){
 return {...discoveryState(operation),state:[404,405].includes(info.httpStatus)?'unsupported':'failed',...info};
}
function rememberPreflight(report,preflight){
 report.inference.preflight=preflight;
 if(report.discovery.state==='not_checked')report.discovery=structuredClone(preflight);
}

/** One GET, bounded by one real deadline. No inference or profile mutation. */
export async function discoverProvider(client,profile,options={}){
 const report=reportFor(profile,options);if(!worker(profile))return report;
 const bound=deadline(options.signal,options.deadlineMs);
 await options.beforeRequest?.();
 try{
  const ids=await client.listModels(bound.signal,{strict:advertised(profile)});
  const models=[...new Set(ids.filter(id=>safeIdentity(id,options.secrets)))];
  observeEndpoint(report,'discovery',{state:'responded'});
  report.discovery={state:'listed',selectedModel:models.includes(profile.model)?'listed':'not_listed',models:models.slice(0,MAX_MODELS),operation:'discovery'};
  report.failed=advertised(profile)&&report.discovery.selectedModel!=='listed';
  if(report.failed)report.discovery.category='model_not_advertised';
 }catch(error){
  const info=failure(error,{...bound,signal:options.signal});
  observeEndpoint(report,'discovery',endpointFailure(info));report.discovery=discoveryFailure(info,'discovery');
  report.failed=!(report.discovery.state==='unsupported'&&!advertised(profile));
 }
 await options.beforeRequest?.();
 return report;
}

/** A fixed-message POST in the configured transport, with fresh membership if required. */
export async function probeProvider(client,profile,options={}){
 const report=reportFor(profile,options);if(!worker(profile))return report;
 // Every explicit probe has its own fresh preflight and dispatch observation.
 report.inference={state:'not_checked',operation:'inference'};
 const bound=deadline(options.signal,options.deadlineMs);let guardFailure;
 const guard=async()=>{try{await options.beforeRequest?.();}catch(error){guardFailure=error;throw error;}};
 await guard();
 try{
  await client.complete([{role:'user',content:SETUP_PROBE_MESSAGE}],{
   signal:bound.signal,maxTokens:16,streaming:profile.streaming,beforeRequest:guard,
   onModel:()=>{
    if(advertised(profile)){
     rememberPreflight(report,{state:'listed',selectedModel:'listed',models:[],operation:'inference_preflight'});
     observeEndpoint(report,'inference_preflight',{state:'responded'});
    }
   },
  });
  observeEndpoint(report,'inference',{state:'responded'});report.inference={...report.inference,state:'response_received',operation:'inference'};report.failed=false;
 }catch(error){
  if(guardFailure)throw guardFailure;
  const info=failure(error,{...bound,signal:options.signal});
  observeEndpoint(report,advertised(profile)&&!report.inference.preflight?'inference_preflight':'inference',endpointFailure(info));
  if(advertised(profile)&&!report.inference.preflight){
   const preflight=info.category==='model_not_advertised'?{state:'listed',selectedModel:'not_listed',models:[],operation:'inference_preflight',...info}:discoveryFailure(info,'inference_preflight');
   rememberPreflight(report,preflight);
  }
  report.inference={...report.inference,state:'failed',operation:report.inference.preflight&&report.inference.preflight.state!=='listed'||report.inference.preflight?.selectedModel==='not_listed'?'inference_preflight':'inference',...info};
  report.failed=true;
 }
 await guard();
 return report;
}

function guidance(observation,step){
 switch(observation.category){
  case 'authentication':return 'Authentication/access denied. Next: check the private key and provider access.';
  case 'address':case 'connection':return 'Transport failed. Next: check the supplied address, running server or tunnel.';
  case 'tls':return 'TLS verification failed. Next: check certificate validity, hostname and trust.';
  case 'timeout':return 'Request timed out.'+(step==='Inference'&&observation.requestOutcome==='unknown'?' The dispatched inference outcome may be uncertain.':'')+' Next: check server responsiveness and retry explicitly.';
  case 'cancelled':return 'Request cancelled.'+(step==='Inference'&&observation.requestOutcome==='unknown'?' The dispatched inference outcome may be uncertain.':'')+' Next: retry explicitly when ready.';
  case 'protocol':return 'Unsupported or malformed API response. Next: check the compatible API and response transport.';
  case 'model_not_advertised':return 'Selected model is not listed by the required fresh membership check. Next: check the configured model and server model list.';
  case 'model_not_found':return 'Provider-reported model not found. Next: check the API base path and selected model.';
  case 'context_length_exceeded':return 'Provider-reported context length exceeded. Next: check the model context limit and server configuration.';
  case 'rate_limit':return 'Provider rate/capacity limit. Next: check provider capacity and retry explicitly.';
  case 'server':return 'Provider server error. Next: check server health and retry explicitly.';
  case 'http':return observation.httpStatus===404?'API path or model could not be confirmed. Next: check the API base path and selected model.':'HTTP request failed. Next: check the compatible API request, base path and selected model.';
  default:return 'Diagnostic failed without a confirmed cause. Next: check the supplied API configuration.';
 }
}

function httpEvidence(observation){
 if(Number.isInteger(observation.httpStatus))return ` (HTTP ${observation.httpStatus})`;
 if(Number.isInteger(observation.observedHttpStatus))return ` (HTTP ${observation.observedHttpStatus} response observed)`;
 return '';
}
/** Fixed wording plus validated bounded identities; never raw exceptions/bodies. */
export function formatProviderDiagnostic(report,{secrets=[]}={}){
 const label=safeIdentity(report.providerId,secrets)??'[redacted]';
 const endpoint={not_checked:'not checked',responded:'responded',transport_failed:'transport failed',unknown:'unknown'}[report.endpoint?.state]??'unknown';
 const lines=[`Worker ${label}: endpoint ${endpoint}.`];
 const d=report.discovery??discoveryState();
 if(d.state==='listed'){
  const selected={listed:'listed',not_listed:'not listed',unknown:'unknown'}[d.selectedModel]??'unknown';
  const models=Array.isArray(d.models)?d.models.filter(id=>safeIdentity(id,secrets)).slice(0,MAX_MODELS):[];
  lines.push(`Model discovery: listed; selected model ${selected}${d.operation==='inference_preflight'?' (fresh inference membership GET)':''}.${models.length?' Models: '+models.join(', ')+'.':''}`);
  if(d.category==='model_not_advertised')lines.push(guidance(d,'Discovery'));
 }else if(d.state==='unsupported')lines.push('Model discovery: unsupported'+(Number.isInteger(d.httpStatus)?` (HTTP ${d.httpStatus})`:'')+'. Next: check the supplied base path; an explicit manual model is allowed.');
 else if(d.state==='failed')lines.push('Model discovery failed'+httpEvidence(d)+'. '+guidance(d,'Discovery'));
 else lines.push('Model discovery: not checked.');
 const i=report.inference??{state:'not_checked'};
 if(i.state==='response_received')lines.push('Inference: response received from the fixed-message test.');
 else if(i.state==='failed')lines.push((i.operation==='inference_preflight'?'Inference membership check':'Inference')+' failed'+httpEvidence(i)+'. '+guidance(i,'Inference'));
 else lines.push('Inference: not checked.');
 lines.push('Coding qualification: untested; coding context capacity is unverified. Host connection: unverified.');
 return lines.join('\n')+'\n';
}
