import {createHostAdapter} from './shared.mjs';
export const codex=createHostAdapter({
 id:'codex',displayName:'Codex',relativeConfig:['.codex','config.toml'],
 cliCommand:'codex',cliArgs:launcher=>['mcp','add','mosaic-beta','--',launcher,'mcp'],
 documentation:'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
 connectionHelp:{
  locate:'Check MCP Servers in Codex settings or run codex mcp get mosaic-beta. Use the same Codex profile in the app and terminal.',
  refresh:'Refresh MCP Servers in Codex or start a new session when ready. In the Codex terminal, /mcp lists active servers.'
 }
});
export const previewRegistration=codex.previewRegistration;
export const applyRegistration=codex.applyRegistration;
export const removeRegistration=codex.removeRegistration;
export default codex;
