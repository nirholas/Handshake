import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const t = new StdioClientTransport({ command: process.execPath, args: [process.argv[2]] });
const c = new Client({ name: 'p', version: '0' });
await c.connect(t);
const { tools } = await c.listTools();
const one = tools.find((x) => x.name === process.argv[3]);
console.log(JSON.stringify(one, null, 2));
await c.close();
