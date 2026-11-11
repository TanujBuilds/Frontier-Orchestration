import {reviewerTransport,reviewInstructions,result,fail} from './common.mjs';
const protocol={id:'openai-chat',path:'chat/completions',headers:{},
 serialize:(profile,evidence,maxTokens)=>({model:profile.model,stream:false,max_tokens:maxTokens,response_format:{type:'json_object'},messages:[{role:'system',content:reviewInstructions},{role:'user',content:evidence}]}),
 parse(body,profile){
  if(body?.error||!Array.isArray(body?.choices)||body.choices.length!==1)throw fail('Reviewer returned invalid chat completion');
  const choice=body.choices[0],message=choice?.message;
  if(choice.finish_reason!=='stop'||!message||message.refusal||message.tool_calls?.length||message.function_call||message.role!=='assistant')throw fail('Reviewer refused, truncated or returned tools');
  return result(message.content,body,profile,'chat');
 }};
export function OpenAIChatReviewer(options){return reviewerTransport(options,protocol);}
