import vm from'node:vm';import{readFileSync}from'node:fs';import assert from'node:assert/strict';
const nodes=new Map(),listeners={},windowListeners={},storage=new Map();let focused='';const actionNodes=[];
function el(id){if(!nodes.has(id)){const classes=new Set();nodes.set(id,{id,innerHTML:'',textContent:'',hidden:false,scrollTop:0,offsetWidth:100,dataset:{},style:{},closest(selector){return selector==='#main'&&this.region==='main'?el('main'):null},classList:{toggle:(s,on)=>{on?classes.add(s):classes.delete(s)},contains:s=>classes.has(s),add:s=>classes.add(s),remove:s=>classes.delete(s)},setAttribute(){},removeAttribute(){},focus(){focused=id},addEventListener(){},querySelectorAll(){return[]}})}return nodes.get(id)}
const document={activeElement:null,querySelector:s=>el(s.replace(/^#/,'')),querySelectorAll:s=>s==='[data-action]'?actionNodes:[],addEventListener:(name,fn)=>listeners[name]=fn};
const window={addEventListener:(n,fn)=>windowListeners[n]=fn,MosaicRuntime:{demo:false,loadEvidence(){},refreshChats(){},captureFocus(){return{}},restoreFocus(){}}};
const c=vm.createContext({window,document,Date,console,Map,Set,JSON,structuredClone,setTimeout(){},matchMedia:()=>({matches:true}),localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}});
vm.runInContext(readFileSync('ui/adapter.js','utf8'),c);
const snapshot={goals:[{id:'p',objective:'Build a clear project screen',mode:'codex_only',status:'active'}],tasks:['a','b'].map(id=>({id,goalId:'p',objective:'Assignment '+id,actor:'codex',status:'accepted',outcome:{summary:'Saved result '+id,checks:{passed:1,total:1}}}))};
window.MOSAIC_DATA=window.MosaicAdapter.adaptSnapshot(snapshot,[]);vm.runInContext(readFileSync('ui/app.js','utf8'),c);
const click=(action,extra={})=>listeners.click({target:{closest:()=>({dataset:{action,...extra}})}});
const saved=()=>JSON.parse(storage.get('mosaic-observer-v1'));

const failures=[];
click('view',{view:'history'});
const sidebar=el('sidebar-task'),row=el('history-task');sidebar.dataset={action:'task',task:'a'};row.dataset={action:'task',task:'a'};row.region='main';actionNodes.push(sidebar,row);document.activeElement=row;
listeners.click({target:{closest:()=>row}});click('inspector-close');
try{assert.equal(focused,'history-task','Back restores the originating list row, not its sidebar duplicate')}catch(e){failures.push(e.message)}
click('task',{task:'b'});
const changed=structuredClone(snapshot);changed.goals[0].objective='Renamed project';changed.tasks.push({...changed.tasks[1],id:'c',objective:'Assignment c'});
windowListeners['mosaic:data']({detail:window.MosaicAdapter.adaptSnapshot(changed,[])});
try{assert.match(el('inspector').innerHTML,/Assignment c/,'sibling assignments update without selected-task changes');assert.match(el('inspector').innerHTML,/Renamed project/)}catch(e){failures.push(e.message)}
assert.deepEqual(failures,[]);
console.log('Back focus identity and project-level live-refresh regressions passed');
