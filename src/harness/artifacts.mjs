import path from 'node:path';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {digest,identifier} from './contracts.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),MAX=32*1024*1024;
const reports=['report.md','claims.json','sources.json','manifest.json','receipt.json'];
export class Artifacts {
 constructor(c){this.c=c;}
 async safe(file){
  const root=this.c.store.root,base=await realpath(root),relative=[root,base].map(r=>path.relative(r,path.resolve(file))).find(r=>r&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r));if(!relative)throw Error('Artifact outside state root');
  let target=base;for(const part of relative.split(path.sep)){target=path.join(target,part);const info=await lstat(target);if(info.isSymbolicLink())throw Error('Unsafe artifact symlink');}
  const info=await lstat(target);if(!info.isFile()||info.size>MAX)throw Error('Unsafe or oversized artifact');return target;
 }
 public(record){const {file,...metadata}=record;return {...metadata,url:'/api/artifacts/'+record.id};}
 async list(taskId){
  const t=this.c.getTask(taskId),candidates=[];
  if(t.result?.checksumsVerified&&t.result.directory)for(const name of reports){const file=path.join(t.result.directory,name);try{await lstat(file);candidates.push({file,name,type:'text/plain; charset=utf-8'});}catch(e){if(e.code!=='ENOENT')throw e;}}
  for(const check of [...(t.result?.checks??[]),...(t.integration?.checks??[])])for(const file of check.screenshots??[])if(typeof file==='string'&&file.endsWith('.png'))candidates.push({file,name:path.basename(file),type:'image/png'});
  const output=[],seen=new Set();for(const item of candidates){
   const file=await this.safe(item.file),id=digest({taskId,file});if(seen.has(id))continue;seen.add(id);const data=await readFile(file),record={id,taskId,file,name:item.name,type:item.type,bytes:data.length,sha256:sha(data)};
   const old=this.c.store.maybe('artifact',id);if(old&&old.sha256!==record.sha256)throw Error('Saved artifact checksum changed');this.c.store.tx(()=>this.c.store.put('artifact',record));output.push(this.public(record));
  }return output;
 }
 async read(id){identifier(id,'artifact ID');const record=this.c.store.get('artifact',id),file=await this.safe(record.file),data=await readFile(file);if(data.length!==record.bytes||sha(data)!==record.sha256)throw Error('Artifact checksum changed');return {data,type:record.type,name:record.name};}
}
