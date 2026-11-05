import{execFileSync}from'node:child_process';import{mkdir,copyFile}from'node:fs/promises';import path from'node:path';
const root=path.resolve(import.meta.dirname,'..'),dist=path.join(root,'dist');await mkdir(dist,{recursive:true});
const run=(name,args)=>execFileSync(name,args,{cwd:root,stdio:'inherit'});
run('xcrun',['swiftc','-swift-version','5','-parse-as-library','native/ChatTransportFixture.swift','-o',path.join(dist,'chat-transport-fixture')]);
for(const mode of ['silent','malformed','large','exit'])await copyFile(path.join(dist,'chat-transport-fixture'),path.join(dist,'codex-'+mode));
run('xcrun',['swiftc','-swift-version','5','-D','MOSAIC_TESTING','native/Policy.swift','native/CodexRecent.swift','native/ChatTransportTests.swift','-o',path.join(dist,'transport-tests')]);
run(path.join(dist,'transport-tests'),[dist]);
if(process.argv.includes('--live')){
 run('xcrun',['swiftc','-swift-version','5','native/Policy.swift','native/CodexRecent.swift','native/ChatIntegrationTests.swift','-o',path.join(dist,'chat-integration')]);
 run(path.join(dist,'chat-integration'),[]);
}
