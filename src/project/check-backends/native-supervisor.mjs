import {spawn} from 'node:child_process';
import {readFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {Pause,digest} from '../contracts.mjs';

const reasons=new Set(['exit','timeout','cancel','control-eof','output-limit','startup-cancel']);
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const within=(root,file)=>file===root||file.startsWith(root+path.sep);
function unknown(message){const error=new Pause(message,'isolation');error.executionOutcome='unknown';return error;}
function eventMatches(event,owner,binding,helperPid){return record(event)&&event.schema===1&&event.requestId===owner.requestId&&event.bindingHash===binding.bindingHash&&event.helperPid===helperPid&&Number.isInteger(event.leaderPid)&&event.leaderPid>0&&event.leaderPid!==helperPid;}
export function validateQuiescenceReceipt(receipt,{requestId,bindingHash,helperPid,leaderPid}={}){
 const keys=['schema','type','requestId','bindingHash','helperPid','leaderPid','reason','code','termSignal','groupESRCH','leaderReaped','nonzeroSignalsAfterReap'];
 if(!record(receipt)||Object.keys(receipt).length!==keys.length||keys.some(k=>!Object.hasOwn(receipt,k))||receipt.schema!==1||receipt.type!=='complete'||receipt.requestId!==requestId||receipt.bindingHash!==bindingHash||receipt.helperPid!==helperPid||receipt.leaderPid!==leaderPid||!reasons.has(receipt.reason)||!Number.isInteger(receipt.code)||receipt.code< -1||receipt.code>255||!Number.isInteger(receipt.termSignal)||receipt.termSignal<0||receipt.termSignal>128||receipt.groupESRCH!==true||receipt.leaderReaped!==true||receipt.nonzeroSignalsAfterReap!==0)throw unknown('Native supervisor did not supply exact public quiescence proof');
 return receipt;
}
async function privateReceiptPath(file,cwd){
 if(typeof file!=='string'||!path.isAbsolute(file)||path.normalize(file)!==file||/[\0\r\n]/.test(file)||within(cwd,file))throw unknown('Native completion receipt must be private and outside the check workspace');
 const dir=path.dirname(file),stat=await lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(dir)!==dir||(stat.mode&0o077)!==0||stat.uid!==process.getuid())throw unknown('Native receipt directory is not canonical private owner storage');
 try{await lstat(file);throw unknown('Native completion receipt path must be fresh');}catch(error){if(error.code!=='ENOENT')throw error;}
}
export async function executeSupervised({argv,cwd,env,timeoutMs,signal,profilePath,identity,ownership,binding,revalidate=()=>{}}){
 if(!ownership||typeof ownership.begin!=='function')throw new Pause('Native checks require durable execution ownership','isolation');
 const owner=await ownership.begin(binding);
 if(!owner||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner.requestId)||!['prepared','authorizeGo','complete','uncertain'].every(k=>typeof owner[k]==='function'))throw unknown('Invalid durable native execution owner');
 let child,finished=false,prepared,receipt,infraError,protocol='',stdout=[],stderr=[],outputBytes=0,chain=Promise.resolve(),watchdog;
 const cap=256*1024;
 async function uncertain(error){if(finished)return;finished=true;clearTimeout(watchdog);signal?.removeEventListener('abort',cancel);child?.stdio[4]?.end();child?.unref();for(const stream of child?.stdio??[])stream?.unref?.();try{await owner.uncertain(error.message);}catch{}throw error;}
 const cancel=()=>{if(!finished)child?.stdio[4]?.write('cancel\n');};
 try{await privateReceiptPath(owner.receiptPath,cwd);await revalidate();}
 catch(error){try{await owner.uncertain(error.message);}catch{}throw unknown('Native ownership setup failed before dispatch: '+error.message);}
 return new Promise((resolve,reject)=>{
  const fail=error=>{uncertain(error.executionOutcome==='unknown'?error:unknown(error.message)).catch(reject);};
  try{child=spawn(identity.runtime.supervisor.executable,[owner.requestId,binding.bindingHash,owner.receiptPath,String(timeoutMs),String(cap),cwd,profilePath,'--',...argv],{cwd,env,stdio:['ignore','pipe','pipe','pipe','pipe']});}catch(error){fail(unknown('Native supervisor launch failed: '+error.message));return;}
  child.stdio[4].on('error',()=>{});
  const collect=target=>chunk=>{if(finished)return;outputBytes+=chunk.length;if(outputBytes>cap){fail(unknown('Native supervisor exceeded its bounded output protocol'));return;}target.push(chunk);};
  child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr));
  child.stdio[3].on('data',chunk=>{
   if(finished)return;protocol+=chunk.toString('utf8');if(Buffer.byteLength(protocol)>8192){fail(unknown('Native private event channel exceeded its bound'));return;}
   let index;while((index=protocol.indexOf('\n'))>=0){const line=protocol.slice(0,index);protocol=protocol.slice(index+1);chain=chain.then(async()=>{
    if(finished)return;let event;try{event=JSON.parse(line);}catch{throw unknown('Malformed native private event');}
    if(!eventMatches(event,owner,binding,child.pid))throw unknown('Native private event identity mismatch');
    if(event.type==='uncertain')throw unknown('Native supervisor could not prove descendant quiescence');
    if(event.type==='prepared'){
     if(prepared||receipt||Object.keys(event).length!==6)throw unknown('Duplicate or malformed native prepared event');prepared=event;
     try{await owner.prepared(event);await revalidate();if(signal?.aborted)cancel();else{const authority=owner.authorizeGo();if(authority&&typeof authority.then==='function'){Promise.resolve(authority).catch(()=>{});throw new Pause('Native GO authority callback must be synchronous','isolation');}child.stdio[4].write('go\n');}}catch(error){infraError=error;child.stdio[4].end();}
    }else if(event.type==='complete'){
     if(!prepared||receipt||event.leaderPid!==prepared.leaderPid)throw unknown('Unbound native completion event');
     validateQuiescenceReceipt(event,{...prepared,requestId:owner.requestId,bindingHash:binding.bindingHash});
     const stat=await lstat(owner.receiptPath);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600||stat.uid!==process.getuid()||stat.size>4096||await realpath(owner.receiptPath)!==owner.receiptPath)throw unknown('Invalid private native completion receipt file');
     const bytes=await readFile(owner.receiptPath);let saved;try{saved=JSON.parse(bytes);}catch{throw unknown('Incomplete private native completion receipt');}if(digest(saved)!==digest(event))throw unknown('Private native receipt differs from authenticated completion channel');
     receipt=saved;await owner.complete(saved);
    }else throw unknown('Unknown native private event type');
   }).catch(fail);}
  });
  child.on('error',error=>fail(unknown('Native supervisor error: '+error.message)));
  child.on('close',()=>{chain.then(async()=>{
   if(finished)return;if(protocol||!receipt)throw unknown('Native supervisor exited without exact durable quiescence proof');
   clearTimeout(watchdog);signal?.removeEventListener('abort',cancel);finished=true;child.stdio[4].end();
   if(infraError)throw infraError;await revalidate();resolve({code:receipt.code,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),stopped:receipt.reason!=='exit',quiescence:receipt});
  }).catch(error=>{if(finished)reject(error);else fail(error);});});
  signal?.addEventListener('abort',cancel,{once:true});
  watchdog=setTimeout(()=>fail(unknown('Native supervisor proof deadline expired; execution ownership remains held')),timeoutMs+10000);
 });
}
