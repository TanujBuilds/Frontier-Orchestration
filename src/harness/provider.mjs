import { DeepSeekHttpAdapter } from '../adapters/deepseek-http.mjs';
import { streamCompletion, redactStream } from './stream.mjs';

export class LocalProvider extends DeepSeekHttpAdapter {
 constructor({streaming=false,...options}={}){super(options);if(typeof streaming!=='boolean')throw Error(this.label+' streaming must be boolean');this.streaming=streaming;}
 async complete(messages,{signal,maxTokens=12000,onContent,expectedModel,onModel,streaming=this.streaming}={}){
  if(typeof streaming!=='boolean'){const error=Error(this.label+' streaming must be boolean');error.requestOutcome='not_dispatched';throw error;}
  const model=await this.resolveModel(signal);
  if(expectedModel&&model!==expectedModel){const error=Error('Resolved '+this.label+' model differs from pinned task model');error.requestOutcome='not_dispatched';throw error;}
  onModel?.(model);
  const payload=JSON.stringify({model,stream:streaming,max_tokens:maxTokens,...(this.openAICompatible?{}:{chat_template_kwargs:{enable_thinking:false}}),messages});
  const capture=this.apiKey&&onContent?redactStream(this.apiKey,onContent):null;
  const streamed=streaming?await streamCompletion(this.chatUrl,payload,{signal,timeoutMs:this.timeoutMs,onContent:capture?.push??onContent,model,authHeaders:this.authHeaders,label:this.label}):null;
  capture?.finish();
  const body=streaming?null:await this.request(this.chatUrl,{method:'POST',headers:{'content-type':'application/json'},body:payload},signal);
  const choice=body?.choices?.[0];
  if(!streamed&&typeof choice?.message?.content!=='string')throw Error(this.label+' returned no content');
  let result=streamed??{content:choice.message.content,model:body.model??model,usage:body.usage??null,finishReason:choice.finish_reason??null};
  if(this.apiKey){
   const redact=value=>typeof value==='string'?this.redact(value):Array.isArray(value)?value.map(redact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[this.redact(key),redact(item)])):value;
   result=redact(result);
  }
  if(this.openAICompatible){
   if(typeof result.model!=='string'||!result.model.trim()||result.model.length>200||typeof result.finishReason!=='string'&&result.finishReason!==null)throw Error('API worker returned invalid completion metadata');
   // Hosted providers may return a dated model behind an explicitly selected alias.
   result={...result,requestedModel:model};
  }
  if(Buffer.byteLength(JSON.stringify(result))>512*1024)throw Error('Provider result exceeds bound');
  return result;
 }
}
