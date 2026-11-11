// A protocol fixture, not an installed host. Test-only result injection is
// confined here; it neither changes production classes nor dispatches inference.
import {Coordinator} from '../../../src/harness/coordinator.mjs';
import {Dispatcher} from '../../../src/harness/tools.mjs';
import {startMcp} from '../../../src/harness/mcp.mjs';
import {hostRegistry} from '../../../src/beta/hosts/index.mjs';
const [root,hostId]=process.argv.slice(2);
const c=new Coordinator({root,selectedHost:hostId,hostRegistry}),d=new Dispatcher({c,config:{hostId}});
const invoke=async(name,input)=>{
 const result=await d.invoke(name,input);
 if(name==='task_submit'&&result.status==='queued'){
  const task=c.claimNext('host-protocol-fixture');
  if(task.id!==result.id)throw Error('Fixture selected unexpected task');
  return c.completeTask(task.id,{content:'Saved independently scripted consultation for host protocol verification.'},'host-protocol-fixture',{reviewRequired:true});
 }
 return result;
};
const server=await startMcp({name:`mosaic-${hostId}-fixture`,invoke,tools:d.tools()});
let closing=false;
async function close(){if(closing)return;closing=true;await d.whenIdle();await server.close();c.close();process.exit(0);}
process.once('SIGTERM',close);process.once('SIGINT',close);
