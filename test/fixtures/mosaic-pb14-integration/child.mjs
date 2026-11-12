import {connect} from './fixture.mjs';
const [root,action,id]=process.argv.slice(2),f=connect(root);
if(action==='hold-lock'){
 const target=await f.i.lockedGoal(id);console.log(JSON.stringify({type:'locked',pid:process.pid,journalId:target.journal.id,repositoryId:f.i.repositoryId(f.c.getGoal(id))}));await new Promise(()=>{setInterval(()=>{},1000);});
}else if(action==='checkpoint'){
 const emit=f.c.emit.bind(f.c);f.c.emit=(type,g,t,data)=>{if(type==='task.integrated'){console.log(JSON.stringify({type:'checkpoint',pid:process.pid,taskId:t,commit:data.commit,task:f.c.getTask(t)}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return emit(type,g,t,data);};
 await f.i.accept({taskId:id,feedback:'Import checked candidate'},'crash-integrate');
}else throw Error('Unknown fixture action');
