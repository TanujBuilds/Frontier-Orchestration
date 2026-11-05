import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

test('real MCP client discovers and invokes the registry without model calls',async()=>{
 const client=new Client({name:'harness-protocol-test',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/harness/mcp.mjs',import.meta.url)),'--registry-only'],stderr:'pipe'});
 try{
  await client.connect(transport);
  const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='registry_list'));
  const result=await client.callTool({name:'registry_list',arguments:{}});
  const packet=JSON.parse(result.content[0].text);assert.equal(new Set(packet.modes.map(m=>m.id)).size,4);assert.equal(packet.modes.find(m=>m.id==='overnight_review'&&m.version===2).version,2);
  assert.ok(packet.capabilities.find(c=>c.id==='research'));
 }finally{await client.close();}
});
