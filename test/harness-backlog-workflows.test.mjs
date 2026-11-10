import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Goals} from '../src/harness/goals.mjs';
import {Backlog} from '../src/harness/backlog/service.mjs';
import {WorkflowRecipes} from '../src/harness/workflow-recipes/service.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'backlog-workflows-'));
  const c = new Coordinator({root});
  t.after(() => {c.close(); rmSync(root, {recursive:true,force:true});});
  const raw = {submissionId:'goal',environment:'fixture',mode:'codex_only',objective:'Fix parsing',acceptance:['Checks pass'],
    project:{repo:'/tmp/fixture',baseCommit:'a'.repeat(40),readPaths:['src/'],writePaths:['src/'],
      checks:[{id:'verify',argv:['node','checks/verify.mjs']}]}};
  const draft = c.prepareGoal(raw,'prepare');
  const goal = c.activateGoal({goalId:draft.id,hash:draft.hash},'activate');
  const backlog = new Backlog({c}), recipes = new WorkflowRecipes({c});
  const parameters = {issue:'Fix empty rows',readPaths:['src/rows.mjs'],writePaths:['src/rows.mjs'],checks:['verify']};
  const preview = recipes.preview({goalId:goal.id,recipeId:'bugfix',version:1,parameters});
  const input = {goalId:goal.id,expectedGoalHash:goal.hash,recipeId:'bugfix',version:1,parameters,submissionId:'recipe',
    definitionDigest:preview.definitionDigest,parameterDigest:preview.parameterDigest,previewDigest:preview.previewDigest};
  return {c,raw,goal,backlog,recipes,input};
}
const counts = c => Object.fromEntries(['records','commands','submissions','events','requests'].map(table =>
  [table,c.store.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n]));

test('recipe workflows appear once in the backlog using existing task IDs without writes', t => {
  const {c,goal,backlog,recipes,input} = fixture(t);
  const receipt = recipes.submit(input,'submit');
  assert.deepEqual(recipes.submit(input,'replay'),receipt);
  const before = counts(c);
  const result = backlog.inspect({goalId:goal.id});
  assert.equal(result.groups.length,1);
  const [group] = result.groups;
  assert.equal(group.id,receipt.id);
  assert.deepEqual(group.origin,{kind:'workflow_recipe_run',workflowRunId:receipt.workflowRunId,recipeId:'bugfix',version:1});
  assert.deepEqual(group.items.map(item=>item.taskId),receipt.tasks);
  assert.equal(group.items[0].key,'fix');
  assert.equal(group.items[0].status,'waiting_host');
  assert.equal(group.stale,false);
  assert.deepEqual(counts(c),before);
  assert.equal(c.store.all('backlog_group').length,0);
  assert.equal(c.store.all('task').length,1);
  assert.deepEqual(backlog.inspect({goalId:goal.id,groupId:receipt.id}).groups,[group]);
});

test('mixed backlog and workflow receipts page once in saved order with bound filters', t => {
  const {c,goal,backlog,recipes,input} = fixture(t);
  const original = backlog.submit({goalId:goal.id,expectedGoalHash:goal.hash,expectedGoalVersion:goal.version,
    submissionId:'backlog',items:[{key:'inspect',dependsOnKeys:[],task:{kind:'consult',objective:'Inspect',acceptance:['Saved']}}]},'backlog');
  c.registry.registerWorkflow({id:'ordinary',version:1,mode:'codex_only',tasks:[
    {key:'second',kind:'consult',objective:'Summarize',acceptance:['Saved'],dependsOn:['first']},
    {key:'first',kind:'consult',objective:'Inspect',acceptance:['Saved']},
  ]});
  const workflow = c.submitWorkflow({goalId:goal.id,workflowId:'ordinary',version:1,submissionId:'ordinary'},'workflow');
  const recipe = recipes.submit(input,'recipe');
  let page = backlog.inspect({goalId:goal.id,limit:1});
  assert.equal(page.groups[0].id,recipe.id);
  assert.ok(page.nextCursor);
  assert.throws(()=>backlog.inspect({goalId:goal.id,groupId:recipe.id,cursor:page.nextCursor}),/cursor/);
  page = backlog.inspect({goalId:goal.id,limit:1,cursor:page.nextCursor});
  assert.equal(page.groups[0].id,workflow.id);
  assert.deepEqual(page.groups[0].origin,{kind:'workflow_run',workflowId:'ordinary',version:1});
  assert.deepEqual(page.groups[0].items.map(item=>[item.key,item.status]),[['first','waiting_host'],['second','waiting_dependency']]);
  assert.equal(page.groups[0].stale,false);
  page = backlog.inspect({goalId:goal.id,limit:1,cursor:page.nextCursor});
  assert.equal(page.groups[0].id,original.id);
  assert.deepEqual(page.groups[0].origin,{kind:'backlog_group'});
  assert.equal(page.nextCursor,null);
});

test('workflow projections preserve stale approval and missing task diagnostics', t => {
  const {c,raw,goal,backlog,recipes,input} = fixture(t);
  const recipe = recipes.submit(input,'recipe');
  const goals = new Goals(c);
  const rev = goals.prepareRevision({goalId:goal.id,expectedHash:goal.hash,manifest:raw},'revision');
  goals.activateRevision({revisionId:rev.id,hash:rev.hash},'activate-revision');
  let group = backlog.inspect({goalId:goal.id}).groups[0];
  assert.equal(group.stale,true);
  assert.equal(group.reasonCode,'stale_group_approval');
  assert.equal(group.items[0].reasonCode,'task_approval_stale');
  c.store.db.prepare("DELETE FROM records WHERE kind='task' AND id=?").run(recipe.tasks[0]);
  group = backlog.inspect({goalId:goal.id}).groups[0];
  assert.equal(group.items[0].reasonCode,'task_missing');
});
