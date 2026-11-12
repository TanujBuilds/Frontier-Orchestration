import {runComposition} from './composition.mjs';
try{console.log(JSON.stringify(await runComposition({root:process.argv[2],review:process.argv[3]})));}
catch(error){console.error(error.stack);process.exitCode=1;}
