import {createHostAdapter} from './shared.mjs';
export const antigravity=createHostAdapter({
 id:'antigravity',displayName:'Antigravity',relativeConfig:['.gemini','config','mcp_config.json'],
 documentation:'https://antigravity.google/docs/mcp?app=antigravity',
 connectionHelp:{
  locate:'In the Antigravity app, go to Customizations → Installed → MCP Servers and use Copy Config File Path or Open MCP Config. In the IDE, go to the agent panel menu → MCP Servers → Manage MCP Servers → View raw config. Use the user configuration shown by your app.',
  refresh:'Refresh or restart mosaic-beta from the Antigravity MCP manager when ready.'
 }
});
export const previewRegistration=antigravity.previewRegistration;
export const applyRegistration=antigravity.applyRegistration;
export const removeRegistration=antigravity.removeRegistration;
export default antigravity;
