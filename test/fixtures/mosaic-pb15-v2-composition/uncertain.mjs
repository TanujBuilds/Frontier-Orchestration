import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,appendFile,access} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {buildFixtureArtifact} from './artifact.mjs';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Goals} from '../../../src/harness/goals.mjs';
import {approvedChecks} from '../../../src/harness/execution.mjs';
import {capacitySnapshot} from '../../../src/harness/scheduling/capacity.mjs';
import {Journal} from '../../../src/project/journal.mjs';
import {Workspace} from '../../../src/project/workspace.mjs';
import {git} from '../../../src/project/process.mjs';

const root=process.argv[2];await mkdir(root,{mode:0o700});
const artifact=await buildFixtureArtifact(root),config={nativeCheckRuntime:artifact.config},state=path.join(root,'state'),repo=path.join(root,'repo');
let c,lease='owned-native-loss';
try{
 await mkdir(path.join(repo,'src'),{recursive:true});await mkdir(path.join(repo,'checks'));
 await writeFile(path.join(repo,'src/value.mjs'),'export const value=0;\n');
 // This owned check has no descendants and exits on its own even if its helper
 // is lost. No liveness observation is used as authority to release its hold.
 await writeFile(path.join(repo,'checks/bounded.mjs'),"import fs from 'node:fs';fs.writeFileSync('dist/ready','ready');setTimeout(()=>process.exit(0),1500);\n");
 await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Base');
 const options={root:state,nativeCheckRuntime:artifact.config,executionPolicy:artifact.policy};
 c=new Coordinator(options);c.acquireWorker(lease);
 const goal=c.prepareGoal({submissionId:'lost-supervisor',objective:'Retain unknown native ownership across restart',acceptance:['No duplicate launch or capacity release'],mode:'deepseek_only',environment:'fixture',executionPolicy:artifact.policy,project:{repo,baseCommit:await git(repo,'rev-parse','HEAD'),readPaths:['src/','checks/'],writePaths:['src/'],checks:[{id:'bounded',argv:[path.join(artifact.root,'node'),'checks/bounded.mjs'],timeoutMs:5000}]}},'prepare');
 await c.preflightExecution({goalId:goal.id,hash:goal.hash},{config});c.activateGoal({goalId:goal.id,hash:goal.hash},'activate');
 const task=c.submitTask({goalId:goal.id,submissionId:'bounded',kind:'coding',objective:'Bounded actual native check',acceptance:['Hold on helper loss']},'task');
 assert.equal(c.claimNext(lease).id,task.id);
 const journal=await new Journal(path.join(root,'checks'),randomUUID()).load(),permissions=c.getGoal(goal.id).manifest.project;
 const workspace=new Workspace({...artifact.policy,executionPolicy:artifact.policy,repo,baseCommit:permissions.baseCommit,permissions},journal);await workspace.initialize();
 const runner=approvedChecks(workspace,{config,context:{c,goalId:goal.id,taskId:task.id,operationKey:'uncertain-real-check'}});
 await runner.verify();
 const checking=runner.run(permissions.checks,'owned-helper-loss');checking.catch(()=>{});
 const marker=path.join(workspace.root,'dist/ready');let row;
 for(let n=0;n<200;n++){
  try{await access(marker);row=c.store.all('execution_owner').find(owner=>owner.taskId===task.id&&owner.status==='running');if(row)break;}catch{}
  await delay(20);
 }
 assert.ok(row,'Actual owned helper and child must start before loss');
 process.kill(row.helperPid,'SIGKILL');
 await assert.rejects(checking,error=>error.executionOutcome==='unknown');
 const held=c.store.get('execution_owner',row.id);assert.equal(held.status,'uncertain');assert.equal(c.getTask(task.id).status,'uncertain');assert.equal(c.getTask(task.id).owner,lease);
 const original={goal:c.getGoal(goal.id),task:c.getTask(task.id),requests:c.store.requestOutcomes(task.id),owner:held,owners:c.store.all('execution_owner').length};
 c.failTaskStep(task.id,lease,'Ordinary error must retain native hold');assert.equal(c.getTask(task.id).owner,lease);
 assert.ok(capacitySnapshot(c).executionOwners.some(owner=>owner.id===row.id));
 assert.throws(()=>new Goals(c).finalize({goalId:goal.id,summary:'Cannot accept an unknown check',partial:true},'finalize'),/unfinished|execution|quiescen/i);
 c.releaseWorker(lease);c.close();c=null;
 const helper=path.join(artifact.root,'mosaic-check-supervisor'),bytes=await readFile(helper);await appendFile(helper,'drift');
 assert.throws(()=>new Coordinator(options),/artifact|runtime|bytes|changed/i);await writeFile(helper,bytes);
 c=new Coordinator(options);lease='restart-native-loss';c.acquireWorker(lease);
 const revision=c.store.revision();c.executionOwnership.reconcile({force:true});c.executionOwnership.reconcile({force:true});assert.equal(c.store.revision(),revision);
 assert.equal(c.store.get('execution_owner',row.id).status,'uncertain');assert.equal(c.store.all('execution_owner').length,original.owners);
 assert.deepEqual(c.store.requestOutcomes(task.id),original.requests);
 for(const field of ['providerBinding','route','routeHash','checkpoint','spent','deadline','hash','goalVersion','attempts'])assert.deepEqual(c.getTask(task.id)[field],original.task[field]);
 assert.equal(c.getGoal(goal.id).hash,original.goal.hash);assert.equal(c.getGoal(goal.id).deadline,original.goal.deadline);
 assert.throws(()=>c.recoverSaved(task.id,lease),/held|execution|quiescen/i);
 assert.throws(()=>c.control({goalId:goal.id,action:'resume'},'resume'),/held|execution|quiescen/i);
 assert.ok(capacitySnapshot(c).executionOwners.some(owner=>owner.id===row.id));
 console.log(JSON.stringify({actualFactory:true,supervisorLost:true,heldAfterRestart:true,noDuplicateLaunch:true,noAdditionalRequests:true,changedHelperRejected:true,ownerId:row.id,status:'uncertain',heldOwner:c.store.get('execution_owner',row.id),retainedTask:c.getTask(task.id),runtimeFingerprint:artifact.fingerprint}));
}finally{if(c){try{c.releaseWorker(lease);}catch{}c.close();}}
