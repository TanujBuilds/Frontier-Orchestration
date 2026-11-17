// Only artifacts.mjs imports this module, via the child-local resolver.
// Every specimen and descriptor belongs to the child. No global fs patch.
import * as fs from 'node:fs/promises';
import {constants, fstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
export const state={armed:false,mutated:false,readBytes:0,readRequests:[],fds:[],flags:[]};
export function configure(values){Object.assign(state,values);}
async function mutate(phase){
 if(!state.armed||state.mutated||state.phase!==phase)return;
 state.mutated=true;
 const {scenario,file,directory,bytes,cap}=state;
 if(scenario==='growth')await fs.appendFile(file,Buffer.alloc(cap+1,103));
 if(scenario==='same-size-change')await fs.writeFile(file,Buffer.alloc(bytes.length,120));
 if(scenario==='name-swap'||scenario==='name-after-read'){
  await fs.rename(file,file+'.original');await fs.writeFile(file,bytes);
 }
 if(scenario==='ancestor-swap'||scenario==='ancestor-after-read'){
  await fs.rename(directory,directory+'.original');await fs.mkdir(directory);await fs.writeFile(file,bytes);
 }
 if(scenario==='symlink-swap'){
  await fs.rename(file,file+'.original');await fs.symlink(state.sibling,file);
 }
 if(scenario==='fifo-swap'){
  await fs.rename(file,file+'.original');execFileSync('/usr/bin/mkfifo',[file]);
 }
}
export const lstat=(...args)=>fs.lstat(...args);
export const realpath=(...args)=>fs.realpath(...args);
export async function readFile(file,...args){
 await mutate('before-open');await mutate('before-read');
 let data;
 if(state.armed&&state.scenario==='read-error'){
  const h=await fs.open(file,'r');await h.close();return h.readFile(...args);
 }
 if(state.armed&&state.scenario==='fifo-swap'){
  const pending=fs.readFile(file,...args),writer=await fs.open(file,constants.O_WRONLY);
  try{await writer.writeFile(state.bytes);}finally{await writer.close();}
  data=await pending;
 }else data=await fs.readFile(file,...args);
 state.readBytes+=data.length;await mutate('after-read');return data;
}
export async function open(file,flags,...args){
 await mutate('before-open');
 const h=await fs.open(file,flags,...args),fd=h.fd;
 state.fds.push(fd);state.flags.push(flags);
 return {
  stat:(...values)=>h.stat(...values),
  async read(...values){
   await mutate('before-read');
   if(state.armed&&state.scenario==='read-error')await h.close();
   state.readRequests.push(values[2]);
   const result=await h.read(...values);state.readBytes+=result.bytesRead;
   await mutate('after-read');return result;
  },
  close:()=>h.close()
 };
}
export function closedDescriptors(){return state.fds.every(fd=>{
 try{fstatSync(fd);return false;}catch(e){if(e.code==='EBADF')return true;throw e;}
});}
