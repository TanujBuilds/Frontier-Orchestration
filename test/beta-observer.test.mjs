import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Observer} from '../src/harness/observer.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {actorRows,renderTerminal,TerminalObserver,runObserver} from '../src/beta/observer.mjs';

const goal={id:'goal-1',objective:'Ship\x1b]52;c;injection\x07 work',status:'active',mode:'collaborative',workerProfile:{displayName:'Fixture Model'}};
const task={id:'task-1',goalId:goal.id,actor:'deepseek',kind:'coding',objective:'Run protected checks',status:'running',phase:'checks',provenance:'captured',lastActivityAt:1000,evidenceRef:'task-task-1'};
const native={id:'task-2',goalId:goal.id,actor:'codex',objective:'Independent implementation',status:'codex_active',provenance:'reported',lastActivityAt:1000};
const snapshot={goals:[goal],tasks:[task,native],agents:[{id:'a',goalId:goal.id,taskId:native.id,actor:'codex',role:'implementer',lastReport:{status:'running',at:1000}}],reviewers:[],cursor:101};

test('narrow plain observer strips terminal injection and distinguishes running actors from waiting reviewer',()=>{
 const terminal=renderTerminal({snapshot,goalId:goal.id,events:[]},{width:31,height:60,color:false});
 assert.match(terminal,/Fixture Model/);
 assert.match(terminal,/Codex/);
 assert.match(terminal,/Waiting for checks/i);
 assert.match(terminal,/captured/);
 assert.match(terminal,/reported/);
 assert.doesNotMatch(terminal,/\x1b|injection/);
 assert.ok(terminal.split('\n').every(line=>line.length<=31));
 const workerOnly=renderTerminal({snapshot:{...snapshot,goals:[{...goal,mode:'deepseek_only'}],tasks:[task]},goalId:goal.id,events:[]},{width:70,height:40});
 assert.doesNotMatch(workerOnly,/Reviewer/);
 const failed=renderTerminal({snapshot:{...snapshot,tasks:[{...task,status:'blocked',outcome:{checks:{passed:0,total:1}}}]},goalId:goal.id,events:[]},{width:70,height:40,color:false});
 assert.match(failed,/checks failed/i);
});

test('observer reopens recent history, deduplicates by sequence and reconnects with its durable cursor',async ()=>{
 let connected=true;
 const event=seq=>({seq,goalId:goal.id,type:'goal.activated',summary:'Event '+seq,provenance:'coordinator',at:seq});
 const requests=[];
 const observer=new TerminalObserver(async(name,input)=>{
  requests.push([name,input]);
  if(!connected)throw Error('unavailable');
  if(name==='observer_snapshot')return snapshot;
  if(name==='observer_timeline')return {events:[event(100),event(101)],cursor:101,hasMore:false};
  assert.fail('unexpected endpoint');
 });
 await observer.poll();
 assert.deepEqual(observer.state.events.map(e=>e.seq),[100,101]);
 connected=false;
 await observer.poll();
 assert.equal(observer.state.stale,true);
 assert.equal(observer.state.snapshot.goals[0].id,goal.id);
 connected=true;
 await observer.poll();
 assert.equal(observer.state.stale,false);
 assert.deepEqual(observer.state.events.map(e=>e.seq),[100,101]);
 assert.equal(requests.at(-1)[1].after,101);
});

test('observer snapshot exposes real reviewer reservations and provider attribution',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'mosaic-beta-observe-'));
 const workerProfile={displayName:'Fixture Model',baseUrl:'https://provider.example/v1',model:'custom',revision:'revision-a',streaming:false};
 const c=new Coordinator({root,beta:true,workerProfile});
 t.after(()=>{c.close();rmSync(root,{force:true,recursive:true});});
 const g=c.prepareGoal({submissionId:'g',objective:'Build',acceptance:['Evidence']},'prepare');
 c.activateGoal({goalId:g.id,hash:g.hash},'activate');
 const assignment=c.submitTask({goalId:g.id,submissionId:'a',kind:'consult',objective:'Answer',acceptance:['Evidence']},'submit');
 const reservation=c.reserveReviewer({taskId:assignment.id},'reserve');
 const state=new Observer({c}).snapshot({goalId:g.id});
 assert.equal(state.tasks[0].workerProfile.displayName,'Fixture Model');
 assert.ok(state.reviewers.some(r=>r.id===reservation.id&&r.status==='reserved'));
});

test('q restores the TTY and leaves its input usable',async ()=>{
 const input=new EventEmitter();
 input.isTTY=true;
 input.isRaw=false;
 input.setRawMode=value=>{input.isRaw=value;};
 input.resume=()=>{};
 input.pause=()=>{};
 const output={isTTY:true,columns:80,rows:30,content:'',write(s){this.content+=s;}};
 const pending=runObserver({input,output,noColor:false,invoke:async name=>name==='observer_snapshot'?snapshot:{events:[],cursor:101},pollMs:10});
 await new Promise(resolve=>setImmediate(resolve));
 input.emit('keypress','q',{name:'q'});
 await pending;
 assert.equal(input.isRaw,false);
 assert.match(output.content,/\x1b\[\?25h/);
 assert.equal(input.listenerCount('keypress'),0);
});

test('native reports describe activity and reserved reviewers wait for actual work',()=>{
 const state={snapshot:{...snapshot,agents:[{...snapshot.agents[0],lastReport:{status:'waiting',at:1000}}],
  reviewers:[{id:'review-1',taskId:task.id,goalId:goal.id,status:'reserved',at:1001}]},goalId:goal.id,events:[]};
 const rows=actorRows(state);
 assert.equal(rows.find(row=>row.id===native.id).status,'Waiting');
 assert.equal(rows.find(row=>row.id==='review-'+task.id).state,'waiting');
 const silent=actorRows({...state,snapshot:{...state.snapshot,agents:[]}});
 assert.equal(silent.find(row=>row.id===native.id).status,'Native owner · activity unknown');
});

test('q and Ctrl-C end the actual observer process on a macOS pseudoterminal', {skip:process.platform!=='darwin'},()=>{
 const url=new URL('../src/beta/observer.mjs',import.meta.url).href;
 const code=`import {runObserver} from ${JSON.stringify(url)}; await runObserver({noColor:false,invoke:async()=>({goals:[],tasks:[],cursor:0})});`;
 const pty=`
import os, pty, select, signal, sys, time
key, node, code = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, '--input-type=module', '-e', code])
output, sent = b'', False
end = time.monotonic() + 2
while time.monotonic() < end:
    if select.select([fd], [], [], 0.1)[0]:
        try:
            output += os.read(fd, 4096)
        except OSError:
            pass
        if not sent and b'\\x1b[?25l' in output:
            os.write(fd, bytes.fromhex(key))
            sent = True
    child, status = os.waitpid(pid, os.WNOHANG)
    if child:
        sys.stdout.buffer.write(output)
        sys.exit(os.waitstatus_to_exitcode(status))
os.kill(pid, signal.SIGKILL)
os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(9)
`;
 for(const key of ['71','03']){
  const result=spawnSync('python3',['-c',pty,key,process.execPath,code],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,'observer quit while PTY input was still open: '+result.stderr);
  assert.match(result.stdout,/\x1b\[\?25h/);
 }
});
