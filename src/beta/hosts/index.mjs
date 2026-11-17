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

// Local presentation only. Neither a receipt nor a viewer request observes the
// coding app's tool discovery/calls; no host-proof schema or probe is implied.
export function formatHostReadiness(hostId,{configuration='selected',instructions='not recorded for this configuration',registration='unverified',nextAction}={}){
 const host=getHost(hostId),fixture=registration==='fixture',saved=registration==='saved';
 const registrationDetail=fixture?'saved in a disposable fixture; actual host registration is unverified.':saved?'saved registration verified; actual tool discovery and calls remain unverified.':'unverified; saving local settings or instructions does not register the coding app.';
 const next=nextAction??(fixture||saved?`In an actual ${host.displayName} profile, discover the mosaic-beta tools, then call registry_list with {} to check the connection without model work.`:`In ${host.displayName}, review the mosaic-beta registration using mosaic host-preview --host ${hostId}, preserve other entries, then load or refresh its MCP connection.`);
 return `INFO  Coding app · ${host.displayName} ${configuration}; selection does not prove a connection.\nINFO  Host registration instructions · ${instructions}.\n${fixture||saved?'INFO':'UNVERIFIED'}  Host registration · ${registrationDetail}\nUNVERIFIED  Host tools discovered · no discovery observed from the selected coding app.\nUNVERIFIED  Host tool call · no successful call observed from the selected coding app.\nINFO  Host evidence · fixture adapters, provider checks and coordinator viewer tools_list do not prove coding-app discovery or a successful call; these stages make no sign-in, host-version, coding-quality or live-provider qualification claim.\nNext action: ${next}\n`;
}
