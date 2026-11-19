import {createHostAdapter} from './shared.mjs';
export const claudeCode=createHostAdapter({
 id:'claude-code',displayName:'Claude Code',relativeConfig:['.claude.json'],entryType:true,
 cliCommand:'claude',cliArgs:launcher=>['mcp','add','--transport','stdio','--scope','user','mosaic-beta','--',launcher,'mcp'],
 documentation:'https://code.claude.com/docs/en/mcp',
 connectionHelp:{
  locate:'In Claude Code, use /mcp to check for mosaic-beta in the intended project. The command below registers it for your user account.',
  refresh:'Open a new Claude Code session and use /mcp to check the server status.'
 }
});
export const previewRegistration=claudeCode.previewRegistration;
export const applyRegistration=claudeCode.applyRegistration;
export const removeRegistration=claudeCode.removeRegistration;
export default claudeCode;
