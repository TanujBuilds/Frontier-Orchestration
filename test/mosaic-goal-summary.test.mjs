import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startApi} from '../src/harness/api.mjs';
import {client as betaClient} from '../src/beta/client.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {seed} from './fixtures/mosaic-goal-summary/mcp.mjs';

function fixture(t,options={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'mosaic-goal-summary-')),c=new Coordinator({root});
 t.after(()=>{c.close();rmSync(root,{recursive:true,force:true});});
 const goals=seed(c,options),dispatcher=new Dispatcher({c});return {root,c,goals,dispatcher};
}
function assertBounded(value){
 const bytes=Buffer.byteLength(JSON.stringify(value));
 assert.ok(bytes<=65536,`default payload exceeds 65536 bytes (actual=${bytes})`);
 assert.equal(Object.keys(value).sort().join(','),'goals,limit,total,truncated','default payload has only summary fields');
 return bytes;
}

test('default goal_get bounds synthetic global history before serialization',async t=>{
 const {dispatcher}=fixture(t,{count:1,heavy:true});
 const value=await dispatcher.invoke('goal_get',{});
 t.diagnostic(`default compact JSON bytes=${Buffer.byteLength(JSON.stringify(value))}`);
 assertBounded(value);
 assert.equal(value.goals.length,1);
 assert.ok(value.goals.every(g=>!['manifest','tasks','reviewerRuns','result'].some(k=>k in g)),'summary excludes full goal children');
});

for(const count of [0,1,50,51,83])test(`latest summaries preserve exact metadata for ${count} goals`,async t=>{
 const {c,goals,dispatcher}=fixture(t,{count});
 // Updating an old record must not turn insertion order into activity order.
 if(count){goals[0].status='stopped';c.store.put('goal',goals[0]);}
 const result=await dispatcher.invoke('goal_get',{});assertBounded(result);
 assert.equal(result.total,count);assert.equal(result.limit,50);assert.equal(result.truncated,count>50);
 assert.deepEqual(result.goals,goals.slice(-50).reverse().map(g=>({id:g.id,status:g.status,hash:g.hash,version:g.version,objective:g.manifest.objective,objectiveTruncated:false,mode:{id:g.manifest.mode.id,version:g.manifest.mode.version},activatedAt:g.activatedAt,deadline:g.deadline})));
});

test('objective prefixes preserve JSON Unicode semantics and serialized byte bounds',async t=>{
 const objectives=['short','😀'.repeat(300),'e\u0301'.repeat(300),'"\\\n\t\r\b\f\0'.repeat(100),'\ud800'.repeat(300),'\udc00'.repeat(300),'prefix\ud800😀\udc00e\u0301'.repeat(100),'a'.repeat(254),'a'.repeat(255)];
 const {c,goals,dispatcher}=fixture(t,{count:objectives.length});
 for(let i=0;i<goals.length;i++){goals[i].manifest.objective=objectives[i];c.store.put('goal',goals[i]);}
 const result=await dispatcher.invoke('goal_get',{});assertBounded(result);
 for(const g of result.goals){
  const original=goals.find(x=>x.id===g.id).manifest.objective;
  assert.ok(original.startsWith(g.objective),'objective is an exact prefix');
  assert.ok(Buffer.byteLength(JSON.stringify(g.objective))<=256,'escaped objective including quotes fits 256 bytes');
  assert.equal(g.objectiveTruncated,g.objective!==original);
  const points=Array.from(original),prefix=Array.from(g.objective);
  assert.equal(points.slice(0,prefix.length).join(''),g.objective,'prefix ends on a codepoint boundary');
  if(g.objectiveTruncated)assert.ok(Buffer.byteLength(JSON.stringify(g.objective+points[prefix.length]))>256,'prefix fills the available serialized budget');
 }
 assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
});

test('missing saved optional metadata is null without fabricated values',async t=>{
 const {c,goals,dispatcher}=fixture(t,{count:1}),g=goals[0];
 delete g.version;delete g.activatedAt;delete g.deadline;delete g.manifest.mode;c.store.put('goal',g);
 const result=await dispatcher.invoke('goal_get',{});assertBounded(result);
 assert.deepEqual(result.goals[0],{id:g.id,status:g.status,hash:g.hash,version:null,objective:g.manifest.objective,objectiveTruncated:false,mode:{id:null,version:null},activatedAt:null,deadline:null});
});

