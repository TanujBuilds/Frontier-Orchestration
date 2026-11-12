import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {runComposition} from '../test/fixtures/mosaic-pb13/composition.mjs';

// Developer-only offline demonstration. The shipping app never imports fixtures.
const args=process.argv.slice(2),options={};
for(let index=0;index<args.length;index++){
 const name=args[index];
 if(name==='--inspect'){if(options.inspect)throw Error('Duplicate --inspect');options.inspect=true;}
 else if(['--root','--review'].includes(name)){
  const key=name.slice(2),value=args[++index];if(!value||value.startsWith('--')||options[key])throw Error('Expected one value for '+name);options[key]=value;
 }else throw Error('Usage: node scripts/demo-routing-composition.mjs --root NEW_PATH [--review host|api] [--inspect]');
}
if(!options.root)throw Error('An explicit disposable --root is required');
const root=path.resolve(options.root);
const result=options.inspect?JSON.parse(await readFile(path.join(root,'composition-result.json'),'utf8')):
 await runComposition({root,review:options.review??'host',beta:true});
process.stdout.write(JSON.stringify(result,null,2)+'\n');
