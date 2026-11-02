import {setTimeout as delay} from 'node:timers/promises';

// Baseline coordinator/native/legacy task lifecycle; unknown additions fail closed.
const taskReady=new Set(['accepted','awaiting_review','awaiting_supervisor','awaiting_user','awaiting_legacy_review','ready_to_integrate','codex_ready']);
const taskAttention=new Set(['failed','partial','cancelled','stopped','paused','uncertain','blocked']);
const taskWaiting=new Set(['queued','running','suspended','codex_active','taking_over','legacy_reviewing']);
const operationStates={completed:'ready',failed:'attention',retryable:'attention',pending:'waiting'};
const safeInteger=n=>Number.isSafeInteger(n)&&n>=0;
const fault=code=>Object.assign(Error(code),{waitReason:code});

/** Observation only. invoke(name,input,{signal,timeoutMs}) must use the selected read client. */
export async function waitForState({invoke,target,id,timeoutMs=30000,signal,now=Date.now,sleep=ms=>delay(ms)}={}){
 if(typeof invoke!=='function'||!['task','operation'].includes(target)||typeof id!=='string'||!id.trim()||id.length>256||/[\x00-\x1f\x7f]/.test(id)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000||typeof now!=='function'||typeof sleep!=='function')throw Error('Invalid wait input');
 const deadline=now()+timeoutMs;let status=null,cursor=0,lastEventSeq=null,checks=0;
 const result=(outcome,reason)=>({version:1,target,id,outcome,status,cursor,observedAt:now(),checks,lastEventSeq,...(reason?{reason}:{})});
 const request=async(name,input)=>{
  if(signal?.aborted)throw fault('cancelled');const remaining=deadline-now();if(remaining<=0)throw fault('deadline');if(checks>=40)throw fault('request_limit');checks++;
  const controller=new AbortController();let timer,onAbort;
  const boundary=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fault('deadline'));},remaining);onAbort=()=>{controller.abort();reject(fault('cancelled'));};signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();});
  try{return await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw fault(signal?.aborted?'cancelled':'deadline');return invoke(name,input,{signal:controller.signal,timeoutMs:remaining});}),boundary]);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
 };
 const observe=async()=>{
  const value=await request(target+'_get',{[target==='task'?'taskId':'operationId']:id});
  if(!value||typeof value!=='object'||value.id!==id){status=null;throw fault('invalid_response');}
  const observed=value.status;
  const state=target==='task'?(taskReady.has(observed)?'ready':taskAttention.has(observed)?'attention':taskWaiting.has(observed)?'waiting':null):Object.hasOwn(operationStates,observed)?operationStates[observed]:null;
  if(!state){status=null;throw fault('unsupported_state');}status=observed;return state;
 };
 try{
  let state=await observe();if(state!=='waiting')return result(state);
  while(true){
   if(checks>=39)throw fault('request_limit'); // Leave room to recheck every returned batch.
   const batch=await request('events_wait',{after:cursor,timeoutMs:Math.min(30000,Math.max(0,deadline-now()))});
   if(!batch||!Array.isArray(batch.events)||batch.events.length>200||!safeInteger(batch.cursor)||batch.events.some(e=>!e||!safeInteger(e.seq)))throw fault('invalid_response');
   cursor=Math.max(cursor,batch.cursor,...batch.events.map(e=>e.seq));for(const e of batch.events)lastEventSeq=Math.max(lastEventSeq??0,e.seq);
   state=await observe();if(state!=='waiting')return result(state);
   // Even a hostile immediate event storm remains bounded by40 requests. Empty polls have a gap.
   if(!batch.events.length){const remaining=deadline-now();if(remaining<=0)throw fault('deadline');
    await requestSleep(Math.min(250,remaining),signal,sleep);
   }
  }
 }catch(error){const reason=error?.waitReason;if(signal?.aborted||reason==='cancelled')return result('cancelled','cancelled');if(reason==='deadline'||reason==='request_limit')return result('timeout',reason);if(reason==='unsupported_state')return result('unsupported_state',reason);status=null;return result('unavailable',['invalid_response','access_denied','invalid_connection','response_limit'].includes(reason)?reason:'request_failed');}
}
async function requestSleep(ms,signal,sleep){
 let onAbort;const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(fault('cancelled'));signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();});
 try{await Promise.race([sleep(ms),cancelled]);}finally{signal?.removeEventListener('abort',onAbort);}
}
