import { Pause, relativePath } from '../contracts.mjs';
import { createDarwinSeatbeltV2Backend, validateNativeCheckRuntime as validateLegacy } from './darwin-seatbelt-v2.mjs';
import {
  createCurrentNativeBackend, nativeImplementationSources, readNativeManifest, validateCurrentNativeCheckRuntime,
} from './darwin-seatbelt-v2-node-24223.mjs';

export { nativeImplementationSources };

function isLegacyRuntime(config, expectedFingerprint) {
  const { manifest } = readNativeManifest(config, expectedFingerprint);
  if (manifest?.nodeVersion === '24.22.0') return true;
  if (manifest?.nodeVersion === '24.22.3') return false;
  throw new Pause('Unsupported native artifact manifest', 'isolation');
}

export function validateNativeCheckRuntime(config, expectedFingerprint) {
  const validate = isLegacyRuntime(config, expectedFingerprint) ? validateLegacy : validateCurrentNativeCheckRuntime;
  return validate(config, expectedFingerprint);
}

export function nativeBackendFactory({ id, revision, workspace, options }) {
  if (id !== 'darwin-seatbelt' || revision !== 2)
    throw new Pause('Unsupported native backend identity revision', 'isolation');
  const create = isLegacyRuntime(options?.nativeCheckRuntime, options?.expectedRuntimeFingerprint)
    ? createDarwinSeatbeltV2Backend : createCurrentNativeBackend;
  return create({ workspace, options });
}

export function nativeCheckArgv(config, script, args = []) {
  const runtime = validateNativeCheckRuntime(config);
  try { relativePath(script); } catch { throw new Pause('Native check script must be an approved relative path', 'isolation'); }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0')))
    throw new Pause('Native check arguments must be literal strings', 'isolation');
  return [runtime.runtime.executable, script, ...args];
}
