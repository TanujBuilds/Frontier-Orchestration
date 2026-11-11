import {reviewerTransport,reviewInstructions,verdictSchema,result,fail} from './common.mjs';
const protocol={id:'openai-responses',path:'responses',headers:{},
 serialize:(profile,evidence,maxTokens)=>({model:profile.model,stream:false,store:false,max_output_tokens:maxTokens,instructions:reviewInstructions,input:evidence,text:{format:{type:'json_schema',name:'mosaic_review_verdict',strict:true,schema:verdictSchema}}}),
 parse(body,profile){
  if(body?.status!=='completed'||body.error||body.incomplete_details||!Array.isArray(body.output)||!body.output.length||body.output.length>16)throw fail('Reviewer response incomplete or invalid');
  const texts=[];
  for(const item of body.output){
   if(item?.type==='reasoning')continue;
   if(item?.type!=='message'||item.role!=='assistant'||item.status!=='completed'||!Array.isArray(item.content)||!item.content.length)throw fail('Reviewer returned an unsupported output item');
   for(const content of item.content){if(content?.type!=='output_text'||typeof content.text!=='string')throw fail('Reviewer refused or returned unsupported content');texts.push(content.text);}
  }
  return result(texts.join(''),body,profile,'responses');
 }};
export function OpenAIResponsesReviewer(options){return reviewerTransport(options,protocol);}
