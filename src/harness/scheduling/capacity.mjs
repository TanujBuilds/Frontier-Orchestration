import {realpathSync,readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {digest} from '../contracts.mjs';

const slots=new Set(['running','uncertain','taking_over']);
const terminalGoals=new Set(['completed','partial']);
// A local failure is not proof the remote request ended. Historical reviews may
// omit outcome entirely; only positively certified completion/non-dispatch frees
// a slot. Use the same predicate for capacity and configuration quiescence.
const heldRequest="status='reserved' OR (status='failed' AND COALESCE(json_extract(data,'$.requestOutcome'),'unknown') NOT IN ('completed','not_dispatched'))";
export function canonicalRepository(repo){
 try{
  const root=realpathSync(repo),dot=path.join(root,'.git');
  const gitdir=statSync(dot).isDirectory()?dot:path.resolve(root,readFileSync(dot,'utf8').trim().replace(/^gitdir:\s*/,''));
  let common=gitdir;try{common=path.resolve(gitdir,readFileSync(path.join(gitdir,'commondir'),'utf8').trim());}catch{}
  return realpathSync(common);
 }catch{return path.resolve(repo);}
}
function scopeRoot(scope){
 if(typeof scope!=='string'||!scope||scope.includes('..'))return null;
 const prefix=scope.split(/[?*[{]/,1)[0];
 const root=(prefix===scope?prefix:prefix.slice(0,prefix.lastIndexOf('/')+1)).replace(/\/$/,'');return root||null;
}
export function scopesOverlap(a,b){
 if(!Array.isArray(a)||!Array.isArray(b)||!a.length||!b.length)return true;
 return a.some(left=>b.some(right=>{const x=scopeRoot(left),y=scopeRoot(right);return !x||!y||x===y||x.startsWith(y+'/')||y.startsWith(x+'/');}));
}
function profiles(goal){return [...(goal.manifest.providerPolicy?.workers??[]),...(goal.manifest.reviewPolicy?.reviewer?[goal.manifest.reviewPolicy.reviewer]:[])];}
export function hasPreparedWork(c){return c.store.all('goal_revision').some(r=>r.status==='draft')||c.store.all('goal').some(g=>!terminalGoals.has(g.status))||c.store.db.prepare('SELECT 1 FROM requests WHERE '+heldRequest).get()!==undefined;}
export function configureServiceCapacity(c,requested){
 if(requested!==undefined&&(!Number.isSafeInteger(requested)||requested<1||requested>4))throw Error('Invalid service maximum concurrent tasks');
 const saved=c.store.maybe('capacity_config','service'),limit=requested??saved?.limit??1;
 if((saved?.limit??1)!==limit&&hasPreparedWork(c))throw Error('Capacity changes require quiescence of active/prepared work');
 if(requested!==undefined)c.store.put('capacity_config',{id:'service',limit});
 return limit;
}
export function assertCapacityConfiguration(c,manifest,{excludeGoalId}={}){
 if(!manifest.providerPolicy&&!manifest.reviewPolicy?.reviewer)return;
 const held=new Set(c.store.db.prepare('SELECT task_id FROM requests WHERE '+heldRequest).all().map(r=>c.store.maybe('task',r.task_id)?.goalId??r.task_id));
 const goals=c.store.all('goal').filter(g=>g.id!==excludeGoalId&&(!terminalGoals.has(g.status)||held.has(g.id))),items=[...goals.map(g=>g.manifest),...c.store.all('goal_revision').filter(r=>r.status==='draft').map(r=>r.manifest),manifest];
 const groups=new Map(),endpoints=new Map(),identities=new Map();
 for(const m of items){
  for(const group of m.providerPolicy?.capacityGroups??[]){if(groups.has(group.id)&&groups.get(group.id)!==group.limit)throw Error('Contradictory active/prepared capacity group limit configuration');groups.set(group.id,group.limit);}
  for(const p of profiles({manifest:m})){
   if(!(m.providerPolicy?.capacityGroups??[]).some(g=>g.id===p.capacityGroup)){if(groups.has(p.capacityGroup)&&groups.get(p.capacityGroup)!==1)throw Error('Contradictory active/prepared reviewer capacity group limit configuration');groups.set(p.capacityGroup,1);}
   if(endpoints.has(p.baseUrl)&&endpoints.get(p.baseUrl)!==p.capacityGroup)throw Error('Endpoint aliases require the same capacity group across active/prepared work');endpoints.set(p.baseUrl,p.capacityGroup);
   const key=p.id+'@'+p.revision,identity={hash:digest(p),group:p.capacityGroup,limit:p.concurrency};
   if(identities.has(key)&&digest(identities.get(key))!==digest(identity))throw Error('Provider capacity identity changed while active/prepared work exists');identities.set(key,identity);
  }
 }
}
export function capacitySnapshot(c){
 const goals=c.store.all('goal'),tasks=c.store.all('task');
 const requests=c.store.db.prepare("SELECT * FROM requests WHERE kind IN ('model','apiReview','codexReview') AND ("+heldRequest+")").all().map(row=>{
  const data=JSON.parse(row.data),binding=data.providerBinding??data.reviewerBinding;
  const p=binding&&goals.flatMap(profiles).find(p=>p.id===binding.providerId&&p.revision===binding.revision&&digest(p)===binding.profileHash);
  return {...row,...data,resource:data.capacityResource??(p?{profileHash:binding.profileHash,capacityGroup:p.capacityGroup,baseUrl:p.baseUrl,profileLimit:p.concurrency}:null)};
 });
 return {serviceLimit:c.store.maybe('capacity_config','service')?.limit??c.serviceMaxConcurrentTasks??1,activeTasks:tasks.filter(t=>slots.has(t.status)&&t.spec.actor==='deepseek'&&t.executionActor!=='codex'),tasks,goals,planning:c.store.all('planning').filter(p=>['running','uncertain'].includes(p.status)),requests};
}
export function canClaim({task,goal,route,snapshot}){
 const active=snapshot.activeTasks,policy=goal.manifest.providerPolicy;
 if(!policy||active.some(t=>!snapshot.goals.find(g=>g.id===t.goalId)?.manifest.providerPolicy)||snapshot.planning.some(p=>!snapshot.goals.find(g=>g.id===p.goalId)?.manifest.providerPolicy)){
  if(active.length||snapshot.planning.length)return {allowed:false,reasonCode:'legacy_global_slot',explanation:'Historical work retains its single global autonomous slot'};
 }
 if(active.length>=snapshot.serviceLimit)return {allowed:false,reasonCode:'service_task_capacity',explanation:'Private service task capacity is occupied'};
 if(active.filter(t=>t.goalId===goal.id).length>=(policy?.maxConcurrentTasks??1))return {allowed:false,reasonCode:'goal_task_capacity',explanation:'Approved goal task capacity is occupied'};
 const scopeWait=writeScopeWait({task,goal,snapshot});if(scopeWait)return scopeWait;
 return {allowed:true,reasonCode:'capacity_available',explanation:'Task runner capacity available'};
}
export function writeScopeWait({task,goal,snapshot}){
 if(task.spec.kind==='coding'&&goal.manifest.project){
  const repo=canonicalRepository(goal.manifest.project.repo);
  for(const other of snapshot.tasks){
   const otherGoal=snapshot.goals.find(g=>g.id===other.goalId),writer=other.native?.writerActive||other.status==='codex_active'||otherGoal?.integrationOwner===other.id;
   if(other.id===task.id||other.spec.kind!=='coding'||(!other.startedAt&&!other.owner&&!writer)||!writer&&['accepted','cancelled','failed','partial'].includes(other.status))continue;
   if(otherGoal?.manifest.project&&canonicalRepository(otherGoal.manifest.project.repo)===repo&&scopesOverlap(task.spec.permissions?.writePaths,other.spec.permissions?.writePaths))return {allowed:false,reasonCode:'write_scope_busy',explanation:'An unresolved candidate owns overlapping or ambiguous write scope'};
  }
 }
 return null;
}
export function inferenceResource(c,goal,binding){
 const p=profiles(goal).find(p=>p.id===binding?.providerId&&p.revision===binding.revision&&digest(p)===binding.profileHash);
 if(!p)return null;
 const group=goal.manifest.providerPolicy?.capacityGroups.find(g=>g.id===p.capacityGroup);
 return {profileHash:binding.profileHash,capacityGroup:p.capacityGroup,baseUrl:p.baseUrl,profileLimit:p.concurrency,groupLimit:group?.limit??1};
}
export function inferenceWait(c,goal,binding,snapshot=capacitySnapshot(c)){
 const resource=inferenceResource(c,goal,binding);
 if(!resource){if(snapshot.requests.length)return {waiting:true,reasonCode:'legacy_inference_busy',explanation:'Historical inference has a single global slot'};return null;}
 if(snapshot.requests.some(r=>!r.resource))return {waiting:true,reasonCode:'legacy_inference_busy',explanation:'Unidentified historical request retains global inference capacity'};
 const sameGroup=snapshot.requests.filter(r=>r.resource.capacityGroup===resource.capacityGroup||r.resource.baseUrl===resource.baseUrl);
 const limit=Math.min(resource.groupLimit,...sameGroup.map(r=>r.resource.groupLimit??1));
 if(sameGroup.length>=limit)return {waiting:true,reasonCode:'capacity_group_busy',explanation:'Shared inference capacity group is occupied'};
 const sameProfile=snapshot.requests.filter(r=>r.resource.profileHash===resource.profileHash);
 if(sameProfile.length>=Math.min(resource.profileLimit,...sameProfile.map(r=>r.resource.profileLimit)))return {waiting:true,reasonCode:'profile_capacity_busy',explanation:'Profile inference capacity is occupied'};
 return null;
}
export class CapacityWaitError extends Error{constructor(wait){super(wait.explanation);this.name='CapacityWaitError';this.waiting=true;this.reasonCode=wait.reasonCode;}}
export function assertInferenceCapacity(c,goal,binding){const wait=inferenceWait(c,goal,binding);if(wait)throw new CapacityWaitError(wait);return inferenceResource(c,goal,binding);}
