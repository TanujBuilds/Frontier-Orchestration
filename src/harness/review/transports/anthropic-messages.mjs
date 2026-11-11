import {reviewerTransport,reviewInstructions,result,fail} from './common.mjs';
// Explicitly pinned direct Claude API protocol, independently documented/tested.
export const ANTHROPIC_VERSION='2026-10-21';
const protocol={id:'anthropic-messages',path:'messages',headers:{'anthropic-version':ANTHROPIC_VERSION},
 serialize:(profile,evidence,maxTokens)=>({model:profile.model,stream:false,max_tokens:maxTokens,system:reviewInstructions,messages:[{role:'user',content:evidence}]}),
 parse(body,profile){
  if(body?.type!=='message'||body.role!=='assistant'||body.stop_reason!=='end_turn'||body.stop_details?.type==='refusal'||!Array.isArray(body.content)||!body.content.length)throw fail('Reviewer message refused, truncated or invalid');
  const texts=[];
  for(const part of body.content){
   // Modern Messages models may think by default. Do not retain or expose
   // reasoning: only final text can supply the separately validated verdict.
   if(part?.type==='thinking'||part?.type==='redacted_thinking')continue;
   if(part?.type!=='text'||typeof part.text!=='string')throw fail('Reviewer returned tools or unsupported content');texts.push(part.text);
  }
  return result(texts.join(''),body,profile,'anthropic');
 }};
export function AnthropicMessagesReviewer(options){return reviewerTransport(options,protocol);}
