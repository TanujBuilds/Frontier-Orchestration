import path from 'node:path';
import {lstat,open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {digest,identifier} from './contracts.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),MAX=32*1024*1024;
const sameNode=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode;
const sameFile=(a,b)=>sameNode(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const reports=['report.md','claims.json','sources.json','manifest.json','receipt.json'];
export class Artifacts {
 constructor(c){this.c=c;}
 async location(file){
  const root=this.c.store.root,base=await realpath(root),relative=[root,base].map(r=>path.relative(r,path.resolve(file))).find(r=>r&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r));
  if(!relative)throw Error('Artifact outside state root');
  return {root,base,file:path.join(base,relative)};
 }
 async inspect(file){
  // Include canonical state-root ancestors: a replaced parent must not silently
  // redirect the final open. These snapshots detect changes, not atomic openat.
  const chain=[];let current=path.parse(file).root;
  for(const part of path.relative(current,file).split(path.sep)){
   current=path.join(current,part);const info=await lstat(current,{bigint:true});
   if(info.isSymbolicLink())throw Error('Unsafe artifact symlink');
   if(current===file){if(!info.isFile()||info.size>BigInt(MAX))throw Error('Unsafe or oversized artifact');}
   else if(!info.isDirectory())throw Error('Unsafe artifact ancestor');
   chain.push({file:current,info});
  }
  return chain;
 }
 async safe(file){const location=await this.location(file);await this.inspect(location.file);return location.file;}
 async load(file){
  const location=await this.location(file),before=await this.inspect(location.file),named=before.at(-1).info;
  const handle=await open(location.file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try{
   const opened=await handle.stat({bigint:true});
   if(!opened.isFile()||opened.size>BigInt(MAX)||!sameFile(named,opened))throw Error('Unsafe or changed artifact');
   const chunks=[];let total=0;
   // Never ask the OS for more than the remaining cap plus one sentinel byte,
   // even if another process keeps appending while this descriptor is open.
   while(total<=MAX){
    const buffer=Buffer.allocUnsafe(Math.min(64*1024,MAX+1-total));
    const {bytesRead}=await handle.read(buffer,0,buffer.length,total);
    if(!bytesRead)break;
    total+=bytesRead;if(total>MAX)throw Error('Unsafe or oversized artifact');
    chunks.push(buffer.subarray(0,bytesRead));
   }
   const after=await handle.stat({bigint:true});
   if(!sameFile(opened,after)||BigInt(total)!==opened.size)throw Error('Artifact changed during read');
   if(await realpath(location.root)!==location.base)throw Error('Artifact state root changed');
   const current=await this.inspect(location.file);
   if(current.length!==before.length||current.some((entry,i)=>!sameNode(entry.info,before[i].info))||!sameFile(current.at(-1).info,after))throw Error('Artifact path changed during read');
   return {file:location.file,data:Buffer.concat(chunks,total)};
  }finally{await handle.close();}
 }
 public(record){const {file,...metadata}=record;return {...metadata,url:'/api/artifacts/'+record.id};}
 async list(taskId,{limit=1000}={}){
  const t=this.c.getTask(taskId),candidates=[];
  if(t.result?.proposalFile)candidates.push({file:t.result.proposalFile,name:'proposal.json',type:'application/json'});
  if(t.result?.checksumsVerified&&t.result.directory)for(const name of reports){const file=path.join(t.result.directory,name);try{await lstat(file);candidates.push({file,name,type:'text/plain; charset=utf-8'});}catch(e){if(e.code!=='ENOENT')throw e;}}
  for(const check of [...(t.result?.checks??[]),...(t.integration?.checks??[])])for(const file of check.screenshots??[])if(typeof file==='string'&&file.endsWith('.png'))candidates.push({file,name:path.basename(file),type:'image/png'});
  if(candidates.length>limit)throw Error('Saved artifact catalog exceeds query limit');
  const output=[],seen=new Set();for(const item of candidates){
   const {file,data}=await this.load(item.file),id=digest({taskId,file});if(seen.has(id))continue;seen.add(id);const record={id,taskId,file,name:item.name,type:item.type,bytes:data.length,sha256:sha(data)};
   const old=this.c.store.maybe('artifact',id);if(old&&old.sha256!==record.sha256)throw Error('Saved artifact checksum changed');this.c.store.tx(()=>this.c.store.put('artifact',record));output.push(this.public(record));
  }return output;
 }
 async read(id){identifier(id,'artifact ID');const record=this.c.store.get('artifact',id),{data}=await this.load(record.file);if(data.length!==record.bytes||sha(data)!==record.sha256)throw Error('Artifact checksum changed');return {data,type:record.type,name:record.name};}
}
