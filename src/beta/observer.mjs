import {emitKeypressEvents} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {stripVTControlCharacters} from 'node:util';

const feedLimit=100;
const clean=value=>stripVTControlCharacters(String(value??''))
 .replace(/[\u001b\u0090\u0098\u009d\u009e\u009f][^\r\n]*/gu,'')
 .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,' ');
const localClock=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const localDate=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'});
function clock(at){
 if(!Number.isFinite(at)||Math.abs(at)>8.64e15)return 'unknown';
 const date=new Date(at),time=localClock.format(date);
 return date.toDateString()===new Date().toDateString()?time:localDate.format(date)+' '+time;
}
const labels={waiting:'Waiting',running:'Running',codex_active:'Running',queued:'Queued',codex_ready:'Ready in Codex',awaiting_review:'Waiting for review',awaiting_legacy_review:'Waiting for review',legacy_reviewing:'Reviewing',awaiting_supervisor:'Waiting for Codex',awaiting_user:'Waiting for user',blocked:'Blocked',uncertain:'Unknown',accepted:'Accepted',ready_to_integrate:'Ready to integrate',completed:'Complete',stopped:'Stopped',partial:'Partial',failed:'Failed',cancelled:'Cancelled',draft:'Prepared',active:'Active',paused:'Paused'};
const status=value=>labels[value]??clean(value).replaceAll('_',' ');
const reviewModes={collaborative:'operator',codex_only:'operator',overnight_review:'legacy',deepseek_only:'checks'};
function goalFor(state){
 return state.snapshot?.goals.find(g=>g.id===state.goalId)??state.snapshot?.goals.find(g=>g.status==='active')??state.snapshot?.goals[0];
}

const candidateReady=new Set(['awaiting_review','awaiting_legacy_review','legacy_reviewing','ready_to_integrate','accepted']);
function checksFailed(task){
 const checks=task.outcome?.checks;
 if(task.actor==='codex'||checks&&candidateReady.has(task.status))return !!checks&&checks.passed<checks.total;
 if(task.lastCheck)return task.lastCheck.status==='failed';
 return !!checks&&checks.passed<checks.total;
}
const reviewComplete=new Set(['accepted','failed','partial','cancelled','ready_to_integrate','stopped']);

export function actorRows(state){
 const goal=goalFor(state);
 if(!goal)return [];
 const {snapshot}=state,tasks=snapshot.tasks.filter(task=>task.goalId===goal.id),rows=[];
 const agents=(snapshot.agents??[]).filter(agent=>agent.goalId===goal.id);
 const workerName=goal.workerProfile?.displayName??'API worker';
 const reviewPolicy=goal.reviewPolicy??reviewModes[goal.mode];
 for(const task of tasks){
  const native=task.actor==='codex',reports=agents.filter(agent=>agent.taskId===task.id&&agent.actor==='codex'&&agent.role!=='reviewer');
  const report=reports.filter(a=>a.lastReport).sort((a,b)=>b.lastReport.at-a.lastReport.at)[0];
  const captured=task.provenance==='captured';
  const nativeActive=native&&task.status==='codex_active',reported=report?.lastReport;
  const stateName=nativeActive?(reported&&!report.stale?reported.status:'uncertain'):task.status==='legacy_reviewing'?'awaiting_legacy_review':task.status;
  rows.push({id:task.id,actor:native?'Codex':task.workerProfile?.displayName??workerName,role:report?.role==='explorer'?'Explorer':report?.role==='supervisor'?'Supervisor':'Implementer',assignment:task.objective,
   status:checksFailed(task)&&task.status==='blocked'?'Checks failed':nativeActive&&stateName==='uncertain'?'Native owner · activity unknown':status(stateName),
   state:stateName,at:reported?.at??task.lastActivityAt??task.updatedAt,evidence:task.evidenceRef,provenance:native?(reported?'reported':'coordinator'):captured?'captured':'coordinator'});
 }
 const planning=snapshot.planning?.find(p=>p.goalId===goal.id);
 if(planning&&planning.status!=='completed')rows.unshift({id:'planner',actor:workerName,role:'Planner',assignment:goal.objective,status:status(planning.status),state:planning.status,at:planning.at,provenance:'coordinator'});
 for(const task of tasks){
  if(!['operator','legacy'].includes(reviewPolicy)||reviewComplete.has(task.status))continue;
  const awaiting=reviewPolicy==='operator'?task.status==='awaiting_review':['awaiting_legacy_review','legacy_reviewing'].includes(task.status);
  const reservation=awaiting?snapshot.reviewers?.find(r=>r.goalId===goal.id&&r.taskId===task.id&&r.status==='reserved'):null;
  const report=reservation?agents.find(a=>a.taskId===task.id&&a.role==='reviewer'&&!a.stale&&a.lastReport?.at>=reservation.at):null;
  const checking=task.kind==='coding'&&task.status==='running'&&task.phase==='checks';
  const failed=task.kind==='coding'&&checksFailed(task);
  if(!awaiting&&!checking&&!failed)continue;
  const reviewing=task.status==='legacy_reviewing'||report?.lastReport.status==='running';
  const heldByChecks=failed&&!checking&&!awaiting;
  rows.push({id:'review-'+task.id,actor:'Codex',role:'Reviewer',assignment:task.objective,
   at:report?.lastReport.at??reservation?.at??(heldByChecks?task.lastCheck?.at:null)??task.updatedAt,evidence:task.evidenceRef,
   state:reviewing?'running':heldByChecks?'blocked':'waiting',
   status:reviewing?'Reviewing':checking?'Waiting for checks':heldByChecks?'Waiting · checks failed':reservation?'Reserved · waiting':'Waiting in Codex',
   provenance:report?'reported':'coordinator'});
 }
 return rows;
}

