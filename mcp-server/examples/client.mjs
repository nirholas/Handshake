// MCP Streamable HTTP lifecycle against the live three.ws server, from Node
// with plain fetch. No SDK, no dependencies; Node 20+ only.
//
// Walks initialize, notifications/initialized, tools/list, one free tool call
// (getting_started), and DELETE session termination against
// https://three.ws/api/mcp (MCP 2025-06-18, JSON-RPC 2.0).
//
// Header rules from the server implementation (api/_mcp/auth.js): sending
// "Accept: text/event-stream", "MCP-Protocol-Version", or "Mcp-Session-Id"
// marks the caller as an OAuth-capable MCP protocol client and yields a 401
// OAuth challenge. Plain JSON clients get free discovery, so this client
// sends only JSON headers. The server is stateless and issues no session id.
//
//   node examples/client.mjs

const MCP_URL = process.env.MCP_URL || 'https://three.ws/api/mcp';
const HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

async function post(message) {
	const res = await fetch(MCP_URL, {
		method: 'POST',
		headers: HEADERS,
		body: JSON.stringify(message),
	});
	if (!res.ok) throw new Error(`${message.method}: HTTP ${res.status} ${await res.text()}`);
	return { body: await res.json(), protocolVersion: res.headers.get('mcp-protocol-version') };
}

// 1. initialize
const init = await post({
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'client-mjs-example', version: '1.0.0' },
	},
});
console.log('initialize:');
console.log('  server:  ', JSON.stringify(init.body.result.serverInfo));
console.log('  protocol:', init.body.result.protocolVersion, '(header:', init.protocolVersion + ')');

// 2. notifications/initialized: a notification has no id and gets a null body.
const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
console.log('notifications/initialized acknowledged (response body:', JSON.stringify(note.body) + ')');

// 3. tools/list
const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const tools = list.body.result.tools;
console.log(`\ntools/list: ${tools.length} tools`);
for (const t of tools) console.log(`  - ${t.name}${t.title ? `: ${t.title}` : ''}`);

// 4. One free tool call: getting_started needs no payment, token, or account.
const call = await post({
	jsonrpc: '2.0',
	id: 3,
	method: 'tools/call',
	params: { name: 'getting_started', arguments: {} },
});
// Prefer MCP structured output; fall back to the text mirror.
const out = call.body.result.structuredContent ?? call.body.result.content?.[0]?.text;
console.log('\ngetting_started:');
console.log(typeof out === 'string' ? out.slice(0, 400) + '\n...' : JSON.stringify(out, null, 2));

// 5. Terminate the session. The server is stateless per request, so DELETE
// always answers 204 No Content.
const bye = await fetch(MCP_URL, { method: 'DELETE' });
console.log(`\nsession terminate: HTTP ${bye.status}`);
