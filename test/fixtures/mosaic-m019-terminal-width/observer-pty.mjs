import {runObserver} from '../../../src/beta/observer.mjs';

const goal={id:'fixture',objective:'Ａ'.repeat(60),status:'active',mode:'codex_only'};
const tasks=Array.from({length:5},(_,i)=>({id:'t'+i,goalId:goal.id,actor:'codex',kind:'consult',status:'running',objective:i===4?'Selected ＡＡ task':'Assignment '+i,lastActivityAt:Date.now()}));
const snapshot={goals:[goal],tasks,agents:[],reviewers:[],cursor:1};
const events=[{seq:1,at:Date.now(),provenance:'coordinator',summary:'Saved ＡＡ handoff'}];
const before={raw:!!process.stdin.isRaw,resize:process.stdout.listenerCount('resize'),sigint:process.listenerCount('SIGINT'),sigterm:process.listenerCount('SIGTERM')};
// Real TTY input/output and resize events, with frame boundaries for the driver.
const output={
 isTTY:process.stdout.isTTY,
 get columns(){return process.stdout.columns;},
 get rows(){return process.stdout.rows;},
 on(...args){process.stdout.on(...args);},
 removeListener(...args){process.stdout.removeListener(...args);},
 write(value){
  process.stdout.write(value);
  if(value.startsWith('\x1b[H\x1b[2J'))process.stdout.write(`\nM019_FRAME_END ${this.columns} ${this.rows}\n`);
 },
};
await runObserver({input:process.stdin,output,noColor:false,pollMs:50,invoke:async name=>{
 if(name==='observer_snapshot')return snapshot;
 if(name==='observer_timeline')return {events,cursor:1,hasMore:false};
 throw Error('unexpected fixture endpoint');
}});
process.stdout.write('\nM019_RESULT '+JSON.stringify({
 rawRestored:!!process.stdin.isRaw===before.raw,
 keypressListeners:process.stdin.listenerCount('keypress'),
 resizeRestored:process.stdout.listenerCount('resize')===before.resize,
 sigintRestored:process.listenerCount('SIGINT')===before.sigint,
 sigtermRestored:process.listenerCount('SIGTERM')===before.sigterm,
})+'\n');
