import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod,copyFile,link,lstat,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs,promisify} from 'node:util';

const exec=promisify(execFile);
const templates=new URL('../distribution/macos/',import.meta.url);
const maxArchiveBytes=256*1024*1024;
const usage='node scripts/package-macos-installer.mjs --version VERSION --archive ARCHIVE --sha256 TRUSTED_SHA256 --output DIRECTORY';

function distribution(version,identifier){
 return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Mosaic Beta ${version}</title>
  <options customize="never" hostArchitectures="arm64" require-scripts="false"/>
  <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>
  <conclusion file="Conclusion.html" mime-type="text/html"/>
  <choices-outline><line choice="mosaic"/></choices-outline>
  <choice id="mosaic" visible="false"><pkg-ref id="${identifier}"/></choice>
  <pkg-ref id="${identifier}">component.pkg</pkg-ref>
</installer-gui-script>
`;
}

async function assertOutputAbsent(file){
 try{
  await lstat(file);
 }catch(error){
  if(error.code==='ENOENT')return;
  throw error;
 }
 throw Error('Output already exists: '+file);
}

async function build({version,archive,sha256,output}){
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Build the macOS installer on an Apple Silicon Mac.');
 if(!version||version.length>64||!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)||!archive||!output||!/^\p{ASCII_Hex_Digit}{64}$/u.test(sha256??''))
  throw Error('Supply an exact version and trusted archive checksum. Usage: '+usage);
 const stem='mosaic-beta-'+version+'-darwin-arm64';
 const archiveName=stem+'.tar.gz';
 if(path.basename(archive)!==archiveName)throw Error('Archive name must match the selected version: '+archiveName);
 const input=await lstat(archive);
 if(!input.isFile()||input.size===0||input.size>maxArchiveBytes)throw Error('Use a regular Mosaic archive no larger than 256 MiB.');
 output=path.resolve(output);
 await mkdir(output,{recursive:true});
 const destination=path.join(output,stem+'.pkg');
 await assertOutputAbsent(destination);
 const staged=await mkdtemp(path.join(output,'.mosaic-macos-'));
 try{
  const root=path.join(staged,'root');
  const payload=path.join(root,'Mosaic Setup',version);
  const resources=path.join(staged,'resources');
  await mkdir(payload,{recursive:true});
  await mkdir(resources);
  const packagedArchive=path.join(payload,archiveName);
  await copyFile(archive,packagedArchive);
  const checksum=createHash('sha256');
  for await(const chunk of createReadStream(packagedArchive))checksum.update(chunk);
  const expected=sha256.toLowerCase();
  if(checksum.digest('hex')!==expected)throw Error('Archive checksum does not match the trusted SHA-256.');

  const launcher=path.join(payload,'Finish Installing Mosaic.command');
  const activation=await readFile(new URL('activate.sh',templates),'utf8');
  await writeFile(launcher,activation.replace('@ARCHIVE_STEM@',stem).replace('@ARCHIVE_SHA256@',expected));
  await chmod(launcher,0o755);
  const conclusion=await readFile(new URL('Conclusion.html',templates),'utf8');
  await writeFile(path.join(resources,'Conclusion.html'),conclusion.replace('@VERSION@',version));

  const identifier='com.mosaic.beta.staging.'+version;
  const component=path.join(staged,'component.pkg');
  const dist=path.join(staged,'Distribution.xml');
  const product=path.join(staged,'product.pkg');
  await writeFile(dist,distribution(version,identifier));
  const commandOptions={timeout:120000};
  await exec('/usr/bin/pkgbuild',['--root',root,'--install-location','/','--identifier',identifier,'--version',version.replace('-beta.','.'),component],commandOptions);
  await exec('/usr/bin/productbuild',['--distribution',dist,'--package-path',staged,'--resources',resources,product],commandOptions);
  try{
   await link(product,destination);
  }catch(error){
   if(error.code==='EEXIST')throw Error('Output already exists: '+destination);
   throw error;
  }
  console.log(destination);
 }finally{
  await rm(staged,{recursive:true,force:true});
 }
}

try{
 const {values}=parseArgs({options:{version:{type:'string'},archive:{type:'string'},sha256:{type:'string'},output:{type:'string'},help:{type:'boolean'}}});
 if(values.help)console.log(usage);
 else await build(values);
}catch(error){
 console.error(error.stderr?.trim()||error.message);
 process.exitCode=1;
}
