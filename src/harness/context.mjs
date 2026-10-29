import { matches, secretPath, AttemptError } from '../project/contracts.mjs';

const MAX_PATHS=128,MAX_BYTES=512*1024;
// Only selection metadata is checkpointed. Every request reads current scoped files.
export async function selectContext(workspace,checkpoint,inventory,requested){
 const base=checkpoint.executionBase??workspace.manifest.baseCommit;
 const prior=checkpoint.workingSet?.version===1&&checkpoint.workingSet.executionBase===base?checkpoint.workingSet.entries.map(e=>e.path):checkpoint.workingSet?inventory.slice(0,2).map(f=>f.path):checkpoint.paths??inventory.slice(0,2).map(f=>f.path);
 const explicit=requested!==undefined;
 const newest=[...new Set(requested??[])];
 if(newest.length>MAX_PATHS)throw new AttemptError('Requested context exceeds 128 exact paths');
 // Validate the whole explicitly requested set first; no requested error can be evicted.
 const required=explicit?await workspace.readFiles(newest):[];
 const files=[...required],evicted=[];let full=false;
 for(const file of prior){
  if(newest.includes(file))continue;
  if(secretPath(file)||!matches(file,workspace.manifest.permissions.readPaths)){evicted.push(file);continue;}
  if(full||files.length>=MAX_PATHS){evicted.push(file);continue;}
  const [entry]=await workspace.readFiles([file]);
  if(Buffer.byteLength(JSON.stringify([...files,entry]))>MAX_BYTES){full=true;evicted.push(file);continue;}
  files.push(entry);
 }
 return {files,evicted,workingSet:{version:1,executionBase:base,entries:files.map(({path,hash})=>({path,hash}))}};
}