function lines(value,width){
 const chars=[...clean(value)],result=[];
 let line='',columns=0;
 for(const char of chars){
  const cell=/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}]/u.test(char)?2:1;
  if(columns+cell>width&&line){
   const space=line.lastIndexOf(' ');
   if(space>0&&space>line.length/2){result.push(line.slice(0,space));line=line.slice(space+1);columns=[...line].reduce((n,x)=>n+(/[　-￿]/u.test(x)?2:1),0);}
   else{result.push(line);line='';columns=0;}
  }
  line+=char;columns+=cell;
 }
 if(line||!result.length)result.push(line);
 return result;
}
const accent=value=>'\x1b[36m'+value+'\x1b[0m';
const statusColor=(value,state)=>`\x1b[${['blocked','failed'].includes(state)?31:['running','active','accepted','codex_active','completed'].includes(state)?32:33}m${value}\x1b[0m`;

function eventText(event){
 const actor=event.actor==='deepseek'?event.displayName??'API worker':event.actor==='codex'?'Codex':'';
 const summary=String(event.summary??'');
 const legacyActor=event.actor==='deepseek'&&summary.startsWith('DeepSeek ');
 const text=legacyActor?actor+summary.slice('DeepSeek'.length):summary;
 return actor&&!legacyActor&&!text.startsWith(actor+' ')?actor+' · '+text:text;
}

function compactMain(state,goal,{width,height,color,selected,offset}){
 const first=value=>lines(value,width)[0];
 const heading=value=>color?accent(first(value)):first(value);
 const rows=actorRows(state),index=Math.max(0,Math.min(selected,rows.length-1));
 const frame=[heading('Mosaic Beta')];
 if(state.snapshot?.source)frame.push(first('Source: '+state.snapshot.source));
 if(state.stale)frame.push(first(state.snapshot?'Disconnected · stale':'Disconnected'));
 if(goal){
  if(height>=8)frame.push(first(goal.objective));
  const end=Math.max(0,state.events.length-offset);
  if(rows.length){
   // Reserve the footer, feed heading and the newest visible event.
   const room=Math.max(1,height-frame.length-2-(end?1:0));
   const blocks=rows.map((row,rowIndex)=>{
    const marker=rowIndex===index?'› ':'  ';
    const joined=lines(`${marker}${row.actor} · ${row.status}`,width);
    const identity=joined.length===1?joined:[first(marker+row.actor),...lines(row.status,width)];
    const heading=color?identity.map(line=>statusColor(line,row.state)):identity;
    const detail=height>=18?[first(`  ${row.provenance} · updated ${clock(row.at)}`)]:[];
    return [...heading,first(row.assignment),...detail];
   });
   let start=index,after=index+1,used=blocks[index].length;
   while(start>0&&used+blocks[start-1].length<=room)used+=blocks[--start].length;
   while(after<blocks.length&&used+blocks[after].length<=room)used+=blocks[after++].length;
   if(used>room)frame.push(...blocks[index].slice(0,room-1),first('› '+rows[index].assignment));
   else frame.push(...blocks.slice(start,after).flat());
  }else frame.push(first('Idle · no assignments'));
  frame.push(heading('Handoff feed'));
  if(state.historyPending)frame.push(first('Loading saved handoffs…'));
  const room=Math.max(0,height-frame.length-1);
  for(const event of state.events.slice(Math.max(0,end-room),end))
   frame.push(first(width>=42?`[${event.provenance}] ${eventText(event)}`:eventText(event)));
 }else if(!state.stale)frame.push(first('Idle · no goals'));
 const footer=first(width<16?'↑↓ g q':'↑↓ Enter g q');
 return [...frame.slice(0,height-1),footer].join('\n');
}

