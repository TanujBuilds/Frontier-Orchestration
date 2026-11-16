import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
const origin='http://offline-feasibility.invalid';
const html='<label><input type="checkbox" value="North">North</label><label><input type="checkbox" value="South">South</label><button>Apply selection</button><output role="status">None selected</output><script type="module" src="/app.mjs"></script>';
const script=await readFile(process.env.MOSAIC_APPROVED_INPUTS+'/src/app.mjs','utf8');
const browser=await chromium.launch({headless:true,timeout:10000,env:{...process.env,MAC_CHROMIUM_TMPDIR:tmpdir()},args:['--single-process','--no-zygote','--in-process-gpu','--disable-gpu']});
try{
  const context=await browser.newContext({serviceWorkers:'block'});let fulfilled=0,aborted=0;
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin===origin&&url.pathname==='/'){fulfilled++;return route.fulfill({body:html,contentType:'text/html'});}
    if(url.origin===origin&&url.pathname==='/app.mjs'){fulfilled++;return route.fulfill({body:script,contentType:'application/javascript'});}
    aborted++;return route.abort();
  });
  const page=await context.newPage();page.setDefaultTimeout(5000);await page.goto(origin);
  await page.getByRole('checkbox',{name:'North',exact:true}).check();
  await page.getByRole('button',{name:'Apply selection'}).click();
  assert.equal(await page.getByRole('status').textContent(),'North','DOM must include only the selected item');
  await page.getByRole('checkbox',{name:'North',exact:true}).uncheck();await page.getByRole('button').click();
  assert.equal(await page.getByRole('status').textContent(),'None selected');
  assert.equal(fulfilled,2);
  console.log(JSON.stringify({schema:1,kind:'offline_browser',assertions:3,fulfilled,aborted,networkServer:false}));
}finally{await browser.close();}
