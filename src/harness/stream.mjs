import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

// SSE framing repeats metadata per delta; bound the wire separately from model output.
const MAX_WIRE=8*1024*1024,MAX_RESPONSE=512*1024,MAX_CAPTURE=128*1024;
function failure(message,outcome='unknown',status){const e=new Error(message);e.requestOutcome=outcome;if(status!==undefined)e.httpStatus=status;return e;}
// Keep a possible secret prefix across chunks, without delaying unrelated output.
export function redactStream(secret,write){
 let pending='';
 const deliver=value=>{if(value){try{Promise.resolve(write(value)).catch(()=>{});}catch{}}};
 return {push(chunk){
  pending+=chunk;
  let out='',at;
  while((at=pending.indexOf(secret))>=0){out+=pending.slice(0,at)+'[redacted]';pending=pending.slice(at+secret.length);}
  let tail=Math.min(pending.length,secret.length-1);
  while(tail&&!pending.endsWith(secret.slice(0,tail)))tail--;
  out+=pending.slice(0,pending.length-tail);pending=pending.slice(pending.length-tail);deliver(out);
 },finish(){deliver(pending);pending='';}};
}

// No retry or probe is performed here: one reservation permits exactly one POST.
export function streamCompletion(url,body,{signal,timeoutMs,onContent,model,authHeaders={},label='DeepSeek'}){
 const timeout=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;
 return new Promise((resolve,reject)=>{
  let settled=false;
  const fail=e=>{if(settled)return;settled=true;reject(e);request.destroy();};
  const request=(url.protocol==='https:'?https:http).request(url,{method:'POST',headers:{'content-type':'application/json','accept':'text/event-stream',...authHeaders},signal:combined},response=>{
   if(response.statusCode<200||response.statusCode>=300){fail(failure(`${label} stream returned HTTP ${response.statusCode}`,response.statusCode>=500?'unknown':'not_dispatched',response.statusCode));return;}
   if(!/^text\/event-stream(?:;|$)/i.test(response.headers['content-type']??'')){fail(failure(label+' streaming response is not SSE; completed-output mode must be explicitly selected'));return;}
   const decoder=new StringDecoder('utf8');let pending='',wireBytes=0,captured=0,content='',actualModel=null,usage=null,finishReason=null,done=false;
   const event=raw=>{
    const data=raw.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
    if(!data)return;
    if(done)throw failure(label+' stream contains data after terminal marker');
    if(data==='[DONE]'){done=true;return;}
    let item;try{item=JSON.parse(data);}catch{throw failure('Malformed '+label+' SSE JSON');}
    if(item?.error)throw failure(label+' stream reported an error');
    if(item?.model!==undefined){if(typeof item.model!=='string'||item.model.length>200||(actualModel&&actualModel!==item.model))throw failure(label+' stream model identity changed');actualModel=item.model;}
    if(item?.usage!==undefined)usage=item.usage;
    const choice=item?.choices?.[0];
    if(choice?.finish_reason!=null)finishReason=choice.finish_reason;
    const visible=choice?.delta?.content;
    if(visible!==undefined&&visible!==null){
     if(typeof visible!=='string')throw failure('Invalid '+label+' visible content');
     if(Buffer.byteLength(content)+Buffer.byteLength(visible)>MAX_RESPONSE)throw failure(label+' content exceeds512KiB bound');
     content+=visible;
     if(captured<MAX_CAPTURE&&onContent){
      const bytes=Buffer.from(visible),take=Math.min(bytes.length,MAX_CAPTURE-captured);
      const chunk=new TextDecoder().decode(bytes.subarray(0,take),{stream:true});captured+=take;
      // Presentation sinks cannot hold inference ownership or the durable result hostage.
      try{Promise.resolve(onContent(chunk)).catch(()=>{});}catch{}
     }
    }
   };
   const consume=text=>{pending+=text;let match;while((match=/\r?\n\r?\n/.exec(pending))){const raw=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);event(raw);}};
   response.on('data',chunk=>{
    if(settled)return;
    wireBytes+=chunk.length;if(wireBytes>MAX_WIRE){fail(failure(label+' SSE wire response exceeds 8 MiB bound'));return;}
    try{consume(decoder.write(chunk));}catch(e){fail(e);}
   });
   response.on('end',()=>{
    if(settled)return;
    try{consume(decoder.end());if(pending.trim()||!done||finishReason===null)throw failure('Incomplete '+label+' stream: terminal marker and finish reason required');
     const result={content,model:actualModel??model,usage,finishReason};if(Buffer.byteLength(JSON.stringify(result))>MAX_RESPONSE)throw failure(label+' provider result exceeds512KiB bound');
     settled=true;resolve(result);
    }catch(e){fail(e);}
   });
   response.on('aborted',()=>fail(failure(label+' stream disconnected')));
   response.on('error',()=>fail(failure(label+' stream connection closed')));
  });
  request.on('error',e=>{const message=signal?.aborted?label+' call interrupted':timeout.aborted?`${label} call timed out after ${timeoutMs} ms`:`${label} stream connection failed: ${e.code??'connection error'}`;fail(failure(message));});
  request.end(body);
 });
}
