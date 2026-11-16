import {mkdir,cp,readFile,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {Journal} from '../../src/project/journal.mjs';
import {Workspace} from '../../src/project/workspace.mjs';
import {git} from '../../src/project/process.mjs';
import {Coordinator} from '../../src/harness/coordinator.mjs';
import {approvedChecks} from '../../src/harness/execution.mjs';
import {validateNativeCheckRuntime,nativeDependencyInventory} from '../../src/project/check-backends/darwin-seatbelt-v2.mjs';
import {validateOutput,inventoryPostgres,sourceInventory,fileIdentity,sourceRoot,command,hash,safePath} from './prerequisites.mjs';
import {jsonFile,sealReport,summary,classifyConnection} from './report.mjs';

const fixtures=fileURLToPath(new URL('../../test/fixtures/native-app-feasibility/',import.meta.url));
const ids=['handler','offline_browser','tcp','unix','postgres','networked_api'];
const missing=detail=>({state:'not_run_missing_prerequisite',detail});
export async function probeHost(target,token){
  return new Promise(resolve=>{
    let data='',settled=false;
    const socket=net.connect(target);
    const finish=value=>{if(settled)return;settled=true;socket.destroy();resolve(value);};
    socket.on('data',b=>{data+=b.toString();if(data.length>256)finish({passed:false,code:'OVERSIZED'});});
    socket.on('end',()=>finish({passed:data===token,payload:data}));
    socket.on('error',e=>finish({passed:false,code:e.code??null}));
    socket.setTimeout(2000,()=>finish({passed:false,code:'ETIMEDOUT'}));
  });
}
async function canary({kind,root,execute}){
  const token=randomUUID();const server=net.createServer(socket=>{socket.on('error',()=>{});socket.end(token);});
  const endpoint=kind==='tcp'?{host:'127.0.0.1',port:0}:{path:path.join(root,'u')};
  let listening=false;
  try{
    if(endpoint.path&&Buffer.byteLength(endpoint.path)>100)return {state:'inconclusive',detail:'Owned Unix socket path exceeds portable macOS bound'};
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,()=>{listening=true;resolve();});});
    const target=kind==='tcp'?{host:'127.0.0.1',port:server.address().port}:endpoint;
    const before=await probeHost(target,token);
    // An unhealthy fixture never becomes a denial claim; keep independent lanes running.
    let result=null;if(before.passed)result=await execute('connect',[JSON.stringify(target)]);
    const after=await probeHost(target,token);
    if(result?.observation&&JSON.stringify(result.observation.target)!==JSON.stringify(target))result.observation=null;
    return {state:classifyConnection({before,after,result,token}),detail:'Actual revision2 boundary connection; host token checked before and after',target,before,after,result};
  }catch(e){if(e.executionOutcome==='unknown')throw e;return {state:'inconclusive',detail:'Canary fixture unavailable',errorCode:e.code??null};}
  finally{if(listening)await new Promise(resolve=>server.close(resolve));else server.close();}
}
function functional(good,bad,kind,assertions){
  return good?.code===0&&!good.stopped&&good.quiescence?.groupESRCH&&good.observation?.schema===1&&good.observation.kind===kind&&good.observation.assertions===assertions&&bad?.code===1&&!bad.stopped&&bad.quiescence?.groupESRCH&&/AssertionError/.test(bad.stderr)?'passed':'failed';
}
export async function runQualification(options){
  await validateOutput(options.output);
  // All caller-controlled input validation precedes output creation.
  const postgres=await inventoryPostgres(options.postgresBinDir);
  const nativeConfig=process.env.MOSAIC_NATIVE_ARTIFACT_MANIFEST?{schema:1,artifactManifestPath:process.env.MOSAIC_NATIVE_ARTIFACT_MANIFEST,artifactManifestSha256:process.env.MOSAIC_NATIVE_ARTIFACT_SHA256}:null;
  if(nativeConfig&&(!/^[a-f0-9]{64}$/.test(nativeConfig.artifactManifestSha256??'')))throw Error('Native artifact requires an explicit SHA256 fingerprint');
  if(!nativeConfig&&process.env.MOSAIC_NATIVE_ARTIFACT_SHA256)throw Error('Native fingerprint requires its manifest');
  let runtime=null,runtimeError=null;
  if(nativeConfig){try{runtime=validateNativeCheckRuntime(nativeConfig,nativeConfig.artifactManifestSha256);}catch(e){runtimeError={code:e.code??null,detail:e.message.slice(0,1000)};}}
  const root=options.output;
  const sourceBefore=await sourceInventory();
  await mkdir(root,{mode:0o700});await mkdir(path.join(root,'evidence'),{mode:0o700});
  const inventory={source:{commit:sourceBefore.commit,tree:sourceBefore.tree,dirty:sourceBefore.dirty,inventorySha256:sourceBefore.sha256},os:{platform:process.platform,arch:process.arch,release:os.release()},officialRuntime:{...await fileIdentity(process.execPath),version:process.version},runtime:runtime?{backend:{id:'darwin-seatbelt',revision:2},fingerprint:runtime.fingerprint,runtime:runtime.runtime,supervisor:runtime.supervisor,sandbox:runtime.sandbox,implementationHash:runtime.implementationHash,version:command([runtime.runtime.executable,'--version'])}:null,runtimeError,postgres,browser:null};
  const capabilities=ids.map(id=>({id,...missing('Native runtime unavailable')}));
  const put=(id,data)=>Object.assign(capabilities.find(c=>c.id===id),data);
  let c=null,ownership=[],malfunction=false;
  try{
    await jsonFile(path.join(root,'evidence/source-before.json'),sourceBefore);
    if(!runtime){for(const id of ids)put(id,missing('Actual revision2 runtime prerequisite missing or unsupported'));}
    else{
      const repo=path.join(root,'fixture');await cp(fixtures,repo,{recursive:true});
      await git(repo,'init','-q');await git(repo,'add','.');await git(repo,'-c','user.name=Mosaic Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Native feasibility protected fixture');
      const dependencies=path.join(repo,'node_modules');await mkdir(dependencies);
      let browserReady=false;
      try{
        const sourceDependencies=path.join(sourceRoot,'node_modules');
        const versions={};for(const name of ['playwright','playwright-core']){const p=path.join(sourceDependencies,name);await safePath(p);versions[name]=JSON.parse(await readFile(path.join(p,'package.json'),'utf8')).version;if(versions[name]!=='1.64.1')throw Error('Browser dependency version differs from pinned 1.64.1');}
        const browserDir=path.join(sourceDependencies,'.cache/ms-playwright');await safePath(browserDir);
        const chromium=path.join(browserDir,'chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell');
        const chromiumIdentity=await fileIdentity(chromium);
        if(chromiumIdentity.sha256!=='77d8278b1ac9d0687fad4e817ea83023ede09b1deef36e1864b49ba194ac9634')throw Error('Pinned Chromium bytes differ');
        const selected={};for(const name of ['playwright','playwright-core','.cache/ms-playwright']){selected[name]=nativeDependencyInventory(path.join(sourceDependencies,name)).hash;await cp(path.join(sourceDependencies,name),path.join(dependencies,name),{recursive:true});if(nativeDependencyInventory(path.join(dependencies,name)).hash!==selected[name])throw Error('Copied dependency inventory differs');}
        inventory.browser={versions,chromium:chromiumIdentity,selected,installed:true,executionProven:false};browserReady=true;
      }catch(e){inventory.browser={installed:false,executionProven:false,detail:e.message.slice(0,1000)};}
      const baseCommit=await git(repo,'rev-parse','HEAD');
      const executionPolicy={version:1,backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:runtime.fingerprint};
      const readPaths=['src/','checks/'],writePaths=['src/'];
      const checks=[{id:'handler',argv:[runtime.runtime.executable,'checks/handler.mjs'],timeoutMs:10000}];
      c=new Coordinator({root:path.join(root,'ownership-state'),selectedHost:'codex',nativeCheckRuntime:nativeConfig});
      const goal=c.preparePortableGoal({submissionId:'native-feasibility',objective:'Qualify native application checks without model dispatch',acceptance:['Bound evidence to exact inputs and durable native ownership'],mode:'codex_only',environment:'fixture',executionPolicy,project:{repo,baseCommit,readPaths,writePaths,checks}},'prepare');
      const journal=await new Journal(path.join(root,'journal'),randomUUID()).load();
      const workspace=new Workspace({repo,baseCommit,permissions:{readPaths,writePaths,checks},executionPolicy,overnightV2:true},journal);await workspace.initialize();
      const dependencyInventory=nativeDependencyInventory(path.join(workspace.root,'node_modules'));
      await jsonFile(path.join(root,'evidence/dependencies.json'),dependencyInventory);
      const runner=approvedChecks(workspace,{config:{nativeCheckRuntime:nativeConfig},context:{c,goalId:goal.id,operationKey:'feasibility',expectedDependencyHash:dependencyInventory.hash}});
      // No backendFactory, policy replacement, legacy backend or owner mock.
      const execute=async(name,args=[])=>{
        const check={id:name,argv:[runtime.runtime.executable,'checks/'+name+'.mjs',...args],timeoutMs:name==='browser'?30000:name==='postgres'?60000:10000};
        const [r]=await runner.run([check],name);
        let observation=null;try{observation=JSON.parse(r.stdout.trim());}catch{}
        const result={argv:check.argv,code:r.code,signal:r.signal??null,stopped:r.stopped,stdout:r.stdout.slice(0,8192),stderr:r.stderr.slice(0,8192),outputBinding:{stdoutBytes:Buffer.byteLength(r.stdout),stderrBytes:Buffer.byteLength(r.stderr),stdoutSha256:hash(r.stdout),stderrSha256:hash(r.stderr)},observation,quiescence:r.quiescence,provenance:r.provenance};
        await jsonFile(path.join(root,'evidence',name+'-'+randomUUID()+'.json'),result);return result;
      };
      // Separate host health probes below provide the network proof; verify also
      // validates actual fork-only children and kernel process-group containment.
      const verification=await runner.verify();await jsonFile(path.join(root,'evidence/backend-verification.json'),verification);
      const positive=async({id,name,file,from,to,kind,assertions})=>{
        const good=await execute(name),original=await workspace.content(file);
        if(!original.content.includes(from))throw Error('Deliberate regression anchor missing');
        await workspace.apply(name+'-wrong',{writePaths},[{path:file,action:'write',baseHash:original.hash,content:original.content.replace(from,to)}]);
        const bad=await execute(name),changed=await workspace.content(file);
        await workspace.apply(name+'-restore',{writePaths},[{path:file,action:'write',baseHash:changed.hash,content:original.content}]);
        put(id,{state:functional(good,bad,kind,assertions),detail:'Correct behavior passes and deliberate application error fails unchanged protected assertions',good,bad});
      };
      await positive({id:'handler',name:'handler',file:'src/handler.mjs',from:'status:201',to:'status:200',kind:'handler',assertions:4});
      if(browserReady){await positive({id:'offline_browser',name:'browser',file:'src/app.mjs',from:'input:checked',to:'input',kind:'offline_browser',assertions:3});inventory.browser.executionProven=capabilities.find(c=>c.id==='offline_browser').state==='passed';}
      else put('offline_browser',missing('Pinned Chromium/project dependencies unavailable; offline browser was not executed'));
      put('tcp',await canary({kind:'tcp',root,execute}));
      put('unix',await canary({kind:'unix',root,execute}));
      if(postgres.missing.length)put('postgres',{...missing('Missing actual commands: '+postgres.missing.join(', ')),steps:['initdb','startup','migration','query'].map(id=>({id,...missing('Required actual PostgreSQL commands missing')}))});
      else if(!postgres.supplied)put('postgres',{state:'inconclusive',detail:'Installed PATH commands inventoried; explicit --postgres-bin-dir is required before creating a disposable cluster'});
      else{
        const reservation=net.createServer();await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
        const result=await execute('postgres',[JSON.stringify({commands:Object.fromEntries(Object.entries(postgres.commands).map(([k,v])=>[k,v.path])),port})]);
        const steps=result.observation?.steps??[],permission=steps.some(s=>['EPERM','EACCES'].includes(s.errorCode));
        const state=result.code!==0||!result.quiescence?.groupESRCH?'inconclusive':steps.find(s=>s.name==='query')?.passed?'passed':permission?'denied':'failed';
        put('postgres',{state,detail:'Actual protected initdb/startup/migration/query; external executable denial is distinct from networking',result,steps});
      }
      const tcp=capabilities.find(x=>x.id==='tcp');put('networked_api',{state:tcp.state==='denied'?'denied':'inconclusive',detail:tcp.state==='denied'?'Healthy host TCP connection denied at actual protected boundary; running networked API proof blocked':'Connection observations alone do not establish a protected listening API'});
    }
  }catch(e){
    const unknown=e.executionOutcome==='unknown';malfunction=!unknown&&e.code!=='isolation';
    for(const capability of capabilities)if(capability.state==='not_run_missing_prerequisite'&&capability.id!=='postgres')Object.assign(capability,{state:'inconclusive',detail:unknown?'Native execution outcome unknown; retained exact owner, no forced cleanup':'Protected execution unavailable; see bounded tool error'});
    await jsonFile(path.join(root,'evidence/tool-error.json'),{code:e.code??null,message:e.message.slice(0,2000),executionOutcome:e.executionOutcome??null});
  }finally{
    if(postgres.missing.length)put('postgres',{...missing('Missing actual commands: '+postgres.missing.join(', ')),steps:['initdb','startup','migration','query'].map(id=>({id,...missing('Required actual PostgreSQL commands missing')}))});
    if(c){c.executionOwnership.reconcile({force:true});ownership=c.store.all('execution_owner');
      await mkdir(path.join(root,'evidence/receipts'),{mode:0o700});
      for(const owner of ownership){try{await copyFile(owner.receiptPath,path.join(root,'evidence/receipts',owner.id+'.json'));}catch(e){if(e.code!=='ENOENT')throw e;}}
      await jsonFile(path.join(root,'evidence/ownership.json'),ownership);c.close();
    }
  }
  if(ownership.some(row=>row.status!=='quiescent'))for(const cap of capabilities)if(cap.state==='passed'){cap.state='inconclusive';cap.detail+='; unresolved execution owner retained';}
  const sourceAfter=await sourceInventory();await jsonFile(path.join(root,'evidence/source-after.json'),sourceAfter);
  if(sourceBefore.sha256!==sourceAfter.sha256||sourceBefore.commit!==sourceAfter.commit){malfunction=true;await jsonFile(path.join(root,'evidence/source-drift.json'),{before:sourceBefore.sha256,after:sourceAfter.sha256});}
  const data={schema:1,createdAt:new Date().toISOString(),requested:{native:true,browser:true,postgres:true,networkedApi:true,requireNative:options.requireNative??false,requireBrowser:options.requireBrowser??false},...summary(capabilities,malfunction),inventory,capabilities,ownership,retainedRoot:root,nativeUsage:'unknown; host accounting unavailable',modelRequests:0};
  await sealReport(root,data);return data;
}
