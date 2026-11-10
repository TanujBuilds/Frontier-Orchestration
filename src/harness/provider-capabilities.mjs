export const STRUCTURED_WORKER_PROTOCOL='mosaic-structured-v1';
const fields=['protocol','transports','modelDiscovery'];
const supportedTransports=['json','sse'];

export function normalizeProviderCapabilities(raw, streaming) {
 if(raw===undefined)return undefined;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||
    Reflect.ownKeys(raw).length!==fields.length||!fields.every(field=>Object.hasOwn(raw,field))||
    raw.protocol!==STRUCTURED_WORKER_PROTOCOL||!['manual','advertised'].includes(raw.modelDiscovery)||
    !Array.isArray(raw.transports)||raw.transports.length<1||raw.transports.length>supportedTransports.length)
  throw Error('Invalid API worker capabilities');

 const transports=[...raw.transports];
 if(transports.some(transport=>!supportedTransports.includes(transport))||new Set(transports).size!==transports.length)
  throw Error('Invalid API worker capabilities');
 if(typeof streaming!=='boolean'||!transports.includes(streaming?'sse':'json'))
  throw Error('Configured response mode is unsupported by API worker capabilities');
 // The order is part of the stored profile identity and must survive readSettings.
 return {protocol:raw.protocol,transports,modelDiscovery:raw.modelDiscovery};
}
