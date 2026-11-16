import {mkdir,writeFile,readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {safePath,hash} from './prerequisites.mjs';

export function classifyConnection({before,after,result,token}){
  if(!before?.passed||!after?.passed||result?.code!==0||result.stopped||!result.quiescence?.groupESRCH||!result.quiescence?.leaderReaped)return 'inconclusive';
  const o=result.observation;
  if(o?.schema!==1||o.kind!=='connection'||typeof o.connected!=='boolean')return 'inconclusive';
  if(o.connected)return typeof token==='string'&&o.payload===token?'passed':'failed';
  return ['EPERM','EACCES'].includes(o.code)?'denied':'inconclusive';
}
export function summary(capabilities,malfunction=false){
  const passed=capabilities.length>0&&capabilities.every(c=>c.state==='passed');
  return {toolStatus:malfunction?'malfunction':'completed',m001:passed&&!malfunction?'READY':'BLOCKED',exitCode:malfunction?1:passed?0:2};
}
export async function jsonFile(file,data){
  const bytes=JSON.stringify(data,null,2)+'\n';if(Buffer.byteLength(bytes)>4*1024*1024)throw Error('Report exceeds JSON bound');
  await writeFile(file,bytes,{mode:0o600,flag:'wx'});
}
async function evidenceFiles(root,relative='evidence'){
  const result=[];for(const name of (await readdir(path.join(root,relative))).sort()){
    const rel=relative+'/'+name,file=path.join(root,rel),s=await lstat(file);
    if(s.isSymbolicLink())throw Error('Symlink evidence refused');
    if(s.isDirectory())result.push(...await evidenceFiles(root,rel));else if(s.isFile())result.push(rel);else throw Error('Nonregular evidence');
    if(result.length>1000)throw Error('Evidence file count exceeds bound');
  }return result;
}
export async function sealReport(root,data){
  await mkdir(path.join(root,'evidence'),{recursive:true,mode:0o700});
  await jsonFile(path.join(root,'report.json'),data);
  const markdown=['# Native application feasibility',`Tool: ${data.toolStatus}; M001: ${data.m001}; CLI exit: ${data.exitCode}.`,'','Installed prerequisites are distinct from execution proofs. Offline browser routing proves no running API.','',...(data.capabilities??[]).map(c=>`- ${c.id}: **${c.state}** — ${c.detail??''}`),'','Failed/uncertain runs are retained. Do not delete an unknown execution owner.','Evidence hashes bind local bytes; they are not an external signature.',''].join('\n');
  await writeFile(path.join(root,'REPORT.md'),markdown,{mode:0o600,flag:'wx'});
  const entries=[];
  for(const relative of ['report.json','REPORT.md',...await evidenceFiles(root)]){
    const bytes=await readFile(path.join(root,relative));if(bytes.length>4*1024*1024)throw Error('Evidence exceeds byte bound');entries.push({path:relative,bytes:bytes.length,sha256:hash(bytes)});
  }
  await jsonFile(path.join(root,'evidence-index.json'),{schema:1,entries});
}
export async function inspectReport(root){
  await safePath(root);
  const bounded=async relative=>{const file=path.join(root,relative);await safePath(file,{directory:false});const s=await lstat(file);if(s.size>4*1024*1024)throw Error('Inspection bytes exceed bound');return readFile(file);};
  const indexBytes=await bounded('evidence-index.json'),index=JSON.parse(indexBytes);
  if(index.schema!==1||!Array.isArray(index.entries)||index.entries.length>1002)throw Error('Invalid evidence index');
  const seen=new Set();let reportBytes;for(const entry of index.entries){
    if(typeof entry.path!=='string'||!(/^(report\.json|REPORT\.md|evidence\/[A-Za-z0-9_./-]+)$/.test(entry.path))||entry.path.split('/').some(p=>p==='..'||p==='')||seen.has(entry.path)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Unsafe evidence index entry');
    seen.add(entry.path);const bytes=await bounded(entry.path);if(bytes.length!==entry.bytes||hash(bytes)!==entry.sha256)throw Error('Evidence hash/bytes mismatch: '+entry.path);
    if(entry.path==='report.json')reportBytes=bytes;
  }
  if(!seen.has('report.json')||!seen.has('REPORT.md'))throw Error('Report is not bound');
  const report=JSON.parse(reportBytes);if(![0,1,2].includes(report.exitCode))throw Error('Invalid report exit code');
  return {verified:true,indexSha256:hash(indexBytes),report};
}
