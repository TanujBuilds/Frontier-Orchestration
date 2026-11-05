import vm from'node:vm';import{readFileSync}from'node:fs';import assert from'node:assert/strict';
const c=vm.createContext({window:{},Date});vm.runInContext(readFileSync('ui/adapter.js','utf8'),c);
const task={id:'paused-task',goalId:'p',actor:'deepseek',status:'paused',objective:'Paused work',lastActivityAt:1800000000000};
const project={id:'p',objective:'Project',mode:'collaborative',environment:'live'};
for(const status of['paused','active']){
const d=c.window.MosaicAdapter.adaptSnapshot({goals:[{...project,status}],tasks:[task]});
assert.equal(c.window.MosaicAdapter.recentWork(d).waiting.length,1,'resumable paused goal remains in waiting');
assert.equal(c.window.MosaicAdapter.recentWork(d).working.length,0);
}
for(const status of['stopped','completed','partial']){
const d=c.window.MosaicAdapter.adaptSnapshot({goals:[{...project,status}],tasks:[task]});assert.equal(c.window.MosaicAdapter.recentWork(d).waiting.length,0,'terminal or stopped goals are historical');
}
console.log('Paused-goal waiting and terminal exclusion regressions passed');