function polishedMain(state,goal,{width,height,color,selected,offset}){
 const margin='  ',space=Math.min(104,width-4);
 const paint=(value,codes)=>color?`\x1b[${codes}m${value}\x1b[0m`:value;
 const quiet=value=>paint(value,'2'),bold=value=>paint(value,'1');
 const tone=(value,state)=>color?statusColor(value,state):value;
 const clip=(value,size)=>{const wrapped=lines(value,size);return wrapped.length>1?lines(value,size-1)[0].trimEnd()+'…':wrapped[0];};
 const cellCount=value=>[...clean(value)].reduce((n,c)=>n+(/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}]/u.test(c)?2:1),0);
 const section=(title,aside='')=>bold(title)+quiet(' '+ '─'.repeat(Math.max(1,space-cellCount(title)-cellCount(aside)-2))+(aside?' '+aside:''));
 const out=[paint('▦','36')+' '+bold('Mosaic Beta')];
 if(state.snapshot?.sourceLabel)out.push(quiet(clip('Watching '+state.snapshot.sourceLabel,space)));
 if(state.snapshot?.sourceHint)out.push(quiet(clip(state.snapshot.sourceHint,space)));
 if(state.stale)out.push(tone(clip(state.snapshot?'Disconnected · last observed state is stale':'Disconnected · coordinator state unknown',space),'blocked'));
 out.push(quiet('─'.repeat(space)),'');
 if(!goal){
  out.push(bold(state.stale?'Waiting for the coordinator':'Ready when you are'),'');
  out.push(...lines(state.stale?'Run mosaic doctor to check the connection.':
   'Start a Mosaic goal in Codex. Agent activity and handoffs will appear here.',space));
 }else{
  const title=lines(goal.objective,space);
  out.push(...title.slice(0,2).map((line,i)=>bold(i===1&&title.length>2?clip(line+' …',space):line)));
  const modes={collaborative:'Collaborative',codex_only:'Codex only',deepseek_only:'API worker only',overnight_review:'Overnight review'};
  out.push(tone('['+status(goal.status)+']',goal.status)+'  '+quiet(modes[goal.mode]??clean(goal.mode)));
  out.push(quiet(clip('Goal '+goal.id,space)),'');
  const rows=actorRows(state),index=Math.max(0,Math.min(selected,rows.length-1));
  out.push(section('Agents',rows.length?`${index+1}/${rows.length}`:''));
  const blocks=rows.map((row,i)=>{
   const actor=clip(row.actor,Math.max(16,space-40)),left=(i===index?'› ':'  ')+actor+'  '+row.role;
   const badge='['+row.status+']',gap=space-cellCount(left)-cellCount(badge);
   const identity=(i===index?paint('› ','36'):'  ')+bold(actor)+'  '+quiet(row.role);
   const head=gap>=2?[identity+' '.repeat(gap)+tone(badge,row.state)]:[identity,...lines(badge,space-2).map(line=>'  '+tone(line,row.state))];
   const assignment=lines(row.assignment,space-2);
   return [...head,...assignment.slice(0,2).map((line,j)=>'  '+(j===1&&assignment.length>2?clip(line+' …',space-2):line)),
    '  '+quiet(clip(`${row.provenance}  updated ${clock(row.at)}`,space-2))];
  });
  if(!blocks.length)out.push(quiet('No assignments recorded.'));
  else{
   const budget=Math.max(blocks[index].length,height-out.length-8);
   let start=index,end=index+1,used=blocks[index].length;
   while(start>0&&used+blocks[start-1].length+1<=budget){used+=blocks[--start].length+1;}
   while(end<blocks.length&&used+blocks[end].length+1<=budget){used+=blocks[end++].length+1;}
   out.push(...blocks.slice(start,end).flatMap((block,i)=>i?['',...block]:block));
  }
  out.push('',section('Handoff feed'));
  if(state.historyPending)out.push(quiet('Loading saved handoffs…'));
  const end=Math.max(0,state.events.length-offset),room=Math.max(0,height-out.length-3),feed=[];
  for(let i=end-1;i>=0;i--){
   const event=state.events[i],stamp=clock(event.at),provenance=clean(event.provenance??'coordinator');
   const prefix=stamp+'  '+provenance.padEnd(11)+'  ',text=lines(eventText(event),Math.max(8,space-cellCount(prefix)));
   const block=text.slice(0,2).map((line,n)=>(n?' '.repeat(cellCount(prefix)):quiet(prefix))+(n===1&&text.length>2?clip(line+' …',space-cellCount(prefix)):line));
   if(feed.length+block.length>room){
    if(!feed.length&&room)feed.push(quiet(prefix)+clip(eventText(event),Math.max(8,space-cellCount(prefix))));
    break;
   }
   feed.unshift(...block);
  }
  out.push(...(feed.length?feed:[quiet(clip(state.events.length?'No handoffs fit. Enlarge the terminal to see the feed.':'Waiting for the first handoff.',space))]).slice(0,room));
 }
 const keys=space>=70?'↑↓ select   Enter evidence   g goals   PgUp/PgDn history   q quit':'↑↓  Enter evidence  g goals  Pg↑/↓ feed  q quit';
 const body=out.slice(0,height-3);
 while(body.length<height-3)body.push('');
 return [...body,'',quiet('─'.repeat(space)),quiet(clip(keys,space))].map(line=>margin+line).join('\n');
}

