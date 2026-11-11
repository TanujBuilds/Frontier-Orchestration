import {createHostAdapter} from './shared.mjs';
export const codex=createHostAdapter({id:'codex',displayName:'Codex',relativeConfig:['.codex','config.toml'],cliCommand:'codex',cliArgs:launcher=>['mcp','add','mosaic-beta','--',launcher,'mcp'],documentation:'https://developers.openai.com/codex/mcp'});
export const previewRegistration=codex.previewRegistration;
export const applyRegistration=codex.applyRegistration;
export const removeRegistration=codex.removeRegistration;
export default codex;
