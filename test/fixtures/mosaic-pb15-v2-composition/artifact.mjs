import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {buildNativeCheckArtifact} from '../../../scripts/build-native-check-artifact.mjs';
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function buildFixtureArtifact(root,{builtNode=process.env.MOSAIC_NATIVE_TEST_NODE}={}){
 if(!builtNode)throw Error('MOSAIC_NATIVE_TEST_NODE must explicitly name the independently verified fork-only Node');
 builtNode=await realpath(builtNode);
 const license=await realpath(process.env.MOSAIC_NATIVE_TEST_LICENSE??path.resolve(process.env.MOSAIC_NATIVE_TEST_NODE??builtNode,'../../../LICENSE'));
 const artifact=await buildNativeCheckArtifact({builtNode,builtNodeSha256:hash(await readFile(builtNode)),nodeLicense:license,nodeSource:{version:'24.22.0',url:'https://nodejs.org/dist/v24.22.0/node-v24.22.0.tar.xz',sha256:'41f97cff2c666f1f8293dc5f85c65e8dd605c16b43fd9febd49ede32ee1e0329'},nodePatch:{sha256:'840109e32a582faf92ed07f75987c6eb03c9b5659cf74b2f5231ac1e72594741',description:'Disable the Apple posix_spawn branch before file actions; use the existing libuv fork path.'},outputDir:path.join(root,'native-artifact')});
 return {...artifact,config:{schema:1,artifactManifestPath:artifact.manifestPath,artifactManifestSha256:artifact.fingerprint},policy:{version:1,backend:'darwin-seatbelt',backendRevision:2,runtimeFingerprint:artifact.fingerprint}};
}