export function renderTerminal(state,{width=80,height=36,color=false,selected=0,picker=null,detail=null,detailOffset=0,offset=0,interactive=false}={}){
 width=Math.max(8,Math.min(300,width));height=Math.max(5,Math.min(200,height));
 const header=(value)=>lines(value,width).map(line=>color?accent(line):line);
 const compact=interactive&&(width<55||height<24);
 const goal=goalFor(state);
 if(compact&&picker===null&&!detail)return compactMain(state,goal,{width,height,color,selected,offset});
 if(interactive&&picker===null&&!detail)return polishedMain(state,goal,{width,height,color,selected,offset});
 const out=header(compact?'Mosaic Beta':'Mosaic Beta  /  Terminal observer');
 if(state.snapshot?.sourceLabel)out.push(...lines('Watching '+state.snapshot.sourceLabel,width));
 if(state.snapshot?.sourceHint)out.push(...lines(state.snapshot.sourceHint,width));
 if(state.stale)out.push(...lines(state.snapshot?'Disconnected · last observed state is stale':'Disconnected · coordinator state unknown',width));
 if(picker!==null){
  out.push(...header('Choose a goal'));
  const goals=state.snapshot?.goals??[];
  const start=compact?Math.max(0,picker-height+5):Math.max(0,picker-1);
  for(const [index,g] of goals.slice(start).entries()){
   const item=lines(`${index+start===picker?'›':' '} ${status(g.status)} · ${g.objective} [${g.id}]`,width);
   out.push(...(compact?item.slice(0,1):item.slice(0,2)));
  }
 }else if(detail){
  out.push(...header('Saved evidence'));
  const detailLines=detail.split('\n').flatMap(line=>lines(line,width));
  out.push(...detailLines.slice(Math.min(detailOffset,Math.max(0,detailLines.length-1))));
 }else if(!goal){
  if(!state.stale||state.snapshot)out.push(...lines('Idle · no saved goals. Start a Mosaic Beta goal in Codex.',width));
 }else{
  const title=lines(`${status(goal.status)} · ${goal.objective}`,width);
  out.push(...(interactive?title.slice(0,2):title),...lines(`Goal ${goal.id} · ${goal.mode}`,width),'');
  const rows=actorRows(state),budget=Math.max(2,Math.floor((height-out.length-5)*0.58));
  if(!rows.length)out.push(...lines('Idle · no assignments recorded.',width));
  const blocks=rows.map((row,index)=>{
   const prefix=interactive&&index===selected?'› ':'  ';
   const identity=width<55?[...lines(`${prefix}${row.actor} · ${row.role}`,width),...lines('  '+row.status,width)]:lines(`${prefix}${row.actor} · ${row.role} · ${row.status}`,width);
   const assignment=lines(`  ${row.assignment}`,width);
   return [...(color?identity.map(line=>statusColor(line,row.state)):identity),
    ...(interactive?assignment.slice(0,2):assignment),...lines(`  ${row.provenance} · updated ${clock(row.at)}`,width)];
  });
  if(interactive&&blocks.length){
   let start=Math.min(selected,blocks.length-1),used=blocks[start].length;
   while(start>0&&used+blocks[start-1].length<=budget){start--;used+=blocks[start].length;}
   out.push(...blocks.slice(start).flat().slice(0,Math.max(budget,blocks[Math.min(selected,blocks.length-1)].length)));
  }else out.push(...blocks.flat());
  out.push('',...header('Handoff feed'));
  if(state.historyPending)out.push(...lines('Loading saved handoffs…',width));
  const room=Math.max(0,height-out.length-(interactive?4:2)),end=Math.max(0,state.events.length-offset);
  for(const event of state.events.slice(Math.max(0,end-Math.max(1,room)),end)){
   out.push(...lines(`${clock(event.at)} [${event.provenance}] ${eventText(event)}`,width));
  }
 }
 const footer=picker!==null?'↑↓ choose · Enter select · Esc back · q quit':detail?'↑↓ or PgUp/PgDn scroll · Esc back · q quit':interactive?'↑↓ rows · Enter evidence · g goals · PgUp/PgDn feed · q quit':'Approvals and decisions stay in Codex.';
 const tail=lines(compact?'↑↓ Esc q':footer,width);
 return [...out.slice(0,Math.max(0,height-tail.length-1)),'',...tail].join('\n');
}

