// Developer-only companion artifact. This is never shipped as Mosaic runtime.
import assert from 'node:assert/strict';
import {cp,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const [modulesInput,browserInput,output]=process.argv.slice(2);
assert.ok(modulesInput&&browserInput&&output,'Provide explicit module root, accepted browser root and new output tar');
const modules=await realpath(modulesInput),browser=await realpath(browserInput);
assert.equal(JSON.parse(await readFile(path.join(modules,'playwright/package.json'))).version,'1.64.1');
assert.equal(JSON.parse(await readFile(path.join(modules,'playwright-core/package.json'))).version,'1.64.1');
await mkdir(path.dirname(path.resolve(output)),{recursive:true,mode:0o700});
const temporary=await realpath(await mkdtemp(path.join(path.dirname(path.resolve(output)),'demo-input-')));
try{
 await cp(fileURLToPath(new URL('./project/',import.meta.url)),path.join(temporary,'project'),{recursive:true});
 for(const name of ['playwright','playwright-core'])await cp(path.join(modules,name),path.join(temporary,'project/node_modules',name),{recursive:true});
 for(const name of ['chromium_headless_shell-1248','ffmpeg-1013'])await cp(path.join(browser,name),path.join(temporary,'project/node_modules/.cache/ms-playwright',name),{recursive:true});
 const files=[];
 async function inventory(relative='project'){
  for(const name of (await readdir(path.join(temporary,relative))).sort()){
   const file=path.posix.join(relative,name),info=await lstat(path.join(temporary,file));
   assert.equal(info.isSymbolicLink(),false,'Companion inputs must be regular canonical files: '+file);
   if(info.isDirectory())await inventory(file);
   else{assert.ok(info.isFile());const bytes=await readFile(path.join(temporary,file));files.push({path:file,bytes:bytes.length,sha256:hash(bytes),mode:info.mode&0o777});}
  }
 }
 await inventory();
 const licenses=files.filter(file=>/(?:^|\/)(?:LICENSE|COPYING|NOTICE)(?:\.[^/]*)?$/i.test(file.path));
 assert.ok(licenses.some(file=>file.path==='project/node_modules/playwright/LICENSE'));
 assert.ok(licenses.some(file=>file.path==='project/node_modules/playwright-core/LICENSE'));
 assert.ok(licenses.some(file=>/chromium_headless_shell.*LICENSE/i.test(file.path)),'Chromium distribution must retain its license');
 const manifest={schema:1,purpose:'offline-installed-check-project-inputs',fixtureOnly:true,playwrightVersion:'1.64.1',browserRevisions:['chromium_headless_shell-1248','ffmpeg-1013'],files,inventorySha256:hash(JSON.stringify(files)),licenseFiles:licenses.map(file=>file.path),provenance:{modulesInput:modules,browserInput:browser,generatedAt:new Date().toISOString()},limits:['Local test inputs, not part of the downloadable Mosaic candidate','No model, host authentication, or personal configuration included','Pinned bytes and inventory are integrity evidence; no binary reproducibility or publisher signature claim']};
 await writeFile(path.join(temporary,'demo-input-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 execFileSync('/usr/bin/tar',['-czf',path.resolve(output),'-C',temporary,'demo-input-manifest.json','project'],{env:{PATH:'/usr/bin:/bin',COPYFILE_DISABLE:'1'},timeout:120000});
 const receipt={archive:path.resolve(output),sha256:hash(await readFile(output)),files:files.length,inventorySha256:manifest.inventorySha256,licenseFiles:manifest.licenseFiles};
 await writeFile(output+'.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await rm(temporary,{recursive:true,force:true});}
