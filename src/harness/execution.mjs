import path from 'node:path';
import {createHash} from 'node:crypto';
import {accessSync,statSync,realpathSync,readFileSync,constants} from 'node:fs';
import {Pause} from '../project/contracts.mjs';
import {CheckRunner} from '../project/sandbox.mjs';
import {assertDarwinSeatbeltContainment} from '../project/check-backends/darwin-seatbelt.mjs';

export function normalizeExecutionPolicy(raw){
 if(raw===undefined)return undefined;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw))||
  Object.keys(raw).some(key=>!['version','backend','backendRevision'].includes(key))||raw.version!==1||raw.backendRevision!==1||!['codex-sandbox','darwin-seatbelt'].includes(raw.backend))throw Error('Invalid execution policy: supported backend and numeric revision 1 required');
 return {version:1,backend:raw.backend,backendRevision:1};
}
export function executionFields(manifest){return manifest.executionPolicy===undefined?{}:{executionPolicy:normalizeExecutionPolicy(manifest.executionPolicy)};}
export function executionIdentity(manifest){return normalizeExecutionPolicy(manifest.executionPolicy)??{version:1,backend:'codex-sandbox',backendRevision:1};}
export function sameExecutionBackend(a,b){const x=executionIdentity(a),y=executionIdentity(b);return x.backend===y.backend&&x.backendRevision===y.backendRevision;}
export function assertExecutionAvailable(manifest,{codexPath='codex'}={}){
 const policy=normalizeExecutionPolicy(manifest.executionPolicy);
 // Native revision 1 has no safe arbitrary-process containment. This gate is
 // independent of fixtures or executable identity and cannot enable execution.
 if(policy?.backend==='darwin-seatbelt')assertDarwinSeatbeltContainment();
 if(policy){if(typeof codexPath!=='string'||!codexPath||/[\0\r\n]/.test(codexPath))throw new Pause('Invalid approved Codex sandbox executable','isolation');const candidates=codexPath.includes('/')?[codexPath]:(process.env.PATH??'').split(path.delimiter).map(dir=>path.join(dir,codexPath));if(!candidates.some(file=>{try{const resolved=realpathSync(file);accessSync(resolved,constants.X_OK);return statSync(resolved).isFile();}catch{return false;}}))throw new Pause('Approved codex-sandbox revision 1 prerequisite missing: Codex sandbox executable unavailable','isolation');}
}
export function approvedChecks(workspace,{checksFactory,config={}}={}){
 const policy=executionIdentity(workspace.manifest);
 assertExecutionAvailable(workspace.manifest,config);
 const options={codex:config.codexPath??'codex',backend:policy.backend};
 const runner=checksFactory?.(workspace,options)??new CheckRunner(workspace,options);
 if(workspace.manifest.executionPolicy){const identity=runner.backendIdentity;if(identity?.id!==policy.backend||identity.revision!==policy.backendRevision)throw new Pause('Check runner identity differs from the approved execution backend','isolation');}
 return runner;
}
function configuredRuntime(codexPath){
 // Historical callers supplied executable configuration only to their runner.
 // Preserve that fallback without guessing a prior executable from a goal pin.
 if(codexPath===undefined)return null;
 if(typeof codexPath!=='string'||!codexPath||/[\0\r\n]/.test(codexPath))throw Error('Invalid trusted execution runtime configuration');
 const candidates=codexPath.includes('/')?[codexPath]:(process.env.PATH??'').split(path.delimiter).map(dir=>path.join(dir,codexPath));
 for(const file of candidates){try{const executable=realpathSync(file);accessSync(executable,constants.X_OK);if(statSync(executable).isFile())return {executable,sha256:createHash('sha256').update(readFileSync(executable)).digest('hex')};}catch{}}
 return {unavailable:true,selector:codexPath};
}
export function assertExecutionConfiguration(c){
 const identity={defaultBackend:executionIdentity({executionPolicy:c.executionPolicy}),runtime:configuredRuntime(c.executionConfig.codexPath)},hash=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
 const previous=c.store.maybe('execution_configuration','coordinator');
 if(previous&&(previous.schema!==1||typeof previous.hash!=='string'))throw Error('Invalid saved execution configuration identity');
 const held=goal=>['draft','active','paused'].includes(goal.status)||c.store.all('task').some(task=>task.goalId===goal.id&&(task.owner||task.native?.writerActive||['running','uncertain','taking_over','codex_active','legacy_reviewing','awaiting_review','ready_to_integrate'].includes(task.status)))||goal.integrationOwner||goal.integrationPending||['running','uncertain'].includes(c.store.maybe('planning',goal.id)?.status)||c.store.all('goal_revision').some(revision=>revision.goalId===goal.id&&revision.status==='draft'&&revision.previousHash===goal.hash&&!['completed','partial'].includes(goal.status));
 // Configuration is a service default/runtime identity, independent of each
 // goal's immutable explicit override. Never rebind saved approvals/evidence.
 if(previous&&previous.hash!==hash&&c.store.all('goal').some(held))throw Error('Execution backend settings or runtime changed with prepared, active or unfinished work; retain the trusted configuration until resolved');
 if(!previous||previous.hash!==hash)c.store.put('execution_configuration',{id:'coordinator',schema:1,identity,hash});
}
