// Only invoked by the protected pinned runtime, never on the host.
import {spawn,spawnSync} from 'node:child_process';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
const {commands,port}=JSON.parse(process.argv[2]);
const data=path.resolve('.overnight-output/pg-data');
await mkdir(data,{recursive:true});
const env={...process.env,PGCONNECT_TIMEOUT:'2',PGPASSFILE:path.resolve('.overnight-output/nonexistent-pgpass'),PGSERVICEFILE:path.resolve('.overnight-output/nonexistent-pgservice')};
const steps=[];
function execute(name,args){const r=spawnSync(commands[name],args,{env,encoding:'utf8',timeout:15000,maxBuffer:16384});return {name,argv:[commands[name],...args],code:r.status,errorCode:r.error?.code??null,syscall:r.error?.syscall??null,stdout:(r.stdout??'').slice(0,4096),stderr:(r.stderr??'').slice(0,4096)};}
const initdb=execute('initdb',['-D',data,'-A','trust','-U','mosaic_fixture','--no-locale','-E','UTF8']);steps.push(initdb);
if(initdb.code!==0){console.log(JSON.stringify({schema:1,kind:'postgres',phase:'initdb',steps}));process.exit(0);}
const args=['-D',data,'-h','127.0.0.1','-p',String(port),'-k','','-c','logging_collector=off'];
const server=spawn(commands.postgres,args,{env,stdio:['ignore','pipe','pipe']});let errorCode=null,stderr='';
server.on('error',e=>{errorCode=e.code??'UNKNOWN';});server.stderr.on('data',b=>{stderr=(stderr+b).slice(-4096);});server.stdout.resume();
try{
  let ready=false;
  for(let n=0;n<20;n++){
    await new Promise(resolve=>setTimeout(resolve,100));if(errorCode||server.exitCode!==null)break;
    const r=execute('psql',['-X','-h','127.0.0.1','-p',String(port),'-U','mosaic_fixture','-d','postgres','-At','-c','SELECT 1']);if(r.code===0&&r.stdout.trim()==='1'){ready=true;break;}
  }
  steps.push({name:'postgres',argv:[commands.postgres,...args],ready,errorCode,stderr});
  if(ready){
    const migration=execute('psql',['-X','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','mosaic_fixture','-d','postgres','-At','-c',"BEGIN; CREATE TABLE feasibility_invites(email text PRIMARY KEY); INSERT INTO feasibility_invites VALUES ('member@example.invalid'); COMMIT;"]);steps.push({...migration,name:'migration'});
    if(migration.code===0){const query=execute('psql',['-X','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','mosaic_fixture','-d','postgres','-At','-c','SELECT email FROM feasibility_invites']);steps.push({...query,name:'query',passed:query.code===0&&query.stdout.trim()==='member@example.invalid'});}
  }
}finally{
  if(server.pid&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('close',resolve)),new Promise(resolve=>setTimeout(resolve,2000))]);}
}
console.log(JSON.stringify({schema:1,kind:'postgres',phase:'lifecycle',steps}));
