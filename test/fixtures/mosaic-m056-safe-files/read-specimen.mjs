// Isolated test process: intercept only owned filesystem boundaries, keeping
// native opens/stats/reads/closes real. No test seam is exported by production.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

const [scenario,root]=process.argv.slice(2);
const file=path.join(root,'input'),target=path.join(root,'target'),saved=path.join(root,'saved');
const secret='fixture-private-content';
await fs.writeFile(file,scenario==='oversize'?'123456789':'original',{mode:0o600});
await fs.chmod(file,0o600);
await fs.writeFile(target,secret,{mode:0o600});
if(scenario==='fifo'){await fs.unlink(file);execFileSync('mkfifo',[file],{timeout:2000});}
const native={open:fs.open,lstat:fs.lstat,readFile:fs.readFile};
const handles=[],metrics={readBytes:0,bufferLengths:[],reads:0,changes:0};
const beforeOpen=['swap-symlink','swap-private','swap-fifo'];
const afterStat=['grow','grow-within-limit','shrink','chmod'];
const afterRead=['rewrite','stamp'];
const change=async()=>{
 if(metrics.changes++)throw Error('Specimen mutation repeated');
 if(scenario==='swap-symlink'){await fs.unlink(file);await fs.symlink(target,file);}
 if(scenario==='swap-private'){await fs.rename(file,saved);await fs.writeFile(file,'private!');await fs.chmod(file,0o644);}
 if(scenario==='swap-fifo'){await fs.unlink(file);execFileSync('mkfifo',[file],{timeout:2000});}
 if(scenario==='swap-regular'){await fs.rename(file,saved);await fs.writeFile(file,'replaced',{mode:0o600});}
 if(scenario==='grow')await fs.appendFile(file,Buffer.alloc(4096,0x78));
 if(scenario==='grow-within-limit')await fs.appendFile(file,'xx');
 if(scenario==='shrink')await fs.truncate(file,2);
 if(scenario==='chmod')await fs.chmod(file,0o644);
 if(scenario==='rewrite')await fs.writeFile(file,'changed!');
 // Explicitly different timestamps avoid relying on clock/filesystem resolution.
 if(afterRead.includes(scenario))await fs.utimes(file,new Date('2001-01-01'),new Date('2001-01-01'));
};
fs.open=async(name,...args)=>{
 if(name!==file)return native.open(name,...args);
 if(beforeOpen.includes(scenario))await change();
 const handle=await native.open(name,...args);
 handles.push(handle);
 const stat=handle.stat.bind(handle),read=handle.read.bind(handle);
 let stats=0;
 handle.stat=async(...args)=>{
  stats++;
  if(scenario==='stat-error'||scenario==='final-stat-error'&&stats===2)throw Object.assign(Error('Injected descriptor stat failure'),{code:'EIO'});
  const info=await stat(...args);
  if(stats===1&&afterStat.includes(scenario))await change();
  return info;
 };
 handle.read=async(buffer,offset,length,position)=>{
  metrics.reads++;
  metrics.bufferLengths.push(buffer.length);
  if(scenario==='read-error')throw Object.assign(Error('Injected descriptor read failure'),{code:'EIO'});
  const result=await read(buffer,offset,scenario==='short-reads'?Math.min(2,length):length,position);
  metrics.readBytes+=result.bytesRead;
  if(metrics.reads===1&&afterRead.includes(scenario))await change();
  return result;
 };
 if(scenario==='swap-regular')await change();
 return handle;
};
// These legacy hooks reproduce the same mutations at the old pathname boundary.
fs.lstat=async(name,...args)=>{
 const info=await native.lstat(name,...args);
 if(name===file&&(beforeOpen.includes(scenario)||afterStat.includes(scenario)||scenario==='swap-regular'))await change();
 return info;
};
fs.readFile=async(name,...args)=>{
 const bytes=await native.readFile(name,...args);
 if(name===file&&afterRead.includes(scenario))await change();
 return bytes;
};
syncBuiltinESMExports();
const {fileBytes}=await import('../../../src/beta/files.mjs');
let outcome;
try{
 const bytes=await fileBytes(file,{max:scenario==='grow-within-limit'?16:8,privateFile:true});
 outcome={ok:true,length:bytes?.length,sample:bytes?.subarray(0,64).toString()};
}catch(error){outcome={ok:false,error:{message:error.message,code:error.code??null}};}
metrics.opened=handles.length;
metrics.closed=handles.map(handle=>handle.fd===-1);
// Also exercise the real post-close descriptor operation, rather than relying
// only on a close spy or a platform-specific /proc descriptor inventory.
metrics.closedStatCodes=[];
for(const handle of handles){
 try{await Object.getPrototypeOf(handle).stat.call(handle);metrics.closedStatCodes.push('OPEN');}
 catch(error){metrics.closedStatCodes.push(error.code);}
}
process.stdout.write(JSON.stringify({...outcome,metrics,flags:{nofollow:constants.O_NOFOLLOW,nonblock:constants.O_NONBLOCK}})+'\n');
