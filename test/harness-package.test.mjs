import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {packageHarness,renderLaunchAgent,verifyPackage} from '../src/harness/package.mjs';

test('standalone snapshot serves installed MCP tools and verifies its checksummed contents',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'harness-package-')),destination=path.join(root,'frontier-harness');let child;const client=new Client({name:'installed-forward',version:'1'});
 t.after(async()=>{await client.close();if(child&&child.exitCode===null&&child.signalCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end;}await rm(root,{recursive:true,force:true});});
 const sourceRoot=fileURLToPath(new URL('..',import.meta.url)),manifest=await packageHarness({sourceRoot,destination,dependencies:true,offline:true});assert.ok(manifest.files.length>30);assert.equal(await verifyPackage(destination),true);
 const state=path.join(root,'state'),config=path.join(root,'config.json');await writeFile(config,JSON.stringify({environment:'fixture',fixtureReply:'Installed fixture answer'}),{mode:0o600});
 const cli=path.join(destination,'runtime/src/harness/cli.mjs');child=spawn(process.execPath,[cli,'serve','--root',state,'--config',config,'--port','0'],{stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let output='',errors='';child.stdout.on('data',b=>{output+=b;if(output.includes('\n'))resolve();});child.stderr.on('data',b=>errors+=b);child.on('exit',code=>reject(Error(`Installed service exited ${code}: ${errors}`)));});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[cli,'mcp','--root',state],stderr:'pipe'}));const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='goal_prepare'));
 const call=async(name,input)=>{const response=await client.callTool({name,arguments:input});assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);};
 const goal=await call('goal_prepare',{idempotencyKey:'p',manifest:{submissionId:'installed',objective:'Verify installed capability',acceptance:['Native evidence'],mode:'codex_only',environment:'fixture'}});await call('goal_activate',{idempotencyKey:'a',goalId:goal.id,hash:goal.hash});const task=await call('task_submit',{idempotencyKey:'t',goalId:goal.id,task:{submissionId:'native',kind:'consult',objective:'Record an explanation',acceptance:['Saved native answer']}});
 await call('native_text_start',{idempotencyKey:'start',taskId:task.id});const done=await call('native_text_finish',{idempotencyKey:'finish',taskId:task.id,content:'Installed native answer.'});assert.equal(done.spent.model,0);assert.equal(done.status,'accepted');
 const receipt=await call('goal_finalize',{idempotencyKey:'final',goalId:goal.id,summary:'Installed MCP and actor isolation verified'});assert.ok(receipt.receiptHash);
 await writeFile(path.join(destination,'runtime/src/harness/provider.mjs'),'tampered');await assert.rejects(verifyPackage(destination),/checksum/);
});
test('LaunchAgent uses literal escaped arguments and keeps private state outside the runtime',()=>{
 const plist=renderLaunchAgent({node:'/opt/node24/bin/node',entry:'/tmp/Frontier & Test/runtime/src/harness/cli.mjs',root:'/tmp/private state',config:'/tmp/private config.json',port:4332,logs:'/tmp/private logs'});assert.match(plist,/Frontier &amp; Test/);assert.match(plist,/<string>--root<\/string>/);assert.doesNotMatch(plist,/<string>(?:sh|bash|zsh)<\/string>/);assert.match(plist,/<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
});
