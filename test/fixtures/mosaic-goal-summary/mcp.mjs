import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Dispatcher} from '../../../src/harness/tools.mjs';
import {startMcp} from '../../../src/harness/mcp.mjs';

// Synthetic preparation/read fixture only: no worker loop or provider/native calls.
export function seed(c,{count=51,heavy=false}={}){
 const goals=[];
 for(let i=0;i<count;i++){
  const g=c.prepareLegacyGoal({submissionId:`summary-${i}`,objective:`Synthetic goal ${i}`,acceptance:['Saved fixture only'],mode:'codex_only',environment:'fixture'},`prepare-${i}`);
  g.version=i+1;g.status=i%2?'paused':'draft';g.activatedAt=i?1000+i:null;g.deadline=i?2000+i:null;
  c.store.put('goal',g);goals.push(g);
 }
 if(heavy&&goals.length){
  const goalId=goals[0].id,payload='SYNTHETIC-ONLY '.repeat(160000);
  c.store.put('task',{id:'synthetic-task',goalId,status:'accepted',spec:{kind:'consult',actor:'codex',objective:'Synthetic saved task',priority:'normal',dependsOn:[],limits:{attempts:1,modelCalls:1,reviews:1}},attempts:0,reviews:0,result:{content:payload},permissions:{readPaths:[],writePaths:[],checks:[]},deadline:1234});
  c.store.put('reviewer',{id:'synthetic-reviewer',goalId,status:'saved',result:'synthetic review'});
  c.store.put('operation',{id:'synthetic-operation',goalId,taskId:'synthetic-task',name:'fixture_read',status:'completed',input:{payload},result:{payload}});
  c.store.event('fixture.history',{goalId,data:{payload}});
 }
 return goals;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [root]=process.argv.slice(2),c=new Coordinator({root});
 seed(c,JSON.parse(await readFile(path.join(root,'seed.json'),'utf8')));
 const dispatcher=new Dispatcher({c});
 const server=await startMcp({tools:dispatcher.tools(),invoke:(name,input)=>dispatcher.invoke(name,input)});
 server.onclose=()=>c.close();
}
