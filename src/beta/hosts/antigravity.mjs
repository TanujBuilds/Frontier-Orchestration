import {createHostAdapter} from './shared.mjs';
export const antigravity=createHostAdapter({id:'antigravity',displayName:'Antigravity',relativeConfig:['.gemini','config','mcp_config.json'],documentation:'https://antigravity.google/docs/mcp?app=antigravity'});
export const previewRegistration=antigravity.previewRegistration;
export const applyRegistration=antigravity.applyRegistration;
export const removeRegistration=antigravity.removeRegistration;
export default antigravity;
