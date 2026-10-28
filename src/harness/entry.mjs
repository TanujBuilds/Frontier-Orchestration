import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
// macOS temporary paths have /var and /private/var aliases. Compare canonical
// paths so an installed executable still starts through either spelling.
export function isEntry(url){try{return url===pathToFileURL(realpathSync(process.argv[1])).href;}catch{return false;}}
