#!/usr/bin/env node
// Local, explicit composition. Does not download, install, sign or publish.
import {lstat,realpath,open,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {assertPortableArtifactPrivacy} from '../lib/beta-archive.mjs';

const MiB=1024*1024,hash=b=>createHash('sha256').update(b).digest('hex');
const requiredAssets=['THIRD_PARTY_NOTICES.md','docs/DISTRIBUTION_PROVENANCE.md'];
const fail=code=>{const e=new Error('staging_'+code);e.code='staging_'+code;throw e;};
const need=(ok,code)=>{if(!ok)fail(code);};
const same=(a,b)=>['dev','ino','mode','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
const overlap=(a,b)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
function absolute(p){
 need(typeof p==='string'&&path.isAbsolute(p)&&p.length<4096&&!/[\x00-\x1f\x7f]/.test(p)&&!p.split(/[\\/]/).includes('..'),'invalid_path');
 p=path.resolve(p);if(process.platform==='darwin')p=p.replace(/^\/var(?=\/|$)/,'/private/var').replace(/^\/tmp(?=\/|$)/,'/private/tmp');return p;
}
async function clean(p){
 p=absolute(p);let current=path.parse(p).root;
 for(const part of p.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const st=await lstat(current);need(!st.isSymbolicLink()&&(current===p||st.isDirectory()),'unsafe_path');}
 need(await realpath(p)===p,'noncanonical_path');return p;
}
async function bounded(file,max,{bytes=false}={}){
 const p=await clean(file),before=await lstat(p);need(before.isFile()&&before.size<=max,'invalid_regular_input');
 const h=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  need(same(before,await h.stat()),'input_changed');const sum=createHash('sha256'),blob=createHash('sha1').update(`blob ${before.size}\0`),chunks=[];let size=0;
  for await(const b of h.createReadStream({autoClose:false,highWaterMark:65536})){size+=b.length;need(size<=max&&size<=before.size,'input_changed');sum.update(b);blob.update(b);if(bytes)chunks.push(b);}
  need(size===before.size&&same(before,await h.stat())&&same(before,await lstat(p)),'input_changed');
  return {sha256:sum.digest('hex'),gitBlob:blob.digest('hex'),bytes:size,executable:!!(before.mode&0o111),...(bytes?{data:Buffer.concat(chunks)}:{})};
 }finally{await h.close();}
}
const json=async(file,max)=>JSON.parse((await bounded(file,max,{bytes:true})).data.toString('utf8'));
const save=(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const gitEnv={PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
const execute=promisify(execFile);
// Diagnostic classifications only: this is not a second input validator.
const verifierReasons=new Set(('missing_cli_arguments invalid_cli_arguments input_or_output_unavailable invalid_object invalid_fields invalid_digest invalid_source_identity invalid_list invalid_size invalid_version unsafe_relative_path unsafe_path path_unavailable symlink_path non_directory_parent noncanonical_path nonregular_file file_too_large file_unavailable file_changed malformed_json duplicate_json_key json_too_large json_too_complex json_too_deep unsupported_candidate dirty_candidate_source archive_version_path_mismatch inventory_path_mismatch unsupported_check_node unsupported_archive_format invalid_build_inputs invalid_inventory_mode duplicate_reference unsupported_preflight_claim unsupported_candidate_gate_labels source_git_failed source_identity_mismatch source_commit_pin_mismatch source_tree_pin_mismatch source_checkout_root_required source_index_mismatch unsupported_source_entry source_too_large dirty_source_bytes dirty_source_mode dirty_source_untracked archive_expanded_too_large archive_short archive_nonascii_header archive_noncanonical_header archive_invalid_number archive_missing_terminator archive_invalid_terminator archive_trailing_data archive_too_many_entries archive_header_checksum archive_not_ustar archive_nonregular_member archive_path_type_mismatch archive_noncanonical_inventory archive_owner_timestamp archive_invalid_mode archive_metadata_too_large archive_nonzero_padding archive_digest_mismatch archive_decode_failed archive_path_collision inventory_digest_mismatch inventory_candidate_mismatch inventory_schema_mismatch empty_inventory noncanonical_inventory inventory_too_large inventory_content_hash_mismatch runtime_source_closure_mismatch inventory_member_mismatch archive_inventory_paths_mismatch archive_outer_mode_mismatch inventory_checksum_list_mismatch inventory_runtime_inputs_mismatch inventory_required_runtime_missing inventory_native_claim_mismatch inventory_native_binding_mismatch inventory_sdk_mismatch runtime_source_closure_missing runtime_source_closure_too_large source_changed runtime_source_bytes_mismatch runtime_source_mode_mismatch unsupported_evidence_index evidence_binding_mismatch invalid_evidence_record evidence_too_large evidence_record_digest_mismatch input_directory_required candidate_changed output_private_owned_directory_required unsafe_output_path output_must_be_direct_child output_overlaps_input output_directory_changed output_unavailable').split(' '));
function diagnostic(phase,stderr){
 if(phase==='verify'){const m=stderr.match(/^portable-evidence: ([a-z_]{1,96})\n$/);return m&&verifierReasons.has(m[1])?m[1]:null;}
 const npm=stderr.match(/(?:^|\n)npm (?:error|ERR!) code (ENOTCACHED|ENOENT|EACCES|ENOSPC|EINTEGRITY|ETIMEDOUT|ECONNREFUSED)(?:\r?\n|$)/);if(npm)return 'npm_'+npm[1];
 if(stderr==='The pinned SDK license is missing\n')return 'builder_sdk_license_missing';
 if(stderr==='The Node executable and license must match the pinned official Darwin arm64 distribution\n')return 'builder_official_node_pin_mismatch';
 if(stderr==='Packaging requires Node 24.22.0 for Darwin arm64\n')return 'builder_runtime_platform_mismatch';
 if(stderr.startsWith('Required package source is not a regular file: '))return 'builder_required_source_invalid';
 if(/^spawn npm (ENOENT|EACCES)\n$/.test(stderr))return 'builder_npm_unavailable';
 return null;
}
async function sourcePins(source,o){
 const git=async args=>(await execute('/usr/bin/git',['--no-replace-objects','--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.excludesFile=/dev/null',...args],{cwd:source,env:gitEnv,timeout:10000,maxBuffer:4*MiB})).stdout;
 need((await git(['rev-parse','--show-toplevel'])).trim()===source,'source_root_required');
 need((await git(['rev-parse','HEAD'])).trim()===o.expectedCommit&&(await git(['rev-parse','HEAD^{tree}'])).trim()===o.expectedTree,'source_pin_mismatch');
 need(await git(['status','--porcelain','--untracked-files=normal'])==='','source_dirty');
 // Check actual bytes before executing source tools; Git status can hide edits
 // behind assume-unchanged/skip-worktree. The existing verifier still owns the
 // complete post-build source/archive/evidence contract.
 const tree=(await git(['ls-tree','-r','-z','HEAD'])).split('\0').filter(Boolean),index=(await git(['ls-files','--stage','-z'])).split('\0').filter(Boolean);
 need(tree.length>0&&tree.length<=10000&&tree.length===index.length,'source_index_mismatch');let total=0;
 for(let i=0;i<tree.length;i++){
  const match=tree[i].match(/^(100644|100755) blob ([a-f0-9]{40})\t([\x20-\x7e]+)$/);need(match,'unsupported_source_entry');const [,mode,oid,p]=match;
  need(!p.startsWith('/')&&!p.includes('\\')&&p.split('/').every(c=>c&&c!=='.'&&c!=='..')&&index[i]===`${mode} ${oid} 0\t${p}`,'source_index_mismatch');
  const f=await bounded(path.join(source,p),16*MiB);total+=f.bytes;need(total<=128*MiB&&f.gitBlob===oid&&f.executable===(mode==='100755'),'source_bytes_mismatch');
 }
}

/** Bounded child ownership. Raw stdout/stderr and environment are never logged. */
export async function runStagingChild({file,args,cwd,env,timeoutMs,logDir,phase}){
 need(['build','verify'].includes(phase)&&Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=300000,'invalid_child_request');
 const child=spawn(file,args,{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
 let outputBytes=0,stderrBytes=0,timedOut=false,overflow=false,done=false,finishing=false,hardTimer,drainTimer,complete,stopDeadline=0,stopping=false,ownerFailed=false;const stderr=[];
 const owner=path.join(logDir,phase+'-owner.json');
 const absent=()=>{if(!child.pid)return true;try{process.kill(-child.pid,0);return false;}catch(e){return e.code==='ESRCH';}};
 // detached:true creates our new session/group. Only that known group is
 // signaled, with no PID search, ancestry guess or unrelated-process cleanup.
 const signalGroup=signal=>{if(child.pid>0&&child.pid!==process.pid&&!absent())try{process.kill(-child.pid,signal);}catch{}};
 const stop=()=>{if(stopping||done)return;stopping=true;stopDeadline=Date.now()+2000;signalGroup('SIGTERM');hardTimer=setTimeout(()=>signalGroup('SIGKILL'),500);drainTimer=setTimeout(()=>complete(null,null),2000);};
 const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{outputBytes+=b.length;if(stream===child.stderr&&stderrBytes<65536){const kept=b.subarray(0,65536-stderrBytes);stderr.push(kept);stderrBytes+=kept.length;}if(outputBytes>MiB&&!overflow){overflow=true;stop();}});
 const ownerSaved=save(owner,{phase,pid:child.pid??null,processGroup:child.pid??null,status:'started',startedAtUTC:new Date().toISOString()}).catch(()=>{ownerFailed=true;stop();});
 const result=await new Promise(resolve=>{
  complete=async(code,signal,spawnError=false)=>{if(finishing)return;finishing=true;clearTimeout(timer);
   await ownerSaved;
   // Leader exit does not cancel escalation for its still-owned descendants.
   if(stopping)while(!absent()&&Date.now()<stopDeadline)await new Promise(r=>setTimeout(r,25));
   done=true;clearTimeout(hardTimer);clearTimeout(drainTimer);child.stdout.destroy();child.stderr.destroy();child.unref();
   const quiescent=absent();const result={phase,exitCode:code,signal,spawnError,timedOut,outputLimitExceeded:overflow,outputBytes,quiescent,processGroup:child.pid??null,ownerLogFailed:ownerFailed,diagnostic:code===0?null:diagnostic(phase,Buffer.concat(stderr).toString('utf8'))};
   try{await save(path.join(logDir,phase+'-result.json'),result);resolve(result);}catch{resolve({...result,logFailed:true});}
  };
  child.once('error',()=>complete(null,null,true));child.once('exit',(code,signal)=>complete(code,signal));
 });
 need(!result.spawnError&&!result.logFailed&&!result.ownerLogFailed&&!result.timedOut&&!result.outputLimitExceeded&&result.exitCode===0&&result.quiescent,'child_'+phase+'_failed_or_unresolved');
 return result;
}

/** Tests may substitute only the expensive child operation via this module API. */
export async function stageReviewedCandidate(o,{run=runStagingChild}={}){
 for(const k of ['expectedCommit','expectedTree'])need(/^[a-f0-9]{40}$/.test(o[k]??''),'invalid_source_pin');
 for(const k of ['nodeSha256','nodeLicenseSha256','nativeManifestSha256','evidenceRecordsSha256'])need(/^[a-f0-9]{64}$/.test(o[k]??''),'invalid_digest_pin');
 need(/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(o.version??'')&&o.version.length<=64,'invalid_version');
 const inputs={};for(const k of ['source','node','nodeLicense','checkArtifact','evidenceRoot','evidenceRecords','npmCache'])inputs[k]=await clean(o[k]);
 for(const k of ['source','checkArtifact','evidenceRoot','npmCache'])need((await lstat(inputs[k])).isDirectory(),'directory_required');
 const source=inputs.source,output=absolute(o.output),parent=await clean(path.dirname(output));
 const parentInfo=await lstat(parent);need(parentInfo.isDirectory()&&parentInfo.uid===process.getuid(),'output_parent_not_owned');
 for(const p of Object.values(inputs))need(!overlap(output,p),'output_overlaps_input');
 const cacheInfo=await lstat(inputs.npmCache);need(cacheInfo.uid===process.getuid()&&(cacheInfo.mode&0o077)===0,'private_owned_cache_required');
 if(o.verificationRef!==undefined)need(typeof o.verificationRef==='string'&&!path.isAbsolute(o.verificationRef)&&!o.verificationRef.includes('\\')&&!/[\x00-\x1f\x7f]/.test(o.verificationRef)&&o.verificationRef.split('/').every(p=>p&&p!=='.'&&p!=='..'),'invalid_verification_reference');
 const pins=[['node',256*MiB,o.nodeSha256],['nodeLicense',2*MiB,o.nodeLicenseSha256],['evidenceRecords',2*MiB,o.evidenceRecordsSha256]];
 const checkPins=async()=>{
  await sourcePins(source,o);
  for(const [k,max,pin] of pins)need((await bounded(inputs[k],max)).sha256===pin,'input_pin_mismatch');
  need((await bounded(path.join(inputs.checkArtifact,'artifact-manifest.json'),2*MiB)).sha256===o.nativeManifestSha256,'native_pin_mismatch');
 };
 await checkPins();
 // The isolated child HOME must not change the existing real-owner prefix
 // scan. Apply that exact accepted helper here, before any builder execution.
 assertPortableArtifactPrivacy((await bounded(path.join(inputs.checkArtifact,'node'),256*MiB,{bytes:true})).data);
 for(const p of [...requiredAssets,'scripts/package-beta.mjs','scripts/release/verify-portable-candidate.mjs','distribution/archive/install.sh'])await bounded(path.join(source,p),2*MiB);
 if(o.verificationRef!==undefined)await bounded(path.join(source,o.verificationRef),2*MiB);
 const records=await json(inputs.evidenceRecords,2*MiB);need(records&&Object.keys(records).length===1&&Array.isArray(records.records)&&records.records.length<=64,'invalid_evidence_records');
 // The accepted verifier validates record fields, bytes, paths and claims after binding.
 await mkdir(output,{mode:0o700});let phase='build',temporaryRoot=null;
 try{
  const build=path.join(output,'build'),reports=path.join(output,'reports'),logs=path.join(output,'process');
  for(const p of [build,reports,logs])await mkdir(p,{mode:0o700});
  // Keep native probe paths short and outside the source checkout. Preserve this
  // newly owned root on both success and failure for explicit later inspection.
  temporaryRoot=await realpath(await mkdtemp(path.join(process.platform==='darwin'?'/private/tmp':'/tmp','mosaic-stage-')));
  await save(path.join(output,'OWNER.json'),{kind:'mosaic-reviewed-candidate-staging',schema:1,sourceCommit:o.expectedCommit,sourceTree:o.expectedTree,version:o.version,temporaryRoot,createdAtUTC:new Date().toISOString()});
  const userConfig=path.join(output,'npm-userconfig'),globalConfig=path.join(output,'npm-globalconfig');
  for(const p of [userConfig,globalConfig])await writeFile(p,'',{flag:'wx',mode:0o600});
  const env={...gitEnv,PATH:path.dirname(process.execPath)+':'+(process.env.PATH??'/usr/bin:/bin'),HOME:output,TMPDIR:temporaryRoot,npm_config_cache:inputs.npmCache,npm_config_offline:'true',npm_config_userconfig:userConfig,npm_config_globalconfig:globalConfig};
  const args=[path.join(source,'scripts/package-beta.mjs'),'--version',o.version,'--output',build,'--node',inputs.node,'--node-license',inputs.nodeLicense,'--check-artifact',inputs.checkArtifact,'--offline',...(o.verificationRef===undefined?[]:['--verification-ref',o.verificationRef])];
  await run({file:process.execPath,args,cwd:source,env,timeoutMs:300000,logDir:logs,phase});
  const stem=`mosaic-beta-${o.version}-darwin-arm64`,candidate=path.join(build,stem+'.candidate.json'),archive=path.join(build,stem+'.tar.gz');
  const cb=await bounded(candidate,MiB,{bytes:true}),c=JSON.parse(cb.data.toString('utf8')),a=await bounded(archive,128*MiB);
  need(c.schema===1&&c.version===o.version&&c.fixture===false&&c.source?.dirty===false&&c.source.commit===o.expectedCommit&&c.source.tree===o.expectedTree&&c.archive?.file===path.basename(archive)&&c.archive.sha256===a.sha256,'candidate_binding_mismatch');
  need(c.verification?.nativePreflight?.runtimeFingerprint===o.nativeManifestSha256,'candidate_native_mismatch');
  const runtime=c.build?.runtimeInputs;need(Array.isArray(runtime)&&runtime.length===3,'candidate_runtime_mismatch');
  for(const [p,pin] of [['runtime/bin/node',o.nodeSha256],['runtime/NODE-LICENSE',o.nodeLicenseSha256],['runtime/check-artifact/artifact-manifest.json',o.nativeManifestSha256]])need(runtime.filter(f=>f.path===p&&f.sha256===pin).length===1,'candidate_runtime_mismatch');
  need((await bounded(archive+'.sha256',1024,{bytes:true})).data.toString('utf8')===a.sha256+'  '+path.basename(archive)+'\n','checksum_file_mismatch');
  await checkPins();
  const evidenceIndex=path.join(output,'evidence-index.json');await save(evidenceIndex,{schema:1,kind:'mosaic-portable-evidence-index',binding:{candidateSha256:cb.sha256,archiveSha256:a.sha256,sourceCommit:o.expectedCommit,sourceTree:o.expectedTree},records:records.records});
  phase='verify';const sidecar=path.join(reports,'portable-evidence.json');
  await run({file:process.execPath,args:[path.join(source,'scripts/release/verify-portable-candidate.mjs'),'--candidate',candidate,'--archive',archive,'--source',source,'--evidence-root',inputs.evidenceRoot,'--evidence-index',evidenceIndex,'--report-dir',reports,'--output',sidecar,'--expected-commit',o.expectedCommit,'--expected-tree',o.expectedTree],cwd:source,env,timeoutMs:300000,logDir:logs,phase});
  const report=await json(sidecar,2*MiB);
  need(report.integrity?.status==='verified'&&report.releaseAuthority===false&&report.readiness==='pending-external-qualification'&&report.candidate?.sha256===cb.sha256&&report.candidate.archive?.sha256===a.sha256&&JSON.stringify(report.candidate.originalUnpassedGates)===JSON.stringify(c.unpassedGates)&&report.externalGates?.length>0&&report.externalGates.every(g=>g.status==='pending'),'verifier_report_mismatch');
  await checkPins();need((await bounded(candidate,MiB)).sha256===cb.sha256&&(await bounded(archive,128*MiB)).sha256===a.sha256,'output_changed');
  // Read data only, after canonical archive verification. No extraction to disk,
  // archive code execution or second archive validator. The verifier already
  // binds every inventory entry to its actual member bytes and mode.
  phase='assets';
  const inventoryBytes=(await execute('/usr/bin/tar',['-xOzf',archive,stem+'/payload/package-manifest.json'],{env:gitEnv,timeout:10000,maxBuffer:2*MiB,encoding:'buffer'})).stdout;
  need(hash(inventoryBytes)===c.inventory.sha256,'inventory_changed');const inventory=JSON.parse(inventoryBytes.toString('utf8')),assets=[];
  for(const p of requiredAssets){const f=inventory.files?.find(f=>f.path==='runtime/'+p),input=await bounded(path.join(source,p),2*MiB);need(f&&f.sha256===input.sha256&&f.bytes===input.bytes&&f.mode==='100644','required_asset_mismatch');assets.push({path:f.path,sha256:f.sha256,bytes:f.bytes,mode:f.mode});}
  need((await bounded(archive,128*MiB)).sha256===a.sha256,'output_changed');
  const result={schema:1,kind:'mosaic-reviewed-candidate-staging',status:'integrity-verified-readiness-pending',releaseAuthority:false,source:{commit:o.expectedCommit,tree:o.expectedTree},version:o.version,candidate:{file:path.relative(output,candidate),sha256:cb.sha256},archive:{file:path.relative(output,archive),sha256:a.sha256},evidence:{file:'reports/portable-evidence.json',sha256:(await bounded(sidecar,2*MiB)).sha256},requiredAssets:assets,originalUnpassedGates:[...c.unpassedGates],nextStep:{executed:false,file:'/bin/sh',argv:[path.join(source,'distribution/archive/install.sh'),'--version',o.version,'--url','REQUIRED_EXACT_HTTPS_ARCHIVE_URL','--sha256',a.sha256,'--home','REQUIRED_ABSOLUTE_DISPOSABLE_HOME','--no-path'],requiresIndependentlyTrustedDigest:true,requiresExplicitTargetHome:true,requiresSeparateDownloadChannelAndInstallAuthorization:true},limitations:['supplied-evidence-does-not-prove-execution-or-reviewer-trust','historical-notices-retain-their-original-audit-boundary','no-download-install-signing-publication-or-external-qualification-executed']};
  result.retainedTemporaryRoot=temporaryRoot;
  await save(path.join(output,'STAGING.json'),result);await save(path.join(output,'STATUS.json'),{status:result.status,phase:'finished',releaseAuthority:false,retainedTemporaryRoot:temporaryRoot});return result;
 }catch(error){await save(path.join(output,'STATUS.json'),{status:'failed-retained',phase,retainedTemporaryRoot:temporaryRoot,error:typeof error.code==='string'&&/^staging_[a-z_]+$/.test(error.code)?error.code:'staging_operation_failed',nextAction:'Inspect owned build/process artifacts and any unresolved process group before retrying in a fresh output directory.'}).catch(()=>{});fail(phase+'_failed_retained');}
}

const flags=['source','expected-commit','expected-tree','version','node','node-sha256','node-license','node-license-sha256','check-artifact','native-manifest-sha256','evidence-root','evidence-records','evidence-records-sha256','npm-cache','output','verification-ref'];
const HELP='Usage: node scripts/release/build-reviewed-candidate.mjs '+flags.filter(f=>f!=='verification-ref').map(f=>'--'+f+' VALUE').join(' ')+' [--verification-ref REPO_RELATIVE_PATH]\nLocal offline build and integrity staging only. All input pins and a fresh private output are explicit. No install or publication.\n';
function options(args){const o={};while(args.length){const f=args.shift();need(flags.includes(f?.slice(2))&&f.startsWith('--')&&args.length&&!args[0].startsWith('--'),'invalid_arguments');const k=f.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());need(!Object.hasOwn(o,k),'duplicate_argument');o[k]=args.shift();}return o;}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length===3&&process.argv[2]==='--help')process.stdout.write(HELP);
 else Promise.resolve().then(()=>stageReviewedCandidate(options(process.argv.slice(2)))).then(()=>process.stdout.write('reviewed-staging: integrity_verified; readiness_pending\n')).catch(e=>{process.stderr.write('reviewed-staging: '+(/^staging_[a-z_]+$/.test(e.code??'')?e.code:'input_or_output_unavailable')+'\n');process.exitCode=2;});
}