export class TerminalObserver {
 constructor(invoke){
  this.invoke=invoke;
  this.state={snapshot:null,stale:false,goalId:null,events:[]};
  this.cursor=null;
  this.fixedGoal=null;
 }
 select(goalId){
  this.fixedGoal=goalId;this.state.goalId=goalId;this.state.events=[];this.cursor=null;
 }
 async poll(signal){
  try{
   const snapshot=await this.invoke('observer_snapshot',{},signal);
   const previous=this.state.snapshot;
   if(snapshot.source!==previous?.source){this.fixedGoal=null;this.cursor=null;this.state.events=[];this.state.historyPending=false;}
   const goal=(this.fixedGoal?snapshot.goals.find(g=>g.id===this.fixedGoal):null)??snapshot.goals.find(g=>g.status==='active')??snapshot.goals[0];
   if(goal?.id!==this.state.goalId||snapshot.cursor<(previous?.cursor??0)){
    this.cursor=null;this.state.events=[];this.state.goalId=goal?.id??null;this.state.historyPending=false;
   }
   this.state.snapshot=snapshot;
   if(goal){
    if(snapshot.overflow?.tasks){
     const selected=await this.invoke('observer_snapshot',{goalId:goal.id},signal);
     if(this.state.goalId===goal.id)this.state.snapshot={...selected,goals:snapshot.goals,source:snapshot.source,sourceLabel:snapshot.sourceLabel,sourceHint:snapshot.sourceHint};
    }
    for(let page=0;page<2;page++){
     const recent=this.cursor===null;
     const result=await this.invoke('observer_timeline',{goalId:goal.id,limit:feedLimit,...(recent?{recent:true}:{after:this.cursor})},signal);
     if(this.state.goalId!==goal.id)break;
     const events=new Map(this.state.events.map(event=>[event.seq,event]));
     for(const event of result.events)if(event.type!=='model.output'&&(recent||event.seq>this.cursor))events.set(event.seq,event);
     this.state.events=[...events.values()].sort((a,b)=>a.seq-b.seq).slice(-feedLimit);
     this.cursor=Math.max(this.cursor??0,result.cursor);
     this.state.historyPending=!!result.hasMore;
     if(!result.hasMore)break;
    }
   }
   this.state.stale=false;
  }catch{this.state.stale=true;}
  return this.state;
 }
}

