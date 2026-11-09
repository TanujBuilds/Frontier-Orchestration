import {execFile} from 'node:child_process';
import {access,mkdir,realpath,rm,rmdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {Writable} from 'node:stream';
import {promisify} from 'node:util';
import path from 'node:path';
import {LocalProvider} from '../harness/provider.mjs';
import {workerEndpoint,workerProfile} from '../harness/worker-profile.mjs';
import {atomic,entry,fileBytes,hash,jsonFile,saveJson,shellQuote,withLock} from './files.mjs';
import {client} from './client.mjs';
import {launchAgent,rollbackLaunchAgent,startLaunchAgent,stopForMaintenance,verifyLaunchAgent} from './service.mjs';
import {canonical} from '../harness/contracts.mjs';

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

async function registration(codex){
 try{
  const {stdout}=await cli(codex,'mcp','list','--json');
  const servers=JSON.parse(stdout);
  if(!Array.isArray(servers))throw Error();
  return servers.find(server=>server.name===mcpName)??null;
 }catch{throw Error('Cannot read the beta MCP registration. Check that the installed Codex CLI supports mcp list --json.');}
}

function expectedRegistration(server,paths){
 const transport=server?.transport;
 return server?.enabled!==false&&transport?.type==='stdio'&&transport.command===paths.launcher&&
  JSON.stringify(transport.args??[])==='["mcp"]'&&Object.keys(transport.env??{}).length===0&&!(transport.env_vars??[]).length&&!transport.cwd;
}

function fingerprint(value){return hash(canonical(value));}
const addMcp=(codex,paths)=>cli(codex,'mcp','add',mcpName,'--',paths.launcher,'mcp');
const removeMcp=codex=>cli(codex,'mcp','remove',mcpName);

export async function readSettings(paths){
 const value=await jsonFile(paths.config,{privateFile:true,max:16384});
 if(!value)return null;
 if(value.schema!==1||typeof value.codexPath!=='string'||!path.isAbsolute(value.codexPath))throw Error('Invalid Mosaic Beta configuration. Run mosaic setup.');
 if(value.worker){
  value.worker.profile=workerProfile(value.worker.profile);
  if(value.worker.apiKey!==undefined&&(!/^[\x21-\x7e]{1,2048}$/.test(value.worker.apiKey)||typeof value.worker.apiKey!=='string'||
     Object.values(value.worker.profile).some(field=>typeof field==='string'&&field.includes(value.worker.apiKey))))throw Error('Invalid private worker credential. Run mosaic setup.');
 }
 return value;
}

async function askSession(input,output,work){
 const queue=[];
 let waiter,closed=false,masked=false;
 const sink=new Writable({write(chunk,_,callback){if(!masked)output.write(chunk);callback();}});
 if(output.isTTY){
  sink.isTTY=true;sink.columns=output.columns;sink.rows=output.rows;
 }
 const rl=createInterface({input,output:sink,terminal:!!input.isTTY&&!!output.isTTY,historySize:0});
 rl.on('line',line=>{if(waiter){const next=waiter;waiter=null;next(line);}else queue.push(line);});
 const finish=()=>{closed=true;const next=waiter;waiter=null;next?.(null);};
 rl.on('SIGINT',()=>rl.close());rl.on('close',finish);
 const ask=async(prompt,{secret=false}={})=>{
  if(secret&&!input.isTTY)throw Error('Bearer keys can only be entered in an interactive terminal.');
  output.write(prompt);
  masked=secret;
  try{
   const answer=queue.length?queue.shift():closed?null:await new Promise(resolve=>{waiter=resolve;});
   if(answer===null)throw Error('Setup interrupted. Run mosaic setup to resume.');
   return answer.trim();
  }finally{masked=false;if(secret)output.write('\n');}
 };
 try{return await work(ask);}finally{rl.close();}
}

const yes=value=>/^y(es)?$/i.test(value);
function discoveryProvider(profile,apiKey,model){
 return new LocalProvider({baseUrl:profile.baseUrl,model,apiKey,openAICompatible:true,streaming:profile.streaming,timeoutMs:10000});
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
 const streaming= /^s$/i.test(await ask('Responses [C]ompleted (default) or [s]treaming? '));
 const profile={baseUrl,displayName,streaming,revision:randomUUID()};
 const provider=discoveryProvider(profile,apiKey);
 let models=[];
 if(yes(await ask(`Request model IDs from ${baseUrl}/models? [y/N] `))){
  try{models=(await provider.listModels()).slice(0,25);models.forEach((model,i)=>output.write(`  ${i+1}. ${model}\n`));}
  catch{output.write('Model discovery is unavailable. Enter a model ID manually.\n');}
 }
 const choice=await ask(`Model ID${models.length?' or list number':''}${old?` [${old.model}]`:''}: `);
 const model=/^[1-9]\d*$/.test(choice)&&models[Number(choice)-1]?models[Number(choice)-1]:choice||old?.model;
 if(apiKey&&model?.includes(apiKey))throw Error('The bearer key must appear only in the credential field.');
 const final=workerProfile({...profile,model});
 if(old&&canonical({...final,revision:old.revision})===canonical(old)&&apiKey===previous.apiKey)final.revision=old.revision;
 if(yes(await ask('Send one connection-test prompt with no repository data (10 seconds, 32 tokens)? [y/N] '))){
  try{
   const result=await discoveryProvider(final,apiKey,final.model).complete([{role:'user',content:'Reply with the single word OK.'}],{maxTokens:32});
   if(!result.content.trim())throw Error();
   output.write('Connection test received a completion. Coding quality is unverified.\n');
  }catch{output.write('Connection test failed. Check the endpoint, key, model ID and response mode.\n');}
 }
 return {profile:final,...(apiKey?{apiKey}:{})};
}

export async function setup(paths,{explicitCodex,input=process.stdin,output=process.stdout}={}){
 const old=await readSettings(paths);
 const codex=await findCodex(paths,explicitCodex??old?.codexPath);
 if(!codex){
  output.write('Codex CLI is required. Install it from https://developers.openai.com/codex/cli, run codex login, then run mosaic setup again.\n');
  return false;
 }
 if(!await codexLogin(codex)){
  output.write('Sign in with codex login, then run mosaic setup again.\n');
  return false;
 }
 return askSession(input,output,async ask=>{
  const choice=await ask(`Mosaic Beta setup\n  1. Codex only\n  2. Codex + API worker\nChoose [${old?.worker?'2':'1'}]: `)||(old?.worker?'2':'1');
  if(!['1','2'].includes(choice))throw Error('Choose 1 or 2 and run mosaic setup again.');
  const worker=choice==='2'?await configureWorker(ask,output,old?.worker):null;
  const settings={schema:1,codexPath:codex,worker};
  const {launcher,skill:skillFile,config,plist}=paths;
  output.write(`\nPrivate settings: ${config}\nCodex MCP: ${shellQuote(codex)} mcp add mosaic-beta -- ${shellQuote(launcher)} mcp\nSkill: ${skillFile}\n`);
  if(!paths.isolated)output.write(`LaunchAgent: ${plist}\n`);
  output.write(worker?`Worker: ${worker.profile.displayName} · ${worker.profile.baseUrl} · ${worker.profile.model} · ${worker.profile.streaming?'streaming':'completed'}\n`:'Worker: Codex only\n');
  if(!yes(await ask('Apply these beta settings and registrations? [y/N] ')))return false;
  return withLock(paths,async()=>{
   const current=await readSettings(paths);
   if(canonical(current)!==canonical(old))throw Error('Mosaic Beta setup changed while the prompt was open. Run mosaic setup again.');
   const ownership=await jsonFile(paths.ownership,{privateFile:true,max:8192});
   const existing=await registration(codex);
   if(existing&&(!expectedRegistration(existing,paths)||ownership?.mcpHash!==fingerprint(existing)))throw Error('Existing mosaic-beta MCP registration is foreign or has changed. Preserve it and inspect codex mcp list.');
   const savedSkill=await fileBytes(skillFile,{max:16384});
   if(savedSkill&&(!ownership||hash(savedSkill)!==ownership.skillHash||savedSkill.toString()!==skill))throw Error('Existing mosaic-beta skill is foreign or has changed. Preserve '+skillFile);
   if(!savedSkill&&await entry(path.dirname(skillFile)))throw Error('Existing mosaic-beta skill directory is foreign. Preserve '+path.dirname(skillFile));
   const existed=await verifyLaunchAgent(paths);
   const changed=canonical(current)!==canonical(settings);
   const registered=changed?await stopForMaintenance(paths):false;
   let addedMcp=false,addedSkill=false,configChanged=false;
   try{
    if(!existing){try{await addMcp(codex,paths);}catch{throw Error('Codex could not add the mosaic-beta MCP registration. Inspect codex mcp list.');}addedMcp=true;}
    const saved=await registration(codex);
    if(!expectedRegistration(saved,paths))throw Error('The beta MCP registration does not match the installed launcher.');
    if(!savedSkill){
     await mkdir(path.dirname(path.dirname(skillFile)),{recursive:true,mode:0o700});
     await mkdir(path.dirname(skillFile),{mode:0o700});addedSkill=true;
     await atomic(skillFile,skill);
    }
    if(changed){await saveJson(config,settings);configChanged=true;}
    await startLaunchAgent(paths);
    await saveJson(paths.ownership,{schema:1,mcpHash:fingerprint(saved),skillHash:hash(skill),codex,...(!paths.isolated?{launchAgentHash:hash(launchAgent(paths))}:{})});
   }catch(error){
    const rollbackErrors=[];
    const recover=async action=>{try{await action();}catch{rollbackErrors.push('beta rollback step failed');}};
    if(configChanged)await recover(()=>current?saveJson(config,current):rm(config,{force:true}));
    if(changed||!existed)await recover(()=>rollbackLaunchAgent(paths,{existed,registered}));
    if(addedSkill)await recover(async()=>{await rm(skillFile,{force:true});await rmdir(path.dirname(skillFile));});
    if(addedMcp)await recover(async()=>{if(expectedRegistration(await registration(codex),paths))await removeMcp(codex);});
    if(rollbackErrors.length)throw Error(error.message+' Some beta bindings need inspection with mosaic doctor.');
    throw error;
   }
   output.write('Setup saved. Reopen Codex so it loads the new MCP server.\n\nStarter prompt\n'+starter+'\n');
   if(paths.isolated)output.write('Start the isolated coordinator with mosaic serve.\n');
   return true;
  });
 });
}

export async function doctor(paths,output=process.stdout){
 const checks=[];
 const check=(name,ok,detail)=>checks.push({name,ok,detail});
 let settings;
 try{settings=await readSettings(paths);}catch{check('Settings',false,'Invalid private config. Run mosaic setup.');}
 check('Installation',!!await entry(paths.launcher),'Expected launcher '+paths.launcher);
 if(!checks.some(item=>item.name==='Settings'))check('Settings',!!settings,settings?'Private setup saved.':'Run mosaic setup.');
 const codex=await findCodex(paths,settings?.codexPath);
 check('Codex CLI',!!codex,codex??'Install the Codex CLI, then run codex login.');
 if(codex){
  const login=await codexLogin(codex);
  check('Codex sign-in',login,login?'Signed in.':'Run codex login.');
  try{
   const server=await registration(codex),ownership=await jsonFile(paths.ownership,{privateFile:true,max:8192});
   const own=expectedRegistration(server,paths)&&ownership?.mcpHash===fingerprint(server);
   check('Codex MCP',own,own?'mosaic-beta points to this launcher.':'Run mosaic setup or inspect a conflicting mosaic-beta entry.');
  }catch{check('Codex MCP',false,'Cannot read registration. Check codex mcp list.');}
 }
 try{await client(paths,{viewer:true})('tools_list');check('Coordinator',true,'Authenticated viewer connection ready.');}
 catch{check('Coordinator',false,paths.isolated?'Start the isolated instance with mosaic serve.':'Run mosaic setup to repair the LaunchAgent.');}
 if(settings?.worker){
  const {profile,apiKey}=settings.worker;
  try{
   const models=await discoveryProvider(profile,apiKey).listModels();
   check('API worker',true,models.includes(profile.model)?`${profile.displayName} advertised the configured model.`:'Discovery works. The manual model ID is not advertised; check it or use the optional setup connection test.');
  }catch(error){
   const reachable=error.httpStatus===404||error.httpStatus===405;
   check('API worker',reachable,reachable?'Discovery is unsupported. The manually selected model can be checked with the optional setup connection test.':'Model discovery failed. Check the endpoint and bearer key, or verify the manual model in setup.');
  }
 }else check('API worker',true,'Codex only.');
 for(const {name,ok,detail} of checks)output.write(`${ok?'OK':'CHECK'}  ${name} · ${detail}\n`);
 return checks.every(item=>item.ok);
}

export async function removeCodexBindings(paths,output=process.stdout){
 const ownership=await jsonFile(paths.ownership,{privateFile:true,max:8192});
 if(!ownership)return;
 const codex=await findCodex(paths,ownership.codex);
 if(codex){
  const existing=await registration(codex);
  if(existing&&expectedRegistration(existing,paths)&&fingerprint(existing)===ownership.mcpHash)await removeMcp(codex);
  else if(existing)output.write('Preserved modified mosaic-beta MCP registration.\n');
 }else output.write('Codex CLI unavailable. Inspect the mosaic-beta MCP registration manually.\n');
 let bytes;
 try{bytes=await fileBytes(paths.skill,{max:16384});}catch{output.write('Preserved modified mosaic-beta skill.\n');return;}
 if(bytes&&hash(bytes)===ownership.skillHash){
  await rm(paths.skill);
  await rmdir(path.dirname(paths.skill)).catch(error=>{if(error.code!=='ENOTEMPTY')throw error;});
 }else if(bytes)output.write('Preserved modified mosaic-beta skill.\n');
}
