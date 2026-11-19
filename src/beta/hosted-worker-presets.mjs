export const hostedWorkerPresets=[
 {displayName:'OpenAI Platform',baseUrl:'https://api.openai.com/v1',account:'OpenAI Platform API key'},
 {displayName:'Kimi Platform',baseUrl:'https://api.moonshot.ai/v1',account:'Kimi Platform pay-as-you-go API key'},
 {displayName:'Z.ai GLM',baseUrl:'https://api.z.ai/api/paas/v4',account:'Z.ai general API key'},
];

export function hostedWorkerChoices(firstNumber){
 return hostedWorkerPresets.map(({displayName,account},index)=>`  ${firstNumber+index}. ${displayName} (${account})`).join('\n');
}

export async function selectHostedWorkerEndpoint(ask,output,prompt){
 output.write('Choose a hosted provider number or paste your own OpenAI-compatible API base URL.\n'+hostedWorkerChoices(1)+'\n');
 const input=await ask(prompt);
 if(!/^\d+$/.test(input))return {baseUrl:input,preset:null};
 const preset=hostedWorkerPresets[Number(input)-1];
 if(!preset)throw Error('Invalid hosted API provider choice');
 return {baseUrl:preset.baseUrl,preset};
}

export async function readBearerKey(ask,prompt){
 const key=await ask(prompt,{secret:true});
 if(!key)throw Error('An API key cannot be empty.');
 return key;
}
