#!/usr/bin/env node
// Offline only. Candidate code is never imported. No installer or service controls.
import {lstat,realpath,open,mkdir,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verifyPackage,renderLaunchAgent} from '../src/harness/package.mjs';
import {normalizeResearchPolicy,digest} from '../src/harness/contracts.mjs';
import {verifyRemoteReviewEvidence} from '../src/harness/research-review.mjs';
import {readResearchAuthority,researchAuthorityPath,ReleaseAuthorityError} from '../src/harness/release-authority.mjs';
import {isEntry} from '../src/harness/entry.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const POLICY={version:2,finish:'selectors_only',discovery:'search_required'};
const GATES=['implementation','live_research_quality','personal_activation','installed_host_discovery','persistent_research_worker','physical_phone','installed_restart','active_policy_rollback'];
const SKILLS=['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only'];
const STATUSES=['passed','failed','pending','unknown','not_applicable'];
const contexts=new WeakMap();
const MAX_JSON=1024*1024,MAX_ARTIFACT=8*1024*1024,MAX_TOTAL=64*1024*1024;
class ReadinessError extends Error { constructor(code){super(code);this.code=code;} }
function need(ok,code){if(!ok)throw new ReadinessError(code);}
function object(v,keys){need(v&&typeof v==='object'&&!Array.isArray(v),'invalid_object');need(Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),'invalid_fields');}
function sha(v){need(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'invalid_sha256');return v;}
function identifier(v){need(typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v),'invalid_identifier');}
function list(v,max=64){need(Array.isArray(v)&&v.length<=max,'invalid_array');}
function policy(p){if(p?.version===3){try{normalizeResearchPolicy(p);return;}catch{throw new ReadinessError('unsupported_policy');}}object(p,['version','finish','discovery']);need(p.version===2&&p.finish===POLICY.finish&&p.discovery===POLICY.discovery,'unsupported_policy');}
function binding(b,expected){object(b,['contentHash','manifestSha256','sourceCommit']);sha(b.contentHash);sha(b.manifestSha256);need(/^[a-f0-9]{40}$/.test(b.sourceCommit),'invalid_source_commit');if(expected)need(Object.keys(b).every(k=>b[k]===expected[k]),'stale_candidate_binding');}
function relative(v){need(typeof v==='string'&&v.length<=400&&!/[\x00-\x1f\x7f\\]/.test(v)&&!path.isAbsolute(v)&&v.split('/').length<=16&&v.split('/').every(x=>x&&x!=='.'&&x!=='..'),'unsafe_artifact_path');return v;}
// Reject duplicate object keys and excessive depth before JSON.parse. Strings are
// lexed first, so braces/escaped quotes inside untrusted text cannot affect depth.
export function parseBoundedJson(bytes,max=MAX_JSON){
 need(bytes.length<=max,'json_too_large');const s=Buffer.from(bytes).toString('utf8');let stack=[],tokens=0;
 for(let i=0;i<s.length;i++){
  const c=s[i];if(/\s/.test(c))continue;need(++tokens<=150000,'json_too_complex');
  if(c==='"'){let j=i+1;for(;j<s.length;j++){if(s[j]==='\\'){j++;continue;}if(s[j]==='"')break;}need(j<s.length,'malformed_json');const next=s.slice(j+1).match(/^\s*(.)/s)?.[1];if(next===':'){const top=stack.at(-1);need(top?.keys,'malformed_json');let key;try{key=JSON.parse(s.slice(i,j+1));}catch{throw new ReadinessError('malformed_json');}need(!top.keys.has(key),'duplicate_json_key');top.keys.add(key);}i=j;
  }else if(c==='{'||c==='['){stack.push(c==='{'?{keys:new Set()}:{keys:null});need(stack.length<=16,'json_too_deep');}else if(c==='}'||c===']'){need(stack.length>0,'malformed_json');stack.pop();}
 }
 need(stack.length===0,'malformed_json');try{return JSON.parse(s);}catch{throw new ReadinessError('malformed_json');}
}
// Resolve only the standard macOS aliases; every other symlink component fails.
async function cleanPath(input,{absent=false}={}){
 need(typeof input==='string'&&input.length>0&&input.length<4096&&!/[\x00-\x1f\x7f]/.test(input)&&!input.split(/[\\/]/).includes('..'),'unsafe_path');
 let resolved=path.resolve(input);if(process.platform==='darwin')resolved=resolved.replace(/^\/var(?=\/|$)/,'/private/var').replace(/^\/tmp(?=\/|$)/,'/private/tmp');
 const parts=resolved.split(path.sep).filter(Boolean);let current=path.parse(resolved).root;
 for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);let info;try{info=await lstat(current);}catch(e){if(absent&&i===parts.length-1&&e.code==='ENOENT')return current;throw new ReadinessError('path_unavailable');}need(!info.isSymbolicLink(),'symlink_path');if(i<parts.length-1)need(info.isDirectory(),'non_directory_parent');}
 need(await realpath(resolved)===resolved,'noncanonical_path');return resolved;
}
async function readBounded(file,max,budget){
 const target=await cleanPath(file);need((await lstat(target)).isFile(),'nonregular_file');const h=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const info=await h.stat();need(info.isFile()&&info.size<=max,'nonregular_or_oversized_file');if(budget){budget.bytes+=info.size;need(budget.bytes<=MAX_TOTAL,'evidence_too_large');}
  // Fixed read ceiling also bounds files that grow after stat.
  const bytes=Buffer.alloc(Math.min(max+1,info.size+1));let used=0;while(used<bytes.length){const {bytesRead}=await h.read(bytes,used,bytes.length-used,null);if(!bytesRead)break;used+=bytesRead;}need(used===info.size,'file_changed_during_read');return bytes.subarray(0,used);
 }finally{await h.close();}
}
async function jsonFile(file,max,budget){return parseBoundedJson(await readBounded(file,max,budget),max);}
const overlaps=(a,b)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
async function readRef(root,ref,budget,roles=false){
 object(ref,roles?['path','sha256','bytes','role']:['path','sha256','bytes']);relative(ref.path);sha(ref.sha256);need(Number.isSafeInteger(ref.bytes)&&ref.bytes>=0&&ref.bytes<=MAX_ARTIFACT,'invalid_artifact_size');if(roles)need(['proof','report','source','assessment','receipt','review'].includes(ref.role),'invalid_artifact_role');
 const bytes=await readBounded(path.join(root,ref.path),MAX_ARTIFACT,budget);need(bytes.length===ref.bytes&&hash(bytes)===ref.sha256,'artifact_checksum_mismatch');return bytes;
}
function assessment(raw,expected,artifacts){
 object(raw,['schema','kind','candidate','policy','status','reportSha256','sourceSha256s','reviewSha256','criteria']);need(raw.schema===1&&raw.kind==='independent-semantic-assessment','unsupported_assessment');binding(raw.candidate,expected);policy(raw.policy);need(['passed','failed','pending'].includes(raw.status),'invalid_assessment_status');sha(raw.reportSha256);sha(raw.reviewSha256);need(artifacts.filter(x=>x.role==='review').length===1&&artifacts.find(x=>x.role==='review').sha256===raw.reviewSha256,'stale_review_binding');list(raw.sourceSha256s);need(raw.sourceSha256s.length>0&&new Set(raw.sourceSha256s).size===raw.sourceSha256s.length,'invalid_assessment_sources');raw.sourceSha256s.forEach(sha);
 const reports=artifacts.filter(x=>x.role==='report'),sources=artifacts.filter(x=>x.role==='source');need(reports.length===1&&reports[0].sha256===raw.reportSha256&&sources.length===raw.sourceSha256s.length&&new Set(sources.map(x=>x.sha256)).size===sources.length&&sources.every(x=>raw.sourceSha256s.includes(x.sha256)),'stale_report_source_binding');
 list(raw.criteria,32);need(raw.criteria.length>0,'missing_acceptance_criteria');const ids=new Set();for(const c of raw.criteria){object(c,['id','status']);identifier(c.id);need(!ids.has(c.id)&&['passed','failed','pending'].includes(c.status),'invalid_acceptance_criterion');ids.add(c.id);}
 need(raw.status!=='passed'||raw.criteria.every(c=>c.status==='passed'),'conflicting_assessment');return raw.status;
}
async function receipt(raw,root,expected,budget,authority){
 if(authority)need(raw?.policy?.version===3,'incompatible_authority_policy');
 object(raw,['schema','id','candidate','policy','gates']);need(raw.schema===1,'unsupported_receipt_schema');identifier(raw.id);binding(raw.candidate,expected);policy(raw.policy);list(raw.gates,GATES.length);const seen=new Set(),gates={};
 for(const g of raw.gates){object(g,['name','status','applicability','scope','authority','artifacts']);need(GATES.includes(g.name)&&!seen.has(g.name),'duplicate_or_unknown_gate');seen.add(g.name);need(STATUSES.includes(g.status)&&['current','historical','not_applicable'].includes(g.applicability)&&['offline','fixture','live','installed'].includes(g.scope)&&['independent_native','operator','coordinator','model'].includes(g.authority),'invalid_gate');need((g.status==='not_applicable')===(g.applicability==='not_applicable'),'invalid_applicability');
  list(g.artifacts,32);const paths=new Set(),data=[];for(const ref of g.artifacts){need(!paths.has(ref.path),'duplicate_artifact');paths.add(ref.path);data.push(await readRef(root,ref,budget,true));}
  let status=g.status,reason='declared_evidence';if(g.applicability!=='current'){status='pending';reason='not_current_applicability';}
  if(status==='passed'){
   if(g.artifacts.length===0||!['independent_native','operator'].includes(g.authority)){status='pending';reason='independent_evidence_required';}
   if(g.name==='implementation'&&!['offline','live'].includes(g.scope)){status='pending';reason='fixture_only';}
   if(!['implementation','live_research_quality','active_policy_rollback'].includes(g.name)&&g.scope!=='installed'){status='pending';reason='actual_installation_required';}
  }
  if(g.name==='live_research_quality'&&(status==='passed'||authority)){
   const declared=status,indices=g.artifacts.flatMap((a,i)=>a.role==='assessment'?[i]:[]);need(indices.length<=1,'duplicate_assessment');
   let assessed=null,qualityReason='independent_live_assessment_required';
   if(indices.length===1&&(authority||(g.scope==='live'&&g.authority==='independent_native'&&g.artifacts.some(x=>x.role==='review')))){
    const independent=parseBoundedJson(data[indices[0]]);need(digest(independent.policy)===digest(raw.policy),'assessment_policy_mismatch');
    assessed=assessment(independent,expected,g.artifacts);qualityReason='bound_independent_assessment';
    if(raw.policy.version===3){
     const ri=g.artifacts.flatMap((a,i)=>a.role==='receipt'?[i]:[]);need(ri.length<=1,'duplicate_review_receipt');
     if(ri.length!==1){if(assessed!=='failed'){assessed='pending';qualityReason='pre_final_review_receipt_required';}}
     else {
      const r=parseBoundedJson(data[ri[0]]),q=r.quality;
      need(r.status==='completed'&&r.mode==='live','live_review_receipt_required');
      try{verifyRemoteReviewEvidence(r,{checkpoint:{remoteJobId:r.job_id,remoteHash:r.manifest_hash},spec:{researchPolicy:raw.policy}});}catch{throw new ReadinessError('invalid_pre_final_review_binding');}
      need(q.report_sha256===independent.reportSha256&&independent.sourceSha256s.length===1&&q.source_artifact_sha256===independent.sourceSha256s[0],'stale_pre_final_artifacts');
      const reportIndex=g.artifacts.findIndex(a=>a.role==='report'),sourceIndex=g.artifacts.findIndex(a=>a.role==='source');need(hash(data[reportIndex])===q.review_binding.reportSha256&&hash(data[sourceIndex])===q.review_binding.sourcesSha256,'stale_accepted_report_or_sources');
      let proof;
      if(authority){
       need(!authority.proof,'duplicate_authority_evidence');
       proof=await readResearchAuthority({stateRoot:authority.stateRoot,taskId:authority.taskId,receipt:r,policy:raw.policy,reportBytes:data[reportIndex],sourceBytes:data[sourceIndex]});authority.proof=proof;
      }
      if(assessed!=='failed'&&proof?.status!=='verified'){assessed='pending';qualityReason=proof?.reason??'authoritative_local_acceptance_required';}
     }
    }
   }
   // Failure dominates; explicit authority only removes the local-approval blocker.
   if(g.status==='failed'||assessed==='failed'){status='failed';reason=assessed==='failed'?'bound_independent_assessment':reason;}
   else if(declared==='passed'||g.status==='passed'){
    if(g.applicability!=='current'){status='pending';reason='not_current_applicability';}
    else if(g.scope!=='live'||g.authority!=='independent_native'){status='pending';reason='independent_live_assessment_required';}
    else {status=assessed??'pending';reason=qualityReason;}
   }
  }
  if(g.name==='active_policy_rollback'){status='pending';reason='active_policy2_downgrade_unsupported';}
  gates[g.name]={status,reason,scope:g.scope,authority:g.authority,applicability:g.applicability,artifacts:g.artifacts.map(a=>({sha256:a.sha256,role:a.role}))};
 }
 return {id:raw.id,policy:raw.policy,gates};
}
async function sealed(root,s,expected,budget){
 object(s,['done','result','resultSha256','index']);const data={};for(const k of Object.keys(s))data[k]=await readRef(root,s[k],budget);
 const done=parseBoundedJson(data.done),result=parseBoundedJson(data.result);object(done,['schema','resultSha256','indexSha256','candidateContentHash','status']);object(result,['schema','candidateContentHash','indexSha256','status']);need(done.schema===1&&result.schema===1,'unsupported_seal');
 need(done.resultSha256===hash(data.result)&&done.indexSha256===hash(data.index)&&done.candidateContentHash===expected.contentHash&&result.candidateContentHash===expected.contentHash&&result.indexSha256===done.indexSha256&&result.status===done.status&&['complete','failed','incomplete'].includes(done.status),'invalid_handoff_seal');need(data.resultSha256.toString('utf8').trim()===done.resultSha256,'invalid_handoff_sidecar');
 const index=parseBoundedJson(data.index);object(index,['schema','artifacts']);need(index.schema===1,'unsupported_sealed_index');list(index.artifacts,256);const seen=new Set();for(const ref of index.artifacts){need(!seen.has(ref.path),'duplicate_sealed_artifact');seen.add(ref.path);await readRef(root,ref,budget);}return {status:'verified',resultSha256:done.resultSha256,indexSha256:done.indexSha256};
}
/** Verify explicit immutable inputs. No environment/private config is read. */
export async function checkReadiness(options){
 const {candidate,expectedContentHash,expectedManifestSha256,evidenceIndex,receipt:receiptPath,coordinatorStateRoot,coordinatorTaskId}=options;
 const suppliedRoot=Object.hasOwn(options,'coordinatorStateRoot'),suppliedTask=Object.hasOwn(options,'coordinatorTaskId');need(suppliedRoot===suppliedTask,'authority_selectors_must_be_paired');
 let authority,authorityRoot;
 if(suppliedRoot){identifier(coordinatorTaskId);authorityRoot=(await researchAuthorityPath(coordinatorStateRoot)).root;authority={stateRoot:authorityRoot,taskId:coordinatorTaskId,proof:null};}
 sha(expectedContentHash);sha(expectedManifestSha256);const root=await cleanPath(candidate);need((await lstat(root)).isDirectory(),'candidate_not_directory');
 const bytes=await readBounded(path.join(root,'package-manifest.json'),2*MAX_JSON);need(hash(bytes)===expectedManifestSha256,'manifest_pin_mismatch');const m=parseBoundedJson(bytes,2*MAX_JSON);
 need(m.schema===1&&m.layout==='shared-runtime-v1'&&m.sourceDirty===false&&m.nodeMajor===24&&m.sdkVersion==='1.32.2'&&m.dependenciesInstalled===true,'unsupported_candidate');need(Array.isArray(m.skills)&&m.skills.length===SKILLS.length&&SKILLS.every((x,i)=>m.skills[i]===x),'incomplete_skill_inventory');need(m.contentHash===expectedContentHash,'content_pin_mismatch');need(/^[a-f0-9]{40}$/.test(m.sourceCommit),'invalid_source_commit');list(m.files,10000);need(m.files.length>0,'empty_inventory');let total=0;
 for(const f of m.files){object(f,['path','bytes','sha256']);relative(f.path);sha(f.sha256);need(Number.isSafeInteger(f.bytes)&&f.bytes>=0&&f.bytes<=16*MAX_JSON,'invalid_package_size');total+=f.bytes;}need(total<=128*MAX_JSON,'package_too_large');
 for(const required of ['scripts/harness.mjs','runtime/src/harness/cli.mjs','runtime/package-lock.json','runtime/node_modules/@modelcontextprotocol/sdk/package.json',...SKILLS.map(n=>'skills/'+n+'/SKILL.md')])need(m.files.some(f=>f.path===required),'incomplete_package');
 const sdk=await jsonFile(path.join(root,'runtime/node_modules/@modelcontextprotocol/sdk/package.json'),MAX_JSON);const lock=await jsonFile(path.join(root,'runtime/package-lock.json'),MAX_JSON);need(sdk.version==='1.32.2'&&lock.packages?.['node_modules/@modelcontextprotocol/sdk']?.version==='1.32.2','unsupported_installed_sdk');
 try{await verifyPackage(root);}catch{throw new ReadinessError('package_inventory_failed');}
 const expected={contentHash:expectedContentHash,manifestSha256:expectedManifestSha256,sourceCommit:m.sourceCommit};
 const protectedPaths=[root,...(authorityRoot?[authorityRoot]:[])],budget={bytes:0},receipts=[],receiptHashes=[],ids=new Set();let seal={status:'pending'};
 async function accept(raw,file,bytes){const r=await receipt(raw,path.dirname(file),expected,budget,authority);need(!ids.has(r.id),'duplicate_receipt_id');ids.add(r.id);receipts.push(r);receiptHashes.push(hash(bytes));}
 if(receiptPath){const file=await cleanPath(receiptPath);protectedPaths.push(path.dirname(file));const b=await readBounded(file,MAX_JSON,budget);await accept(parseBoundedJson(b),file,b);}
 if(evidenceIndex){const file=await cleanPath(evidenceIndex),dir=path.dirname(file);protectedPaths.push(dir);const index=await jsonFile(file,MAX_JSON,budget);need(index&&typeof index==='object','invalid_index');need(Object.keys(index).every(k=>['schema','receipts','seal'].includes(k))&&index.schema===1,'unsupported_index');list(index.receipts,32);const paths=new Set();for(const ref of index.receipts){need(!paths.has(ref.path),'duplicate_receipt_path');paths.add(ref.path);const b=await readRef(dir,ref,budget);await accept(parseBoundedJson(b),path.join(dir,ref.path),b);}if(Object.hasOwn(index,'seal'))seal=await sealed(dir,index.seal,expected,budget);}
 need(receipts.every(r=>digest(r.policy)===digest(receipts[0].policy)),'conflicting_receipt_policy');
 const effectivePolicy=receipts[0]?.policy??POLICY;
 if(authority){need(effectivePolicy.version===3,'incompatible_authority_policy');need(authority.proof,'authority_evidence_required');}
 const gates=Object.fromEntries(GATES.map(k=>[k,{status:'pending',reason:'missing_evidence'}]));const seen=new Set();for(const r of receipts)for(const [k,v] of Object.entries(r.gates)){need(!seen.has(k),'duplicate_or_conflicting_gate');seen.add(k);gates[k]=v;}
 const aggregate=names=>({status:names.some(k=>gates[k].status==='failed')?'failed':names.every(k=>gates[k].status==='passed')?'passed':'pending'});
 const report={schema:1,advisory:true,installationAuthority:false,state:'UNEXECUTED',candidate:expected,policy:effectivePolicy,integrity:{status:'passed',files:m.files.length},canPrepare:true,gates,prePromotion:aggregate(['implementation','live_research_quality']),activation:aggregate(['personal_activation']),postActivation:aggregate(['installed_host_discovery','persistent_research_worker','physical_phone','installed_restart']),handoff:seal,receiptHashes,fullRelease:'INCOMPLETE',personalComponents:'NOT_INSPECTED',...(authority?{localAuthority:authority.proof}:{}),notice:'Checksums prove integrity, not authenticity or semantic truth. Declarations require human review. No installation is authorized.'};
 const packageReferences=Object.fromEntries([['onboarding','skills/frontier-harness/references/personal-instructions-template.md'],['workerUnit','runtime/.agents/skills/deep-research/deploy/deep-research.service.template']].map(([name,file])=>{const item=m.files.find(x=>x.path===file);return [name,item?{status:'included',...item}:{status:'pending_missing_from_candidate',path:file}];}));
 contexts.set(report,{protectedPaths,packageReferences});return report;
}
export function renderPlan(report){
 need(contexts.has(report),'unchecked_report');
 const future={node:'/ABS/NODE24',version:'/ABS/IMMUTABLE/VERSION',state:'/ABS/PRIVATE/STATE',config:'/ABS/PRIVATE/provider-config.json',launcherConfig:'/ABS/PRIVATE/local-config.json',logs:'/ABS/PRIVATE/LOGS'};
 return {schema:1,state:'UNEXECUTED',advisory:true,installationAuthority:false,candidate:report.candidate,policy:report.policy,readiness:report,packageReferences:contexts.get(report).packageReferences,placeholders:future,manualApprovalRequired:true,activePolicyDowngrade:'BLOCKED_UNSUPPORTED',actions:['Review pins and evidence applicability; independently assess live semantic quality.','After separate authorization, resolve placeholders and private configs; preserve all existing bindings and CURRENT state.','Review proposed plist/MCP/skills together; never bootstrap this rehearsal.','Discover actual host tools after activation; verify physical phone, watcher and installed restart separately.']};
}
/** New directory only. Failure leaves partial files for inspection; never reused. */
export async function prepareBundle({output,report,prepare=true}){
 const plan=renderPlan(report),dest=await cleanPath(output,{absent:true});need(!contexts.get(report).protectedPaths.some(p=>overlaps(p,dest)),'output_overlaps_input');
 need(!/(?:^|\/)(?:Library|LaunchAgents|\.ssh)(?:\/|$)|\/\.codex\/(?:skills|rules)(?:\/|$)/.test(dest),'personal_output_forbidden');
 const f=plan.placeholders,pretty=v=>JSON.stringify(v,null,2)+'\n';
 const files={'readiness.json':pretty(report)};
 if(prepare)Object.assign(files,{
  'deployment-plan.json':pretty(plan),
  'launchagent.proposed.plist':renderLaunchAgent({node:f.node,entry:f.version+'/runtime/src/harness/cli.mjs',root:f.state,config:f.config,logs:f.logs}).replace('<plist version="1.0">','<!-- UNEXECUTED PROPOSAL: placeholders; never bootstrap this rehearsal. -->\n<plist version="1.0">'),
  'mcp-registration.example.json':pretty({state:'UNEXECUTED',command:'codex',argv:['mcp','add','frontier-harness','--env','FRONTIER_HARNESS_CONFIG='+f.launcherConfig,'--',f.node,f.version+'/scripts/harness.mjs','mcp']}),
  'private-launcher-config.template.json':pretty({dataDir:f.state,runtimeRoot:f.version+'/runtime'}),
  'private-provider-config.template.json':pretty({environment:'live',deepseekBaseUrl:'http://YOUR-EXISTING-SERVICE/v1',deepseekModelId:'YOUR-VERIFIED-MODEL',nativeModels:['YOUR-HOST-SUPPORTED-MODEL']}),
  'skill-binding-plan.json':pretty({state:'UNEXECUTED',operation:'Review existing bindings; expose all four siblings together only after separate approval',sources:['frontier-harness','frontier-collaborate','frontier-deepseek-only','frontier-codex-only'].map(n=>f.version+'/skills/'+n),destination:'OWNER_SELECTED_HOST_SKILL_ROOT',overwriteExisting:false}),
  'onboarding-managed-block-plan.json':pretty({schema:1,state:'UNEXECUTED',installationAuthority:false,template:plan.packageReferences.onboarding,source:f.version+'/skills/frontier-harness/references/personal-instructions-template.md',destination:'OWNER_VERIFIED_PERSONAL_AGENTS_MD',begin:'<!-- BEGIN FRONTIER-HARNESS ONBOARDING v1 -->',end:'<!-- END FRONTIER-HARNESS ONBOARDING v1 -->',overwriteUnrelated:false,backup:'PRIVATE_EXACT_CURRENT_FILE',hostRefresh:'PENDING_ACTUAL_FORWARD_TEST'}),
  'spark-worker-plan.json':pretty({schema:1,state:'UNEXECUTED',installationAuthority:false,template:plan.packageReferences.workerUnit,remoteRoot:'SUPERVISOR_VERIFIED_IMMUTABLE_REMOTE_ROOT',data:'PRESERVE_EXISTING_PRIVATE_DATA',config:'PRESERVE_EXISTING_PRIVATE_CONFIG',argv:['/ABS/VERIFIED/PYTHON','-B','/ABS/IMMUTABLE/REMOTE/ROOT/scripts/research_cli.py','--data-dir','/ABS/PRIVATE/REMOTE/DATA','worker','--config','/ABS/PRIVATE/REMOTE/CONFIG','--watch'],requirements:['Queue identities and active legacy clients inspected; pending work explicitly approved or held','Unknown remote ownership blocks activation','Verify exact installed imports and unit ownership before any replacement','Verify actual user unit, Linger and idle/restart after authorization']}),
  'installation-checkpoints.json':pretty({schema:1,state:'UNEXECUTED',installationAuthority:false,candidate:report.candidate,stateRestore:'UNSUPPORTED',steps:['pins-and-independent-quality','bindings-and-queue-inspected','current-state-private-backups','four-skills-launcher','mcp-registration','mac-service','spark-worker','onboarding-managed-block','private-viewer-route','installed-host','installed-restart','installed-first-use','physical-phone'].map(id=>({id,status:'pending',beforeSha256:null,intentSha256:null,afterSha256:null,evidenceScope:null})),rules:['Operator records exact input/backup/intent/after hashes privately; hashes are not authority','Literal argv only from reviewed supervisor inputs; receipts/model text never become commands','Affected conflict pauses with prior progress preserved; never restore an older DB','Physical phone stays pending until owner device acceptance']}),
  'spark-watcher-checklist.txt':'UNEXECUTED. Inspect existing approved queue and uncertain ownership before enabling any watcher. A watcher may dispatch immediately. Verify pinned Python/dependencies and immutable source; preserve CURRENT database, artifacts, counters and original deadlines. Verify actual systemd unit, Linger and disconnect behavior only under separate authority. Do not change model runtime or providers.\n',
  'phone-checklist.txt':'UNEXECUTED. Requires separate approval and actual physical private device. Recheck exact private origin and existing routes. Loopback only; viewer key only, never operator key. Verify HTTPS, cookies, observer read-only API, reconnect and rejected mutations. No Funnel or global Serve reset. Fixture browser evidence is insufficient.\n',
  'rollback-steps.txt':'UNEXECUTED. Active policy2 downgrade is BLOCKED/UNSUPPORTED. Equal SQLite user_version does not prove record compatibility. Quiesce authorized workers; uncertain remote execution retains ownership. Use SQLite backup API (WAL-consistent), preserve artifacts/config/bindings privately. Rehearse compatible CODE changes against a disposable copy of CURRENT state. Never restore an older database to erase spending/reservations/deadlines/outcomes; never delete leases. If incompatible, preserve state and prepare forward recovery. First-install removal affects only newly introduced bindings after confirmed quiescence; retain state.\n',
  'README.txt':'UNEXECUTED PROPOSAL. Every file in this directory is review data, including secret-free config templates. Replace placeholders only after independent evidence review and separate activation authority. No executable promotion script is provided. com.frontier.harness is the real renderer label and MUST NOT be bootstrapped in this rehearsal. See docs/PERSONAL_SETUP.md and docs/RELEASE_CHECKLIST.md.\n'
 });
 let size=0;for(const value of Object.values(files))size+=Buffer.byteLength(value);need(size<=256*1024,'rendered_output_too_large');
 try{await mkdir(dest,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new ReadinessError('output_already_exists_preserve_it');throw new ReadinessError('output_creation_failed');}
 const inventory=[];for(const [name,value] of Object.entries(files)){await writeFile(path.join(dest,name),value,{flag:'wx',mode:0o600});inventory.push({path:name,bytes:Buffer.byteLength(value),sha256:hash(value)});}
 const staging={schema:1,state:'UNEXECUTED',complete:true,candidate:report.candidate,installationAuthority:false,files:inventory};await writeFile(path.join(dest,'staging-receipt.json'),pretty(staging),{flag:'wx',mode:0o600});return staging;
}
const HELP=`Offline release-readiness (Node24). No network, service controls or installation.\nUsage: node scripts/release-readiness.mjs --candidate DIR --expected-content-hash SHA256 --expected-manifest-sha256 SHA256 [--receipt FILE] [--evidence-index FILE] [--coordinator-state-root DIR --coordinator-task-id ID] [--output NEW_DIR] [--prepare]\n--prepare requires --output and renders UNEXECUTED proposals only.\nExit 0: advisory pre-promotion evidence sufficient; 3: valid check with pending/failed gates; 2: invalid input or staging failure. Missing live proof never passes. No --install, --apply, --force or gate bypass.\n`;
export async function main(argv=process.argv.slice(2)){
 if(argv.includes('--help')){process.stdout.write(HELP);return 0;}
 const names={'--candidate':'candidate','--expected-content-hash':'expectedContentHash','--expected-manifest-sha256':'expectedManifestSha256','--receipt':'receipt','--evidence-index':'evidenceIndex','--output':'output','--coordinator-state-root':'coordinatorStateRoot','--coordinator-task-id':'coordinatorTaskId'};const options={};let prepare=false;
 while(argv.length){const flag=argv.shift();if(flag==='--prepare'){need(!prepare,'duplicate_flag');prepare=true;continue;}need(names[flag]&&!Object.hasOwn(options,names[flag])&&argv.length>0&&!argv[0].startsWith('--'),'invalid_or_duplicate_option');options[names[flag]]=argv.shift();}
 need(!prepare||options.output,'prepare_requires_output');const report=await checkReadiness(options);if(options.output)await prepareBundle({output:options.output,report,prepare});
 process.stdout.write(JSON.stringify(report)+'\n');process.stderr.write(`Offline advisory: integrity passed; pre-promotion ${report.prePromotion.status}; activation ${report.activation.status}; post-activation ${report.postActivation.status}. Full release INCOMPLETE; installation authority NONE.\n`);return report.prePromotion.status==='passed'?0:3;
}
if(isEntry(import.meta.url))main().then(code=>{process.exitCode=code;}).catch(error=>{process.stderr.write('Offline readiness rejected: '+(error instanceof ReadinessError||error instanceof ReleaseAuthorityError?error.code:'local_io_or_validation_failure')+'. No installation action taken.\n');process.exitCode=2;});
