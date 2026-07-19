// Manual live e2e (not part of `npm test`): spins a real stdio MCP client
// against the built server and exercises all three tools. concierge_ask hits
// THREE_WS_BASE/api/concierge, so run a local server first, e.g.:
//   PORT=8093 node server/index.mjs &
//   THREE_WS_BASE=http://localhost:8093 node packages/concierge-mcp/test/_manual-e2e.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '../src/index.js');

const transport = new StdioClientTransport({
	command: 'node',
	args: [serverPath],
	env: { ...process.env },
});
const client = new Client({ name: 'concierge-mcp-e2e', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

const embed = await client.callTool({
	name: 'concierge_embed',
	arguments: { siteName: 'Acme', accent: '#f97316', flavor: 'script', suggestions: ['What is Acme?', 'Pricing?'] },
});
const embedOut = JSON.parse(embed.content[0].text);
console.log('EMBED one-tag ok:', /data-concierge/.test(embedOut.snippets.script));

const av = await client.callTool({ name: 'concierge_avatars', arguments: {} });
console.log('AVATARS:', JSON.parse(av.content[0].text).avatars.map((a) => a.id).join(','));

const ask = await client.callTool({
	name: 'concierge_ask',
	arguments: {
		question: 'How much are Pro skates? One short sentence.',
		siteName: 'Acme',
		knowledge: 'Pro skates cost $199 and reach 300 mph. Standard skates cost $99.',
	},
});
const askOut = JSON.parse(ask.content[0].text);
console.log('ASK ok:', askOut.ok, '| provider:', askOut.provider, '| answer:', (askOut.answer || '').slice(0, 140));

await client.close();
console.log('MCP E2E DONE');
process.exit(0);