test('summary reads use only limited goal scalar projections and goal count',async t=>{
 const {c,dispatcher}=fixture(t,{count:83,heavy:true});
 c.getGoal=c.snapshot=c.store.all=()=>{throw Error('Summary hydrated global or child state');};
 const prepare=c.store.db.prepare.bind(c.store.db),queries=[];
 c.store.db.prepare=sql=>{queries.push(sql);assert.match(sql,/FROM records/i);assert.match(sql,/kind\s*=\s*'goal'/i);assert.doesNotMatch(sql,/SELECT\s+(?:\*|data\s+FROM)/i);return prepare(sql);};
 const result=await dispatcher.invoke('goal_get',{});assertBounded(result);
 assert.equal(result.goals.length,50);assert.equal(result.total,83);assert.equal(queries.length,2);
 assert.ok(queries.some(sql=>/COUNT\(\*\)/i.test(sql)));
 assert.ok(queries.some(sql=>/ORDER BY rowid DESC LIMIT/i.test(sql)));
});

test('envelope cap omits whole rows and never clips exact IDs or hashes',async t=>{
 const {c,goals,dispatcher}=fixture(t,{count:50});
 for(const g of goals){g.hash='hash-😀"\\\n'.repeat(150);c.store.put('goal',g);}
 const result=await dispatcher.invoke('goal_get',{});const bytes=assertBounded(result);
 assert.ok(result.goals.length>0&&result.goals.length<50);assert.equal(result.total,50);assert.equal(result.truncated,true);
 assert.deepEqual(result.goals.map(g=>g.id),goals.slice(-result.goals.length).reverse().map(g=>g.id));
 for(const row of result.goals)assert.equal(row.hash,goals.find(g=>g.id===row.id).hash);
 t.diagnostic(`escaped metadata envelope bytes=${bytes}; complete rows=${result.goals.length}`);
 const newest=goals.at(-1);newest.id='id-😀'.repeat(20000);newest.hash='exact-hash'.repeat(20000);c.store.put('goal',newest);
 const omitted=await dispatcher.invoke('goal_get',{});assertBounded(omitted);assert.equal(omitted.goals.length,0);assert.equal(omitted.total,51);assert.equal(omitted.truncated,true);
});

test('exact goal and explicit snapshot preserve full legacy equality without a summary cap',async t=>{
 const {c,goals,dispatcher}=fixture(t,{count:1,heavy:true});
 const expected=c.snapshot(),revision=c.store.revision();
 const snapshot=await dispatcher.invoke('goal_get',{view:'snapshot'});
 // Boolean equality keeps assertion diagnostics from dumping multi-MiB state.
 assert.ok(JSON.stringify(snapshot)===JSON.stringify(expected),'explicit snapshot equals the existing full snapshot');
 assert.ok(Buffer.byteLength(JSON.stringify(snapshot))>65536,'explicit snapshot remains intentionally uncapped');
 const goal=await dispatcher.invoke('goal_get',{goalId:goals[0].id});
 assert.ok(JSON.stringify(goal)===JSON.stringify(c.getGoal(goals[0].id)),'exact goal preserves children, manifest and counters');
 assert.ok(Buffer.byteLength(JSON.stringify(goal))>65536,'exact goal inspection remains full');
 assert.equal(c.store.revision(),revision);
});

test('invalid and mixed selectors reject before any coordinator read',async t=>{
 const {c,dispatcher}=fixture(t,{count:1});
 c.getGoal=c.snapshot=c.goalSummaries=()=>{throw Error('Unexpected coordinator read');};
 for(const input of [{view:'summary'},{view:null},{view:1},{view:{}},{view:[]},{view:''},{goalId:'saved',view:'snapshot'}]){
  await assert.rejects(dispatcher.invoke('goal_get',input),error=>/view|combine|together|selector/i.test(error.message)&&!error.message.includes('Unexpected'));
 }
});

test('all read variants preserve revisions, permissions, approvals, reservations and spending',async t=>{
 const {c,goals,dispatcher}=fixture(t,{count:2,heavy:true});
 c.store.put('approval',{id:'synthetic-approval',goalId:goals[0].id,hash:goals[0].hash});
 c.store.put('reservation',{id:'synthetic-reservation',goalId:goals[0].id,limit:1});
 c.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run('synthetic-request','synthetic-task','saved-request','model','completed',JSON.stringify({approved:true}));
 const fingerprint=()=>createHash('sha256').update(JSON.stringify(['records','requests','commands','submissions','events'].map(table=>c.store.db.prepare(`SELECT * FROM ${table}`).all()))).digest('hex');
 const revision=c.store.revision(),before=fingerprint();
 for(let i=0;i<3;i++){
  await dispatcher.invoke('goal_get',{});await dispatcher.invoke('goal_get',{goalId:goals[0].id});await dispatcher.invoke('goal_get',{view:'snapshot'});
  await assert.rejects(dispatcher.invoke('goal_get',{view:'invalid'}));
 }
 assert.equal(c.store.revision(),revision);assert.equal(fingerprint(),before);assert.equal(c.getTask('synthetic-task').spent.model,1);
});

