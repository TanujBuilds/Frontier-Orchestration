import {Writable} from 'node:stream';
import {runSupportBundle} from '../../../src/beta/support-bundle.mjs';

const fail=()=>new Writable({write(_bytes,_encoding,callback){callback(Error('SENTINEL_STREAM_ERROR /private/SENTINEL_PATH'));}});
let diagnostic='';
const stderr=process.argv[3]==='both'?fail():new Writable({write(bytes,_encoding,callback){diagnostic+=bytes;callback();}});
const code=await runSupportBundle(['--home',process.argv[2]],{stdout:fail(),stderr});
process.stdout.write(JSON.stringify({code,diagnostic})+'\n');
