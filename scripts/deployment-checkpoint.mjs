// Narrow local binding checkpoint. No subprocesses, services, MCP edits, remote
// operations or state restoration. Call only from reviewed supervisor code after
// the separate activation decision. Receipts and safety declarations grant none.
import {lstat,realpath,open,mkdir,readlink,symlink,unlink,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {checkReadiness,parseBoundedJson} from './release-readiness.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const SKILLS=['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only'];
const PREPARE=['candidate','expectedContentHash','expectedManifestSha256','personalRoot','skillRoot','launcherConfig','state','checkpoint'];
const APPLY=['checkpoint','expectedPlanSha256','expectedContentHash','expectedManifestSha256','safety'];
const need=(ok,code)=>{if(!ok)throw Error(code);};
function fields(o,keys){need(o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k)),'invalid_fields');}
function pin(v){need(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'invalid_pin');}
const inside=(a,b)=>a.startsWith(b+path.sep),overlap=(a,b)=>a===b||inside(a,b)||inside(b,a);
async function info(file){try{return await lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw Error('local_io_failure');}}
async function clean(input,{absent=false}={}){
 need(typeof input==='string'&&path.isAbsolute(input)&&input.length<4096&&!/[\x00-\x1f\x7f\\]/.test(input)&&!input.split('/').some(x=>x==='..'||x==='.'),'unsafe_path');
 let result=path.normalize(input);if(process.platform==='darwin')result=result.replace(/^\/var(?=\/|$)/,'/private/var').replace(/^\/tmp(?=\/|$)/,'/private/tmp');
 let current=path.parse(result).root;const parts=result.split(path.sep).filter(Boolean);
 for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);const st=await info(current);if(!st&&absent&&i===parts.length-1)return current;need(st&&!st.isSymbolicLink(),'unsafe_or_missing_path');if(i<parts.length-1)need(st.isDirectory(),'non_directory_parent');}
 need(await realpath(result)===result,'noncanonical_path');return result;
}
async function read(file){await clean(file);const h=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const st=await h.stat();need(st.isFile()&&st.size<=1024*1024,'invalid_file');const b=Buffer.alloc(st.size+1),{bytesRead}=await h.read(b,0,b.length,0);need(bytesRead===st.size,'file_changed');return b.subarray(0,bytesRead);}finally{await h.close();}}
async function syncParent(file){const h=await open(path.dirname(file),constants.O_RDONLY);try{await h.sync();}finally{await h.close();}}
async function writeNew(file,data){const h=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await h.writeFile(data);await h.sync();}finally{await h.close();}await syncParent(file);}
const pretty=v=>JSON.stringify(v,null,2)+'\n';
function safe(s){fields(s,['local','remote','pending','authorized']);need(s.local==='quiescent'&&s.remote==='quiescent','quiescence_required');for(const list of [s.pending,s.authorized])need(Array.isArray(list)&&list.length<=100&&new Set(list).size===list.length&&list.every(x=>typeof x==='string'&&/^[\w-]{1,100}$/.test(x)),'invalid_queue_snapshot');need(s.pending.every(x=>s.authorized.includes(x)),'unauthorized_pending_queue');}
function content(p){return pretty({dataDir:p.roots.state,runtimeRoot:path.join(p.candidate.path,'runtime')});}
function bindings(p){return [...SKILLS.map(name=>({kind:'symlink',path:path.join(p.roots.skillRoot,name),source:path.join(p.candidate.path,'skills',name)})),{kind:'file',path:p.roots.launcherConfig,sha256:hash(content(p))}];}
async function validate(options){
 fields(options,PREPARE);pin(options.expectedContentHash);pin(options.expectedManifestSha256);
 const candidate=await clean(options.candidate),personalRoot=await clean(options.personalRoot),skillRoot=await clean(options.skillRoot),state=await clean(options.state),checkpoint=await clean(options.checkpoint,{absent:true});
 // Validate parents, but inspect a possible final symlink without following it.
 const parent=await clean(path.dirname(options.launcherConfig));const launcherConfig=path.join(parent,path.basename(options.launcherConfig));need(launcherConfig===options.launcherConfig,'unsafe_path');
 for(const dir of [candidate,personalRoot,skillRoot,state])need((await lstat(dir)).isDirectory(),'not_directory');
 need(personalRoot!==path.parse(personalRoot).root&&inside(skillRoot,personalRoot)&&inside(launcherConfig,personalRoot),'outside_binding_allowlist');
 const outputs=[...SKILLS.map(n=>path.join(skillRoot,n)),launcherConfig];
 need(outputs.every((a,i)=>outputs.every((b,j)=>i===j||!overlap(a,b))),'overlapping_bindings');
 need(![candidate,state,checkpoint].some(x=>outputs.some(y=>overlap(x,y)))&&!overlap(checkpoint,candidate)&&!overlap(checkpoint,state)&&!overlap(candidate,state),'protected_path_overlap');
 const report=await checkReadiness({candidate,expectedContentHash:options.expectedContentHash,expectedManifestSha256:options.expectedManifestSha256});
 const plan={schema:1,installationAuthority:false,candidate:{path:candidate,...report.candidate},roots:{personalRoot,skillRoot,launcherConfig,state},bindings:[]};plan.bindings=bindings(plan);return {plan,checkpoint};
}
/** Exclusive new private ledger. Existing personal bindings are never adopted. */
async function prepareBindingsImpl(options){
 const {plan,checkpoint}=await validate(options);for(const b of plan.bindings)need(!await info(b.path),'existing_binding');
 need(!await info(checkpoint),'checkpoint_exists_preserve_it');await mkdir(checkpoint,{mode:0o700});await syncParent(checkpoint);const bytes=pretty(plan);await writeNew(path.join(checkpoint,'plan.json'),bytes);
 return {schema:1,status:'prepared',installationAuthority:false,planSha256:hash(bytes),bindings:plan.bindings.length};
}
async function load(options){
 fields(options,APPLY);pin(options.expectedPlanSha256);pin(options.expectedContentHash);pin(options.expectedManifestSha256);safe(options.safety);
 const checkpoint=await clean(options.checkpoint);need((await lstat(checkpoint)).isDirectory(),'invalid_checkpoint');const bytes=await read(path.join(checkpoint,'plan.json'));need(hash(bytes)===options.expectedPlanSha256,'plan_pin_mismatch');
 const plan=parseBoundedJson(bytes);fields(plan,['schema','installationAuthority','candidate','roots','bindings']);fields(plan.candidate,['path','contentHash','manifestSha256','sourceCommit']);fields(plan.roots,['personalRoot','skillRoot','launcherConfig','state']);
 need(plan.schema===1&&plan.installationAuthority===false&&plan.candidate.contentHash===options.expectedContentHash&&plan.candidate.manifestSha256===options.expectedManifestSha256,'candidate_pin_mismatch');
 const expected=await validate({candidate:plan.candidate.path,expectedContentHash:options.expectedContentHash,expectedManifestSha256:options.expectedManifestSha256,...plan.roots,checkpoint});need(JSON.stringify(expected.plan)===JSON.stringify(plan),'invalid_plan');return {plan,checkpoint,pin:options.expectedPlanSha256};
}
function recordData(ctx,index){return {schema:1,planSha256:ctx.pin,index};}
const recordPath=(ctx,index,kind)=>path.join(ctx.checkpoint,`binding-${index}.${kind}.json`);
async function hasRecord(ctx,index,kind){const file=recordPath(ctx,index,kind);if(!await info(file))return false;let value;try{value=parseBoundedJson(await read(file));}catch{throw Error('invalid_record');}need(JSON.stringify(value)===JSON.stringify(recordData(ctx,index)),'invalid_record');return true;}
async function record(ctx,index,kind){if(!await hasRecord(ctx,index,kind))await writeNew(recordPath(ctx,index,kind),JSON.stringify(recordData(ctx,index)));}
async function matches(b){const st=await info(b.path);if(!st)return false;if(b.kind==='symlink')return st.isSymbolicLink()&&await readlink(b.path)===b.source;return st.isFile()&&!st.isSymbolicLink()&&hash(await read(b.path))===b.sha256;}
const result=status=>({schema:1,status,installationAuthority:false,services:'NOT_TOUCHED',hostRefresh:'PENDING',physicalPhone:'PENDING',activePolicyDowngrade:'BLOCKED_UNSUPPORTED'});
/** No automatic rollback. Earlier steps remain inspectable after any conflict. */
async function applyBindingsImpl(options){
 const ctx=await load(options);for(let i=0;i<ctx.plan.bindings.length;i++)need(!await hasRecord(ctx,i,'remove-intent')&&!await hasRecord(ctx,i,'removed'),'bindings_removed_cannot_reapply');
 for(const [i,b]of ctx.plan.bindings.entries()){
  const intent=await hasRecord(ctx,i,'intent'),done=await hasRecord(ctx,i,'done'),exists=await info(b.path);need(!done||intent,'invalid_record');
  if(exists){need(intent,'unowned_binding');need(await matches(b),'changed_binding');}
  else {need(!done,'changed_binding');await record(ctx,i,'intent');if(b.kind==='symlink'){await symlink(b.source,b.path);await syncParent(b.path);}else await writeNew(b.path,content(ctx.plan));}
  await record(ctx,i,'done');
 }
 return result('bindings_applied');
}
/** Only remove exact introduced bytes/links. CURRENT data/config/keys stay put. */
async function removeBindingsImpl(options){
 const ctx=await load(options);
 for(let i=ctx.plan.bindings.length-1;i>=0;i--){const b=ctx.plan.bindings[i],intent=await hasRecord(ctx,i,'intent'),done=await hasRecord(ctx,i,'done'),removing=await hasRecord(ctx,i,'remove-intent'),removed=await hasRecord(ctx,i,'removed');need(!done||intent,'invalid_record');need(!removed||removing,'invalid_record');
  const exists=await info(b.path);if(exists){need(intent&&!removed,'unowned_binding');need(await matches(b),'changed_binding');await record(ctx,i,'remove-intent');await unlink(b.path);await syncParent(b.path);}
  else {need(!done||removing,'changed_binding');await record(ctx,i,'remove-intent');}
  await record(ctx,i,'removed');
 }
 return result('bindings_removed_state_retained');
}
/** SQLite online backup includes committed WAL. Never restores any database. */
async function backupCurrentDatabaseImpl(options){
 fields(options,['source','output']);const source=await clean(options.source),output=await clean(options.output,{absent:true});need((await lstat(source)).isFile(),'invalid_database');need(!overlap(output,path.dirname(source)),'backup_overlaps_state');need(!await info(output),'backup_exists_preserve_it');
 await mkdir(output,{mode:0o700});await syncParent(output);const destination=path.join(output,'current.sqlite'),db=new DatabaseSync(source,{readOnly:true});
 try{await backup(db,destination);}finally{db.close();}await chmod(destination,0o600);
 const copy=new DatabaseSync(destination,{readOnly:true});let userVersion;try{need(copy.prepare('PRAGMA integrity_check').get().integrity_check==='ok','backup_integrity_failed');userVersion=copy.prepare('PRAGMA user_version').get().user_version;}finally{copy.close();}
 const h=await open(destination,constants.O_RDONLY);let checksum;try{const st=await h.stat();need(st.size<=128*1024*1024,'backup_too_large');checksum=hash(await h.readFile());await h.sync();}finally{await h.close();}
 const receipt={schema:1,scope:'fixture_or_operator_backup',restorationSupported:false,complete:true,sha256:checksum,userVersion};await writeNew(path.join(output,'backup-receipt.json'),pretty(receipt));return receipt;
}

// Public failures are fixed summaries; never echo SQLite/OS path-bearing text.
const bounded=fn=>async options=>{try{return await fn(options);}catch(e){throw Error(/^[a-z][a-z0-9_]{1,80}$/.test(e.message)?e.message:'local_io_failure');}};
export const prepareBindings=bounded(prepareBindingsImpl);
export const applyBindings=bounded(applyBindingsImpl);
export const removeBindings=bounded(removeBindingsImpl);
export const backupCurrentDatabase=bounded(backupCurrentDatabaseImpl);
