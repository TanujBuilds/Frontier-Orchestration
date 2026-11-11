import {codex} from './codex.mjs';
import {claudeCode} from './claude-code.mjs';
import {cursor} from './cursor.mjs';
import {antigravity} from './antigravity.mjs';
const adapters=new Map([codex,claudeCode,cursor,antigravity].map(adapter=>[adapter.id,adapter]));
export const HOST_IDS=Object.freeze([...adapters.keys()]);
export function getHost(id){const adapter=adapters.get(id);if(!adapter)throw Error('Unsupported Mosaic host');return adapter;}
export function normalizeHostSettings(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['id','options'].includes(key)))throw Error('Invalid host settings');
 getHost(raw.id);const options=raw.options??{};
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).length)throw Error('Unsupported host registration option');
 return {id:raw.id,options:{}};
}
export const hostRegistry=Object.freeze({get(id){const {schema,id:hostId,displayName,transport,reviewDelivery,capabilities,documentation}=getHost(id);return structuredClone({schema,id:hostId,displayName,transport,reviewDelivery,capabilities,documentation});},list(){return HOST_IDS.map(id=>this.get(id));}});
