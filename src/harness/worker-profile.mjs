function field(value, limit) {
 return typeof value==='string'&&value.length<=limit&&value.trim()===value&&value.length>0&&!/[\x00-\x1f\x7f-\x9f]/u.test(value);
}

export function workerEndpoint(value) {
 let url;
 try{if(field(value,2048))url=new URL(value);}catch{}
 if(!url||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)
  throw Error('Use an HTTP or HTTPS API base URL without credentials, query parameters or fragment');
 return url.href.replace(/\/+$/,'');
}

export function workerProfile(raw) {
 if(!raw||Object.keys(raw).some(key=>!['baseUrl','model','displayName','revision','streaming'].includes(key))||
    !field(raw.model,200)||!field(raw.displayName,80)||!field(raw.revision,80)||typeof raw.streaming!=='boolean')
  throw Error('Invalid API worker profile');
 return {baseUrl:workerEndpoint(raw.baseUrl),model:raw.model,displayName:raw.displayName,revision:raw.revision,streaming:raw.streaming};
}
