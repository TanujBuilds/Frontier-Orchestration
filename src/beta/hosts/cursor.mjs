import {createHostAdapter} from './shared.mjs';
export const cursor=createHostAdapter({id:'cursor',displayName:'Cursor',relativeConfig:['.cursor','mcp.json'],entryType:true,documentation:'https://cursor.com/docs/mcp'});
export const previewRegistration=cursor.previewRegistration;
export const applyRegistration=cursor.applyRegistration;
export const removeRegistration=cursor.removeRegistration;
export default cursor;
