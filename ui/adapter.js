/* Pure translation of saved observer records. No credentials or execution authority. */
(() => {
  'use strict';
  const modes = {
    collaborative: {name:'Collaborative',description:'Codex leads, implements, delegates to DeepSeek, reviews and integrates. An active Codex chat supervises this work.'},
    deepseek_only: {name:'DeepSeek-only',description:'DeepSeek plans and implements. Protected checks govern acceptance. Codex relays controls and answers without implementation, review or fallback.'},
    codex_only: {name:'Codex-only',description:'Codex and registered native agents do the work. DeepSeek is not used.'},
    overnight_review: {name:'Overnight review',description:'DeepSeek implements. Bounded automatic Codex review follows passing checks.'},
    unknown: {name:'Mode not reported',description:'This snapshot does not report a recognized working mode. No actor participation is inferred.'}
  };
  const terminal = status => ['accepted','completed','failed','stopped','cancelled','partial'].includes(status);
  const waiting = t => ['waiting_user','waiting_question','awaiting_user','awaiting_supervisor'].includes(t.status);
  const title = (text,fallback='Registered work') => { const line=String(text||fallback).split('\n').map(s=>s.replace(/^#+\s*/, '').trim()).find(Boolean)||fallback; const sentence=line.split(/\.\s/)[0];return sentence.length>64?sentence.slice(0,61).replace(/\s+\S*$/, '')+'…':sentence; };
  const age = (at,now) => !Number.isFinite(at) ? 'Not reported' : now-at<60000 ? 'just now' : now-at<3600000 ? `${Math.floor((now-at)/60000)} min ago` : now-at<86400000 ? `${Math.floor((now-at)/3600000)} hr ago` : `${Math.floor((now-at)/86400000)} days ago`;
  const date = at => Number.isFinite(at) ? new Date(at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'Time not reported';
  const checkLabel = checks => checks && Number.isInteger(checks.passed) && Number.isInteger(checks.total) ? checks.passed===checks.total && checks.total>0 ? `${checks.passed} checks passed` : `${checks.passed} of ${checks.total} checks passed` : 'Checks not reported';
  function mergeEvents(previous,incoming) {
    const bySeq=new Map([...previous,...incoming].filter(e=>Number.isInteger(e.seq)).map(e=>[e.seq,e]));
    return [...bySeq.values()].sort((a,b)=>a.seq-b.seq).slice(-500);
  }
  function taskStatus(t) {
    if(t.outcome?.integrated===true) return 'Integrated';
    return ({accepted:'Accepted',completed:'Completed',awaiting_review:'In review',codex_active:'Working',running:'Working',queued:'Queued',failed:'Failed',blocked:'Blocked',stopped:'Stopped',cancelled:'Stopped',partial:'Partial',waiting_user:'Answer needed',waiting_question:'Answer needed',awaiting_user:'Answer needed',awaiting_supervisor:'Answer needed',ready_to_integrate:'Accepted',awaiting_legacy_review:'Waiting for review',codex_ready:'Ready',paused:'Paused'})[t.status] || title(t.status,'Status unknown').replaceAll('_',' ');
  }
  function questionText(question) {
    return typeof question==='string'?question:question?.text||question?.question||question?.prompt||null;
  }
  function actorRecord(kind,rows,mode,now,agents=[]) {
    const name=kind==='codex'?'Codex':'DeepSeek';
    const absent=(mode==='codex_only'&&kind==='deepseek')||(mode==='deepseek_only'&&kind==='codex');
    if(absent) return {action:kind==='deepseek'?'Not used in this mode':'Relay available in Codex',assignment:kind==='deepseek'?'Codex handles implementation and review':'Answers and controls stay in Codex',status:kind==='deepseek'?'Not participating':'Relay only · no implementation or review',report:'No implementation report expected',source:`${modes[mode].name} mode`};
    const active=rows.find(t=>t.actor===kind&&!terminal(t.status)) || rows.find(t=>t.actor===kind);
    const nativeReport=kind==='codex'?agents.filter(a=>a.actor==='codex'&&a.lastReport).sort((a,b)=>b.lastReport.at-a.lastReport.at)[0]:null;
    if(!active && nativeReport) { const report=nativeReport.lastReport,old=now-report.at>300000;return {action:old?'No recent native report':report.summary||'No summary reported',assignment:rows.find(t=>t.id===nativeReport.taskId)?.objective?title(rows.find(t=>t.id===nativeReport.taskId).objective):'Registered native report',task:rows.some(t=>t.id===nativeReport.taskId)?nativeReport.taskId:undefined,status:old?'Activity unknown':`Reported ${report.status||'activity'}`,report:`Reported ${age(report.at,now)}`,source:`Registered native report · ${nativeReport.role||'native'}`}; }
    if(!active && kind==='codex') { const reviewed=rows.find(t=>t.outcome?.review && !/no recorded|no Codex/i.test(t.outcome.review));if(reviewed)return {action:reviewed.outcome.review,assignment:title(reviewed.objective),task:reviewed.id,status:'Saved review outcome',report:'No live native report is available',source:'Coordinator review record'}; }
    if(!active) return {action:'No activity reported',assignment:'No implementation assignment reported',status:mode==='overnight_review'&&kind==='codex'?'Review state shown in task details':'Activity unknown',report:'No registered report',source:kind==='codex'?'Registered native reports only':'Mosaic-captured worker actions only'};
    const stale=!Number.isFinite(active.lastActivityAt)||now-active.lastActivityAt>300000;
    const done=terminal(active.status),status=done?taskStatus(active):stale?'Activity unknown':taskStatus(active);
    return {action:done?active.outcome?.summary||`${name} assignment ${status.toLowerCase()}`:stale?'No recent progress report':active.lastActivity||'No action reported',assignment:title(active.objective,'Registered assignment'),task:active.id,status,report:`${kind==='codex'?'Reported':'Captured'} ${age(active.lastActivityAt,now)}${stale&&!done?' · current activity unknown':''}`,source:kind==='codex'?'Registered native report':'Mosaic-captured worker action'};
  }
  function adaptSnapshot(snapshot,events=[],now=Date.now()) {
    const d={modes:structuredModes(),projects:[],tasks:{},history:[],events:[],sample:false,connection:'connected',generatedAt:snapshot.generatedAt??now,cursor:snapshot.cursor??0};
    const goals=[...(snapshot.goals||[])].sort((a,b)=>(terminal(a.status)?1:0)-(terminal(b.status)?1:0));
    for(const g of goals) {
      const mode=g.mode||'unknown';
      if(!d.modes[mode]) d.modes[mode]={name:`Unknown mode · ${mode}`,description:'This mode is not recognized by this version of Mosaic. Its saved actor records are displayed without inferring permissions.'};
      const rows=(snapshot.tasks||[]).filter(t=>t.goalId===g.id).map(t=>{
        if(t.actor!=='codex')return t;
        const report=(snapshot.agents||[]).filter(a=>a.goalId===g.id&&a.taskId===t.id&&a.actor==='codex'&&Number.isFinite(a.lastReport?.at)).sort((a,b)=>b.lastReport.at-a.lastReport.at)[0];
        return report && (!Number.isFinite(t.lastActivityAt)||report.lastReport.at>=t.lastActivityAt) ? {...t,lastActivityAt:report.lastReport.at,lastActivity:report.lastReport.summary,nativeReportRole:report.role} : t;
      });
      for(const t of rows) {
        const status=taskStatus(t),out=t.outcome||{}, q=waiting(t)?questionText(t.question):null;
        const result={id:t.id,project:g.id,title:title(t.objective,'Registered assignment'),objective:t.objective||'Objective not reported',actor:t.actor==='codex'?'Codex':t.actor==='deepseek'?'DeepSeek':'Actor not reported',implementer:t.actor==='codex'?'Codex':t.actor==='deepseek'?'DeepSeek':'Not reported',mode,status,tone:['Failed','Blocked','Stopped'].includes(status)?'rose':status==='Answer needed'?'amber':'mint',outcome:out.summary||'No saved implementation outcome yet.',checks:checkLabel(out.checks),checksPassed:!!(out.checks&&out.checks.total>0&&out.checks.passed===out.checks.total),review:out.review||'Review not recorded',integration:out.integrated===true?'Integrated':'Not integrated yet',report:`${t.provenance==='reported'?'Native report':'Captured activity'} · ${age(t.lastActivityAt,now)}`,elapsed:'Not reported',attempts:'Not reported',requests:Number.isFinite(t.spent?.model)?String(t.spent.model):'Not reported',usage:t.usage?.reportedTokens==null?'Not reported':`${t.usage.reportedTokens} reported tokens`,files:Array.isArray(out.files)?out.files:[],checkItems:[],feedback:'Review feedback has not been loaded.',output:out.summary||'No saved output reported.',diff:'Saved changes have not been loaded. Open Changes to read the recorded evidence.',integrationDetail:out.integrated===true?`Accepted changes integrated${out.commit?` · commit ${out.commit}`:''}. This saved result remains valid when activity reports become old.`:'No integration result has been recorded.',question:q,rawRecord:t,evidenceRef:t.evidenceRef||null,evidenceNotice:'',evidenceLoaded:false};
        d.tasks[t.id]=result;
        if(terminal(t.status)||out.integrated===true)d.history.push({task:t.id,goal:title(g.objective),when:date(t.lastActivityAt)});
      }
      const q=rows.some(t=>waiting(t)&&questionText(t.question));
      const pending=rows.find(t=>!terminal(t.status));
      const stale=pending?.actor==='codex'&&(!pending.lastActivityAt||now-pending.lastActivityAt>300000);
      const state=q?'question':!rows.length?'empty':stale?'stale':pending?.status==='awaiting_review'?'review':'active';
      const name=title(g.objective), selected=pending?.id||rows[0]?.id||null;
      const status=rows.length&&rows.every(t=>t.outcome?.integrated)?'Integrated':q?'Your answer needed':stale?'Activity unknown':({completed:'Completed',partial:'Partial',stopped:'Stopped',active:'In progress',failed:'Failed'})[g.status]||title(g.status,'Status unknown');
      d.projects.push({id:g.id,name,initials:name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase(),color:'mint',description:'Registered Mosaic goal',mode,goal:name,subtitle:'Saved work, checks and handoffs from your coordinator.',state,status,tasks:rows.map(t=>t.id),selected,codex:actorRecord('codex',rows,mode,now,(snapshot.agents||[]).filter(a=>a.goalId===g.id)),deepseek:actorRecord('deepseek',rows,mode,now),handoff:mode==='deepseek_only'?['Work registered','Checks','Acceptance','Integration']:['Work registered','Checks','Review','Integration'],currentStep:status==='Integrated'?3:d.tasks[selected]?.status==='Accepted'?3:d.tasks[selected]?.checksPassed===true?2:pending?0:1,notice: q?'Read the saved question in task details, then answer in Codex.':stale?'The latest registered native report is old or unavailable. Current activity is unknown; saved outcomes are unchanged.':undefined});
    }
    if(!d.projects.length)d.projects.push({id:'workspace',name:'Personal workspace',initials:'M',color:'mint',description:'No goals registered',mode:'unknown',goal:'No active Mosaic work',subtitle:'Ready when your next idea is',state:'empty',status:'No active work',tasks:[],selected:null});
    const goalIds=new Set(d.projects.map(p=>p.id));
    d.events=events.filter(e=>goalIds.has(e.goalId)).map(e=>({id:`event-${e.seq}`,seq:e.seq,project:e.goalId,task:d.tasks[e.taskId]?e.taskId:null,actor:e.actor==='codex'?'Codex':e.actor==='deepseek'?'DeepSeek':'Mosaic',title:e.summary||title(e.type),detail:e.summary||'No further event detail reported.',time:date(e.at),age:age(e.at,now),type:e.type||'event',icon:/integrat/.test(e.type)?'merge':/review/.test(e.type)?'eye':/check/.test(e.type)?'checkCircle':/question/.test(e.type)?'message':'clock',source:e.provenance==='reported'?'Registered native report':e.provenance==='captured'?'Captured worker action':'Coordinator record'})).sort((a,b)=>b.seq-a.seq);
    return d;
  }
  function structuredModes(){return Object.fromEntries(Object.entries(modes).map(([k,v])=>[k,{...v}]))}
  function applyEvidence(task,evidence) {
    const t={...task,evidenceLoaded:true};
    if(evidence.partial)t.evidenceNotice='Partial in-progress evidence. This task has not reached a terminal result.';
    if(evidence.truncated){t.evidenceNotice='Partial bounded evidence. The raw record is truncated; summary milestones remain from the authoritative snapshot.';t.rawEvidence=evidence.text||'';return t;}
    let raw;try{raw=JSON.parse(evidence.text)}catch{t.evidenceNotice=(t.evidenceNotice||'')+' Saved evidence could not be decoded. Summary milestones remain available.';t.rawEvidence=evidence.text||'';return t;}
    t.rawRecord=raw;
    const result=raw.result||{},changes=result.changes||[],newFiles=Array.isArray(result.newFiles)?result.newFiles:[];
    const unified=typeof result.diff==='string'?result.diff:'';
    const diffPaths=[...unified.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m=>m[1]);
    t.files=[...new Set([...(t.files||[]),...changes.map(c=>c.path),...newFiles.map(c=>c.path),...diffPaths].filter(Boolean))];
    const contents=changes.map(c=>`File: ${c.path}\nAction: ${c.action}\n${c.action==='delete'?'Recorded deletion':c.content??'Content not recorded'}`).join('\n\n');
    const added=newFiles.map(c=>`New file: ${c.path}\n${c.content??'Content not recorded'}`).join('\n\n');
    t.diff=[unified,contents,added].filter(Boolean).join('\n\n')||'No file contents are included in this evidence record.';
    t.changeNotice=unified?'Saved unified diff and any recorded new-file contents.':'Recorded file contents and actions. A before/after unified diff is not supplied by this observer.';
    t.checkItems=(result.checks||[]).map(c=>`${c.passed?'Passed':'Failed'} · ${c.id||'Protected check'}${c.code!=null?` · exit ${c.code}`:''}${c.stdout?`\n${c.stdout}`:''}${c.stderr?`\n${c.stderr}`:''}`);
    const feedback=Array.isArray(raw.feedback)?raw.feedback:[];
    t.feedback=feedback.length?feedback.map(f=>`${f.decision||'Feedback'}: ${f.text||f.feedback||'No text recorded'}`).join('\n\n'):'No operator review feedback is included in this evidence.';
    t.output=result.summary||result.workerSummary||t.output;
    if(Number.isInteger(raw.attempts))t.attempts=String(raw.attempts);
    return t;
  }
  window.MosaicAdapter={adaptSnapshot,applyEvidence,mergeEvents};
})();
