import {normalizeExecutionPolicy,normalizeNativeCheckRuntime,assertExecutionAvailable} from '../harness/execution.mjs';
import {execFile} from 'node:child_process';
import {access,mkdir,readdir,realpath,rm,rmdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {Writable} from 'node:stream';
import {promisify} from 'node:util';
import path from 'node:path';
import {LocalProvider} from '../harness/provider.mjs';
import {workerEndpoint,workerProfile} from '../harness/worker-profile.mjs';
import {STRUCTURED_WORKER_PROTOCOL} from '../harness/provider-capabilities.mjs';
import {atomic,entry,fileBytes,hash,jsonFile,localDirectory,saveJson,shellQuote,withLock} from './files.mjs';
import {client} from './client.mjs';
import {assertMaintenanceIdle,launchAgent,startLaunchAgent,stopForMaintenance,verifyLaunchAgent} from './service.mjs';
import {canonical} from '../harness/contracts.mjs';
import {getHost,normalizeHostSettings} from './hosts/index.mjs';

const exec=promisify(execFile);
const mcpName='mosaic-beta';
export const starter='Use Mosaic Beta in this repository. Inspect the mosaic-beta registry, ask me to choose a workflow if needed, then prepare an exact goal and show me its scope and limits for approval before activation.';
const skill=`---
name: mosaic-beta
description: Use only for explicit Mosaic Beta requests through the separate local beta coordinator.
---

# Mosaic Beta

Use the \`mosaic-beta\` MCP server for explicit Mosaic Beta work. Use its registry,
goal, task, observer and protected integration tools. The private terminal
observer opens with \`mosaic\`. If the beta server is unavailable, ask the
operator to run \`mosaic doctor\` and reopen Codex.

Use the configured API worker in eligible modes. Protocol actor \`deepseek\` and
mode \`deepseek_only\` are stable identifiers for the selected API worker.
Choose among \`collaborative\`, \`deepseek_only\`, \`codex_only\`, and
\`overnight_review\` with the operator. With no API worker use \`codex_only\`.
Research is parked. Confirm exact manifest and hash with the operator before
activation, including worker profile, project revision, paths, protected checks,
deadline, and call budgets. A setup or mode selection grants no dispatch.
Use unique idempotency keys and inspect existing state before retrying. Use
candidate_v1 for native coding, report real host progress, review saved evidence
after checks pass, and integrate only through the coordinator.
`;

function cli(command,...args){
 return exec(command,args,{timeout:12000,maxBuffer:1024*1024,windowsHide:true});
}

async function findCodex(paths,explicit){
 const candidates=explicit?[explicit]:paths.isolated?[path.join(paths.home,'.local','bin','codex')]:
  [...(process.env.PATH??'').split(path.delimiter).filter(path.isAbsolute).map(dir=>path.join(dir,'codex')),
   path.join(paths.home,'.local','bin','codex'),'/opt/homebrew/bin/codex','/usr/local/bin/codex'];
 for(const candidate of new Set(candidates)){
  if(!path.isAbsolute(candidate))continue;
  try{
   const file=await realpath(candidate);
   if(paths.isolated&&!file.startsWith(await realpath(paths.home)+path.sep))continue;
   if(!(await entry(file))?.isFile())continue;
   await access(file,constants.X_OK);
   return candidate;
  }catch{}
 }
 return null;
}

async function codexLogin(codex){
 try{await cli(codex,'login','status');return true;}catch{return false;}
}

async function hostRegistration(codex){
 try{
  const {stdout}=await cli(codex,'mcp','list','--json');
  const servers=JSON.parse(stdout);
  if(!Array.isArray(servers))throw Error();
  return servers.find(server=>server.name===mcpName)??null;
 }catch{throw Error('Cannot read the beta MCP registration. Check that the installed Codex CLI supports mcp list --json.');}
}

function expectedRegistration(server,paths){
 const transport=server?.transport;
 return server?.name===mcpName&&server.enabled!==false&&transport?.type==='stdio'&&transport.command===paths.launcher&&
  JSON.stringify(transport.args??[])==='["mcp"]'&&Object.keys(transport.env??{}).length===0&&!(transport.env_vars??[]).length&&!transport.cwd;
}

function fingerprint(value){return hash(canonical(value));}
function codexRegistrations(paths){
 if(paths.isolated)return {
  get:()=>jsonFile(paths.isolatedMcp,{privateFile:true,max:8192}),
  add:()=>saveJson(paths.isolatedMcp,{name:mcpName,enabled:true,transport:{type:'stdio',command:paths.launcher,args:['mcp']}}),
  remove:()=>rm(paths.isolatedMcp,{force:true})
 };
 return {
  get:hostRegistration,
  add:codex=>cli(codex,'mcp','add',mcpName,'--',paths.launcher,'mcp'),
  remove:codex=>cli(codex,'mcp','remove',mcpName)
 };
}

function expectedNewRegistration(server,paths){
 return expectedRegistration(server,paths)&&!server.disabled_reason&&server.startup_timeout_sec==null&&server.tool_timeout_sec==null&&
  Object.keys(server).every(key=>['name','enabled','disabled_reason','transport','startup_timeout_sec','tool_timeout_sec','auth_status'].includes(key))&&
  Object.keys(server.transport).every(key=>['type','command','args','env','env_vars','cwd'].includes(key));
}

async function bindingReceipt(paths){
 await localDirectory(paths,paths.configDir,{create:false});
 return jsonFile(paths.ownership,{privateFile:true,max:8192});
}
export async function readSetupIntent(paths){
 await localDirectory(paths,paths.configDir,{create:false});
 const intent=await jsonFile(paths.setupIntent,{privateFile:true,max:32768});
 if(intent&&(intent.schema!==1||!intent.settings||typeof intent.settings.codexPath!=='string'||
    !/^[a-f0-9]{64}$/.test(intent.previousConfigHash??'')||typeof intent.hadAgent!=='boolean'||
    ![intent.previousMcpHash,intent.previousSkillHash].every(hash=>hash===null||/^[a-f0-9]{64}$/.test(hash))))
  throw Error('Invalid private setup intent. Inspect Mosaic Beta settings before continuing.');
 return intent;
}

export async function setupComplete(paths){
 const receipt=await bindingReceipt(paths);
 return !await entry(paths.setupIntent)&&!!receipt?.mcpHash&&!!receipt?.skillHash&&receipt.complete!==false;
}

export async function readSettings(paths){
 await localDirectory(paths,paths.configDir,{create:false});
 const value=await jsonFile(paths.config,{privateFile:true,max:16384});
 if(!value)return null;
 if(value.nativeCheckRuntime!==undefined)value.nativeCheckRuntime=normalizeNativeCheckRuntime(value.nativeCheckRuntime);
 if(value.executionPolicy!==undefined)value.executionPolicy=normalizeExecutionPolicy(value.executionPolicy);
 if(value.host!==undefined)value.host=normalizeHostSettings(value.host);
 if(value.schema!==1||value.codexPath!==undefined&&(typeof value.codexPath!=='string'||!path.isAbsolute(value.codexPath))||!value.codexPath&&(!value.host||value.host.id==='codex'))throw Error('Invalid Mosaic Beta configuration. Run mosaic setup.');
 if(value.worker){
  value.worker.profile=workerProfile(value.worker.profile);
  if(value.worker.apiKey!==undefined&&(!/^[\x21-\x7e]{1,2048}$/.test(value.worker.apiKey)||typeof value.worker.apiKey!=='string'||
     Object.values(value.worker.profile).some(field=>typeof field==='string'&&field.includes(value.worker.apiKey))))throw Error('Invalid private worker credential. Run mosaic setup.');
 }
 return value;
}

async function askSession(input,output,work){
 const queue=[];
 let waiter,closed=false,echo=false;
 const sink=new Writable({write(chunk,_,callback){if(echo)output.write(chunk);callback();}});
 if(output.isTTY){
  sink.isTTY=true;sink.columns=output.columns;sink.rows=output.rows;
 }
 const rl=createInterface({input,output:sink,terminal:!!input.isTTY&&!!output.isTTY,historySize:0});
 rl.on('line',line=>{
  // readline can process more pasted characters before an awaiting prompt resumes.
  echo=false;
  if(waiter){const next=waiter;waiter=null;next(line);}else queue.push(line);
 });
 const finish=()=>{closed=true;const next=waiter;waiter=null;next?.(null);};
 rl.on('SIGINT',()=>rl.close());rl.on('close',finish);
 const ask=async(prompt,{secret=false}={})=>{
  if(secret&&!input.isTTY)throw Error('Bearer keys can only be entered in an interactive terminal.');
  output.write(prompt);
  try{
   const answer=queue.length?queue.shift():closed?null:await new Promise(resolve=>{waiter=resolve;echo=!secret;});
   if(answer===null)throw Error('Setup interrupted. Run mosaic setup to resume.');
   return answer.trim();
  }finally{echo=false;if(secret)output.write('\n');}
 };
 try{return await work(ask);}finally{rl.close();}
}

const WORKER_PROBE_TIMEOUT_MS=10000;
const yes=value=>/^y(es)?$/i.test(value);
const responseMode=profile=>profile.streaming?'streaming SSE':'completed JSON';
const requiresAdvertisedModel=profile=>profile?.capabilities?.modelDiscovery==='advertised';
function discoveryProvider(profile,apiKey){
 return new LocalProvider({...profile,apiKey,openAICompatible:true,timeoutMs:WORKER_PROBE_TIMEOUT_MS});
}

async function configureWorker(ask,output,previous){
 const old=previous?.profile;
 const name=await ask(`Display name${old?` [${old.displayName}]`:''}: `);
 const endpoint=await ask(`OpenAI-compatible API base URL (include /v1 if required)${old?` [${old.baseUrl}]`:''}: `);
 const baseUrl=workerEndpoint(endpoint||old?.baseUrl);
 const displayName=name||old?.displayName||'API worker';
 const keyChoice=await ask('Use a bearer key? [y/N, k to keep an existing key for this URL] ');
 let apiKey;
 if(keyChoice.toLowerCase()==='k'){
  if(!previous?.apiKey||baseUrl!==old.baseUrl)throw Error('An existing key can only be kept for the same base URL.');
  apiKey=previous.apiKey;
 }else if(yes(keyChoice))apiKey=(await ask('Bearer key (hidden): ',{secret:true}))||undefined;
 if(apiKey&&[baseUrl,displayName].some(value=>value.includes(apiKey)))throw Error('The bearer key must appear only in the credential field.');
 const mode=await ask(`Responses [C]ompleted or [s]treaming [${old?.streaming?'s':'c'}]: `);
 const streaming=mode?/^s$/i.test(mode):old?.streaming??false;
 const profile={baseUrl,displayName,streaming,revision:old?.revision??randomUUID()};
 const provider=discoveryProvider(profile,apiKey);
 const discovery=await ask(`Request model IDs from ${baseUrl}/models? [${requiresAdvertisedModel(old)?'Y/n':'y/N'}] `);
 const keepAdvertised=requiresAdvertisedModel(old)&&!/^n(o)?$/i.test(discovery);
 const discover=yes(discovery)||keepAdvertised;
 let models=[];
 if(discover){
  try{models=await provider.listModels(undefined,{strict:true});}
  catch{output.write('Model discovery is unavailable.\n');}
 }
 const choices=models.slice(0,25);
 choices.forEach((model,i)=>output.write(`  ${i+1}. ${model}\n`));
 const choice=await ask(`Model ID${choices.length?' or list number':''}${old?` [${old.model}]`:''}: `);
 const listedModel=/^[1-9]\d*$/.test(choice)?choices[Number(choice)-1]:undefined;
 const model=listedModel??(choice||old?.model);
 if(apiKey&&model?.includes(apiKey))throw Error('The bearer key must appear only in the credential field.');
 const advertised=models.includes(model);
 const modelDiscovery=advertised||keepAdvertised?'advertised':'manual';
 if(advertised)output.write('Completion requests will check that the selected model remains advertised.\n');
 else if(discover)output.write(keepAdvertised?
  'The selected model is not advertised. Completion requests require this model to be advertised.\n':
  'The selected model is not advertised. Setup will save manual model selection.\n');
 const candidate={...profile,model};
 const unchangedLegacy=old&&!old.capabilities&&modelDiscovery==='manual'&&apiKey===previous.apiKey&&canonical(candidate)===canonical(old);
 const sameProvider=old&&old.baseUrl===baseUrl&&old.model===model&&old.streaming===streaming&&apiKey===previous.apiKey;
 const retainedTransports=sameProvider?old.capabilities?.transports:undefined;
 const capabilities={protocol:STRUCTURED_WORKER_PROTOCOL,transports:retainedTransports??[streaming?'sse':'json'],modelDiscovery};
 const final=workerProfile(unchangedLegacy?candidate:{...candidate,capabilities});
 if(old&&(canonical(final)!==canonical(old)||apiKey!==previous.apiKey))final.revision=randomUUID();
 if(yes(await ask('Send one connection-test prompt with no repository data (10 seconds, 32 tokens)? [y/N] '))){
  try{
   const result=await discoveryProvider(final,apiKey).complete([{role:'user',content:'Reply with the single word OK.'}],{
    maxTokens:32,signal:AbortSignal.timeout(WORKER_PROBE_TIMEOUT_MS)
   });
   if(!result.content.trim())throw Error();
   output.write('Connection test received a completion. Coding quality is unverified.\n');
  }catch{output.write('Connection test failed. Check the endpoint, key, model ID and response mode.\n');}
 }
 return {profile:final,...(apiKey?{apiKey}:{})};
}

async function inspectSkill(paths){
 const directory=path.dirname(paths.skill);
 await localDirectory(paths,path.dirname(directory),{create:false});
 const info=await entry(directory);
 if(info&&!info.isDirectory())throw Error('Existing mosaic-beta skill directory is foreign. Preserve '+directory);
 return {directory,info,bytes:await fileBytes(paths.skill,{max:16384})};
}

async function applySetup(paths,intent,registrations,{recovering=false}={}){
 const settings=intent.settings,codex=await findCodex(paths,settings.codexPath);
 if(!codex)throw Error('The Codex CLI used by the interrupted setup is unavailable.');
 const current=await readSettings(paths),currentHash=fingerprint(current);
 const changed=currentHash!==fingerprint(settings);
 if(changed&&currentHash!==intent.previousConfigHash)
  throw Error('Private settings changed since setup began. Preserve them and inspect the pending setup with mosaic doctor.');
 let saved=await registrations.get(codex);
 if(saved&&(!expectedRegistration(saved,paths)||(intent.previousMcpHash?fingerprint(saved)!==intent.previousMcpHash:!expectedNewRegistration(saved,paths))))
  throw Error('Existing mosaic-beta MCP registration is foreign or has changed. Preserve it and inspect the beta registration.');
 const {directory,info,bytes}=await inspectSkill(paths);
 if(bytes&&(bytes.toString()!==skill||intent.previousSkillHash&&hash(bytes)!==intent.previousSkillHash)||
    !bytes&&info&&(intent.previousSkillHash|| (await readdir(directory)).length))
  throw Error('Existing mosaic-beta skill has changed. Preserve '+paths.skill);
 const allowUnrecorded=!intent.hadAgent;
 await verifyLaunchAgent(paths,{allowUnrecorded});
 if(changed)await stopForMaintenance(paths,{allowUnrecorded,recovering});
 if(!saved){
  try{await registrations.add(codex);}catch{throw Error('Could not add the beta MCP registration. Run mosaic setup to retry.');}
  saved=await registrations.get(codex);
 }
 if(!expectedNewRegistration(saved,paths)&&(!intent.previousMcpHash||!saved||fingerprint(saved)!==intent.previousMcpHash))
  throw Error('The beta MCP registration does not match the approved launcher.');
 if(!bytes){
  await localDirectory(paths,path.dirname(directory));
  if(!info)await mkdir(directory,{mode:0o700});
  await atomic(paths.skill,skill);
 }
 if(changed)await saveJson(paths.config,settings);
 await startLaunchAgent(paths,{allowUnrecorded});
 await saveJson(paths.ownership,{schema:1,complete:true,mcpHash:fingerprint(saved),skillHash:hash(skill),codex,
  ...(!paths.isolated?{launchAgentHash:hash(launchAgent(paths))}:{})});
 await rm(paths.setupIntent);
}

function printCompletion(paths,output,{resumed=false}={}){
 if(resumed)output.write('Resumed interrupted setup.\n');
 output.write(paths.isolated?'Setup saved. Isolated registration stays inside the fixture home. Start it with mosaic serve.\n':
  'Setup saved. Reopen Codex so it loads the new MCP server.\n');
 output.write('\nStarter prompt\n'+starter+'\n');
}

export async function setup(paths,{explicitCodex,input=process.stdin,output=process.stdout,registrations=codexRegistrations(paths)}={}){
 const old=await readSettings(paths);
 if(old?.host&&old.host.id!=='codex'){
  output.write(`The current host is ${old.host.id}. This interactive setup configures Codex only; existing settings and registrations are preserved. Use mosaic host-preview --host ${old.host.id} for that host's manual configuration path.\n`);
  return false;
 }
 if(await entry(paths.setupIntent)){
  await withLock(paths,async()=>{
   const intent=await readSetupIntent(paths);
   if(intent)await applySetup(paths,intent,registrations,{recovering:true});
  });
  printCompletion(paths,output,{resumed:true});
  return true;
 }
 const codex=await findCodex(paths,explicitCodex??old?.codexPath);
 if(!codex){
  output.write('Codex CLI is required. Install it from https://developers.openai.com/codex/cli, run codex login, then run mosaic setup again.\n');
  return false;
 }
 if(!paths.isolated&&!await codexLogin(codex)){
  output.write('Sign in with codex login, then run mosaic setup again.\n');
  return false;
 }
 return askSession(input,output,async ask=>{
  const choice=await ask(`Mosaic Beta setup\n  1. Codex only\n  2. Codex + API worker\nChoose [${old?.worker?'2':'1'}]: `)||(old?.worker?'2':'1');
  if(!['1','2'].includes(choice))throw Error('Choose 1 or 2 and run mosaic setup again.');
  const worker=choice==='2'?await configureWorker(ask,output,old?.worker):null;
  // Reapplying legacy settings must not migrate their serialized shape. The
  // service derives trusted Codex context from an existing validated codexPath.
  const settings=old?{...old,codexPath:codex,worker}:{schema:1,host:{id:'codex',options:{}},codexPath:codex,worker};
  const {launcher,skill:skillFile,config,plist}=paths;
  const registrationPreview=paths.isolated?`Isolated MCP: ${paths.isolatedMcp} → ${shellQuote(launcher)} mcp`:
   `Codex MCP: ${shellQuote(codex)} mcp add mosaic-beta -- ${shellQuote(launcher)} mcp`;
  output.write(`\nPrivate settings: ${config}\n${registrationPreview}\nSkill: ${skillFile}\n`);
  if(!paths.isolated)output.write(`LaunchAgent: ${plist}\n`);
  output.write(worker?`Worker: ${worker.profile.displayName} · ${worker.profile.baseUrl} · ${worker.profile.model} · ${responseMode(worker.profile)} · ${requiresAdvertisedModel(worker.profile)?'advertised model required':'manual model selection'}\n`:'Worker: Codex only\n');
  if(!yes(await ask('Apply these beta settings and registrations? [y/N] ')))return false;
  return withLock(paths,async()=>{
   if(await entry(paths.setupIntent))throw Error('Another setup already has pending changes. Run mosaic setup to resume.');
   const current=await readSettings(paths);
   if(canonical(current)!==canonical(old))throw Error('Mosaic Beta setup changed while the prompt was open. Run mosaic setup again.');
   const ownership=await bindingReceipt(paths),existing=await registrations.get(codex);
   if(existing&&(!expectedRegistration(existing,paths)||ownership?.mcpHash!==fingerprint(existing)))
    throw Error('Existing mosaic-beta MCP registration is foreign or has changed. Preserve it and inspect the beta registration.');
   const {info,bytes}=await inspectSkill(paths);
   if(bytes&&(!ownership||hash(bytes)!==ownership.skillHash||bytes.toString()!==skill)||!bytes&&info)
    throw Error('Existing mosaic-beta skill is foreign or has changed. Preserve '+skillFile);
   const hadAgent=await verifyLaunchAgent(paths);
   if(fingerprint(current)!==fingerprint(settings))await assertMaintenanceIdle(paths);
   const intent={schema:1,settings,hadAgent,previousConfigHash:fingerprint(current),previousMcpHash:existing?fingerprint(existing):null,previousSkillHash:bytes?hash(bytes):null};
   await saveJson(paths.setupIntent,intent);
   await applySetup(paths,intent,registrations);
   printCompletion(paths,output);
   return true;
  });
 });
}

export async function doctor(paths,output=process.stdout){
 const checks=[];
 const check=(name,ok,detail)=>checks.push({name,ok,detail});
 let settings;
 try{settings=await readSettings(paths);}catch{check('Settings',false,'Invalid private config. Run mosaic setup.');}
 try{
  if(settings&&!await setupComplete(paths))check('Setup',false,'Setup needs attention. Run mosaic setup to restore or resume its bindings.');
 }catch{check('Setup',false,'Cannot read the private beta binding receipt. Inspect the beta settings directory.');}
 check('Installation',!!await entry(paths.launcher),'Expected launcher '+paths.launcher);
 if(!checks.some(item=>item.name==='Settings'))check('Settings',!!settings,settings?'Private setup saved.':'Run mosaic setup.');
 const selectedHost=settings?.host?.id??'codex';
 if(selectedHost==='codex'){
 const codex=await findCodex(paths,settings?.codexPath);
 check('Codex CLI',!!codex,codex??'Install the Codex CLI, then run codex login.');
 if(codex){
  if(!paths.isolated){
   const login=await codexLogin(codex);
   check('Codex sign-in',login,login?'Signed in.':'Run codex login.');
  }
  const checkName=paths.isolated?'Isolated MCP fixture':'Codex MCP';
  try{
   const server=await codexRegistrations(paths).get(codex),ownership=await bindingReceipt(paths);
   const own=expectedRegistration(server,paths)&&ownership?.mcpHash===fingerprint(server);
   check(checkName,own,own?(paths.isolated?'Fixture registration points to this launcher; host registration and sign-in are outside this check.':'mosaic-beta points to this launcher.'):'Run mosaic setup or inspect a conflicting mosaic-beta entry.');
  }catch{check(checkName,false,paths.isolated?'Cannot read fixture registration. Run mosaic setup.':'Cannot read registration. Check codex mcp list.');}
 }
 }else check('Host',true,getHost(selectedHost).displayName+' selected; inspect its Mosaic MCP connection in the host.');
 if(settings&&(selectedHost!=='codex'||settings.executionPolicy)){
  try{assertExecutionAvailable({...settings,executionPolicy:settings.executionPolicy??{version:1,backend:'codex-sandbox',backendRevision:1}},{codexPath:settings.codexPath,nativeCheckRuntime:settings.nativeCheckRuntime});check('Protected checks',true,'Configured backend prerequisites found; actual enforcement probe is required before work.');}
  catch(error){check('Protected checks',false,error.message);}
 }
 try{await client(paths,{viewer:true})('tools_list');check('Coordinator',true,'Authenticated viewer connection ready.');}
 catch{check('Coordinator',false,paths.isolated?'Start the isolated instance with mosaic serve.':'Run mosaic setup to repair the LaunchAgent.');}
 if(settings?.worker){
  const {profile,apiKey}=settings.worker;
  const requireAdvertised=requiresAdvertisedModel(profile);
  const untested=` The configured ${responseMode(profile)} completion is untested.`;
  try{
   const models=await discoveryProvider(profile,apiKey).listModels(undefined,{strict:requireAdvertised});
   const advertised=models.includes(profile.model);
   check('API worker',advertised||!requireAdvertised,(advertised?`${profile.displayName} advertised the configured model.`:
    requireAdvertised?'The required model is not advertised.':'Discovery works. The manual model ID is not advertised.')+untested);
  }catch(error){
   const unsupported=error.httpStatus===404||error.httpStatus===405;
   check('API worker',!requireAdvertised&&unsupported,(requireAdvertised?
    'Could not confirm the required model through discovery. Check the endpoint and bearer key.':
    unsupported?'Discovery is unsupported. The model is configured manually.':'Model discovery failed. Check the endpoint and bearer key.')+untested);
  }
 }else check('API worker',true,selectedHost==='codex'?'Codex only.':'No API worker configured.');
 for(const {name,ok,detail} of checks)output.write(`${ok?'OK':'CHECK'}  ${name} · ${detail}\n`);
 return checks.every(item=>item.ok);
}

export async function removeCodexBindings(paths,output=process.stdout,intent=null){
 const ownership=await bindingReceipt(paths);
 if(!ownership&&!intent)return;
 const registrations=codexRegistrations(paths);
 const codex=paths.isolated?null:await findCodex(paths,intent?.settings.codexPath??ownership?.codex);
 if(paths.isolated||codex){
  const existing=await registrations.get(codex);
  const owned=existing&&expectedRegistration(existing,paths)&&
   (fingerprint(existing)===(ownership?.mcpHash??intent?.previousMcpHash)||intent&&!intent.previousMcpHash&&expectedNewRegistration(existing,paths));
  if(owned)await registrations.remove(codex);
  else if(existing)output.write('Preserved modified mosaic-beta MCP registration.\n');
 }else output.write('Codex CLI unavailable. Inspect the mosaic-beta MCP registration manually.\n');
 let saved;
 try{saved=await inspectSkill(paths);}catch{output.write('Preserved modified mosaic-beta skill.\n');return;}
 if(saved.bytes&&(hash(saved.bytes)===(ownership?.skillHash??intent?.previousSkillHash)||intent&&!intent.previousSkillHash&&saved.bytes.toString()===skill)){
  await rm(paths.skill);
  await rmdir(saved.directory).catch(error=>{if(error.code!=='ENOTEMPTY')throw error;});
 }else if(saved.bytes)output.write('Preserved modified mosaic-beta skill.\n');
 else if(saved.info&&intent&&!intent.previousSkillHash)
  await rmdir(saved.directory).catch(error=>{if(error.code!=='ENOTEMPTY')throw error;});
}

// Read-only preparation. Actual host writes require an explicit injected adapter;
// the legacy interactive setup remains its separately supported Codex path.
export function previewHostRegistration(paths,hostId,{launcher=paths.launcher,existing}={}){
 return getHost(hostId).previewRegistration({paths,launcher,existing});
}