async function apiFixture(t,options={count:1,heavy:true}){
 const f=fixture(t,options),token='a'.repeat(64),viewerToken='b'.repeat(64),api=await startApi({dispatcher:f.dispatcher,token,viewerToken});
 t.after(()=>api.close());
 const call=(input={},headers={authorization:`Bearer ${token}`})=>fetch(api.url+'/api/invoke',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({name:'goal_get',input})});
 const login=await fetch(api.url+'/login',{method:'POST',headers:{origin:api.url,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}),redirect:'manual'});
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 const session=await fetch(api.url+'/api/session',{headers:{cookie}}).then(r=>r.json());
 return {...f,api,token,viewerToken,call,cookie,session};
}

test('authenticated HTTP and beta client expose bounded defaults with unchanged role and CSRF rules',async t=>{
 const f=await apiFixture(t),revision=f.c.store.revision();
 const response=await f.call();assert.equal(response.status,200);const wire=await response.text();assert.ok(Buffer.byteLength(wire)<=65536);assertBounded(JSON.parse(wire));
 for(const input of [{},{view:'snapshot'},{goalId:f.goals[0].id}]){
  assert.equal((await f.call(input,{authorization:`Bearer ${f.viewerToken}`})).status,403);
  assert.equal((await f.call(input,{})).status,401);
  assert.equal((await f.call(input,{cookie:f.cookie,origin:f.api.url})).status,403);
  const allowed=await f.call(input,{cookie:f.cookie,origin:f.api.url,'x-csrf-token':f.session.csrf});assert.equal(allowed.status,200);await allowed.arrayBuffer();
 }
 assert.equal((await f.call({},{authorization:`Bearer ${f.token}`,origin:'https://evil.invalid'})).status,403);
 const paths={home:f.root,state:f.root,isolated:true};
 await writeFile(path.join(f.root,'connection.json'),JSON.stringify({url:f.api.url,token:f.token}),{mode:0o600});
 const beta=betaClient(paths);assertBounded(await beta('goal_get',{}));
 const full=await beta('goal_get',{view:'snapshot'});assert.ok(JSON.stringify(full)===JSON.stringify(f.c.snapshot()),'beta uses the same explicit legacy view');
 assert.equal(f.c.store.revision(),revision);
 t.diagnostic(`HTTP compact JSON bytes=${Buffer.byteLength(wire)}; fixture loopback API closed by test cleanup`);
});

