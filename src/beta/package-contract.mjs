import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateNativeCheckRuntime} from '../project/check-backends/darwin-seatbelt-v2.mjs';

// runtimeRoot is the installed version's runtime/ directory. No saved approval
// or command is relocated by this reader; callers prepare fresh literal argv.
export async function readBundledNativeCheckRuntime(runtimeRoot=fileURLToPath(new URL('../../',import.meta.url))){
 const artifactManifestPath=path.join(runtimeRoot,'check-artifact','artifact-manifest.json');
 const bytes=await readFile(artifactManifestPath);
 const config={schema:1,artifactManifestPath,artifactManifestSha256:createHash('sha256').update(bytes).digest('hex')};
 validateNativeCheckRuntime(config);
 return config;
}
