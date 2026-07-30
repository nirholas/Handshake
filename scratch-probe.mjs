import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const target = process.argv[2];
const t = new StdioClientTransport({ command: process.execPath, args: [target], stderr: 'inherit' });
const c = new Client({ name: 'probe', version: '0.0.0' });
await c.connect(t);
const { tools } = await c.listTools();
console.log(target, '->', tools.length, 'tools');
for (const x of tools) console.log('  -', x.name, JSON.stringify(Object.keys(x.inputSchema?.properties||{})));
await c.close();
