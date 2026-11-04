/* Browser-side observer client. Native code owns authentication and transport. */
(() => {
  'use strict';
  const adapter=window.MosaicAdapter;
  const demo=!!window.MOSAIC_DEMO || new URL(location.href).searchParams.get('demo')==='1';
  const fixture=window.MOSAIC_DATA;
  let snapshot=null,events=[],scan=0,busy=false,stopped=false,publishedKey=null;
  const evidenceCache=new Map(),pending=new Set();
  const rpc=(name,input={})=> {
    const handler=window.webkit?.messageHandlers?.mosaic;
    if(!handler) return Promise.reject(Error('Open the installed Mosaic app to connect to your coordinator.'));
    return handler.postMessage({name,input});
  };
  function publish(data) {
    const {generatedAt,...stable}=data;
    const key=JSON.stringify([stable,Math.floor(Date.now()/60000)]);
    if(key===publishedKey)return;
    publishedKey=key;window.MOSAIC_DATA=data;window.dispatchEvent(new CustomEvent('mosaic:data',{detail:data}));
  }
  function enrich(data) {
    for(const [id,t]of Object.entries(data.tasks)){
      const cache=evidenceCache.get(id);
      if(cache&&cache.key===JSON.stringify(t.rawRecord))data.tasks[id]=adapter.applyEvidence(t,cache.value);
    }
    return data;
  }
  function connection(state,message='') {
    const d=snapshot?enrich(adapter.adaptSnapshot(snapshot,events)):adapter.adaptSnapshot({goals:[],tasks:[]});
    d.connection=state;d.connectionMessage=message;d.hasSnapshot=!!snapshot;
    if(!snapshot)d.generatedAt=null;
    if(!snapshot){d.projects[0].state=state==='loading'?'loading':'empty';d.projects[0].goal=state==='loading'?'Connecting to Mosaic':'Mosaic is not connected';d.projects[0].subtitle=message||'Reading your saved work from the local coordinator.';}
    publish(d);
  }
  async function refresh() {
    if(demo||busy||stopped||document.hidden)return;
    busy=true;
    try {
      snapshot=await rpc('observer_snapshot');
      // Fetch the latest bounded window initially, then advance a durable cursor.
      if(!scan)scan=Math.max(0,(snapshot.cursor||0)-200);
      for(let page=0;page<3;page++){
        const batch=await rpc('observer_timeline',{after:scan,limit:200});
        events=adapter.mergeEvents(events,batch.events||[]);
        scan=Math.max(scan,batch.cursor||0);
        if(!batch.hasMore)break;
      }
      connection('connected');
    } catch(error) {
      connection('disconnected',String(error.message||error));
    } finally {busy=false;}
  }
  async function loadEvidence(id) {
    const task=window.MOSAIC_DATA.tasks[id];
    if(demo||!task?.evidenceRef||pending.has(id))return;
    const key=JSON.stringify(task.rawRecord);
    if(evidenceCache.get(id)?.key===key)return;
    pending.add(id);
    try {
      let text='',start=0,last;
      for(let i=0;i<8;i++){
        last=await rpc('observer_evidence',{reference:task.evidenceRef,start,length:32768});
        text+=last.text||'';
        if(last.nextStart>=last.totalBytes)break;
        if(last.nextStart<=start)break;
        start=last.nextStart;
      }
      const value={...last,text,truncated:last.nextStart<last.totalBytes};
      evidenceCache.set(id,{key,value});
      window.dispatchEvent(new CustomEvent('mosaic:evidence',{detail:{id,key,value}}));
    } catch(error) {
      window.dispatchEvent(new CustomEvent('mosaic:evidence-error',{detail:{id,message:'Evidence could not be loaded. Check the coordinator in Codex, then retry.'}}));
    } finally {pending.delete(id);}
  }
  function captureFocus() {
    const el=document.activeElement;
    return {id:el?.id,action:el?.dataset?.action,task:el?.dataset?.task,view:el?.dataset?.view,start:el?.selectionStart,end:el?.selectionEnd,detailsKey:el?.closest?.('details[data-key]')?.dataset.key,tag:el?.tagName};
  }
  function restoreFocus(f) {
    let el=f.id?document.getElementById(f.id):null;
    if(!el&&f.action)el=[...document.querySelectorAll('[data-action]')].find(e=>e.dataset.action===f.action&&e.dataset.task===f.task&&e.dataset.view===f.view);
    if(!el&&f.detailsKey&&f.tag==='SUMMARY')el=[...document.querySelectorAll('details[data-key]')].find(e=>e.dataset.key===f.detailsKey)?.querySelector('summary');
    if(el){el.focus({preventScroll:true});if(f.start!=null&&el.setSelectionRange)try{el.setSelectionRange(f.start,f.end)}catch{}}
  }
  window.MosaicRuntime={demo,refresh,loadEvidence,captureFocus,restoreFocus,openCodex:()=>rpc('open_codex'),stop:()=>{stopped=true;}};
  if(demo) {fixture.sample=true;fixture.connection='demo';window.MOSAIC_DATA=fixture;}
  else {
    const d=adapter.adaptSnapshot({goals:[],tasks:[]});d.connection='loading';d.hasSnapshot=false;d.generatedAt=null;d.projects[0].state='loading';d.projects[0].goal='Connecting to Mosaic';window.MOSAIC_DATA=d;
    setTimeout(refresh,0);
    setInterval(refresh,5000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
  }
})();
