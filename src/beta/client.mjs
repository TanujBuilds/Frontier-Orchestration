import path from 'node:path';
import {jsonFile,localDirectory} from './files.mjs';
import {OBSERVER_TOOLS} from '../harness/observer.mjs';

const MAX_REPLY=8*1024*1024;
async function responseJson(response){
 if(!response.body)throw Error('Empty coordinator response');
 const reader=response.body.getReader();
 const chunks=[];let bytes=0;
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   bytes+=value.length;
   if(bytes>MAX_REPLY)throw Error('Coordinator reply exceeds the terminal client limit');
   chunks.push(Buffer.from(value));
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('Invalid coordinator response');}
 }finally{await reader.cancel().catch(()=>{});}
}

export function client(paths,{viewer=false,timeoutMs=viewer?2400:35000}={}){
 return async(name,input={},signal)=>{
  if(viewer&&!OBSERVER_TOOLS.has(name))throw Error('Terminal observer has read-only access');
  await localDirectory(paths,paths.state,{create:false});
  const cfg=await jsonFile(path.join(paths.state,viewer?'viewer-connection.json':'connection.json'),{privateFile:true,max:8192});
  if(!cfg)throw Error('Mosaic Beta coordinator is unavailable. Run mosaic doctor.');
  let url;
  try{url=new URL(cfg.url);}catch{}
  if(!url||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
     viewer&&cfg.role!=='viewer'||typeof cfg.token!=='string'||!/^[a-f0-9]{64}$/.test(cfg.token))
   throw Error('Invalid private Mosaic Beta coordinator connection');
  const timeout=AbortSignal.timeout(timeoutMs);
  let response;
  try{
   response=await fetch(new URL('/api/invoke',url),{method:'POST',redirect:'error',
    headers:{authorization:'Bearer '+cfg.token,'content-type':'application/json'},body:JSON.stringify({name,input}),
    signal:signal?AbortSignal.any([signal,timeout]):timeout});
  }catch{throw Error('Mosaic Beta coordinator is disconnected. Run mosaic doctor.');}
  const body=await responseJson(response);
  if(!response.ok)throw Error(typeof body.error==='string'?body.error:'Coordinator request failed');
  return body;
 };
}
