function cell(value,max=160){
 return String(value??'unknown').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max)
  .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
  .replace(/[\\`*_{}[\]()|~]/g,'\\$&');
}

const words = value => cell(value?.replaceAll('_',' '));
const coverageLine = ({knownTokens,knownRequests,eligibleRequests,reason})=>
 `${knownTokens===null?'unknown':knownTokens+' tokens'} across ${knownRequests} of ${eligibleRequests} completed provider requests${reason?' ('+words(reason)+')':''}`;
const tally = counts => Object.entries(counts).map(([name,n])=>`${words(name)} ${n}`).join(', ')||'none recorded';
const seconds = ms => ms===null?'unknown':(ms/1000).toFixed(3)+' s';

export function renderOutcomeMarkdown(report){
 const {scope,coverage,counts,usage,retries,interactions,timing,diagnostics}=report;
 const lines=[
  '# Mosaic outcomes','',
  `As of **${cell(report.generatedAt)}** · source revision **${cell(report.sourceRevision)}**`,
  `Goal **${cell(scope?.goalId??'any selected')}** · project **${cell(scope?.projectKey??'any selected')}**`,
 ];
 if(scope?.from||scope?.to) lines.push(`Task creation window [${cell(scope.from??'unbounded')}, ${cell(scope.to??'unbounded')}) UTC`);
 lines.push(
  '',
  coverage?.complete===true
   ?'Complete selected task scope.'
   :'**Partial coverage.** Totals describe only the records included in this report.',
  '',
  '## Outcomes','',
  `**${counts.attempted} attempted** · ${counts.queued} queued before execution · ${counts.tasks} selected`,
  `**${counts.acceptedCoding}** accepted coding integrations · **${counts.acceptedResearch}** fully reviewed research results · **${counts.unverified}** with unverified evidence`,
  `${counts.terminal} terminal · ${counts.nonterminal} nonterminal · ${tally(counts.byDisposition)}`,
  counts.acceptanceRate.value===null
   ?'Useful acceptance rate is undefined because no tasks were attempted.'
   :`Useful acceptances among attempted tasks **${counts.acceptanceRate.numerator} of ${counts.acceptanceRate.denominator}** (${(counts.acceptanceRate.value*100).toFixed(1)}%).`,
  counts.acceptanceRate.definition,
  '',
  '## Recorded usage','',
  `Local ledger — ${usage.reservations} reservations · ${usage.observedStarts} observed model starts · ${tally(usage.requestStates)}`,
  usage.planning.reason,
  `${usage.uncertainRequests} with uncertain outcomes · ${usage.certifiedNonDispatch} certified as undispatched`,
  `Input — ${coverageLine(usage.input)}`,
  `Output — ${coverageLine(usage.output)}`,
  `Both token fields recorded for ${usage.knownUsageRequests} of ${usage.eligibleCompletedRequests} completed provider requests.`,
  `Native host tokens — ${cell(usage.nativeHost.reason)}.`,
 );
 const remote = usage.remoteResearch;
 if(remote.eligibleTasks){
  const counters = Object.entries(remote.byKind).map(([kind,row])=>
   `${words(kind)} ${row.knownReservations??'unknown'} across ${row.knownTasks} of ${remote.eligibleTasks} selected research tasks`);
  lines.push('',`Last saved remote research reservations — ${counters.join(', ')}.`,remote.tokenReason);
 }
 lines.push(
  '',
  '## Retries, interactions and timing','',
  `Worker attempt counts are available for ${retries.tasksWithKnownAttemptCount} of ${retries.eligibleTasks} tasks. Recorded attempts ${retries.knownWorkerAttempts??'unknown'}, retries beyond the first ${retries.knownWorkerRetries??'unknown'}.`,
  `Observed failure and hold events — ${tally(retries.failureReasons)}.`,
  `${interactions.reviews} recorded review decisions including ${interactions.revisionRequests} revisions requested. Recorded answers include ${interactions.userAnswers} from the user and ${interactions.codexAnswers} from Codex.`,
  timing.definition,
 );
 const goalTimes = timing.goals.slice(0,10);
 if(goalTimes.length){
  lines.push('','| Goal | Wall elapsed | State |','| --- | ---: | --- |');
  for(const goal of goalTimes) lines.push(`| ${cell(goal.id)} | ${seconds(goal.wallElapsedMs)} | ${words(goal.state)} |`);
  if(timing.goals.length>goalTimes.length) lines.push('',`JSON includes all ${timing.goals.length} selected goal timelines.`);
 }
 if(timing.questionWaits.length) lines.push('',`JSON includes ${timing.questionWaits.length} clarification intervals with event IDs.`);
 const taskTimes = new Map(timing.tasks.map(row=>[row.id,row]));
 const visibleTasks = [
  ...report.tasks.filter(task=>task.usefulAccepted===true),
  ...report.tasks.filter(task=>task.usefulAccepted!==true),
 ].slice(0,20);
 if(visibleTasks.length){
  lines.push('','## Task evidence','','| Task | Outcome | Wall elapsed | Evidence IDs |','| --- | --- | ---: | --- |');
  for(const task of visibleTasks){
   const refs = task.evidenceRefs.slice(0,4).map(ref=>cell(ref.kind+'/'+ref.id)).join(', ')||'none recorded';
   const duration = taskTimes.get(task.id)?.wallElapsedMs??null;
   lines.push(`| ${cell(task.id)} | ${words(task.disposition)} (${words(task.reason)}) | ${seconds(duration)} | ${refs} |`);
  }
  if(report.tasks.length>visibleTasks.length) lines.push('',`JSON includes all ${report.tasks.length} selected tasks.`);
 }
 const workers = visibleTasks.filter(task=>task.worker);
 if(workers.length){
  lines.push('','## Pinned workers','','| Task | Worker | Route provenance |','| --- | --- | --- |');
  for(const task of workers){
   const worker=task.worker;
   lines.push(`| ${cell(task.id)} | ${cell(worker.providerId)} @ ${cell(worker.revision)} | ${cell(worker.routeExplanation??(worker.routeProvenance==='legacy_binding'?'Historical binding; routing reason unavailable':'Routing provenance unverified'))} |`);
  }
 }
 if(diagnostics.length) lines.push('','## Data diagnostics','',tally(Object.fromEntries(Object.entries(Object.groupBy(diagnostics,item=>item.code)).map(([code,items])=>[code,items.length]))));
 lines.push('','## Evidence and limits','',report.evidenceExplanation,'',...report.limitations.map(line=>`- ${line}`));
 return lines.join('\n')+'\n';
}
