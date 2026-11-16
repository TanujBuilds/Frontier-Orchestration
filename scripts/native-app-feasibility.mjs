#!/usr/bin/env node
import {parseArgs,rejectGitOverrides} from './native-app-feasibility/prerequisites.mjs';
import {inspectReport} from './native-app-feasibility/report.mjs';
import {runQualification} from './native-app-feasibility/run.mjs';
try{
  rejectGitOverrides();const options=parseArgs(process.argv.slice(2));
  if(options.inspect){const result=await inspectReport(options.inspect);console.log(JSON.stringify(result));process.exitCode=result.report.exitCode;}
  else{const report=await runQualification(options);console.log(JSON.stringify({toolStatus:report.toolStatus,m001:report.m001,exitCode:report.exitCode,capabilities:report.capabilities.map(({id,state})=>({id,state})),report:options.output+'/report.json'}));process.exitCode=report.exitCode;}
}catch(e){console.error(JSON.stringify({toolStatus:'invalid_input_or_malfunction',code:e.code??null,message:String(e.message).slice(0,1000)}));process.exitCode=1;}
