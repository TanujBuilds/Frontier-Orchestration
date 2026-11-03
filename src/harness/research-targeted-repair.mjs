// Mechanical reconstruction only. Local acknowledged review remains authority.
import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {canonical,digest} from './contracts.mjs';
import {verifyDescriptor} from './research-review.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const need=(ok,msg)=>{if(!ok)throw Error('Targeted repair: '+msg);};
const closed=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const same=(a,b)=>a!==undefined&&b!==undefined&&digest(a)===digest(b);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const length=x=>[...x].length;
const fields=['title','complete','claims','summary','comparisons','recommendations','contradictions','unanswered'];
const sections=fields.slice(3);
const sorted=xs=>[...xs].sort();
function unitMap(r){
 need(closed(r,fields)&&Array.isArray(r.claims),'closed report');const out=new Map([['title',r.title]]);
 for(const c of r.claims){need(closed(c,['id','kind','text','evidence'])&&typeof c.id==='string'&&/^C[0-9]{1,4}$/.test(c.id)&&!out.has('claims:'+c.id),'claim unit');out.set('claims:'+c.id,c);}
 for(const s of sections){need(Array.isArray(r[s]),'section');r[s].forEach((v,i)=>out.set(s+':'+i,v));}return out;
}
function validateReport(r,sources){
 const u=unitMap(r),ids=new Set(r.claims.map(c=>c.id));
 need(typeof r.title==='string'&&length(r.title)>=1&&length(r.title)<=300&&typeof r.complete==='boolean'&&r.claims.length<=100,'report bounds');
 for(const c of r.claims){need(typeof c.text==='string'&&length(c.text)>=1&&length(c.text)<=6000&&['fact','vendor_claim','inference','unknown'].includes(c.kind)&&Array.isArray(c.evidence)&&c.evidence.length<=10&&(c.kind==='unknown'||c.evidence.length),'claim shape');
  for(const e of c.evidence)need(closed(e,['source_id','quote','selection'])&&typeof e.quote==='string'&&length(e.quote)>=12&&length(e.quote)<=1000&&typeof sources[e.source_id]?.text==='string'&&sources[e.source_id].text.includes(e.quote),'claim quote');
 }
 need(r.summary.length<=30&&r.summary.every(x=>typeof x==='string'&&ids.has(x)),'summary');
 for(const section of ['comparisons','recommendations','contradictions'])need(r[section].length<=30&&r[section].every(x=>closed(x,['text','claim_ids'])&&typeof x.text==='string'&&length(x.text)>=1&&length(x.text)<=6000&&Array.isArray(x.claim_ids)&&x.claim_ids.length&&x.claim_ids.every(id=>typeof id==='string'&&ids.has(id))),'synthesis');
 need(r.unanswered.length<=50&&r.unanswered.every(x=>typeof x==='string'&&length(x)<=3000)&&(!r.complete||r.claims.some(c=>c.evidence.length)),'report gaps/evidence');return u;
}
function selector(row){return {source_id:row.source_id,text_sha256:row.text_sha256,start:row.start,end:row.end};}
function catalog(rows,sources){
 need(Array.isArray(rows)&&rows.length<=96,'request offers bound');const seen=new Set();
 for(const row of rows){need(closed(row,['source_id','text_sha256','start','end','text'])||closed(row,['source_id','text_sha256','start','end','text','catalog_version','complete_unit']),'offer fields');
  const {source_id:sid,text_sha256:h,start,end}=row,text=sources[sid]?.text;
  need(typeof sid==='string'&&typeof text==='string'&&hash(h)&&sha(text)===h&&Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<end&&end<=length(text)&&end-start>=12&&end-start<=1000&&row.text===[...text].slice(start,end).join(''),'offer source/range');
  if(Object.hasOwn(row,'catalog_version'))need(row.catalog_version===2&&typeof row.complete_unit==='boolean','offer version');
  const key=canonical(selector(row));need(!seen.has(key),'duplicate offer');seen.add(key);
 }return rows;
}
function unionOffers(a,b,sources){
 const m=new Map();for(const rows of [a,b])for(const row of catalog(rows,sources)){const k=canonical(selector(row));need(!m.has(k)||same(m.get(k),row),'conflicting selector');m.set(k,row);}
 const rows=[...m.values()];need(rows.length<=192,'union bound');return rows.sort((a,b)=>{for(const k of ['source_id','text_sha256','start','end']){if(a[k]<b[k])return -1;if(a[k]>b[k])return 1;}return 0;});
}
function resolveClaim(c,offers,sources,raw){
 need(closed(c,['id','kind','text','evidence'])&&Array.isArray(c.evidence)&&c.evidence.length<=10,'replacement claim fields');
 return {...c,evidence:c.evidence.map(e=>{
  if(raw)need(closed(e,['source_id','text_sha256','start','end']),'raw selectors only');
  else need(closed(e,['source_id','quote','selection'])&&closed(e.selection,['text_sha256','start','end']),'retained canonical selection');
  const s=raw?e:{source_id:e.source_id,...e.selection};
  const matches=offers.filter(o=>same(selector(o),s));need(matches.length===1,'selector not uniquely offered');
  const row=matches[0],text=sources[s.source_id]?.text;need(typeof text==='string'&&sha(text)===s.text_sha256,'selector source');
  const quote=[...text].slice(s.start,s.end).join('');need(quote===row.text&&(raw||e.quote===quote),'selection quote');
  return {source_id:s.source_id,quote,selection:{text_sha256:s.text_sha256,start:s.start,end:s.end}};
 })};
}
export function buildTargetedPlan(base,submission,ticketId){
 need(closed(base,['descriptor','canonical']),'base packet');const d=verifyDescriptor(base.descriptor),c=base.canonical;
 need(d.version===1&&closed(c,['report','sources','offers'])&&Buffer.byteLength(c.report)<=131072,'base bound/version');
 for(const k of ['report','sources','offers'])need(typeof c[k]==='string'&&sha(c[k])===d[k+'Sha256'],'base canonical hash');
 const r=JSON.parse(c.report),sources=JSON.parse(c.sources),offers=catalog(JSON.parse(c.offers),sources),u=validateReport(r,sources);
 need(same([...u.keys()],d.units),'base units');for(const claim of r.claims)need(same(resolveClaim(claim,offers,sources,false),claim),'base provenance');
 need(closed(submission,['ticketId','candidateHash','rubricSha256','decision','findings','coverage','key'])&&submission.ticketId===ticketId&&typeof ticketId==='string'&&length(ticketId)>=1&&length(ticketId)<=200&&submission.decision==='revise'&&submission.candidateHash===d.candidateHash&&submission.rubricSha256===d.rubricSha256&&typeof submission.key==='string'&&length(submission.key)>=1&&length(submission.key)<=200,'bound revise');
 need(Array.isArray(submission.coverage)&&new Set(submission.coverage).size===submission.coverage.length&&submission.coverage.every(x=>u.has(x))&&Array.isArray(submission.findings)&&submission.findings.length>=1&&submission.findings.length<=50,'revise coverage/findings');
 const required=new Set(),summaries=new Map(),edges=new Map();
 for(const f of submission.findings){need(closed(f,['unit','code','message','evidence'])&&u.has(f.unit)&&['missing_context','cross_alternative_attribution','unsupported_premise','lost_condition','unsupported_claim','material_omission','contradiction','other'].includes(f.code)&&typeof f.message==='string'&&length(f.message)>=1&&length(f.message)<=2000&&Array.isArray(f.evidence)&&f.evidence.length<=10&&f.evidence.every(e=>offers.some(o=>same(selector(o),e))),'plan finding');if(f.unit.startsWith('summary:'))summaries.set(f.unit,u.get(f.unit));else required.add(f.unit);}
 for(const [name,value]of u){const refs=name.startsWith('summary:')?[value]:['comparisons','recommendations','contradictions'].includes(name.split(':')[0])?value.claim_ids:[];for(const ref of refs){const e={from:'claims:'+ref,to:name};edges.set(canonical(e),e);}}
 const edgeList=[...edges.values()].sort((a,b)=>a.from<b.from?-1:a.from>b.from?1:a.to<b.to?-1:a.to>b.to?1:0),targets=new Set([...required,...summaries.keys(),...[...summaries.values()].map(c=>'claims:'+c)]),affected=new Set(targets);
 for(const e of edgeList)if(targets.has(e.from))affected.add(e.to);need(affected.size<=250,'required closure bound');
 return {version:1,baseCandidateHash:d.candidateHash,baseDescriptorSha256:digest(d),baseReportSha256:d.reportSha256,sourcesSha256:d.sourcesSha256,offersSha256:d.offersSha256,rubricSha256:d.rubricSha256,review:{ticketId,submission},units:[...u].map(([unit,value])=>({unit,beforeSha256:digest(value)})),required:sorted(required),summaries:sorted(summaries.keys()).map(unit=>({unit,claim:summaries.get(unit)})),edges:edgeList,affected:sorted(affected)};
}
function localRevise(task,base,plan){
 const ticket=task.researchReviewTickets?.find(t=>t.id===plan.review.ticketId),i=ticket?.submissionIntent,d=base.descriptor;
 need(ticket&&i?.state==='acknowledged'&&same(ticket.descriptor,d)&&same(i.descriptor,d)&&i.input?.decision==='revise'&&i.input.action==='submit'&&i.input.taskId===task.id&&i.input.ticketId===ticket.id&&i.input.candidateHash===d.candidateHash&&i.input.rubricHash===d.rubricSha256,'missing local acknowledged A revise');
 need(ticket.goalId===task.goalId&&ticket.taskId===task.id&&ticket.jobId===d.jobId&&ticket.manifestHash===d.manifestHash&&i.goalId===task.goalId&&i.taskId===task.id&&i.jobId===d.jobId&&i.manifestHash===d.manifestHash&&i.ticketId===ticket.id&&i.nativeReservationId===ticket.nativeReservationId&&ticket.submissionHash===i.inputHash&&i.inputHash===digest({input:i.input,key:i.submissionKey})&&Number.isFinite(i.intentAt)&&Number.isFinite(i.acknowledgedAt)&&i.intentAt<=i.acknowledgedAt&&i.acknowledgedAt<task.deadline,'local revise identity/time');
 const ack={jobId:d.jobId,ticketId:ticket.id,decision:'revise',candidateHash:d.candidateHash,status:'queued'};need(same(i.acknowledgment,ack)&&same(ticket.submissionResult,ack),'local revise acknowledgment');
 const sub={ticketId:ticket.id,candidateHash:d.candidateHash,rubricSha256:d.rubricSha256,decision:'revise',findings:i.input.findings,coverage:i.input.coverage,key:i.submissionKey};need(same(plan.review.submission,sub),'remote revise differs from local');return ticket;
}
export function verifyTargetedRepair(packet,task){
 const d=packet.descriptor,b=packet.repair;
 need(task.spec.researchPolicy?.correctionStrategy==='targeted_v1'&&task.spec.researchPolicy.version===3&&task.spec.researchPolicy.repairContextVersion===1&&d.version===2,'policy isolation');
 need(closed(b,['version','base','plan','patch','correctionOffers','receipt'])&&b.version===1&&Buffer.byteLength(canonical(b))<=262144&&closed(b.base,['descriptor','report','offers']),'bundle shape/bound');
 const base={descriptor:b.base.descriptor,canonical:{report:b.base.report,sources:packet.canonical.sources,offers:b.base.offers}},plan=buildTargetedPlan(base,b.plan.review.submission,b.plan.review.ticketId);
 need(same(plan,b.plan),'derived plan mismatch');localRevise(task,base,plan);
 const r=JSON.parse(base.canonical.report),sources=JSON.parse(packet.canonical.sources),aOffers=JSON.parse(base.canonical.offers),correction=JSON.parse(b.correctionOffers),u=unitMap(r),patch=b.patch;
 need(typeof b.correctionOffers==='string'&&canonical(correction)===b.correctionOffers,'canonical correction offers');
 need(closed(patch,['action','base_candidate_hash','plan_sha256','replacements','checked_units','cannot_repair'])&&patch.action==='repair'&&patch.base_candidate_hash===plan.baseCandidateHash&&patch.plan_sha256===digest(plan)&&Array.isArray(patch.replacements)&&Array.isArray(patch.checked_units)&&Array.isArray(patch.cannot_repair)&&!patch.cannot_repair.length&&length(canonical(patch))<=150000,'patch shape/binding');
 const replacements=new Map(),checks=new Map(),names=new Set();
 for(const [rows,ks,map]of [[patch.replacements,['unit','before_sha256','value'],replacements],[patch.checked_units,['unit','before_sha256'],checks]])for(const row of rows){need(closed(row,ks)&&typeof row.unit==='string'&&plan.affected.includes(row.unit)&&!names.has(row.unit)&&hash(row.before_sha256)&&u.has(row.unit)&&row.before_sha256===digest(u.get(row.unit)),'unit/hash/closure');map.set(row.unit,row);names.add(row.unit);}
 need(names.size<=250&&plan.required.every(x=>replacements.has(x)),'required replacement missing');
 const union=unionOffers(aOffers,correction,sources),out=structuredClone(r),newUnits=new Map(u),ids=new Set(r.claims.map(c=>c.id));
 for(const [name,row]of replacements){let value=structuredClone(row.value);const [section,index]=name.split(':');
  if(section==='claims'){need(value.id===u.get(name).id,'changed claim ID');value=resolveClaim(value,correction,sources,true);}
  else if(['comparisons','recommendations','contradictions'].includes(section))need(closed(value,['text','claim_ids']),'synthesis fields');
  else if(section==='summary')need(typeof value==='string'&&ids.has(value),'summary reference');
  else need((section==='title'||section==='unanswered')&&typeof value==='string','text value');
  need(!same(value,u.get(name)),'canonical no-op');newUnits.set(name,value);
  if(section==='title')out.title=value;else if(section==='claims')out.claims[out.claims.findIndex(c=>c.id===value.id)]=value;else out[section][Number(index)]=value;
 }
 need(plan.summaries.every(s=>replacements.has(s.unit)||replacements.has('claims:'+s.claim)),'failed summary missing');
 need(plan.edges.filter(e=>e.from.startsWith('claims:')&&replacements.has(e.from)).every(e=>names.has(e.to)),'dependent check missing');
 validateReport(out,sources);need(same([...unitMap(out).keys()],[...u.keys()])&&out.complete===r.complete,'report identity');
 const request=d.request;need(request.offersSha256===digest(correction),'correction request offers');
 const receipt={version:1,baseCandidateHash:plan.baseCandidateHash,planSha256:digest(plan),patchSha256:digest(patch),request,reportSha256:digest(out),sourcesSha256:digest(sources),offersSha256:digest(union),retained:sorted([...u.keys()].filter(x=>!replacements.has(x))).map(unit=>({unit,sha256:digest(u.get(unit))})),changed:sorted(replacements.keys()).map(unit=>({unit,beforeSha256:digest(u.get(unit)),afterSha256:digest(newUnits.get(unit))})),rechecked:sorted(checks.keys()).map(unit=>({unit,beforeSha256:digest(u.get(unit))}))};
 need(same(receipt,b.receipt),'assembly receipt mismatch');
 need(packet.canonical.report===canonical(out)&&packet.canonical.sources===canonical(sources)&&packet.canonical.offers===canonical(union)&&d.reportSha256===receipt.reportSha256&&d.sourcesSha256===receipt.sourcesSha256&&d.offersSha256===receipt.offersSha256,'assembled canonical bytes mismatch');
 need(same(d.assembly,{version:1,baseCandidateHash:plan.baseCandidateHash,planSha256:digest(plan),patchSha256:digest(patch),receiptSha256:digest(receipt),bundleSha256:digest(b)}),'descriptor assembly mismatch');return b;
}
// Generated allowlisted artifact, never a caller/SQLite supplied path.
export async function readTargetedProof(stateRoot,task){
 const d=task.checkpoint.reviewCandidate,ref=task.checkpoint.targetedProof;
 need(d?.version===2&&hash(d.candidateHash)&&closed(ref,['candidateHash','sha256'])&&ref.candidateHash===d.candidateHash&&hash(ref.sha256)&&/^[a-zA-Z0-9_-]{1,100}$/.test(task.id),'local proof reference');
 let target=stateRoot;for(const part of ['research-proposals',task.id]){target=path.join(target,part);const st=await lstat(target);need(st.isDirectory()&&!st.isSymbolicLink(),'unsafe proof directory');}
 target=path.join(target,d.candidateHash+'.json');const st=await lstat(target);need(st.isFile()&&!st.isSymbolicLink()&&st.size<=32*1024*1024,'missing/unsafe/oversize proof');const bytes=await readFile(target);need(sha(bytes)===ref.sha256,'local proof hash');const packet=JSON.parse(bytes);need(same(packet.descriptor,d),'local proof descriptor');verifyTargetedRepair(packet,task);return packet;
}
