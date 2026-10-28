import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry, normalizeGoal, normalizeTask, digest } from '../src/harness/contracts.mjs';

export const project = {repo:'/tmp/approved-project',baseCommit:'a'.repeat(40),readPaths:['src/'],writePaths:['src/'],checks:[{id:'verify',argv:['node','checks/verify.mjs']}]};
export const brief = (extra={}) => ({submissionId:'goal-a',objective:'Build and verify a bounded task queue',acceptance:['Queue survives restart'],project,...extra});
test('goal materializes mode and budgets before hashing exact approval',()=>{
 const r=new Registry(),g=normalizeGoal(brief(),r);
 assert.equal(g.mode.id,'collaborative');assert.equal(g.limits.hours,8);assert.equal(g.limits.maxTasks,10);
 assert.notEqual(digest(g),digest({...g,objective:g.objective+' changed'}));
 assert.equal(digest({b:2,a:1}),digest({a:1,b:2}));
 assert.throws(()=>normalizeGoal(brief({limits:{hours:Infinity}}),r),/hours/);
 assert.throws(()=>normalizeGoal(brief({shell:'rm -rf'}),r),/unknown/);
 assert.notEqual(digest(g),digest(normalizeGoal(brief({environment:'fixture'}),r)));
});
test('fifth mode narrows registered capabilities without scheduler edits',()=>{
 const r=new Registry();r.registerMode({id:'research-brief',version:1,planner:'deepseek',actors:['deepseek'],review:'checks',capabilities:['research']});
 const g=normalizeGoal(brief({mode:'research-brief',project:null}),r);
 const t=normalizeTask({submissionId:'r1',kind:'research',objective:'Compare queue durability',acceptance:['Cited comparison']},g,r);
 assert.equal(t.actor,'deepseek');assert.equal(t.limits.modelCalls,20);
 assert.throws(()=>normalizeTask({submissionId:'c',kind:'coding',objective:'Code',acceptance:['Tests']},g,r),/capability/);
 assert.throws(()=>r.registerMode({id:'bad',version:1,planner:'deepseek',actors:['deepseek'],review:'checks',capabilities:['shell']}),/capability/);
 assert.throws(()=>r.registerMode({id:'evil',version:1,planner:'deepseek',actors:['deepseek'],review:'checks',capabilities:['research'],script:'eval()'}),/unknown/);
});
test('modes prohibit forbidden executors and require coding project/checks',()=>{
 const r=new Registry();
 for(const [mode,actor] of [['deepseek_only','codex'],['codex_only','deepseek']]){
  assert.throws(()=>normalizeTask({submissionId:'t',kind:'coding',actor,objective:'Implement',acceptance:['Pass']},normalizeGoal(brief({mode}),r),r),/actor/);
 }
 assert.throws(()=>normalizeGoal(brief({project:{...project,writePaths:['.codex/']}}),r),/write|scope/);
 assert.throws(()=>normalizeTask({submissionId:'t',kind:'coding',objective:'Implement',acceptance:['Pass']},normalizeGoal(brief({project:null}),r),r),/project/);
});
test('child permissions/checks/limits cannot widen parent authority',()=>{
 const r=new Registry(),g=normalizeGoal(brief(),r);
 const t=normalizeTask({submissionId:'a',kind:'coding',objective:'Implement',acceptance:['Pass'],permissions:{readPaths:['src/a.mjs'],writePaths:['src/a.mjs'],checks:['verify']}},g,r);
 assert.equal(t.limits.attempts,5);assert.equal(t.limits.modelCalls,50);assert.deepEqual(t.permissions.checks,['verify']);
 assert.throws(()=>normalizeTask({...t,submissionId:'b',permissions:{...t.permissions,writePaths:['other/']}},g,r),/scope/);
 assert.throws(()=>normalizeTask({...t,submissionId:'b',permissions:{...t.permissions,checks:['invented']}},g,r),/check/);
 assert.throws(()=>normalizeTask({...t,submissionId:'b',limits:{modelCalls:51}},g,r),/modelCalls/);
});
test('registry versions are immutable and goal pins survive later definitions',()=>{
 const r=new Registry(),g=normalizeGoal(brief(),r),before=digest(g.mode);
 assert.throws(()=>r.registerMode({...g.mode,id:'collaborative',version:1}),/exists/);
 r.registerMode({id:'collaborative',version:2,planner:'codex',actors:['codex'],review:'operator',capabilities:['coding']});
 assert.equal(digest(g.mode),before);assert.equal(normalizeGoal(brief(),r).mode.version,2);
});
test('normalized assignments can be validated again without inventing context',()=>{
 const r=new Registry(),g=normalizeGoal(brief(),r),raw={submissionId:'a',kind:'consult',objective:'Explain a queue',acceptance:['Useful answer']};
 const normalized=normalizeTask(raw,g,r);assert.deepEqual(normalizeTask(normalized,g,r),normalized);
});
test('workflow registration rejects cycles, duplicates and forbidden capabilities',()=>{
 const r=new Registry(),workflow={id:'research-pair',version:1,mode:'deepseek_only',tasks:[{key:'a',kind:'research',objective:'Read evidence',acceptance:['Cited sources'],dependsOn:['b']},{key:'b',kind:'research',objective:'Compare',acceptance:['Comparison'],dependsOn:['a']}]};
 assert.throws(()=>r.registerWorkflow(workflow),/cycle/);
 assert.throws(()=>r.registerWorkflow({...workflow,tasks:[{...workflow.tasks[0],dependsOn:[]},{...workflow.tasks[1],key:'a',dependsOn:[]}]}),/duplicate/i);
 assert.throws(()=>r.registerMode({id:'forbidden-review',version:1,actors:['deepseek'],planner:'deepseek',review:'operator',capabilities:['coding']}),/actor|review/i);
});
test('capability discovery describes schemas, permissions and limits as pinned data',()=>{
 const g=normalizeGoal(brief());for(const capability of g.capabilities){assert.equal(capability.inputSchema.type,'object');assert.equal(capability.outputSchema.type,'object');assert.ok(capability.permissions);assert.ok(capability.limits);}
});
