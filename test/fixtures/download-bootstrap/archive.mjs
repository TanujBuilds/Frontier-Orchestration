import {gzipSync} from 'node:zlib';
export const version='0.1.0-beta.184';
export const stem=`mosaic-beta-${version}-darwin-arm64`;
// Independent small ustar specimens; no packaged runtime or provider calls.
export function header(name,{type='0',size=0,mode=0o644,link=''}={}){
 const b=Buffer.alloc(512);
 const oct=(n,len)=>n.toString(8).padStart(len-1,'0')+'\0';
 b.write(name,0,100);b.write(oct(mode,8),100);b.write(oct(0,8),108);b.write(oct(0,8),116);b.write(oct(size,12),124);b.write(oct(0,12),136);b.fill(32,148,156);b.write(type,156);b.write(link,157,100);b.write('ustar\0',257);b.write('00',263);b.write(b.reduce((a,n)=>a+n,0).toString(8).padStart(6,'0')+'\0 ',148);return b;
}
export function tar(entries){return Buffer.concat([...entries.flatMap(({name,body=Buffer.alloc(0),...opts})=>{body=Buffer.from(body);return [header(name,{...opts,size:opts.size??body.length}),body,Buffer.alloc((512-body.length%512)%512)];}),Buffer.alloc(1024)]);}
export function entries({root=stem,manifestVersion=version,installerExit=0}={}){
 const installer=`#!/bin/sh\nset -eu\n[ "$1" = --home ]\nhome=$2\nshift 2\nprintf '%s\\n' "$@" > "$home/installer-argv"\nprintf '%s\\n' invoked > "$home/installer-called"\nexit ${installerExit}\n`;
 return [{name:root+'/',type:'5',mode:0o755},{name:root+'/install',body:installer,mode:0o755},{name:root+'/payload/',type:'5',mode:0o755},{name:root+'/payload/package-manifest.json',body:JSON.stringify({schema:1,layout:'terminal-beta-v2',version:manifestVersion,dependenciesInstalled:true})}];
}
export const archive=opts=>gzipSync(tar(entries(opts)));
export async function expandedBomb(){
 const {Readable}=await import('node:stream');const {createGzip}=await import('node:zlib');
 async function* chunks(){
  yield tar(entries()).subarray(0,-1024);const block=Buffer.alloc(65536);
  for(let file=0;file<4;file++){yield header(stem+'/expanded-'+file,{size:256*1024*1024});for(let n=0;n<4096;n++)yield block;}
  yield Buffer.alloc(1024);
 }
 const result=[];for await(const b of Readable.from(chunks()).pipe(createGzip()))result.push(b);return Buffer.concat(result);
}