export async function runObserver({invoke,input=process.stdin,output=process.stdout,once=false,noColor=Object.hasOwn(process.env,'NO_COLOR'),pollMs=1000}){
 const observer=new TerminalObserver(invoke);
 if(once||!input.isTTY||!output.isTTY||noColor){
  const state=await observer.poll();
  output.write(renderTerminal(state,{width:output.columns??80,height:200})+'\n');
  return state;
 }
 const controller=new AbortController(),close=()=>controller.abort();
 const originalRaw=!!input.isRaw,wasFlowing=input.readableFlowing===true;
 let selected=0,picker=null,detail=null,detailOffset=0,offset=0;
 const draw=()=>{
  if(controller.signal.aborted)return;
  output.write('\x1b[H\x1b[2J'+renderTerminal(observer.state,{width:output.columns,height:output.rows,color:true,interactive:true,selected,picker,detail,detailOffset,offset}));
 };
 const keypress=async(_,key={})=>{
  if(key.name==='q'||key.ctrl&&key.name==='c'){close();return;}
  if(key.name==='escape'){detail=null;picker=null;draw();return;}
  if(detail){
   const delta={up:-1,down:1,pageup:-10,pagedown:10}[key.name];
   if(delta){detailOffset=Math.max(0,Math.min(4096,detailOffset+delta));draw();}
   return;
  }
  const goals=observer.state.snapshot?.goals??[],rows=actorRows(observer.state);
  if(picker!==null){
   if(key.name==='up')picker=Math.max(0,picker-1);
   if(key.name==='down')picker=Math.min(goals.length-1,picker+1);
   if(key.name==='return'&&goals[picker]){observer.select(goals[picker].id);picker=null;selected=0;offset=0;}
  }else{
   if(key.name==='g'&&goals.length)picker=Math.max(0,goals.findIndex(g=>g.id===observer.state.goalId));
   if(key.name==='up')selected=Math.max(0,selected-1);
   if(key.name==='down')selected=Math.max(0,Math.min(rows.length-1,selected+1));
   if(key.name==='pageup')offset=Math.min(Math.max(0,observer.state.events.length-1),offset+6);
   if(key.name==='pagedown')offset=Math.max(0,offset-6);
   if(key.name==='return'&&rows[selected]?.evidence){
    const source=observer.state.snapshot?.source;
    detail='Loading saved evidence…';detailOffset=0;draw();
    try{
     const evidence=await invoke('observer_evidence',{reference:rows[selected].evidence,length:4096},controller.signal);
     if(source===observer.state.snapshot?.source&&detail==='Loading saved evidence…')detail=`${evidence.provenance} · ${evidence.partial?'partial':'saved'}${evidence.truncated?' · excerpt':''}\n${evidence.text}`;
    }catch{if(source===observer.state.snapshot?.source&&detail==='Loading saved evidence…')detail='Evidence unavailable. Retry after reconnecting.';}
   }
  }
  draw();
 };
 emitKeypressEvents(input);
 input.on('keypress',keypress);output.on?.('resize',draw);
 process.once('SIGINT',close);process.once('SIGTERM',close);
 try{
  input.setRawMode(true);input.resume();output.write('\x1b[?1049h\x1b[?25l');
  do{
   const source=observer.state.snapshot?.source;
   await observer.poll(controller.signal);
   if(source!==observer.state.snapshot?.source){selected=0;picker=null;detail=null;detailOffset=0;offset=0;}
   selected=Math.min(selected,Math.max(0,actorRows(observer.state).length-1));draw();
   await delay(pollMs,undefined,{signal:controller.signal}).catch(()=>{});
  }while(!controller.signal.aborted);
 }finally{
  input.removeListener('keypress',keypress);output.removeListener?.('resize',draw);
  process.removeListener('SIGINT',close);process.removeListener('SIGTERM',close);
  input.setRawMode(originalRaw);if(!wasFlowing)input.pause();
  output.write('\x1b[0m\x1b[?25h\x1b[?1049l');
 }
 return observer.state;
}
