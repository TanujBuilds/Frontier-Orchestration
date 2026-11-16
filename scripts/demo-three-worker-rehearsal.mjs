import path from 'node:path';
import {runRehearsal,inspectRehearsal} from './fixtures/three-worker-rehearsal.mjs';

try {
  const args=process.argv.slice(2),options={};
  for(let n=0;n<args.length;n++){
    if(args[n]==='--inspect'&&!options.inspect)options.inspect=true;
    else if(args[n]==='--root'&&!options.root&&args[n+1]&&!args[n+1].startsWith('--'))options.root=args[++n];
    else throw Error('Usage: node scripts/demo-three-worker-rehearsal.mjs --root NEW_OWNED_ROOT [--inspect]');
  }
  if(!options.root)throw Error('An explicit task-owned --root is required');
  const root=path.resolve(options.root);
  const report=options.inspect?await inspectRehearsal(root):await runRehearsal({root});
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
} catch(error) {process.stderr.write(String(error)+'\n');process.exitCode=1;}
