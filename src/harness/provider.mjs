import { DeepSeekHttpAdapter } from '../adapters/deepseek-http.mjs';
import { streamCompletion } from './stream.mjs';

export class LocalProvider extends DeepSeekHttpAdapter {
 constructor({streaming=false,...options}={}){super(options);if(typeof streaming!=='boolean')throw Error('DeepSeek streaming must be boolean');this.streaming=streaming;}
 async complete(messages,{signal,maxTokens=12000,onContent,expectedModel,onModel}={}){
  const model=await this.resolveModel(signal);
  if(expectedModel&&model!==expectedModel){const error=Error('Resolved DeepSeek model differs from pinned task model');error.requestOutcome='not_dispatched';throw error;}
  onModel?.(model);
  const payload=JSON.stringify({model,stream:this.streaming,max_tokens:maxTokens,chat_template_kwargs:{enable_thinking:false},messages});
  if(this.streaming)return streamCompletion(this.chatUrl,payload,{signal,timeoutMs:this.timeoutMs,onContent,model});
  const body=await this.request(this.chatUrl,{method:'POST',headers:{'content-type':'application/json'},body:payload},signal);
  const choice=body?.choices?.[0];
  if(typeof choice?.message?.content!=='string')throw Error('DeepSeek returned no content');
  const result={content:choice.message.content,model:body.model??model,usage:body.usage??null,finishReason:choice.finish_reason??null};
  if(Buffer.byteLength(JSON.stringify(result))>512*1024)throw Error('Provider result exceeds bound');
  return result;
 }
}
