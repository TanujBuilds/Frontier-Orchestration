import path from 'node:path';
import {client} from './client.mjs';
import {OBSERVER_TOOLS} from '../harness/observer.mjs';

const labels={beta:'Mosaic Beta (mosaic-beta)',core:'Mosaic core (frontier-harness)'};
const rank=snapshot=>snapshot.goals.some(g=>g.status==='active')?2:snapshot.goals.length?1:0;

// The observer can read either installation; operator/MCP traffic stays bound
// to its original coordinator. Never use an operator credential for discovery.
export function observerClient(paths,{source='auto'}={}){
 if(!['auto','beta','core'].includes(source))throw Error('Observer source must be auto, beta or core');
 const clients={
  beta:client(paths,{viewer:true}),
  core:client({...paths,state:path.join(paths.home,'Library','Application Support','Mosaic','state')},{viewer:true})
 };
 const recentSupport=new Map();
 let selected=source==='auto'?null:source;
 return async(name,input={},signal)=>{
  if(!OBSERVER_TOOLS.has(name))throw Error('Terminal observer has read-only access');
  if(name!=='observer_snapshot'||input.goalId){
   if(!selected)throw Error('Read an observer snapshot before requesting evidence');
   const id=selected,invoke=clients[id];
   if(name==='observer_timeline'&&input.recent){
    if(!recentSupport.has(id)){
     const tools=await invoke('tools_list',{},signal);
     recentSupport.set(id,!!tools.find(t=>t.name==='observer_timeline')?.inputSchema.properties.recent);
    }
    if(!recentSupport.get(id)){const {recent,...query}=input;input={...query,after:0};}
   }
   const result=await invoke(name,input,signal);
   return name==='observer_timeline'&&id==='core'?{...result,events:result.events.map(e=>e.actor==='deepseek'?{...e,displayName:e.displayName??'DeepSeek'}:e)}:result;
  }
  const names=source==='auto'?['beta','core']:[source];
  const results=await Promise.allSettled(names.map(id=>clients[id](name,input,signal)));
  const snapshots=new Map(results.flatMap((result,i)=>result.status==='fulfilled'?[[names[i],result.value]]:[]));
  // Preserve the last observed source on disconnect. An empty second service
  // must not turn a running or failed job into a misleading "idle" screen.
  if(selected&&!snapshots.has(selected))throw Error('Observed coordinator is disconnected');
  for(const id of names){
   if(snapshots.has(id)&&(!selected||rank(snapshots.get(id))>rank(snapshots.get(selected))))selected=id;
  }
  if(!selected)throw Error('No Mosaic observer is available. Run mosaic doctor.');
  const snapshot=snapshots.get(selected);
  const other=names.filter(id=>id!==selected&&snapshots.get(id)?.goals.length);
  return {...snapshot,source:selected,sourceLabel:labels[selected],
   sourceHint:other.length?`Other saved goals: mosaic --source ${other[0]}`:null,
   // The existing core predates generic worker profiles and uses DeepSeek.
   goals:selected==='core'?snapshot.goals.map(g=>({...g,workerProfile:g.workerProfile??{displayName:'DeepSeek'}})):snapshot.goals};
 };
}