async function cliRun(t,args){
 const child=spawn(process.execPath,[fileURLToPath(new URL('../src/harness/cli.mjs',import.meta.url)),...args],{cwd:repo,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
 const outcome=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
 assert.equal(outcome.code,0,`CLI exit=${outcome.code}; signal=${outcome.signal}; stderr=${stderr.slice(0,400)}`);
 t.diagnostic(`CLI ${args[0]} pid=${child.pid} exit=${outcome.code} signal=${outcome.signal}`);
 return JSON.parse(stdout);
}

test('actual core CLI status lists summaries and explicit call preserves full history',async t=>{
 const f=await apiFixture(t);await writeFile(path.join(f.root,'connection.json'),JSON.stringify({url:f.api.url,token:f.token}),{mode:0o600});
 const revision=f.c.store.revision(),summary=await cliRun(t,['status','--root',f.root]);assertBounded(summary);assert.equal(summary.total,1);
 const full=await cliRun(t,['call','--root',f.root,'--tool','goal_get','--input-json',JSON.stringify({view:'snapshot'})]);
 assert.ok(JSON.stringify(full)===JSON.stringify(f.c.snapshot()),'CLI explicit snapshot retains exact full state');assert.equal(f.c.store.revision(),revision);
});

test('real MCP SDK stdio advertises the read-only selector and returns bounded text JSON',async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'mosaic-summary-mcp-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'seed.json'),JSON.stringify({count:51,heavy:true}));
 const client=new Client({name:'mosaic-goal-summary-test',version:'1.0.0'}),transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/mosaic-goal-summary/mcp.mjs',import.meta.url)),root],cwd:repo,stderr:'pipe'});
 let stderr='';transport.stderr?.on('data',b=>stderr+=b);
 try{
  await client.connect(transport);const pid=transport.pid;
  const {tools}=await client.listTools(),tool=tools.find(t=>t.name==='goal_get');assert.equal(tool.annotations.readOnlyHint,true);assert.deepEqual(tool.inputSchema.properties.view,{type:'string',enum:['snapshot']});
  assert.ok(!tool.inputSchema.required.includes('view'));
  const read=async input=>{const result=await client.callTool({name:'goal_get',arguments:input});assert.equal(result.isError??false,false,'MCP fixture invocation succeeds');return result.content[0].text;};
  const text=await read({});assert.ok(Buffer.byteLength(text)<=65536);const result=JSON.parse(text);assertBounded(result);assert.equal(result.total,51);assert.equal(result.goals.length,50);assert.equal(result.truncated,true);
  const snapshot=JSON.parse(await read({view:'snapshot'})),goal=JSON.parse(await read({goalId:snapshot.goals[0].id}));
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))>65536);assert.ok(JSON.stringify(goal)===JSON.stringify(snapshot.goals[0]),'MCP exact goal retains saved children');
  const invalid=await client.callTool({name:'goal_get',arguments:{view:'invalid'}});assert.equal(invalid.isError,true);
  await client.close();
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'owned MCP process exited after transport close');
  t.diagnostic(`MCP compact text bytes=${Buffer.byteLength(text)}; pid=${pid}; after close ESRCH; stderr bytes=${Buffer.byteLength(stderr)}`);
 }finally{await client.close();}
});

class DomNode{
 constructor(tag='',text=''){this.tag=tag;this.text=text;this.children=[];this.dataset={};this.value='';this.attributes={};}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;this.text='';}
 setAttribute(name,value){this.attributes[name]=value;}
 removeAttribute(name){delete this.attributes[name];}
 addEventListener(){}
 get textContent(){return this.text+this.children.map(n=>n.textContent??String(n)).join('');}
 set textContent(value){this.text=String(value);this.children=[];}
}

test('actual legacy console refresh requests snapshot and renders full goal task history and registry',async t=>{
 const f=await apiFixture(t),nodes=new Map(),views=['work','activity','notifications'].map(view=>{const n=new DomNode('button');n.dataset.view=view;return n;});
 const document={querySelector:s=>{if(s==='#workspace details[open] form')return null;if(!nodes.has(s))nodes.set(s,new DomNode(s));return nodes.get(s);},querySelectorAll:()=>views,createElement:tag=>new DomNode(tag),createTextNode:text=>new DomNode('',text),activeElement:null};
 const requests=[];let booted;const boot=new Promise(resolve=>booted=resolve);
 const context=vm.createContext({document,Node:DomNode,crypto:{randomUUID:()=> 'synthetic-ui'},location:{assign:()=>assert.fail('unexpected login redirect')},setInterval:()=>{booted();return 1;},fetch:async(url,options={})=>{
  if(url==='/api/invoke')requests.push(JSON.parse(options.body));
  return fetch(f.api.url+url,{...options,headers:{...options.headers,cookie:f.cookie,origin:f.api.url}});
 }});
 const source=await readFile(new URL('../src/harness/dashboard/app.js',import.meta.url),'utf8');
 vm.runInContext(source+'\nglobalThis.consoleUnderTest={refresh,state};',context);
 await Promise.race([boot,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Console boot failed')),5000);timer.unref();})]);
 const ui=context.consoleUnderTest;assert.deepEqual(requests,[{name:'goal_get',input:{view:'snapshot'}}]);
 assert.ok(JSON.stringify(ui.state.snapshot)===JSON.stringify(f.c.snapshot()),'actual render receives the full snapshot');
 assert.ok(nodes.get('#workspace').textContent.includes('Synthetic saved task'));assert.ok(nodes.get('#workspace').textContent.includes('Synthetic goal 0'));assert.ok(nodes.get('#mode-select').children.length>=4);
 assert.equal(nodes.get('#connection').textContent,'Coordinator connected');
 ui.state.view='activity';await ui.refresh(true);assert.ok(nodes.get('#workspace').textContent.includes('fixture / history'));
 assert.ok(requests.every(p=>p.input.view==='snapshot'));assert.ok(ui.state.snapshot.operations.length>0);assert.ok(ui.state.snapshot.registry.modes.length>=4);
});
