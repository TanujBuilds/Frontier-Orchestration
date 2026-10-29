import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/harness/store.mjs';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {digest} from '../src/harness/contracts.mjs';
import * as v from '../src/harness/collaboration-contracts.mjs';

test('shared v1 fixture examples normalize without drift',()=>{const f=JSON.parse(readFileSync(new URL('./fixtures/collaboration/v1.json',import.meta.url),'utf8'));for(const [key,fn]of [['registration',v.normalizeAgentRegistration],['progress',v.normalizeProgressReport],['observer',v.normalizeObserverQuery],['activity',v.normalizeActivityEvent]])assert.deepEqual(fn(f[key]),f[key]);});

const registration={version:1,taskId:'task-1',actor:'codex',role:'implementer',hostAgentId:'host/child-1',model:{requested:null,resolved:null}};
test('registration and model metadata are copied, bounded and cannot create execution authority',()=>{
 const raw=structuredClone(registration),saved=v.normalizeAgentRegistration(raw);assert.deepEqual(saved,registration);raw.model.resolved='changed';assert.equal(saved.model.resolved,null);
 assert.deepEqual(v.normalizeModelSelection({}),{requested:null,resolved:null});
 for(const x of [{...registration,version:2},{...registration,command:'run'},{...registration,role:'integrator'},{...registration,actor:'cloud'},{...registration,taskId:'../outside'},{...registration,model:{requested:'',resolved:null}},{...registration,model:{requested:null,resolved:null,provider:'other'}}])assert.throws(()=>v.normalizeAgentRegistration(x));
});
test('version, actor and role are explicit and host correlations are bounded',()=>{
 for(const field of ['version','actor','role']){const x={...registration};delete x[field];assert.throws(()=>v.normalizeAgentRegistration(x));}
 assert.throws(()=>v.normalizeAgentRegistration({...registration,version:null}));assert.throws(()=>v.normalizeAgentRegistration({...registration,hostAgentId:'h'.repeat(121)}));
 for(const fn of [v.normalizeProgressReport,v.normalizeNativeCandidate,v.normalizeHelpRequest,v.normalizeActivityEvent])assert.throws(()=>fn({version:null}));
});

test('progress is reported bounded data, not a stopped-worker certificate',()=>{
 const result=v.normalizeProgressReport({version:1,agentId:'agent-1',status:'stopped',summary:'Host reports stopping',evidenceIds:['artifact-1']});assert.equal(result.status,'stopped');assert.equal(result.quiescent,undefined);
 for(const x of [{...result,quiescent:true},{...result,status:'integrated'},{...result,summary:'x'.repeat(2001)},{...result,evidenceIds:['/etc/passwd']}])assert.throws(()=>v.normalizeProgressReport(x));
});
test('candidate metadata fixes base identity and does not confer check authority',()=>{
 const x={version:1,taskId:'t-1',baseCommit:'a'.repeat(40),worktree:path.resolve('/tmp/candidate'),commit:null,status:'active',checks:[]};assert.deepEqual(v.normalizeNativeCandidate(x),x);
 for(const y of [{...x,baseCommit:'HEAD'},{...x,worktree:'relative'},{...x,status:'accepted'},{...x,checks:[{value:Infinity}]},{...x,permission:'all'}])assert.throws(()=>v.normalizeNativeCandidate(y));
});
test('help links correlate approved tasks and cannot contain a new assignment or executable action',()=>{
 const x={version:1,taskId:'parent',questionId:'question',helperTaskId:'helper',reason:'Needs a tested helper'};assert.deepEqual(v.normalizeHelpRequest(x),x);
 assert.throws(()=>v.normalizeHelpRequest({...x,command:'launch'}));assert.throws(()=>v.normalizeHelpRequest({...x,helperTaskId:'../other'}));
});
test('observer queries enforce exact page and evidence bounds',()=>{
 assert.deepEqual(v.normalizeObserverQuery({}),{goalId:null,actor:null,after:0,limit:50});assert.equal(v.normalizeObserverQuery({limit:200}).limit,200);assert.equal(v.OBSERVER_LIMITS.evidenceBytes,32768);
 for(const x of [{limit:201},{after:-1},{after:Infinity},{actor:'unknown'},{goalId:'../outside'},{path:'/etc/passwd'},{limit:1.5}])assert.throws(()=>v.normalizeObserverQuery(x));
});
test('normalized activity distinguishes captured, reported and coordinator evidence',()=>{
 const x={version:1,seq:1,at:0,goalId:'goal',taskId:'task',agentId:null,requestId:'request',type:'coding.read',actor:'deepseek',provenance:'captured',summary:'Read source',artifactIds:[]};assert.deepEqual(v.normalizeActivityEvent(x),x);
 for(const y of [{...x,provenance:'private-thought'},{...x,seq:NaN},{...x,artifactIds:['../../secret']},{...x,summary:'x'.repeat(2001)}])assert.throws(()=>v.normalizeActivityEvent(y));
});
test('generic additive records preserve legacy native ownership, receipts, approvals and spending through restart',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'collaboration-compat-'));let c=new Coordinator({root});try{
 const g=c.prepareGoal({submissionId:'legacy',objective:'Preserve state',acceptance:['Same state'],environment:'fixture'},'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const pending=c.submitTask({goalId:g.id,submissionId:'spent',kind:'consult',objective:'Saved evidence',acceptance:['Preserved']},'spent-submit');c.claimNext('owner');const request=c.reserve(pending.id,{key:'request-1',kind:'model'},'owner');c.saveRequest(request.id,{content:'saved'});
 const record={id:'legacy-task',goalId:g.id,status:'codex_active',native:{worktree:'/private/tmp/legacy',startSnapshot:{a:'hash'}},deadline:123,attempts:4,reviews:1,checkpoint:{phase:'checks'}};c.store.put('task',record);
 const goal=c.store.get('goal',g.id);goal.integrationOwner=record.id;c.store.put('goal',goal);c.store.put('agent',{id:'agent-v1',...registration});const before=digest({goal,record});
 c.close();c=new Coordinator({root});assert.equal(digest({goal:c.store.get('goal',g.id),record:c.store.get('task',record.id)}),before);assert.equal(c.getTask(pending.id).spent.model,1);assert.equal(c.store.request(pending.id,'request-1').result.content,'saved');assert.equal(c.store.get('task',record.id).native.layout,undefined);assert.equal(c.store.get('goal',g.id).integrationOwner,record.id);
 const sealed={...c.store.get('goal',g.id),integrationSealed:{snapshotHash:'saved'}};c.store.put('goal',sealed);c.close();c=new Coordinator({root});assert.deepEqual(c.store.get('goal',g.id).integrationSealed,{snapshotHash:'saved'});
 let calls=0;assert.deepEqual(c.store.command('same',{x:1},()=>{calls++;return {ok:true};}),{ok:true});assert.deepEqual(c.store.command('same',{x:1},()=>{calls++;return {ok:false};}),{ok:true});assert.equal(calls,1);assert.throws(()=>c.store.command('same',{x:2},()=>null),/conflict/);
 }finally{c.close();rmSync(root,{recursive:true,force:true});}
});
test('unknown database versions fail closed',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'collaboration-version-'));const s=new Store(root);s.db.exec('PRAGMA user_version=99');s.close();try{assert.throws(()=>new Store(root),/Unsupported/);}finally{rmSync(root,{recursive:true,force:true});}
});
