// Owned subprocess: real filesystem operations with deterministic syscall-boundary
// mutation and read/allocation accounting. No production injection points.
import fs from 'node:fs/promises';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';

const [moduleUrl,root,scenario,target='data']=process.argv.slice(2);
const original={open:fs.open,readFile:fs.readFile,lstat:fs.lstat,opendir:fs.opendir,readdir:fs.readdir};
const selected=path.join(root,target),handles=new Set();
const outside=root+'-outside';
let triggered=false,maxRead=0,maxBuffer=0,readBytes=0,readFileCalls=0,dirEntries=0;
const directories=new Set();
const baseline=process.memoryUsage().arrayBuffers;
async function mutate(){
 if(triggered)return;triggered=true;
 if(scenario==='symlink'){
  await fs.rename(selected,outside);await fs.symlink(outside,selected);
 }else if(scenario==='replace'){
  const bytes=await original.readFile(selected);await fs.rename(selected,outside);await fs.writeFile(selected,bytes);
 }else if(scenario==='grow')await fs.appendFile(selected,'x');
 else if(scenario==='rewrite'){
  const handle=await original.open(selected,'r+');try{await handle.write(Buffer.from('X'),0,1,0);}finally{await handle.close();}
 }
}
fs.open=async function(file,...args){
 if(String(file)===selected&&scenario==='symlink')await mutate();
 const h=await original.open(file,...args);handles.add(h);
 const close=h.close.bind(h),read=h.read.bind(h),stat=h.stat.bind(h);
 h.close=async()=>{try{return await close();}finally{handles.delete(h);}};
 let reads=0,stats=0;
 h.stat=async(...a)=>{const s=await stat(...a);stats++;if(String(file)===selected&&stats===1&&scenario==='grow')await mutate();return s;};
 h.read=async function(buffer,offset,length,position){
  if(scenario==='read-error'&&String(file)===selected)throw Error('Injected read failure');
  maxRead=Math.max(maxRead,length);maxBuffer=Math.max(maxBuffer,buffer.length);
  if(scenario==='stream'&&String(file)===selected){
   if(buffer.length>65536||length>65536)throw Error('Whole payload buffer requested');
   if(process.memoryUsage().arrayBuffers-baseline>4*1024*1024)throw Error('Payload allocation exceeded 4 MiB headroom');
  }
  const result=await read(buffer,offset,length,position);readBytes+=result.bytesRead;reads++;
  if(String(file)===selected&&reads===1&&scenario==='rewrite')await mutate();
  return result;
 };
 if(String(file)===selected&&scenario==='replace')await mutate();
 return h;
};
fs.readFile=async function(file,...args){
 readFileCalls++;
 if(String(file)===selected){
  if(scenario==='stream')throw Error('Whole payload readFile requested');
  if(scenario==='symlink')await mutate();
  const bytes=await original.readFile(file,...args);
  if(scenario==='symlink'){await fs.unlink(selected);await fs.rename(outside,selected);}
  if(['replace','grow','rewrite'].includes(scenario))await mutate();
  return bytes;
 }
 return original.readFile(file,...args);
};
fs.opendir=async function(...args){
 const d=await original.opendir(...args),read=d.read.bind(d),close=d.close.bind(d);directories.add(d);
 d.close=async()=>{try{return await close();}finally{directories.delete(d);}};
 d.read=async()=>{const entry=await read();if(entry)dirEntries++;return entry;};return d;
};
fs.readdir=async function(...args){const entries=await original.readdir(...args);dirEntries+=entries.length;return entries;};
syncBuiltinESMExports();
const {verifyPackage}=await import(moduleUrl);
let result;
try{result={ok:true,value:await verifyPackage(root)};}catch(error){result={ok:false,message:error.message};}
await fs.rm(outside,{force:true});
console.log(JSON.stringify({...result,triggered,openHandles:handles.size,openDirectories:directories.size,maxRead,maxBuffer,readBytes,readFileCalls,dirEntries}));
