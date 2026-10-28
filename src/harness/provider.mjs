import { DeepSeekHttpAdapter } from '../adapters/deepseek-http.mjs';

export class LocalProvider extends DeepSeekHttpAdapter {
 async complete(messages,{signal,maxTokens=12000}={}){
  const model=await this.resolveModel(signal);
  const body=await this.request(this.chatUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,stream:false,max_tokens:maxTokens,chat_template_kwargs:{enable_thinking:false},messages})},signal);
  const choice=body?.choices?.[0];
  if(typeof choice?.message?.content!=='string')throw Error('DeepSeek returned no content');
  return {content:choice.message.content,model:body.model??model,usage:body.usage??null,finishReason:choice.finish_reason??null};
 }
}
