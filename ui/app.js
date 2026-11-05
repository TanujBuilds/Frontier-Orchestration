/* Mosaic observer prototype. Views are local; no execution or approval APIs exist. */
(() => {
  'use strict';
  let data = window.MOSAIC_DATA;
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const all = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths = {
    work: '<rect x="4" y="4" width="6" height="16" rx="2"/><rect x="14" y="4" width="6" height="16" rx="2"/><path d="M7 9h0m10 6h0"/>',
    timeline: '<path d="M5 4v16M10 6h10M10 12h7M10 18h10"/><circle cx="5" cy="6" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="5" cy="18" r="1.5"/>',
    history: '<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2"/>',
    projects: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    external: '<path d="M14 4h6v6m0-6L10 14M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
    code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    circle: '<circle cx="12" cy="12" r="8"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    merge: '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="4" r="2"/><path d="M6 6v12m12-12c0 7-12 3-12 10"/>',
    file: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8m-8 4h6"/>',
    message: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V5a2 2 0 0 1 2-2h8a8 8 0 0 1 8 8Z"/><path d="M7 8h10M7 12h7"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    link: '<path d="m10 13 4-2m-6 5H6a4 4 0 0 1 0-8h4m4 0h4a4 4 0 0 1 0 8h-4"/>',
    disconnect: '<path d="m3 3 18 18M9 8H6a4 4 0 0 0-3 6m3 2h4m5-8h3a4 4 0 0 1 3 6m-7 2h4"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4"/>',
    alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m12-10c0 6-12 3-12 8"/>',
    folder: '<path d="M3 7V4h6l3 3h9v13H3V7Z"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>'
  };
  const icon = name => `<svg class="od-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">${paths[name] || paths.circle}</svg>`;
  const state = {
    project: data.projects[0].id, view: 'recent', task: data.projects[0].selected, tab: 'summary',
    timeline: { project: data.projects[0].id, task: 'all', actor: 'all' },
    history: { project: 'all', result: 'all', query: '' },
    selections: {}, tabs: {}, expanded: {}, scroll: {}, inspectorOpen: false, chatQuery: ''
  };
  let pendingSaved = null;
  // Storage is optional in a sandbox. The same state works entirely in memory.
  try {
    const saved = JSON.parse(localStorage.getItem(window.MosaicRuntime.demo ? 'mosaic-observer-demo-v1' : 'mosaic-observer-v1') || 'null');
    pendingSaved = saved;
    if (saved && data.projects.some(p => p.id === saved.project)) {
      state.project = saved.project;
      state.selections = { ...state.selections, ...(saved.selections || {}) };
      state.task = data.tasks[saved.task] ? saved.task : currentProject().selected;
      state.tabs = saved.tabs || {};
      state.expanded = saved.expanded || {};
      state.view = ['recent','overview','timeline','history','projects'].includes(saved.view) ? saved.view : 'recent';
      state.inspectorOpen = state.view !== 'recent';
      state.tab = state.tabs[state.task] || 'summary';
      state.timeline.project = state.project;
    }
  } catch (_) { /* in-memory state remains available */ }
  function currentProject() { return data.projects.find(p => p.id === state.project) || data.projects[0]; }
  function currentTask() { return data.tasks[state.task] || null; }
  function save() {
    try { localStorage.setItem(window.MosaicRuntime.demo ? 'mosaic-observer-demo-v1' : 'mosaic-observer-v1', JSON.stringify({ project: state.project, task: state.task, view: state.view, selections: state.selections, tabs: state.tabs, expanded: state.expanded })); } catch (_) { /* no persistence required */ }
  }
  function capture() {
    const main = $('#main');
    const detail = $('#inspector-scroll');
    if (main) state.scroll[`${state.project}:${state.view}`] = main.scrollTop;
    if (detail) state.scroll[`detail:${state.task}:${state.tab}`] = detail.scrollTop;
    all('details[data-key]').forEach(el => { state.expanded[el.dataset.key] = el.open; });
  }
  function restore() {
    $('#main').scrollTop = state.scroll[`${state.project}:${state.view}`] || 0;
    const detail = $('#inspector-scroll');
    if (detail) detail.scrollTop = state.scroll[`detail:${state.task}:${state.tab}`] || 0;
    all('details[data-key]').forEach(el => { el.open = !!state.expanded[el.dataset.key]; });
  }
  const badge = (text, tone = 'muted', glyph = '') => `<span class="badge ${escape(tone)}">${glyph ? icon(glyph) : ''}${escape(text)}</span>`;
  const modeButton = mode => `<button type="button" class="mode-button" data-action="mode" data-mode="${escape(mode)}" aria-label="About ${escape(data.modes[mode].name)} mode">${icon('people')}${escape(data.modes[mode].name)}${icon('down')}</button>`;
  function projectColor(p) { return p.color === 'mint' ? 'var(--mint)' : p.color === 'blue' ? 'var(--blue)' : p.color === 'amber' ? 'var(--amber)' : p.color === 'rose' ? 'var(--rose)' : 'var(--lilac)'; }
  function projectTone(p) { return ['question','review','loading'].includes(p.state) ? 'amber' : ['unavailable','disconnected'].includes(p.state) ? 'rose' : ['empty','stale'].includes(p.state) ? 'muted' : 'mint'; }
  function renderChrome() {
    const p = currentProject();
    const select = $('#project-select');
    select.innerHTML = data.projects.map(item => `<option value="${item.id}"${item.id === p.id ? ' selected' : ''}>${escape(item.name)}</option>`).join('');
    $('#project-initials').textContent = p.initials;
    $('#project-initials').style.color = projectColor(p);
    $('#breadcrumb-project').textContent = state.view === 'recent' ? 'Personal workspace' : p.name;
    $('#breadcrumb-view').textContent = {recent:'Recent · all projects',overview:'Current work',timeline:'Shared timeline',history:'History',projects:'Projects'}[state.view];
    const connection = $('#connection');
    const connectionText = data.connection === 'demo' ? 'Design demo · not connected' : data.connection === 'disconnected' ? 'Coordinator disconnected' : data.connection === 'loading' ? 'Connecting to coordinator' : 'Coordinator connected';
    connection.className = `connection${data.connection === 'disconnected' ? ' offline' : data.connection === 'loading' ? ' loading' : ''}`;
    connection.setAttribute('aria-label', connectionText);
    connection.innerHTML = `<span class="status-dot"></span><span class="connection-label">${escape(connectionText)}</span>`;
    all('.sample-badge,.workspace-button .tiny').forEach(el => el.textContent = data.sample ? 'Design demo' : 'Live observer');
    $('#snapshot-notice').hidden = data.connection !== 'disconnected';
    $('#snapshot-message').textContent = data.hasSnapshot && data.generatedAt ? 'Connection lost. Showing the snapshot from '+new Date(data.generatedAt).toLocaleTimeString()+'. Current activity is unknown. Retry here or inspect the coordinator in Codex.' : 'No snapshot available. Open Codex and check the Mosaic coordinator, then retry.';
    all('.nav-button').forEach(button => {
      button.classList.toggle('active', button.dataset.view === state.view);
      if (button.dataset.view === state.view) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
    });
    $('#side-tasks').innerHTML = p.tasks.length ? p.tasks.map(id => {
      const task = data.tasks[id];
      return `<button type="button" class="side-task${state.task === id ? ' selected' : ''}" data-action="task" data-task="${id}" aria-pressed="${state.task === id}"><span class="status-dot ${task.tone}"></span><span class="od-truncate">${escape(task.title)}</span></button>`;
    }).join('') : `<p class="sidebar-label">${p.state === 'loading' ? 'Awaiting first snapshot' : 'No registered assignments'}</p>`;
    $('#sidebar-task-label').textContent = p.state === 'empty' ? 'In this project' : 'Assignments';
  }
  function intro(p, title, subtitle, showMode = true) {
    return `<header class="page-intro"><div class="od-fill"><h1 id="page-heading" tabindex="-1">${escape(title)}</h1><p>${escape(subtitle)}</p>${showMode ? `<div class="goal-meta">${modeButton(p.mode)}${p.started ? `<span class="goal-time">Started ${escape(p.started.toLowerCase())}</span>` : ''}</div>` : ''}</div>${showMode ? `<span class="goal-status ${projectTone(p)}"><span class="status-dot"></span>${escape(p.status)}</span>` : ''}</header>`;
  }
  function notice(p) {
    const notices = {
      question: { icon:'message', title:'Waiting for your answer in Codex', body:'Read the saved question in task details, then answer in Codex.', action:true },
      stale: { icon:'clock', title:'No recent native progress report', body:'The last registered native report is old or unavailable. Current activity is unknown. Check the conversation in Codex for context.', tone:'quiet', action:true },
      review: { icon:'eye', title:'Checks passed. Review comes next.', body:'DeepSeek’s result is saved. Bounded automatic Codex review has not started; the result is not yet accepted.' },
      unavailable: { icon:'alert', title:'DeepSeek is unavailable', body:'The saved plan is preserved. Implementation is blocked; Codex has not taken over. Inspect worker availability from Codex.', tone:'problem', action:true },
      disconnected: { icon:'disconnect', title:'You’re viewing the last saved snapshot', body:'The coordinator is disconnected. These reports are 12 minutes old; current activity is unknown. Check the coordinator from Codex.', tone:'problem', action:true }
    };
    const item = notices[p.state];
    if (item && p.notice) item.body = p.notice;
    return item ? `<section class="notice ${item.tone || ''}" aria-label="Work notice">${icon(item.icon)}<div><strong>${item.title}</strong><p>${item.body}</p>${item.action ? `<button type="button" class="text-button" data-action="open-codex">Open Codex ${icon('external')}</button>` : ''}</div></section>` : '';
  }
  function actorPanel(actor, kind) {
    const native = kind === 'codex';
    return `<section class="actor-panel ${kind}" aria-label="${native ? 'Codex' : 'DeepSeek'} activity"><div class="actor-head"><span class="actor-symbol">${icon(native ? 'terminal' : 'layers')}</span><h2 class="actor-name">${native ? 'Codex' : 'DeepSeek'}</h2><span class="actor-role">${native ? (currentProject().mode === 'collaborative' ? 'Lead' : currentProject().mode === 'deepseek_only' ? 'Relay' : 'Native') : 'Local worker'}</span></div><p class="actor-action">${escape(actor.action)}</p><div class="actor-status">${icon(actor.status.includes('passed') ? 'checkCircle' : actor.status.includes('Reviewing') ? 'eye' : actor.status.includes('unknown') ? 'info' : 'clock')}<span>${escape(actor.status)}</span></div>${actor.task ? `<button type="button" class="actor-assignment" data-action="task" data-task="${actor.task}" aria-label="Inspect ${escape(actor.assignment)}">${icon('file')}<span class="od-field"><small>Assignment</small><strong>${escape(actor.assignment)}</strong></span>${icon('chevron')}</button>` : `<div class="actor-assignment"><span class="od-field"><small>Participation</small><strong>${escape(actor.assignment)}</strong></span></div>`}${actor.agent ? `<button type="button" class="native-agent" data-action="task" data-task="${actor.agentTask}">${icon('branch')}<span class="status-dot"></span><span>${escape(actor.agent)}</span></button>` : ''}<div class="actor-report">${icon(native ? 'clock' : 'checkCircle')}<span>${escape(actor.report)}</span></div><p class="actor-source">${escape(actor.source)}</p></section>`;
  }
  function handoff(p) {
    return `<section class="handoff" aria-label="Current handoff"><span class="handoff-label">Current handoff</span><div class="handoff-steps">${p.handoff.map((step,index) => `${index ? icon('arrow').replace('od-icon','od-icon handoff-arrow') : ''}<span class="handoff-step${index < p.currentStep ? ' done' : index === p.currentStep ? ' current' : ''}">${icon(index < p.currentStep ? 'checkCircle' : index === p.currentStep ? 'eye' : 'circle')}<span>${escape(step)}</span>${index === p.currentStep ? '<span class="sr-only"> · current milestone</span>' : ''}</span>`).join('')}</div></section>`;
  }
  function taskRow(id) {
    const task = data.tasks[id];
    return `<button type="button" class="assignment-row${id === state.task ? ' selected' : ''}" data-action="task" data-task="${id}" aria-pressed="${id === state.task}"><span class="assignment-symbol ${task.tone}">${icon(task.status === 'Integrated' ? 'checkCircle' : task.status === 'Working' ? 'code' : 'file')}</span><span class="od-field"><span class="assignment-title od-truncate">${escape(task.title)}</span><span class="assignment-actor">${escape(task.actor)}</span></span>${badge(task.status,task.tone)}${icon('chevron')}</button>`;
  }
  function recentActivity(p) {
    const events = data.events.filter(event => event.project === p.id).slice(0,3);
    return `<section class="activity-section"><div class="section-title"><h2>Recent activity</h2><button type="button" class="text-button" data-action="project-timeline">Full timeline ${icon('arrow')}</button></div><div class="activity-list">${events.length ? events.map(event => `<div class="activity-row"><span class="event-symbol">${icon(event.icon)}</span><div><button type="button" class="event-title" data-action="event" data-event="${event.id}">${escape(event.title)}</button><p class="event-actor">${escape(event.actor)}<span aria-hidden="true"> · </span>${escape(data.tasks[event.task]?.title || 'Goal activity')}</p></div><span class="event-time">${escape(event.age)}</span></div>`).join('') : '<p class="small muted">No captured activity yet.</p>'}</div></section>`;
  }
  function footnote() { return `<p class="main-footnote">${icon('info')}<span>DeepSeek actions are captured by Mosaic. Codex activity comes from registered native reports and may be stale or unavailable.</span></p>`; }
  function overview() {
    const p = currentProject();
    const header = intro(p,p.goal,p.subtitle);
    if (p.state === 'empty') return `${header}<section class="large-empty"><span class="empty-symbol">${icon('work')}</span><h2>A clear space for your next goal.</h2><p>No Mosaic work is registered for this project. Give Codex a coding task and choose a mode there. Registered work will appear here.</p><button type="button" class="soft-button" data-action="open-codex">Open Codex ${icon('external')}</button><button type="button" class="text-button" data-action="view" data-view="history">Browse saved results ${icon('arrow')}</button></section>${footnote()}`;
    if (p.state === 'loading') return `${header}<p class="loading-note" role="status">Waiting for the coordinator’s first snapshot.<span class="loading-dots" aria-hidden="true"><i></i><i></i><i></i></span><br>Actor activity will appear when it is reported.</p><div class="skeleton-grid" aria-hidden="true">${[1,2].map(() => '<div class="skeleton-card"><span class="skeleton short"></span><span class="skeleton large"></span><span class="skeleton"></span><span class="skeleton short"></span></div>').join('')}</div><p class="small muted">No activity or outcome is inferred while work is loading.</p>${footnote()}`;
    return `${header}${notice(p)}<div class="actor-grid">${actorPanel(p.codex,'codex')}${actorPanel(p.deepseek,'deepseek')}</div>${handoff(p)}<section><div class="section-title"><h2>Assignments <span class="muted tiny">${p.tasks.length}</span></h2><span class="tiny muted">Registered work only</span></div><div class="assignment-list">${p.tasks.map(taskRow).join('')}</div></section>${recentActivity(p)}${footnote()}`;
  }
  function recentTaskRow(task) {
    const project=data.projects.find(p=>p.id===task.project);
    const linked=task.chatId && (data.recentChats?.items||[]).some(c=>c.id===task.chatId);
    return `<article class="recent-work-row"><button type="button" class="recent-task-button" aria-pressed="${state.task===task.id && state.inspectorOpen}" data-action="task" data-task="${escape(task.id)}"><span class="event-symbol">${icon(task.actor==='DeepSeek'?'layers':'terminal')}</span><span class="od-field"><span class="recent-project">${escape(project?.name||'Project not reported')}</span><strong>${escape(task.title)}</strong><small>${escape(task.actor)} · ${escape(data.modes[task.mode]?.name||'Mode not reported')}${task.environment==='fixture'?' · Fixture':''}${task.goalStatus&&task.goalStatus!=='active'?' · Goal '+escape(task.goalStatus):''}</small></span><span class="recent-row-state">${badge(task.status,task.tone)}<small>${escape(data.sample?'Frozen example':task.updatedLabel||'Time not reported')}</small></span>${icon('chevron')}</button>${linked?`<button type="button" class="text-button linked-chat" data-action="open-chat" data-chat="${escape(task.chatId)}">Open linked chat ${icon('external')}</button>`:''}</article>`;
  }
  function chatRows() {
    const list=data.recentChats||{state:'loading',items:[]};
    if(data.sample)return '<p class="recent-empty">Design demo. Real Codex chat titles appear in Live Work.</p>';
    const items=(list.items||[]).filter(c=>`${c.title} ${c.project}`.toLowerCase().includes(state.chatQuery.toLowerCase()));
    const error=list.state==='error'?`<div class="recent-inline-notice" role="status"><p>${escape(list.error)}${list.loadedAt?' Showing the last successful chat list.':''}</p><button type="button" class="text-button" data-action="refresh-chats">Retry chats</button></div>`:'';
    if(!items.length)return `${error}<p class="recent-empty">${list.state==='loading'?'Loading recent chats…':state.chatQuery?'No chats match your search.':list.state==='error'?'Chat titles are unavailable. Open Codex to find your conversation.':'No recent local Codex chats.'}</p>`;
    return `${error}<div class="recent-chat-list">${items.map(chat=>{
      const timestamp=Number.isFinite(chat.updatedAt)?chat.updatedAt*(chat.updatedAt<1e12?1000:1):null;
      return `<article class="recent-chat-row"><span class="event-symbol">${icon('message')}</span><span class="od-field"><h3>${escape(chat.title)}</h3><small>${escape(chat.project||'Project not reported')} · ${escape(timestamp?new Date(timestamp).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Update time not reported')}</small></span><button type="button" class="soft-button" data-action="open-chat" data-chat="${escape(chat.id)}" aria-label="Open chat: ${escape(chat.title)}">Open chat ${icon('external')}</button></article>`;
    }).join('')}</div>`;
  }
  function recent() {
    const work=window.MosaicAdapter.recentWork(data);
    const offline=data.connection==='disconnected';
    const live=`<section class="recent-section" aria-label="DeepSeek across all projects"><div class="section-title"><h2>${offline?'Last saved DeepSeek assignments':'DeepSeek now'} <span class="count">${work.working.length}</span></h2><span class="tiny muted">${offline?'Current activity unknown':'Registered work'}</span></div>${work.working.length?`<div class="recent-work-list">${work.working.map(recentTaskRow).join('')}</div>`:`<div class="recent-empty-state">${icon('layers')}<div><strong>${data.connection==='loading'?'Checking registered assignments…':'No running DeepSeek assignment recorded'}</strong><p>${offline?'Reconnect to see current assignments.':'A collaborative chat can be planning or waiting before it registers a DeepSeek assignment. Find the conversation in Recent Codex chats.'}</p></div></div>`}</section>`;
    const waiting=work.waiting.length?`<section class="recent-section"><div class="section-title"><h2>Waiting & needs attention</h2><span class="tiny muted">${work.waiting.length} assignments</span></div><div class="recent-work-list">${work.waiting.slice(0,8).map(recentTaskRow).join('')}</div></section>`:'';
    const chats=`<section class="recent-section recent-chats" aria-label="Recent Codex chats"><div class="section-title"><h2>Recent Codex chats</h2><button type="button" class="text-button" data-action="refresh-chats">Refresh chats</button></div><p class="recent-section-note">Open the exact conversation. Saved chat activity does not imply DeepSeek is working there.</p><label class="sr-only" for="recent-chat-search">Find a recent chat</label><input id="recent-chat-search" class="search-input recent-search" type="search" placeholder="Find a chat or project" value="${escape(state.chatQuery)}" autocomplete="off"><div id="recent-chat-results">${chatRows()}</div></section>`;
    const projects=`<section class="recent-section recent-projects"><div class="section-title"><h2>Recent projects</h2><span class="tiny muted">Most recently updated first</span></div>${work.recent.length?`<div class="recent-work-list">${work.recent.map(recentTaskRow).join('')}</div>`:'<p class="recent-empty">No registered project activity yet.</p>'}</section>`;
    return `${intro(currentProject(),'Recent','DeepSeek work and recent chats, across all your projects.',false)}<div class="recent-grid"><div class="recent-live">${live}${waiting}</div>${chats}${projects}</div>${footnote()}`;
  }
  function projectOptions(value, allProjects = true) {
    return `${allProjects ? `<option value="all"${value === 'all' ? ' selected' : ''}>All projects</option>` : ''}${data.projects.map(p => `<option value="${p.id}"${p.id === value ? ' selected' : ''}>${escape(p.name)}</option>`).join('')}`;
  }
  function timeline() {
    const filter = state.timeline;
    const taskOptions = Object.values(data.tasks).filter(t => filter.project === 'all' || t.project === filter.project);
    const events = data.events.filter(e => (filter.project === 'all' || e.project === filter.project) && (filter.task === 'all' || e.task === filter.task) && (filter.actor === 'all' || e.actor === filter.actor));
    return `${intro(currentProject(),'Shared timeline','The handoffs, decisions, and evidence behind the work.',false)}<div class="filter-bar"><div class="filter"><label for="timeline-project">Project</label><select id="timeline-project" data-filter="timeline-project">${projectOptions(filter.project)}</select></div><div class="filter"><label for="timeline-task">Assignment</label><select id="timeline-task" data-filter="timeline-task"><option value="all">All assignments</option>${taskOptions.map(task => `<option value="${task.id}"${filter.task === task.id ? ' selected' : ''}>${escape(task.title)}</option>`).join('')}</select></div><div class="filter"><label for="timeline-actor">Actor</label><select id="timeline-actor" data-filter="timeline-actor">${['all','Codex','DeepSeek','Protected checks','Mosaic'].map(actor => `<option value="${actor}"${filter.actor === actor ? ' selected' : ''}>${actor === 'all' ? 'All actors' : actor}</option>`).join('')}</select></div></div><div class="section-title"><span class="small secondary">Saved activity <span class="muted tiny">· ${events.length} ${events.length === 1 ? 'event' : 'events'}</span></span><span class="tiny muted">Newest first</span></div>${events.length ? events.map(event => `<article class="timeline-event"><div class="timeline-marker"><span class="event-symbol">${icon(event.icon)}</span></div><details class="timeline-card" data-key="event:${event.id}"><summary><span class="od-field"><span class="event-title">${escape(event.title)}</span><span class="event-actor">${escape(event.actor)} · ${escape(data.projects.find(p => p.id === event.project).name)}</span></span><span class="event-time">${escape(event.time)}</span></summary><div class="timeline-body"><p>${escape(event.detail)}</p><p class="timeline-source">${escape(event.source)} · ${escape(data.tasks[event.task]?.title || 'Goal activity')}</p>${event.task ? `<button type="button" class="text-button" data-action="task" data-task="${event.task}">Inspect assignment ${icon('arrow')}</button>` : ''}</div></details></article>`).join('') : `<div class="empty-results"><h2>No matching events</h2><p>Try another actor or assignment to see the saved activity.</p><button type="button" class="soft-button" data-action="clear-timeline">Clear filters</button></div>`}${footnote()}`;
  }
  function history() {
    const f = state.history;
    const items = data.history.filter(item => {
      const task = data.tasks[item.task];
      const result = ['Integrated','Accepted'].includes(task.status) ? 'accepted' : task.status.toLowerCase();
      const project = data.projects.find(p => p.id === task.project);
      return (f.project === 'all' || task.project === f.project) && (f.result === 'all' || result === f.result) && `${task.title} ${item.goal} ${project.name}`.toLowerCase().includes(f.query.toLowerCase());
    });
    return `${intro(currentProject(),'History & results','Saved outcomes, with the context that made them.',false)}<div class="filter-bar"><div class="filter"><label for="history-search">Find saved work</label><input id="history-search" class="search-input" type="search" placeholder="Search goals or assignments" value="${escape(f.query)}" autocomplete="off" data-filter="history-query"></div></div><div class="filter-bar"><div class="filter"><label for="history-project">Project</label><select id="history-project" data-filter="history-project">${projectOptions(f.project)}</select></div><div class="filter"><label for="history-result">Outcome</label><select id="history-result" data-filter="history-result">${[['all','All outcomes'],['accepted','Accepted or integrated'],['partial','Partial'],['blocked','Blocked'],['failed','Failed']].map(([value,label]) => `<option value="${value}"${f.result === value ? ' selected' : ''}>${label}</option>`).join('')}</select></div></div><div id="history-results" aria-live="polite">${historyRows(items)}</div><p class="main-footnote">${icon('info')}<span>Saved acceptance and integration remain valid when old activity reports become stale. Checks, review, and integration are separate milestones.</span></p>`;
  }
  function historyRows(items) {
    return items.length ? `<div class="section-title"><h2>Saved assignments</h2><span class="tiny muted">${items.length} results</span></div><div class="history-list">${items.map(item => {
      const task = data.tasks[item.task];
      const project = data.projects.find(p => p.id === task.project);
      return `<button type="button" class="history-row${state.task === task.id ? ' selected' : ''}" data-action="task" data-task="${task.id}"><span class="assignment-symbol ${task.tone}">${icon(task.status === 'Integrated' ? 'merge' : task.status === 'Accepted' ? 'checkCircle' : 'file')}</span><span class="od-field"><strong>${escape(task.title)}</strong><small>${escape(project.name)} · ${escape(item.goal)}</small><small>${escape(task.mode === 'deepseek_only' ? 'Checks only; no Codex review' : task.actor)}</small></span><span class="history-meta">${badge(task.status,task.tone)}<span class="tiny">${escape(item.when)}</span></span></button>`;
    }).join('')}</div>` : `<div class="empty-results"><h2>No saved results match</h2><p>Try another project, outcome, or search term.</p><button type="button" class="soft-button" data-action="clear-history">Clear filters</button></div>`;
  }
  function projects() {
    return `${intro(currentProject(),'Projects','A window into your registered coding work.',false)}<div class="project-grid">${data.projects.map(p => `<button type="button" class="project-card" data-action="project" data-project="${p.id}" aria-label="Open ${escape(p.name)}, ${escape(p.status)}"><span class="project-card-head"><span class="project-mini" style="color:${projectColor(p)}">${p.initials}</span><span class="od-field"><h2>${escape(p.name)}</h2><span class="tiny muted">${escape(p.description)}</span></span></span><p>${escape(p.goal)}</p><span class="project-card-foot">${badge(p.status,projectTone(p))}${icon('chevron')}</span><span class="mode-name">${escape(data.modes[p.mode].name)}</span></button>`).join('')}</div><p class="main-footnote">${icon('info')}<span>Each workspace represents a saved Mosaic goal. Unrelated chats and projects without registered work do not appear here.</span></p>`;
  }
  function disclosure(key, title, body) { return `<details class="disclosure" data-key="detail:${state.task}:${key}"><summary>${escape(title)}</summary><div class="disclosure-body">${body}</div></details>`; }
  function milestone(glyph, color, title, subtitle) { return `<div class="milestone">${icon(glyph).replace('od-icon',`od-icon ${color}`)}<span class="od-field"><strong>${escape(title)}</strong><small>${escape(subtitle)}</small></span></div>`; }
  function fileList(task) { return task.files.length ? task.files.map(file => `<div class="file-row">${icon('file')}<code>${escape(file)}</code></div>`).join('') : '<p class="small muted">No changed files reported.</p>'; }
  function checks(task) { return task.checkItems.length ? `<div class="check-list">${task.checkItems.map(check => `<div class="check-item">${icon(check.toLowerCase().includes('failed') ? 'alert' : 'checkCircle')}<span>${escape(check)}</span></div>`).join('')}</div><p class="detail-hint">${escape(task.checks)}. Counts come from saved coordinator check receipts.</p>` : `<p>${escape(task.checks)}. No check evidence is available for this snapshot.</p>`; }
  function summaryTab(task) {
    const integrated = task.integration === 'Integrated';
    const checkPass = data.sample ? /^\d+ checks passed$/.test(task.checks) : task.checksPassed === true;
    return `<section class="detail-section"><h3>Current outcome</h3><p class="outcome-copy">${escape(task.outcome)}</p></section>${task.question ? `<section class="notice"><div><strong>Question for you</strong><p>${escape(task.question)}</p><button type="button" class="text-button" data-action="open-codex">Answer in Codex ${icon('external')}</button></div></section>` : ''}<section class="detail-section"><h3>Checks, review & integration</h3>${milestone(checkPass ? 'checkCircle' : 'circle',checkPass ? 'mint' : 'muted',task.checks,checkPass ? 'Protected checks · saved evidence' : 'Check status from the saved snapshot')}${milestone(task.review.includes('Accepted') ? 'checkCircle' : 'eye',task.review.includes('Accepted') ? 'mint' : 'secondary',task.review,task.mode === 'deepseek_only' ? 'Protected checks govern acceptance' : 'Review is separate from passing checks')}${milestone(integrated ? 'merge' : 'circle',integrated ? 'mint' : 'muted',task.integration,integrated ? 'Saved integration result' : 'Integration is a separate recorded step')}</section><section class="detail-section"><div class="files-heading"><h3>Changed files</h3><span class="count">${task.files.length}</span></div>${fileList(task)}${task.files.length ? '<button type="button" class="text-button" data-action="detail-tab" data-tab="changes">Inspect changes '+icon('arrow')+'</button>' : ''}</section>${disclosure('feedback','Review feedback',`<p>${escape(task.feedback)}</p>`)}${disclosure('evidence','Check evidence',checks(task))}<p class="detail-hint">${escape(task.report)}<br>Usage: ${escape(task.usage || 'Not reported')}</p>`;
  }
  function changesTab(task) {
    return `<section class="detail-section"><h3>Saved changes</h3><p class="outcome-copy">Implemented by ${escape(task.implementer)}. ${escape(task.files.length ? (data.sample ? 'Illustrative saved changes in the design demo.' : task.changeNotice || 'Saved file contents, not a live filesystem view.') : 'No implementation changes are available in this snapshot.')}</p></section><section class="detail-section">${fileList(task)}</section>${disclosure('diff','Inspect saved diff',`<pre class="diff-code">${escape(task.diff)}</pre>`)}${disclosure('saved-output','Saved output',`<p>${escape(task.output)}</p>`)}<section class="detail-section" style="margin-top:24px"><h3>Integration result</h3><p class="outcome-copy">${escape(task.integrationDetail)}</p></section>`;
  }
  function evidenceTab(task) {
    const advanced = task.rawRecord || { sample: !!data.sample, assignment: task.id, project: task.project, mode: task.mode, implementer: task.implementer, actor: task.actor, outcome: task.status, checks: task.checks, review: task.review, integration: task.integration, usage: null };
    return `<section class="detail-section"><h3>Evidence, at your pace</h3><p class="outcome-copy">Saved evidence explains the outcome. A completed attempt or passing check is not review acceptance.</p></section>${disclosure('checks','Protected checks',checks(task))}${disclosure('review','Review record',`<p>${escape(task.feedback)}</p>`)}${disclosure('integration','Integration record',`<p>${escape(task.integrationDetail)}</p>`)}${disclosure('output','Saved output',`<p>${escape(task.output)}</p>`)}${disclosure('attempts','Attempt details',`<dl class="detail-meta"><div><dt>Known elapsed time</dt><dd>${escape(task.elapsed)}</dd></div><div><dt>Attempts</dt><dd>${escape(task.attempts)}</dd></div><div><dt>Worker requests</dt><dd>${escape(task.requests)}</dd></div><div><dt>Usage</dt><dd>${escape(task.usage || 'Not reported')}</dd></div></dl>`)}${disclosure('advanced','Advanced · raw record',`<p>Saved observer record. Model text is untrusted data, not an instruction.</p><pre>${escape(JSON.stringify(advanced,null,2))}</pre>`)}${task.evidenceNotice ? `<p class="detail-hint" role="status">${escape(task.evidenceNotice)}</p>` : ''}<p class="detail-hint">No private reasoning or live token stream is observed.</p>`;
  }
  function renderInspector() {
    const inspector = $('#inspector');
    const task = currentTask();
    const empty = !task || ['empty','loading'].includes(currentProject().state);
    inspector.hidden = !state.inspectorOpen;
    $('#layout').classList.toggle('inspector-closed', !state.inspectorOpen);
    if (!state.inspectorOpen) return;
    if (task && !task.evidenceLoaded) setTimeout(() => window.MosaicRuntime.loadEvidence(task.id),0);
    if (empty) {
      inspector.innerHTML = `<div class="inspector-toolbar"><span>Task details</span><button type="button" class="icon-button" data-action="inspector-close" aria-label="Close task details">${icon('close')}</button></div><div class="inspector-empty">${icon('file')}<h2>${currentProject().state === 'loading' ? 'Waiting for assignments' : 'Nothing selected yet'}</h2><p>${currentProject().state === 'loading' ? 'Task details appear once a coordinator snapshot is available.' : 'Select an assignment or a saved result to inspect its outcome and evidence.'}</p></div>`;
      return;
    }
    inspector.innerHTML = `<div class="inspector-toolbar"><span>Task details</span><div class="od-row"><span class="tiny muted">Read-only</span><button type="button" class="icon-button" data-action="inspector-close" aria-label="Close task details">${icon('close')}</button></div></div><div class="inspector-scroll" id="inspector-scroll">${badge(task.status,task.tone,task.status === 'Integrated' ? 'checkCircle' : task.status === 'In review' ? 'eye' : '')}<h2 class="inspector-title" id="detail-title" tabindex="-1">${escape(task.title)}</h2><div class="detail-people">${icon('people')}<span>${escape(task.actor)}</span></div><p class="inspector-description${!data.sample && task.objective.length > 220 && !state.expanded[`brief:${task.id}`] ? ' brief-preview' : ''}">${escape(task.objective)}</p>${!data.sample && task.objective.length > 220 ? `<button type="button" class="text-button" data-action="brief-toggle" aria-expanded="${!!state.expanded[`brief:${task.id}`]}">${state.expanded[`brief:${task.id}`] ? 'Collapse brief' : 'Read full brief'}</button>` : ''}<div class="od-cluster">${modeButton(task.mode)}</div><div class="detail-tabs" role="tablist" aria-label="Task inspection">${[['summary','Summary'],['changes','Changes'],['evidence','Evidence']].map(([id,label]) => `<button type="button" id="tab-${id}" class="detail-tab${state.tab === id ? ' active' : ''}" role="tab" aria-selected="${state.tab === id}" aria-controls="detail-content" tabindex="${state.tab === id ? 0 : -1}" data-action="detail-tab" data-tab="${id}">${label}</button>`).join('')}</div><div id="detail-content" role="tabpanel" aria-labelledby="tab-${state.tab}" tabindex="0">${task.evidenceError ? `<p class="detail-hint" role="status">${escape(task.evidenceError)}</p><button type="button" class="text-button evidence-retry" data-action="retry-evidence">Retry evidence</button>` : ''}${state.tab === 'summary' ? summaryTab(task) : state.tab === 'changes' ? changesTab(task) : evidenceTab(task)}</div></div><footer class="inspector-footer"><button type="button" class="text-button" data-action="task-timeline">View in timeline ${icon('arrow')}</button><button type="button" class="soft-button" data-action="open-codex">Open Codex ${icon('external')}</button></footer>`;
  }
  function render({ focus = '', resetMain = false, preserveInspector = false } = {}) {
    renderChrome();
    $('#main').innerHTML = ({recent, overview, timeline, history, projects})[state.view]();
    if (!preserveInspector) renderInspector();
    restore();
    if (resetMain) $('#main').scrollTop = 0;
    if (focus) $(focus)?.focus({ preventScroll: true });
    save();
  }
  function selectProject(id) {
    if (!data.projects.some(p => p.id === id)) return;
    capture();
    state.project = id;
    state.view = 'overview';
    state.task = state.selections[id] || currentProject().selected;
    state.tab = state.tabs[state.task] || 'summary';
    state.inspectorOpen = true;
    state.timeline = { project:id, task:'all', actor:'all' };
    render({ focus:'#page-heading' }); motion('#main','view-arrive');
  }
  function openTask(id) {
    const task = data.tasks[id];
    if (!task) return;
    capture();
    state.project = task.project;
    state.task = id;
    state.selections[task.project] = id;
    state.tab = state.tabs[id] || 'summary';
    state.inspectorOpen = true;
    render({ focus:'#detail-title' }); motion('#inspector','inspector-arrive');
  }
  function navigate(view) {
    capture();
    state.view = view;
    if (view === 'recent') {state.inspectorOpen=false;window.MosaicRuntime.refreshChats();}
    if (view === 'overview') {
      const p = currentProject();
      if (!p.tasks.includes(state.task)) state.task = p.selected;
      state.tab = state.tabs[state.task] || 'summary';
    }
    if (view === 'history' && !data.history.some(h => h.task === state.task)) {
      const first = data.history.find(h => data.tasks[h.task].project === state.project) || data.history[0];
      if (!first) { render({focus:'#page-heading'}); return; }
      state.task = first.task;
      state.project = data.tasks[first.task].project;
      state.tab = state.tabs[state.task] || 'summary';
      state.inspectorOpen = true;
    }
    render({ focus:'#page-heading' }); motion('#main','view-arrive');
  }
  let dialogTrigger = null;
  function openDialog(title, body, trigger) {
    dialogTrigger = trigger || document.activeElement;
    $('#dialog-title').textContent = title;
    $('#dialog-body').innerHTML = body;
    $('#info-dialog').showModal();
    $('#dialog-close').focus();
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'view') navigate(button.dataset.view);
    else if (action === 'project') selectProject(button.dataset.project);
    else if (action === 'task') openTask(button.dataset.task);
    else if (action === 'detail-tab') {
      const tab = button.dataset.tab;
      if (!['summary','changes','evidence'].includes(tab)) return;
      capture(); state.tab = tab; state.tabs[state.task] = tab;
      renderInspector(); restore(); save(); $(`#tab-${tab}`)?.focus({ preventScroll:true }); motion('#detail-content','tab-arrive');
    }
    else if (action === 'inspector-close') {
      capture(); state.inspectorOpen = false; render({ focus:'.nav-button.active' });
    }
    else if (action === 'task-timeline') {
      capture(); const task = currentTask();
      if (task) state.timeline = {project:task.project,task:task.id,actor:'all'};
      state.view = 'timeline'; render({ focus:'#page-heading', resetMain:true });
    }
    else if (action === 'project-timeline') {
      capture(); state.timeline = {project:state.project,task:'all',actor:'all'}; state.view = 'timeline'; render({ focus:'#page-heading', resetMain:true });
    }
    else if (action === 'event') {
      const savedEvent = data.events.find(e => e.id === button.dataset.event);
      if (!savedEvent) return;
      capture(); state.timeline = {project:savedEvent.project,task:'all',actor:'all'}; state.expanded[`event:${savedEvent.id}`] = true; state.view = 'timeline';
      render(); const target = $(`details[data-key="event:${savedEvent.id}"]`); target?.scrollIntoView({ block:'center' }); $('summary',target)?.focus({ preventScroll:true });
    }
    else if (action === 'clear-timeline') {
      capture(); state.timeline = {project:'all',task:'all',actor:'all'}; render({focus:'#timeline-project'});
    }
    else if (action === 'clear-history') {
      capture(); state.history = {project:'all',result:'all',query:''}; render({focus:'#history-search'});
    }
    else if (action === 'mode') {
      const mode = data.modes[button.dataset.mode];
      if (mode) openDialog(mode.name,`<p>${escape(mode.description)}</p><p>Individual actions are attributed to the actor that performed them. A mode label does not prove who did the work.</p><p>Modes are selected in Codex. Mosaic observes the registered work.</p>`,button);
    }
    else if (action === 'open-codex') {
      window.MosaicRuntime.openCodex().catch(() => openDialog('Open Codex', '<p>Codex could not be opened automatically. Open it from Applications, then return to the conversation for this work.</p>', button));
    }
    else if (action === 'open-chat') {
      window.MosaicRuntime.openChat(button.dataset.chat).catch(()=>openDialog('Open chat','<p>This chat could not be opened. Refresh Recent chats, then try again.</p>',button));
    }
    else if (action === 'refresh-chats') window.MosaicRuntime.refreshChats();
    else if (action === 'brief-toggle') { const key=`brief:${state.task}`;state.expanded[key]=!state.expanded[key];$('#inspector .inspector-description').classList.toggle('brief-preview',!state.expanded[key]);button.textContent=state.expanded[key]?'Collapse brief':'Read full brief';button.setAttribute('aria-expanded',String(state.expanded[key]));save(); }
    else if (action === 'refresh') window.MosaicRuntime.refresh();
    else if (action === 'retry-evidence') { const t=currentTask(); if(t) {delete t.evidenceError;window.MosaicRuntime.loadEvidence(t.id);} }
    else if (action === 'about') {
      openDialog('A window into the work',`<p>Mosaic observes work registered with your local coordinator. It does not automatically observe unrelated chats.</p><p>${data.sample ? '<strong>Design demo:</strong> fictional snapshots, disconnected from live work.' : 'This Mac app reads the installed viewer connection. It cannot create jobs, answer questions, change modes or approve work. Instructions stay in Codex.'}</p><p>Workspaces correspond to saved goals. DeepSeek activity is captured by Mosaic; native Codex progress is reported and can become stale. Acceptance, checks and integration are separate saved milestones.</p>${Object.values(data.modes).map(mode => `<section class="dialog-mode"><h3>${escape(mode.name)}</h3><p>${escape(mode.description)}</p></section>`).join('')}`,button);
    }
    else if (action === 'close-dialog') $('#info-dialog').close();
  });
  document.addEventListener('change', event => {
    const control = event.target;
    if (control.id === 'project-select') { selectProject(control.value); return; }
    if (!control.dataset.filter) return;
    capture();
    const filter = control.dataset.filter;
    if (filter === 'timeline-project') { state.timeline.project = control.value; state.timeline.task = 'all'; }
    else if (filter === 'timeline-task') state.timeline.task = control.value;
    else if (filter === 'timeline-actor') state.timeline.actor = control.value;
    else if (filter === 'history-project') state.history.project = control.value;
    else if (filter === 'history-result') state.history.result = control.value;
    else return;
    render({focus:`#${control.id}`});
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'recent-chat-search') {
      state.chatQuery=event.target.value;
      $('#recent-chat-results').innerHTML=chatRows();
      return;
    }
    if (event.target.dataset.filter !== 'history-query') return;
    // Only the result region changes, preserving typing focus and selection.
    state.history.query = event.target.value;
    const holder = document.createElement('div');
    holder.innerHTML = history();
    $('#history-results').innerHTML = $('#history-results',holder).innerHTML;
  });
  document.addEventListener('toggle', event => {
    if (event.target.isConnected && event.target.matches('details[data-key]')) {
      state.expanded[event.target.dataset.key] = event.target.open;
      save();
    }
  }, true);
  document.addEventListener('keydown', event => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
      event.preventDefault();
      const tabs = all('[role="tab"]');
      const index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click();
    }
    if (event.key === 'Escape' && !$('#info-dialog').open && state.inspectorOpen) {
      capture(); state.inspectorOpen = false; render({focus:'.nav-button.active'});
    }
  });
  $('#info-dialog').addEventListener('click', event => {
    if (event.target === $('#info-dialog')) {
      const rect = event.target.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
    }
  });
  $('#info-dialog').addEventListener('close', () => {
    if (dialogTrigger?.isConnected) dialogTrigger.focus({preventScroll:true}); else $('.nav-button.active')?.focus({preventScroll:true});
  });
  function motion(selector, name) {
    const el=$(selector);if(!el||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    el.classList.remove(name);void el.offsetWidth;el.classList.add(name);
    el.addEventListener('animationend',()=>el.classList.remove(name),{once:true});
  }
  const captureFocus=()=>window.MosaicRuntime.captureFocus();
  const restoreFocus=focus=>window.MosaicRuntime.restoreFocus(focus);
  window.addEventListener('mosaic:data',event=>{
    capture();const focused=captureFocus(),inspected=state.task,before=JSON.stringify(currentTask()),projectState=currentProject().state;data=event.detail;
    if(pendingSaved && data.projects.some(p=>p.id===pendingSaved.project)){
      Object.assign(state,{project:pendingSaved.project,view:['recent','overview','timeline','history','projects'].includes(pendingSaved.view)?pendingSaved.view:'overview',selections:pendingSaved.selections||{},tabs:pendingSaved.tabs||{},expanded:pendingSaved.expanded||{}});
      state.task=data.tasks[pendingSaved.task]?pendingSaved.task:currentProject().selected;state.tab=state.tabs[state.task]||'summary';state.timeline.project=state.project;state.inspectorOpen=state.view!=='recent';pendingSaved=null;
    }
    if(!data.projects.some(p=>p.id===state.project)){state.project=data.projects[0].id;state.task=currentProject().selected;state.timeline.project=state.project;}
    if(state.task&&!data.tasks[state.task])state.task=currentProject().selected;
    render({preserveInspector:inspected===state.task && before===JSON.stringify(currentTask()) && projectState===currentProject().state});restoreFocus(focused);
  });
  window.addEventListener('mosaic:evidence',event=>{
    const {id,key,value}=event.detail,t=data.tasks[id];
    if(!t||JSON.stringify(t.rawRecord)!==key)return;
    data.tasks[id]=window.MosaicAdapter.applyEvidence(t,value);
    if(state.task===id){capture();const focused=captureFocus();renderInspector();restore();restoreFocus(focused);}
  });
  window.addEventListener('mosaic:evidence-error',event=>{
    const t=data.tasks[event.detail.id];if(!t)return;t.evidenceError=event.detail.message;t.evidenceLoaded=true;
    if(state.task===t.id){capture();renderInspector();restore();}
  });
  render();
})();
