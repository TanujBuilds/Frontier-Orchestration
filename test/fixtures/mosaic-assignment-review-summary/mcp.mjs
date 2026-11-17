import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Coordinator } from '../../../src/harness/coordinator.mjs';
import { ProviderRegistry } from '../../../src/harness/providers/registry.mjs';
import { Dispatcher } from '../../../src/harness/tools.mjs';
import { startMcp } from '../../../src/harness/mcp.mjs';

// Owned preparation-only process: no worker loop, live provider or native grant.
const [root, selectedHost] = process.argv.slice(2);
const profiles = JSON.parse(await readFile(path.join(root, 'profiles.json'), 'utf8'));
const c = new Coordinator({
  root: path.join(root, 'state'), selectedHost,
  providerRegistry: ProviderRegistry({ profiles }),
  codexPath: path.join(root, 'no-native-call'),
});
const dispatcher = new Dispatcher({ c });
const server = await startMcp({ tools: dispatcher.tools(), invoke: (name, input) => dispatcher.invoke(name, input) });
server.onclose = () => c.close();
