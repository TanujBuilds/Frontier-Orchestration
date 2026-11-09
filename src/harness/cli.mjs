#!/usr/bin/env node
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {isEntry} from './entry.mjs';
import {waitForState} from './wait.mjs';
import {waitClient} from './wait-client.mjs';
import {Coordinator} from './coordinator.mjs';
import {Worker} from './worker.mjs';
import {Dispatcher} from './tools.mjs';
import {startApi} from './api.mjs';
import {startMcp} from './mcp.mjs';
import {openObserver} from './personal.mjs';

const defaultRoot=path.join(os.homedir(),'Library','Application Support','Frontier Harness');
async function atomic(file,value){await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,file);}
async function connection(root){return JSON.parse(await readFile(path.join(root,'connection.json'),'utf8'));}
async function invoke(root,name,input){const cfg=await connection(root),url=new URL(cfg.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('Authenticated loopback coordinator required');const response=await fetch(new URL('/api/invoke',url),{method:'POST',headers:{authorization:'Bearer '+cfg.token,'content-type':'application/json'},body:JSON.stringify({name,input}),signal:AbortSignal.timeout(35000)}),result=await response.json();if(!response.ok)throw Error(result.error??'Coordinator request failed');return result;}
export async function serve({root,configFile,port,runtimeConfig,headless=false,canStop,verifyCurrentWorker}){
 const raw=runtimeConfig??(configFile?JSON.parse(await readFile(configFile,'utf8')):{}),config={...raw,deepseekBaseUrl:raw.deepseekBaseUrl??raw.DEEPSEEK_BASE_URL,deepseekModelId:raw.deepseekModelId??raw.DEEPSEEK_MODEL_ID},owner=randomUUID(),c=new Coordinator({root,beta:config.beta,workerProfile:config.workerProfile,verifyCurrentWorker});c.acquireWorker(owner);
 const provider=config.environment==='fixture'?{complete:async()=>({content:config.fixtureReply??'Fixture answer',model:'fixture-no-model',usage:{}})}:undefined;
 const worker=new Worker({c,owner,config,provider}),dispatcher=new Dispatcher({c,worker,config});let quitting=false;
 for(const task of c.store.all('task').filter(t=>t.status==='uncertain')){try{c.recoverSaved(task.id,owner);}catch{/* Ambiguous model/backend ownership stays held. */}}
 for(const planning of c.store.all('planning').filter(p=>p.status==='uncertain')){try{c.recoverPlanning(planning.id,owner);}catch{/* Pending planner calls remain spent and exclusive. */}}
 const stop=()=>{quitting=true;};process.once('SIGTERM',stop);process.once('SIGINT',stop);dispatcher.onStop=()=>{canStop?.(c);if(canStop)dispatcher.quiescing=true;stop();};
 let old;try{old=await connection(root);}catch(error){if(error.code!=='ENOENT')throw error;}
 const token=old?.token??randomBytes(32).toString('hex'),viewerToken=old?.viewerToken??randomBytes(32).toString('hex'),api=await startApi({dispatcher,token,viewerToken,port,headless,trustedOrigins:config.observerOrigins??[]});
 await atomic(path.join(root,'connection.json'),{url:api.url,token,viewerToken});await atomic(path.join(root,'viewer-connection.json'),{url:api.url,token:viewerToken,role:'viewer'});await atomic(path.join(root,'service.json'),{pid:process.pid,owner,url:api.url,node:process.versions.node,startedAt:Date.now()});
 process.stdout.write(JSON.stringify({status:'ready',url:api.url,root,node:process.versions.node})+'\n');
 try{
  await dispatcher.recoverOperations(owner);
  while(!quitting){try{await worker.tick();}catch(error){c.emit('service.error',null,null,{reason:error.message.slice(0,1500)});}await delay(250);}
  let active=c.store.all('task').find(t=>t.owner===owner&&t.status==='running');
  if(active){c.store.tx(()=>{active.yieldRequested=true;c.store.put('task',active);});
   const until=Date.now()+25000;while(active&&Date.now()<until){if(active.spec.kind==='research')await worker.adapters.research.step(c.getTask(active.id),owner);else c.boundary(active.id,active.checkpoint,owner);active=c.store.all('task').find(t=>t.owner===owner&&t.status==='running');if(active)await delay(250);}
   if(active)c.markUncertain(active.id,'Service stopped before remote quiescence was confirmed',owner);
  }
 }finally{await api.close();await dispatcher.whenIdle();c.releaseWorker(owner);c.close();process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
export async function main(argv=process.argv.slice(2)){
 if(Number(process.versions.node.split('.')[0])<24)throw Error('Harness requires Node24 or newer');
 if(!argv.length||argv.includes('--help')){process.stdout.write('Mosaic (Node24)\n\nserve --root STATE_DIR --config PRIVATE_CONFIG_JSON [--port 4332]\ncall --root STATE_DIR --tool TOOL_NAME [--input INPUT_JSON_FILE | --input-json JSON]\nstatus --root STATE_DIR\nstop --root STATE_DIR\nmcp --root STATE_DIR\nobserver --root STATE_DIR\nwait --root STATE_DIR (--task ID | --operation ID) [--timeout-ms MS]\n\nKeep the same state root and private config across restarts. Use call --tool tools_list for schemas. Mutations require an idempotencyKey. Native Codex and harness service controls have separate lifecycles.\n');return;}
 const action=argv.shift(),flags={};const invalid=()=>{if(action==='wait')process.exitCode=2;return Error(action==='wait'?'Invalid wait input':'Invalid or duplicate command option');};const allowed={serve:['root','config','port'],call:['root','tool','input','input-json'],status:['root'],stop:['root'],mcp:['root'],observer:['root'],wait:['root','task','operation','timeout-ms']};if(!allowed[action])throw Error('Use serve, call, status, stop, observer or mcp');
 while(argv.length){const flag=argv.shift();if(!flag.startsWith('--')||!allowed[action].includes(flag.slice(2))||!argv.length||argv[0].startsWith('--')||flags[flag.slice(2)]!==undefined)throw invalid();flags[flag.slice(2)]=argv.shift();}
 if(action==='wait'&&(!flags.root||!!flags.task===!!flags.operation||flags['timeout-ms']!==undefined&&!/^[0-9]+$/.test(flags['timeout-ms'])))throw invalid();
 const root=path.resolve(flags.root??defaultRoot);
 if(action==='observer'){const result=await openObserver({root});process.stdout.write(JSON.stringify(result)+'\n');return result;}
 if(action==='wait'){const controller=new AbortController(),cancel=()=>controller.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{const result=await waitForState({invoke:waitClient(root),target:flags.task?'task':'operation',id:flags.task??flags.operation,timeoutMs:flags['timeout-ms']===undefined?30000:Number(flags['timeout-ms']),signal:controller.signal});process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.outcome==='ready'?0:['attention','timeout','cancelled'].includes(result.outcome)?3:2;return result;}catch{throw invalid();}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
 }
 if(action==='serve'){const port=flags.port===undefined?4332:Number(flags.port);if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');return serve({root,configFile:flags.config,port});}
 if(action==='mcp'){const tools=await invoke(root,'tools_list',{});await startMcp({tools,invoke:(name,input)=>invoke(root,name,input)});return;}
 if(action==='status'){try{const result=await invoke(root,'goal_get',{});process.stdout.write(JSON.stringify(result,null,2)+'\n');}catch(error){if(error.code==='ENOENT'||error.cause?.code==='ECONNREFUSED')process.stdout.write(JSON.stringify({status:error.code==='ENOENT'?'not_started':'stopped',root})+'\n');else throw error;}return;}
 let input={};if(flags.input&&flags['input-json'])throw Error('Use one input source');if(flags.input)input=JSON.parse(await readFile(flags.input,'utf8'));if(flags['input-json'])input=JSON.parse(flags['input-json']);
 const tool=action==='status'?'goal_get':action==='stop'?'service_stop':flags.tool;if(!tool)throw Error('Provide --tool TOOL_NAME');if(action==='stop')input={idempotencyKey:randomUUID()};const result=await invoke(root,tool,input);process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(isEntry(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=process.exitCode||1;});
