import {writeSync,readdirSync} from 'node:fs';
import {locations} from '../../../src/beta/files.mjs';
import * as settings from '../../../src/beta/settings.mjs';

const paths=locations(process.argv[2],true),api=process.argv[3];
const lifecycle={verifyLaunchAgent:async()=>false,stopForMaintenance:async()=>false,startLaunchAgent:async()=>false};
writeSync(1,'entered:'+api+'\n');
const descriptorsBefore=api==='readiness'?readdirSync('/dev/fd').length:null;
try{
 const result=api==='readiness'?await settings.assertMigrationStartupReady(paths,await settings.readSettings(paths)):
  api==='apply'?await settings.applySettingsMigration(paths,await settings.previewSettingsMigration(paths),{lifecycle}):
  await settings.resumeSettingsMigration(paths,{lifecycle});
 writeSync(1,JSON.stringify({rejected:false,result})+'\n');process.exitCode=2;
}catch(error){
 const descriptorsAfter=api==='readiness'?readdirSync('/dev/fd').length:null;
 writeSync(1,JSON.stringify({rejected:true,message:error.message,descriptorsBefore,descriptorsAfter})+'\n');
}
