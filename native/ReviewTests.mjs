import vm from 'node:vm';import{readFileSync}from'node:fs';import assert from'node:assert/strict';
const now=1800000000000;
const adapterContext=vm.createContext({window:{},Date});vm.runInContext(readFileSync('ui/adapter.js','utf8'),adapterContext);const{adaptSnapshot}=adapterContext.window.MosaicAdapter;
let snapshot={goals:[{id:'g',mode:'codex_only',status:'active',objective:'Build screen'}],tasks:[{id:'t',goalId:'g',objective:'Implement screen',actor:'codex',status:'codex_active',lastActivityAt:null,lastActivity:null,outcome:{checks:{passed:1,total:2}}}],agents:[{taskId:'t',goalId:'g',actor:'codex',role:'reviewer',lastReport:null},{taskId:'t',goalId:'g',actor:'codex',role:'implementer',lastReport:{at:now-1000,status:'running',summary:'Implementing the screen'}}]};
let d=adaptSnapshot(snapshot,[],now);
assert.equal(d.tasks.t.checksPassed,false,'partial check counts cannot mean all passed');
assert.notEqual(d.projects[0].currentStep,2,'partial checks cannot advance handoff to Review');
assert.notEqual(d.projects[0].state,'stale','fresh native report must survive unrelated registration');
assert.match(d.projects[0].codex.action,/Implementing/);
snapshot.tasks[0].outcome.checks={passed:2,total:2};d=adaptSnapshot(snapshot,[],now);assert.equal(d.tasks.t.checksPassed,true);assert.equal(d.projects[0].currentStep,2);
console.log('Partial-check and registration-order regressions passed');

const events=[],details={dataset:{key:'detail:t:diff'}},summary={tagName:'SUMMARY',closest:()=>details};let focused=false;
const replacement={focus:()=>{focused=true}};const newDetails={dataset:details.dataset,querySelector:()=>replacement};
const document={hidden:false,activeElement:summary,addEventListener:()=>{},getElementById:()=>null,querySelectorAll:selector=>selector==='details[data-key]'?[newDetails]:[]};
const realDate=Date;class Clock extends realDate{static now(){return now}}
const window={MosaicAdapter:adapterContext.window.MosaicAdapter,MOSAIC_DATA:{},dispatchEvent:e=>events.push(e),webkit:{messageHandlers:{mosaic:{postMessage:async({name})=>{if(name==='observer_snapshot')return{goals:[],tasks:[],generatedAt:Clock.now(),cursor:0};return{events:[],cursor:0,hasMore:false}}}}}};
const context=vm.createContext({window,document,Date:Clock,location:{href:'mosaic-app://ui/index.html'},URL,Map,Set,JSON,console,setTimeout:()=>{},setInterval:()=>{},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail}}});
vm.runInContext(readFileSync('ui/runtime.js','utf8'),context);
assert.equal(typeof window.MosaicRuntime.captureFocus,'function','focus helpers cover native disclosure identity');
const focus=window.MosaicRuntime.captureFocus();window.MosaicRuntime.restoreFocus(focus);assert.equal(focused,true,'disclosure focus restored after replacement');
await window.MosaicRuntime.refresh();let count=events.length;await window.MosaicRuntime.refresh();assert.equal(events.length,count,'unchanged polling must not replace content');
console.log('Disclosure focus and unchanged-poll regressions passed');

const errorEvents=[];window.dispatchEvent=e=>errorEvents.push(e);window.webkit.messageHandlers.mosaic.postMessage=async()=>{throw Error('offline')};
vm.runInContext(readFileSync('ui/runtime.js','utf8'),context);
await window.MosaicRuntime.refresh();const offline=errorEvents.at(-1).detail;
assert.equal(offline.connection,'disconnected');assert.equal(offline.hasSnapshot,false,'fresh offline launch must not claim a previous snapshot');assert.equal(offline.generatedAt,null);
console.log('Fresh-offline provenance regression passed');
