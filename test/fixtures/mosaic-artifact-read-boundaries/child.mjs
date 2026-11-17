import {registerHooks} from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Store} from '../../../src/harness/store.mjs';
import {configure,state,closedDescriptors} from './io.mjs';
const source=new URL('../../../src/harness/artifacts.mjs',import.meta.url).href;
registerHooks({resolve(specifier,context,next){
 if(context.parentURL===source&&specifier==='node:fs/promises')return {url:new URL('./io.mjs',import.meta.url).href,shortCircuit:true};
 return next(specifier,context);
}});
const {Artifacts}=await import(source);
const [scenario,operation]=process.argv.slice(2),cap=32*1024*1024;
const parent=process.env.MOSAIC_ARTIFACT_EVIDENCE_ROOT||os.tmpdir();
await fs.mkdir(parent,{recursive:true});
const root=await fs.mkdtemp(path.join(parent,`artifact-${scenario}-${operation}-`));
const store=new Store(root),directory=path.join(root,'reports'),file=path.join(directory,'report.md'),sibling=path.join(root,'sibling.json');
const bytes=Buffer.from('original saved bytes\n'),hash=b=>createHash('sha256').update(b).digest('hex');
await fs.mkdir(directory);await fs.writeFile(file,bytes);await fs.writeFile(sibling,'safe sibling\n');
let task={result:{proposalFile:file}};
const artifacts=new Artifacts({store,getTask:()=>task});
let outcome,error,result;
try{
 let record;
 if(operation==='read'){
  [record]=await artifacts.list('task');
 }
 if(scenario==='at-limit'||scenario==='over-limit'){
  await fs.writeFile(file,Buffer.alloc(cap+(scenario==='over-limit'?1:0),97));
  if(operation==='read'){
   // The saved record matches the known specimen; size policy still applies.
   const data=await fs.readFile(file),saved=store.get('artifact',record.id);
   store.put('artifact',{...saved,bytes:data.length,sha256:hash(data)});
  }
 }
 if(scenario==='static-symlink'){await fs.unlink(file);await fs.symlink(sibling,file);}
 if(scenario==='ancestor-symlink'){
  await fs.rename(directory,directory+'.original');await fs.symlink(directory+'.original',directory);
 }
 if(scenario==='directory'){await fs.unlink(file);await fs.mkdir(file);}
 if(scenario==='fifo'){await fs.unlink(file);execFileSync('/usr/bin/mkfifo',[file]);}
 if(scenario==='missing')await fs.unlink(file);
 if(scenario==='tamper')await fs.writeFile(file,'changed');
 const before=store.all('artifact');
 configure({armed:true,mutated:false,scenario,phase:['name-swap','ancestor-swap','symlink-swap','fifo-swap'].includes(scenario)?'before-open':['name-after-read','ancestor-after-read','same-size-change'].includes(scenario)?'after-read':'before-read',file,directory,sibling,bytes,cap,readBytes:0,readRequests:[],fds:[],flags:[]});
 try{result=operation==='read'?await artifacts.read(record.id):await artifacts.list('task');outcome='accepted';}
 catch(e){outcome='rejected';error={name:e.name,code:e.code,message:e.message};}
 const after=store.all('artifact'),closed=closedDescriptors();
 const io={mutated:state.mutated,readBytes:state.readBytes,readRequests:state.readRequests,fds:state.fds,flags:state.flags,closed};
 configure({armed:false});
 task={result:{proposalFile:sibling}};
 const [safe]=await artifacts.list('task'),safeRead=await artifacts.read(safe.id);
 const snapshot={scenario,operation,root,outcome,error,io,catalogUnchanged:JSON.stringify(before)===JSON.stringify(after),safeSibling:safeRead.data.toString(),result:operation==='read'&&result?{bytes:result.data.length,sha256:hash(result.data),type:result.type,name:result.name}:result};
 await fs.writeFile(path.join(root,'observation.json'),JSON.stringify(snapshot,null,2));
 console.log(JSON.stringify(snapshot));
}finally{
 store.close();if(!process.env.MOSAIC_ARTIFACT_EVIDENCE_ROOT)await fs.rm(root,{recursive:true,force:true});
}
