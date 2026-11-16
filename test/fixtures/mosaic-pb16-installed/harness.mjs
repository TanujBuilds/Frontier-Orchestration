import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,lstat,copyFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const ownedCommands=new Map();
let interrupted=false;
export function beginInterruption(){interrupted=true;}
export async function stopOwnedCommands(){
 interrupted=true;
 const children=[...ownedCommands];for(const [child] of children)child.kill('SIGTERM');
 await Promise.all(children.map(async([child,closed])=>{let timer;try{timer=setTimeout(()=>child.kill('SIGKILL'),5000);await closed;}finally{clearTimeout(timer);}}));
 return children.map(([child])=>({pid:child.pid,code:child.exitCode,signal:child.signalCode}));
}
export async function waitFor(read,{timeout=60000,label='expected durable state',interval=10}={}){
 const end=Date.now()+timeout;let last;
 while(Date.now()<end){try{const value=await read();if(value)return value;}catch(error){if(!['ENOENT','ECONNREFUSED','SQLITE_BUSY'].includes(error.code))throw error;last=error;}await delay(interval);}
 throw Error('Timed out waiting for '+label+(last?' ('+last.message+')':''));
}
export function command(argv,{env,cwd,input,timeout=90000}={}){
 if(interrupted)return Promise.reject(Error('Installed fixture interrupted; no new child may start'));
 return new Promise((resolve,reject)=>{
  const child=spawn(argv[0],argv.slice(1),{env,cwd,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  let finish;ownedCommands.set(child,new Promise(resolve=>{finish=resolve;}));
  child.stdout.on('data',value=>{stdout+=value;});child.stderr.on('data',value=>{stderr+=value;});child.stdin.end(input);
  let escalation;const timer=setTimeout(()=>{child.kill('SIGTERM');escalation=setTimeout(()=>child.kill('SIGKILL'),5000);escalation.unref();},timeout);timer.unref();child.once('error',reject);
  child.once('close',(code,signal)=>{clearTimeout(timer);clearTimeout(escalation);ownedCommands.delete(child);finish();resolve({code,signal,stdout,stderr});});
 });
}
export async function successful(argv,options){const result=await command(argv,options);assert.equal(result.code,0,JSON.stringify({argv,...result}));return result;}
export async function verifyDemo(input){
 const manifest=JSON.parse(await readFile(path.join(input,'demo-input-manifest.json'),'utf8'));
 assert.equal(manifest.playwrightVersion,'1.64.1');assert.equal(manifest.inventorySha256,hash(JSON.stringify(manifest.files)));
 for(const file of manifest.files){const target=path.join(input,file.path),info=await lstat(target);assert.ok(info.isFile()&&!info.isSymbolicLink());assert.equal(info.mode&0o777,file.mode,file.path);assert.equal(info.size,file.bytes,file.path);assert.equal(hash(await readFile(target)),file.sha256,file.path);}
 return manifest;
}
export async function saveUncertainEvidence(h,ownerId,destination){
 assert.equal(h.pid,undefined,'Capture a consistent database after the owned service has stopped');
 assert.equal(h.record('execution_owner',ownerId).status,'uncertain');
 await mkdir(destination,{mode:0o700});const files=[],receipts=[];
 const copy=async(source,name)=>{const info=await lstat(source),before=await readFile(source),target=path.join(destination,name);await copyFile(source,target);assert.equal(hash(await readFile(source)),hash(before),'Stopped evidence changed while copying');assert.equal(hash(await readFile(target)),hash(before));files.push({path:name,sourcePath:source,bytes:before.length,sha256:hash(before),sourceMode:info.mode&0o777});};
 for(const suffix of ['','-wal','-shm']){const source=path.join(h.state,'harness.sqlite3'+suffix);try{await copy(source,'harness.sqlite3'+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}}
 for(const owner of h.rows('execution_owner')){try{await copy(owner.receiptPath,owner.id+'-completion.json');receipts.push({ownerId:owner.id,present:true,path:owner.id+'-completion.json'});}catch(error){if(error.code!=='ENOENT')throw error;receipts.push({ownerId:owner.id,present:false,expectedSourcePath:owner.receiptPath});}}
 const db=new DatabaseSync(path.join(destination,'harness.sqlite3'),{readOnly:true});try{const saved=JSON.parse(db.prepare("SELECT data FROM records WHERE kind='execution_owner' AND id=?").get(ownerId).data);assert.equal(saved.status,'uncertain');assert.deepEqual(saved,h.record('execution_owner',ownerId));}finally{db.close();}
 for(const file of files){const bytes=await readFile(path.join(destination,file.path));file.bytes=bytes.length;file.sha256=hash(bytes);}
 const manifest={schema:1,fixtureOnly:true,retainedOriginalRoot:h.root,sourceDatabase:path.join(h.state,'harness.sqlite3'),heldOwnerId:ownerId,ownerStatus:'uncertain',files,receipts,testWroteProductState:false};
 await writeFile(path.join(destination,'inventory.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});return manifest;
}
export async function installedHarness({bundle,root,profiles,review='host',routing,credentials}){
 await mkdir(root,{mode:0o700});const home=path.join(root,'Temporary User');await mkdir(home,{mode:0o700});
 const env={PATH:'/usr/bin:/bin',HOME:home,TMPDIR:process.env.TMPDIR??'/tmp',LANG:'en_US.UTF-8',CI:'1'};
 assert.equal(spawnSync('/usr/bin/which',['codex'],{env}).status,1);
 const product=path.join(home,'Library/Application Support/Mosaic Beta'),configDir=path.join(product,'config'),state=path.join(product,'state');
 const launcher=path.join(home,'.local/bin/mosaic'),log=[];let service,closed,mcp,transport,stopping,sequence=0;
 const run=async(args,input)=>{const result=await command([launcher,...args],{env,cwd:root,input});log.push({args,code:result.code,stdout:result.stdout,stderr:result.stderr});return result;};
 const installed=await successful([path.join(bundle,'install'),'--home',home,'--no-path'],{env,cwd:root});log.push({action:'install',...installed});
 const installation=JSON.parse(await readFile(path.join(configDir,'installation.json'),'utf8'));
 const version=path.join(product,'versions',installation.version),runtime=path.join(version,'runtime'),checkRoot=path.join(runtime,'check-artifact');
 const artifactManifestPath=path.join(checkRoot,'artifact-manifest.json'),fingerprint=hash(await readFile(artifactManifestPath));
 const executionPolicy={version:1,backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:fingerprint};
 const settings={schema:2,host:{id:'cursor',options:{}},providers:profiles,defaults:{workerId:'worker-a',plannerWorkerId:'worker-a',review:review==='host'?{source:'host',hostId:'cursor'}:{source:'api',reviewer:{id:'fixture-reviewer',revision:'r1'}},routing},execution:{backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:fingerprint},nativeCheckRuntime:{schema:1,artifactManifestPath,artifactManifestSha256:fingerprint},serviceMaxConcurrentTasks:2,capacityGroups:profiles.filter(profile=>profile.roles.includes('worker')).map(profile=>({id:profile.capacityGroup,limit:1}))};
 await writeFile(path.join(configDir,'credentials.json'),JSON.stringify({schema:1,entries:credentials}),{mode:0o600});
 const input=path.join(root,'setup-input.json');await writeFile(input,JSON.stringify(settings),{mode:0o600});
 // Explicitly decline discovery and inference before approving the exact setup.
 const configured=await run(['setup','--config',input],'n\nn\ny\n');assert.equal(configured.code,0,configured.stderr+'\n'+configured.stdout);
 assert.equal((await lstat(path.join(configDir,'settings.json'))).mode&0o777,0o600);
 const {Client}=await import(pathToFileURL(path.join(runtime,'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
 const {StdioClientTransport}=await import(pathToFileURL(path.join(runtime,'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
 function rows(kind){const db=new DatabaseSync(path.join(state,'harness.sqlite3'),{readOnly:true});try{return db.prepare('SELECT data FROM records WHERE kind=?').all(kind).map(row=>JSON.parse(row.data));}finally{db.close();}}
 const record=(kind,id)=>rows(kind).find(row=>row.id===id);
 const requests=()=>{const db=new DatabaseSync(path.join(state,'harness.sqlite3'),{readOnly:true});try{return db.prepare('SELECT * FROM requests ORDER BY id').all();}finally{db.close();}};
 const events=()=>{const db=new DatabaseSync(path.join(state,'harness.sqlite3'),{readOnly:true});try{return db.prepare('SELECT * FROM events ORDER BY seq').all();}finally{db.close();}};
 const disconnect=async()=>{if(mcp){await mcp.close();mcp=null;transport=null;}};
 const connect=async()=>{assert.ok(!mcp);mcp=new Client({name:'mosaic-installed-offline-host',version:'1'});transport=new StdioClientTransport({command:launcher,args:['mcp'],env,stderr:'pipe'});await mcp.connect(transport);};
 const start=async({freezeReady=false}={})=>{
  if(interrupted)throw Error('Installed fixture interrupted; no new service may start');
  assert.ok(!service);let stdout='',stderr='',stopped=false;
  service=spawn(launcher,['serve'],{env,cwd:root,stdio:['ignore','pipe','pipe']});const child=service;
  closed=new Promise(resolve=>child.once('close',(code,signal)=>{log.push({action:'service-exit',pid:child.pid,code,signal,stdout,stderr});resolve({code,signal});}));
  child.stdout.on('data',value=>{stdout+=value;if(freezeReady&&!stopped&&stdout.includes('"status":"ready"')){process.kill(child.pid,'SIGSTOP');stopped=true;}});child.stderr.on('data',value=>{stderr+=value;});
  await waitFor(async()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error('Service exited: '+stderr);const value=JSON.parse(await readFile(path.join(state,'service.json'),'utf8'));return value.pid===child.pid&&(!freezeReady||stopped)&&value;},{label:'installed service readiness'});
  if(!freezeReady)await connect();
 };
 const stop=async({signal='SIGTERM'}={})=>{
  if(stopping)return stopping;if(!service){await disconnect();return;}
  const child=service,completion=closed;
  stopping=(async()=>{
   // SIGKILL terminates a frozen boundary directly. Continuing it first would
   // permit an unobserved extra step before the exact restart.
   if(signal==='SIGKILL')child.kill('SIGKILL');
   else{try{process.kill(child.pid,'SIGCONT');}catch{}child.kill(signal);}
   let timer;try{timer=setTimeout(()=>{log.push({action:'forced-owned-service-stop',pid:child.pid});child.kill('SIGKILL');},30000);await completion;await disconnect();}
   finally{clearTimeout(timer);if(service===child)service=null;}
  })();
  try{return await stopping;}finally{stopping=null;}
 };
 const invoke=async(name,input={})=>{assert.ok(mcp,'Connected installed MCP client required');const result=await mcp.callTool({name,arguments:input},undefined,{timeout:120000});if(result.isError)throw Error(result.content.map(block=>block.text??'').join('\n'));return JSON.parse(result.content.find(block=>block.type==='text').text);};
 const mutate=(name,input,key='installed-'+(++sequence))=>invoke(name,{...input,idempotencyKey:key});
 const operation=async(name,input,key)=>{const pending=await mutate(name,input,key);return waitFor(async()=>{const op=await invoke('operation_get',{operationId:pending.id});if(['failed','uncertain'].includes(op.status))throw Error(op.status+': '+op.error);return op.status==='completed'&&op;},{timeout:120000,label:name+' completed operation'});};
 const restart=async()=>{await stop({signal:'SIGKILL'});await start();};
 const restartAt=async(taskId,predicate,label)=>{
  const child=service;
  const before=await waitFor(async()=>{
   const task=record('task',taskId);if(!task||!predicate(task))return;
   process.kill(child.pid,'SIGSTOP');const frozen=record('task',taskId);
   if(!predicate(frozen)||rows('execution_owner').some(owner=>owner.status!=='quiescent')){process.kill(child.pid,'SIGCONT');return;}
   return frozen;
  },{timeout:90000,label,interval:2});
  await stop({signal:'SIGKILL'});await start({freezeReady:true});const recovered=record('task',taskId);
  for(const field of ['providerBinding','route','routeHash','checkpoint','deadline','hash','goalVersion','attempts'])assert.deepEqual(recovered[field],before[field],label+': '+field);
  process.kill(service.pid,'SIGCONT');await connect();return before;
 };
 return {home,root,env,product,configDir,state,version,runtime,launcher,checkRoot,fingerprint,executionPolicy,settings,initialInstallation:installation,run,log,rows,record,requests,events,start,stop,connect,disconnect,invoke,mutate,operation,restart,restartAt,get pid(){return service?.pid;}};
}
