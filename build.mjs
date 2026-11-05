import {mkdir,cp,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const root=import.meta.dirname,dist=path.join(root,'dist'),app=path.join(dist,'Mosaic.app');
const run=(name,args)=>execFileSync(name,args,{cwd:root,stdio:'inherit'});
await mkdir(dist,{recursive:true});
run('xcrun',['swiftc','-swift-version','5','native/Policy.swift','native/CodexRecent.swift','native/PolicyTests.swift','-o',path.join(dist,'policy-tests')]);
run(path.join(dist,'policy-tests'),[]);
run('xcrun',['swiftc','-swift-version','5','native/Policy.swift','native/CodexRecent.swift','native/CodexRecentTests.swift','-o',path.join(dist,'chat-tests')]);
run(path.join(dist,'chat-tests'),[]);
await rm(app,{recursive:true,force:true});
await mkdir(path.join(app,'Contents/MacOS'),{recursive:true});await mkdir(path.join(app,'Contents/Resources'),{recursive:true});
run('xcrun',['swiftc','-swift-version','5','-O','-target',process.arch==='arm64'?'arm64-apple-macos13.0':'x86_64-apple-macos13.0','-parse-as-library','native/Policy.swift','native/CodexRecent.swift','native/Mosaic.swift','-framework','AppKit','-framework','WebKit','-o',path.join(app,'Contents/MacOS/Mosaic')]);
run('xcrun',['swiftc','-swift-version','5','-parse-as-library','native/Icon.swift','-framework','AppKit','-o',path.join(dist,'icon-builder')]);
run(path.join(dist,'icon-builder'),[path.join(dist,'Mosaic.iconset'),path.join(root,'ui/assets/mosaic.svg')]);
run('iconutil',['-c','icns',path.join(dist,'Mosaic.iconset'),'-o',path.join(app,'Contents/Resources/Mosaic.icns')]);
await cp(path.join(root,'ui'),path.join(app,'Contents/Resources/ui'),{recursive:true});
await writeFile(path.join(app,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Mosaic</string>
<key>CFBundleIdentifier</key><string>dev.mosaic.observer</string>
<key>CFBundleName</key><string>Mosaic</string>
<key>CFBundleDisplayName</key><string>Mosaic</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>4</string>
<key>CFBundleShortVersionString</key><string>1.2.1</string>
<key>CFBundleIconFile</key><string>Mosaic</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>\n`);
run('codesign',['--force','--sign','-','--timestamp=none',app]);
run('codesign',['--verify','--deep','--strict',app]);
run('plutil',['-lint',path.join(app,'Contents/Info.plist')]);
console.log('Built self-contained app:',app);
