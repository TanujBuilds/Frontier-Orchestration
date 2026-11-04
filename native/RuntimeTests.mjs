import vm from 'node:vm';import{readFileSync}from'node:fs';import assert from'node:assert/strict';
function client(pages){
 const events=[],calls=[];
 const window={MosaicAdapter:{adaptSnapshot:()=>({projects:[{}],tasks:{}})},MOSAIC_DATA:{},dispatchEvent:e=>events.push(e),webkit:{messageHandlers:{mosaic:{postMessage:async request=>{calls.push(request);return pages.shift()}}}}};
 const context=vm.createContext({window,location:{href:'mosaic-app://ui/index.html'},URL,Date,console,Map,Set,JSON,setTimeout:()=>{},setInterval:()=>{},document:{hidden:false,addEventListener:()=>{}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail}}});
 vm.runInContext(readFileSync('ui/runtime.js','utf8'),context);
 window.MOSAIC_DATA={tasks:{t:{id:'t',evidenceRef:'task-t',rawRecord:{id:'t'}}}};
 return {window,events,calls};
}
let c=client([{text:'{"a":',partial:false,nextStart:5,totalBytes:7},{text:'1}',partial:false,nextStart:7,totalBytes:7}]);
await c.window.MosaicRuntime.loadEvidence('t');assert.equal(c.calls.length,2,'finalized evidence still requires all byte windows');assert.equal(c.events.at(-1).detail.value.text,'{"a":1}');assert.equal(c.events.at(-1).detail.value.truncated,false);
c=client([{text:'{}',partial:true,nextStart:2,totalBytes:2}]);await c.window.MosaicRuntime.loadEvidence('t');assert.equal(c.events.at(-1).detail.value.partial,true,'complete window must preserve incomplete execution provenance');
console.log('2 evidence pagination/provenance regressions passed');
