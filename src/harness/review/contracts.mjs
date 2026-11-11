import {keys,text,integer,digest} from '../contracts.mjs';
import {profileIdentity} from '../providers/contracts.mjs';
import {relativePath,secretPath,matches} from '../../project/contracts.mjs';

export const HOST_IDS=Object.freeze(['codex','claude-code','cursor','antigravity']);
export const bindingFields=Object.freeze(['goalId','goalVersion','goalHash','taskId','candidateHash','checksHash','rubricHash','reviewPolicyHash','generation','expiresAt']);
export function normalizeReviewPolicy(raw){
 if(raw===undefined)return undefined;
 keys(raw,['version','source','hostId','reviewer','fallback'],'review policy');
 if(raw.version!==1||!['host','api'].includes(raw.source)||raw.fallback!=='wait')throw Error('Invalid review policy');
 if(raw.source==='host'){
  if(!HOST_IDS.includes(raw.hostId)||Object.hasOwn(raw,'reviewer'))throw Error('Invalid host review policy');
  return {version:1,source:'host',hostId:raw.hostId,fallback:'wait'};
 }
 if(Object.hasOwn(raw,'hostId')||!raw.reviewer)throw Error('Invalid API review policy');
 const reviewer=profileIdentity(raw.reviewer);
 if(!reviewer.roles.includes('reviewer')||reviewer.streaming||!reviewer.capabilities.transports.includes('json'))throw Error('Reviewer requires nonstreaming JSON capability');
 return {version:1,source:'api',reviewer,fallback:'wait'};
}
export function assertReviewMode(mode,policy){
 if(!policy)return;
 if(!['collaborative','codex_only','overnight_review'].includes(mode.id)||mode.id==='codex_only'&&policy.source!=='host')throw Error('Mode prohibits selected review policy');
}
export function normalizeVerdict(raw,{writePaths,readPaths}={}){
 keys(raw,['decision','feedback','findings'],'review verdict');
 if(!['accept','revise'].includes(raw.decision))throw Error('Invalid review decision');
 text(raw.feedback,'review feedback',16384);
 if(Buffer.byteLength(raw.feedback)>16384)throw Error('Review feedback exceeds 16 KiB');
 if(!Array.isArray(raw.findings)||raw.findings.length>50)throw Error('Invalid review findings');
 const findings=raw.findings.map(f=>{
  keys(f,['path','line','message'],'review finding');relativePath(f.path);
  if(secretPath(f.path)||(readPaths||writePaths)&&!matches(f.path,[...(readPaths??[]),...(writePaths??[])]))throw Error('Review finding path outside approved scope');
  text(f.message,'review finding message',2000);if(Buffer.byteLength(f.message)>4000)throw Error('Review finding message too large');
  if(Object.hasOwn(f,'line'))integer(f.line,'finding line',1,Number.MAX_SAFE_INTEGER);
  return {path:f.path,...(Object.hasOwn(f,'line')?{line:f.line}:{}),message:f.message};
 });
 return {decision:raw.decision,feedback:raw.feedback,findings};
}
export function assertBinding(input,expected){
 for(const field of bindingFields){if(input[field]!==expected[field])throw Error('Stale review binding: '+field);}
}
export function reviewerIdentity(policy){return policy.source==='host'?{source:'host',hostId:policy.hostId,model:null,provenance:'unknown',usage:null}:{source:'api',providerId:policy.reviewer.id,revision:policy.reviewer.revision,requestedModel:policy.reviewer.model,reportedModel:null,profileHash:digest(policy.reviewer)};}
