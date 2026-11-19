import {createHostAdapter} from './shared.mjs';
export const cursor=createHostAdapter({
 id:'cursor',displayName:'Cursor',relativeConfig:['.cursor','mcp.json'],entryType:true,
 documentation:'https://cursor.com/docs/mcp',
 connectionHelp:{
  locate:'Open the user MCP configuration. In Cursor, Customize → MCPs shows the active servers. A project entry with the same name takes precedence.',
  refresh:'Restart Cursor when ready and check mosaic-beta under Customize → MCPs.'
 }
});
export const previewRegistration=cursor.previewRegistration;
export const applyRegistration=cursor.applyRegistration;
export const removeRegistration=cursor.removeRegistration;
export default cursor;
