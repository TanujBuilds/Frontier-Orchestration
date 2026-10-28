import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {Coordinator} from '../src/harness/coordinator.mjs';
import {Dispatcher} from '../src/harness/tools.mjs';
import {startApi} from '../src/harness/api.mjs';

const root=await mkdtemp(path.join(os.tmpdir(),'harness-browser-')),c=new Coordinator({root}),token='b'.repeat(64),dispatcher=new Dispatcher({c,config:{environment:'fixture'}}),api=await startApi({dispatcher,token});
const g=c.prepareGoal({submissionId:'browser',objective:'Compare durable queues for one AI worker',acceptance:['Cited comparison and recovery evidence'],environment:'fixture'},'prepare');c.activateGoal({goalId:g.id,hash:g.hash},'activate');
const a=c.submitTask({goalId:g.id,submissionId:'question',kind:'research',objective:'Investigate crash recovery',acceptance:['Primary sources']},'a');c.claimNext('fixture');c.ask(a.id,'Should recovery prioritize a lost response or a repeated side effect?',{phase:'sources'},'fixture');
const b=c.submitTask({goalId:g.id,submissionId:'queued',kind:'research',objective:'Compare SQLite WAL and filesystem queues',acceptance:['Two primary sources']},'b');
const browser=await chromium.launch({headless:true,executablePath:process.env.FRONTIER_BROWSER??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
const output=process.env.HARNESS_SCREENSHOTS??path.join(root,'screenshots');await mkdir(output,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(5000);
 await page.goto(api.url);await page.getByLabel('Connection key').fill(token);await Promise.all([page.waitForURL(api.url+'/'),page.getByRole('button',{name:'Connect',exact:true}).click()]);
 await page.getByRole('heading',{name:g.manifest.objective,exact:true}).waitFor();
 await page.getByLabel('Answer supervisor question').fill('Prevent repeated side effects first.');await page.getByRole('button',{name:'Send answer',exact:true}).click();
 await page.waitForFunction(()=>!document.body.textContent.includes('Should recovery prioritize'));assert.equal(c.getTask(a.id).answers.length,1);assert.equal(c.getTask(a.id).status,'queued');
 const row=page.locator(`[data-task-id="${b.id}"]`);await row.getByRole('button',{name:'Pause',exact:true}).click();await page.waitForFunction(id=>document.querySelector(`[data-task-id="${id}"]`)?.textContent.includes('paused'),b.id);assert.equal(c.getTask(b.id).status,'paused');
 await row.getByRole('button',{name:'Resume',exact:true}).click();await page.waitForFunction(id=>document.querySelector(`[data-task-id="${id}"]`)?.textContent.includes('queued'),b.id);assert.equal(c.getTask(b.id).status,'queued');
 for(const width of [1280,390]){await page.setViewportSize({width,height:900});await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`horizontal overflow at${width}`);await page.screenshot({path:path.join(output,`harness-${width}.png`),fullPage:true});}
 await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.activeElement!==document.body));assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,backendControls:['question_answer','pause','resume'],viewports:[1280,390],reducedMotion:true,screenshots:output}));
}finally{await browser.close();await api.close();c.close();await rm(root,{recursive:true,force:true});}
