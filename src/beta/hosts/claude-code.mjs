import {createHostAdapter} from './shared.mjs';
export const claudeCode=createHostAdapter({id:'claude-code',displayName:'Claude Code',relativeConfig:['.claude.json'],entryType:true,cliCommand:'claude',cliArgs:launcher=>['mcp','add','--transport','stdio','--scope','user','mosaic-beta','--',launcher,'mcp'],documentation:'https://code.claude.com/docs/en/mcp'});
export const previewRegistration=claudeCode.previewRegistration;
export const applyRegistration=claudeCode.applyRegistration;
export const removeRegistration=claudeCode.removeRegistration;
export default claudeCode;
