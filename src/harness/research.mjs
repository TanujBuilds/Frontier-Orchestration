import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bridge=fileURLToPath(new URL('../../.agents/skills/deep-research/scripts/harness_rpc.py',import.meta.url));
export class ResearchClient {
 constructor(config){this.config=config;}
 async call(request,collectOutput){
  const cfg=this.config,args=[bridge,...(collectOutput?['--collect-output',collectOutput]:cfg.remoteConfig?['--remote-config',cfg.remoteConfig]:['--data-dir',cfg.dataDir,...(cfg.providerConfig?['--provider-config',cfg.providerConfig]:[])])];
  return new Promise((resolve,reject)=>{
   const child=spawn(cfg.python??'python3',args,{stdio:['pipe','pipe','pipe']});let out='',err='',oversize=false;
   const timer=setTimeout(()=>child.kill('SIGKILL'),130000);
   child.stdout.on('data',b=>{out+=b;if(Buffer.byteLength(out)>34*1024*1024){oversize=true;child.kill('SIGKILL');}});
   child.stderr.on('data',b=>{err=(err+b).slice(-4000);});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
   child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);try{if(oversize)throw Error('Research packet exceeds bound');const result=JSON.parse(out);if(code!==0||result.error)throw Error(result.error??err??'Research bridge failed');resolve(result);}catch(e){reject(new Error(e.message.replace(/https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/g,'[SSH identity check required]')));}});
  });
 }
}
export class ResearchAdapter {
 constructor(worker,{rpc,collect}={}){
  this.worker=worker;const client=new ResearchClient(worker.config.research??{});this.rpc=rpc??(r=>client.call(r));this.collect=collect??((packet,output)=>client.call(packet,output));
 }
 async step(task,owner){
  const {c}=this.worker,cp={...task.checkpoint},cfg=this.worker.config.research??{},g=c.store.get('goal',task.goalId);
  if(!cp.phase){
   const manifest={schema:2,submission_id:task.id,question:task.spec.objective,mode:g.manifest.environment,
    scope:{seed_urls:task.spec.scope.seedUrls,include_domains:task.spec.scope.includeDomains,exclude_domains:task.spec.scope.excludeDomains},
    limits:{seconds:task.spec.limits.seconds,searches:task.spec.limits.searches,downloads:task.spec.limits.downloads,model_calls:task.spec.limits.modelCalls},
    not_after:Math.floor(task.deadline/1000),collaboration:{supervisor:g.manifest.mode.actors.includes('codex')?'codex':'user',max_questions:task.spec.limits.questions}};
   const prepared=await this.rpc({command:'prepare_manifest',manifest});return c.boundary(task.id,{phase:'submit',manifest:prepared.manifest,remoteHash:prepared.hash},owner);
  }
  if(cp.phase==='submit'){
   try{const remote=await this.rpc({command:'submit',manifest:cp.manifest,approved_hash:cp.remoteHash});return c.boundary(task.id,{...cp,phase:'poll',remoteJobId:remote.id},owner,{quiescent:false});}
   catch(e){c.markUncertain(task.id,'Ambiguous research submission: '+e.message,owner);return c.getTask(task.id);}
  }
  if(cp.nextPollAt&&c.now()<cp.nextPollAt)return {waiting:true,taskId:task.id};
  try{
   if(task.answers.length>(cp.answeredCount??0)){
    const answer=task.answers.at(-1);await this.rpc({command:'answer',job:cp.remoteJobId,answer:answer.text,responder:answer.responder,question_id:cp.remoteQuestionId});cp.answeredCount=task.answers.length;
   }
   if(task.stopRequested||task.pauseRequested||task.yieldRequested){
    await this.rpc({command:task.stopRequested?'stop':'yield',job:cp.remoteJobId});
   }else if(cp.remotePaused){await this.rpc({command:'resume',job:cp.remoteJobId});cp.remotePaused=false;}
   const remote=await this.rpc({command:'status',job:cp.remoteJobId});
   if(remote.manifest_hash&&remote.manifest_hash!==cp.remoteHash)throw Error('Research manifest identity mismatch');
   c.store.tx(()=>{const current=c.owned(task.id,owner);for(const [kind,n] of Object.entries(remote.counters??{})){if(n<(current.remoteSpent?.[kind]??0))throw Error('Remote counters decreased');}current.remoteSpent=remote.counters??{};c.store.put('task',current);});
   if(!remote.quiescent){
    if(remote.execution?.status==='uncertain'){c.markUncertain(task.id,'Remote model request outcome is uncertain',owner);return c.getTask(task.id);}
    return c.boundary(task.id,{...cp,nextPollAt:c.now()+(cfg.pollMs??1000)},owner,{quiescent:false});
   }
   if(['awaiting_supervisor','awaiting_user'].includes(remote.status)){
    const current=c.boundary(task.id,cp,owner);if(current.status!=='running')return current;
    const questions=await this.rpc({command:'questions',job:cp.remoteJobId});const q=questions.at(-1);return c.ask(task.id,q.question,{...cp,nextPollAt:0,remoteQuestionId:q.id},owner);
   }
   if(['suspended','stopped'].includes(remote.status))return c.boundary(task.id,{...cp,remotePaused:true,nextPollAt:0},owner);
   if(['completed','partial'].includes(remote.status)){
    const packet=await this.rpc({command:'export',job:cp.remoteJobId}),collected=await this.collect(packet,path.join(c.store.root,'research-results'));
    if(!collected.checksums_verified)throw Error('Research collection lacked verified checksums');
    const done=c.completeTask(task.id,{directory:collected.directory,checksumsVerified:true,remoteJobId:cp.remoteJobId,receiptStatus:remote.status,independentReview:'not_requested'},owner);
    if(remote.status==='partial')c.store.tx(()=>{const t=c.store.get('task',task.id);t.status='partial';c.store.put('task',t);});return c.getTask(done.id);
   }
   if(['blocked','failed'].includes(remote.status))throw Error(remote.reason??'Remote research failed');
   return c.boundary(task.id,{...cp,nextPollAt:c.now()+(cfg.pollMs??1000)},owner);
  }catch(e){if(c.getTask(task.id).status==='uncertain')return c.getTask(task.id);c.markUncertain(task.id,'Research contact/evidence uncertain: '+e.message,owner);return c.getTask(task.id);}
 }
 async reconcile(input,key){return this.worker.integration.effect(key,{op:'research.reconcile',...input},async()=>{
  const {c,owner}=this.worker,lease=c.store.get('lease','coordinator');
  if(lease.token!==owner||lease.pid!==process.pid)throw Error('Current coordinator lease required for reconciliation');
  const t=c.getTask(input.taskId),cp={...t.checkpoint};
  if(t.spec.kind!=='research'||t.spec.actor!=='deepseek'||t.status!=='uncertain')throw Error('Uncertain DeepSeek research task required');
  if(!cp.remoteHash)throw Error('Missing approved remote identity');
  if(!cp.remoteJobId){
   const jobs=await this.rpc({command:'status'}),matches=jobs.filter(j=>j.manifest_hash===cp.remoteHash&&j.manifest?.submission_id===t.id);
   if(matches.length!==1)throw Error('Exact remote submission could not be located; ownership remains uncertain');
   cp.remoteJobId=matches[0].id;cp.phase='poll';
  }
  // Quiescent queued work can be claimed remotely immediately. Request a durable
  // yield, then require both the exact identity and a safe remote lifecycle state.
  await this.rpc({command:'yield',job:cp.remoteJobId});
  const remote=await this.rpc({command:'status',job:cp.remoteJobId});
  if(remote.id!==cp.remoteJobId||remote.manifest_hash!==cp.remoteHash)throw Error('Research manifest identity mismatch');
  c.store.tx(()=>{
   const current=c.store.get('task',t.id);if(current.status!=='uncertain')throw Error('Research ownership changed');
   for(const [kind,n]of Object.entries(remote.counters??{}))if(!Number.isInteger(n)||n<0||n<(current.remoteSpent?.[kind]??0))throw Error('Remote counters decreased or invalid');
   current.remoteSpent=remote.counters??{};current.checkpoint={...cp,nextPollAt:0};c.store.put('task',current);
  });
  if(!remote.quiescent||!['suspended','stopped','completed','partial','blocked','failed','awaiting_supervisor','awaiting_user'].includes(remote.status))return c.getTask(t.id);
  c.store.tx(()=>{const current=c.store.get('task',t.id);current.owner=owner;current.status='running';c.store.put('task',current);c.emit('research.reconciled',t.goalId,t.id,{remoteJobId:cp.remoteJobId,status:remote.status,counters:remote.counters});});
  return this.step(c.getTask(t.id),owner);
 });}
}
