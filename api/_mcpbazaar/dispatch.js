// JSON-RPC dispatch for the x402 Bazaar MCP server — thin binding of the shared
// payment-free dispatcher (api/_lib/mcp-dispatch.js) to this server's catalog.
import { makeDispatcher, PROTOCOL_VERSION } from '../_lib/mcp-dispatch.js';
import { TOOL_CATALOG, TOOLS } from './catalog.js';

export { PROTOCOL_VERSION };

const INSTRUCTIONS = [
	'The x402 Bazaar lets you discover paid agent services across the live x402 facilitator network.',
	'search_services(query) finds services; browse_services() lists them; get_service(resource_url) returns',
	'the exact price, payment networks, input schema, and a ready pay link.',
	'Use this to answer "what can I pay for?" and to price and locate an external service before calling it.',
].join(' ');

export const dispatch = makeDispatcher({
	serverInfo: { name: 'three-ws-x402-bazaar', version: '1.0.0' },
	instructions: INSTRUCTIONS,
	catalog: TOOL_CATALOG,
	tools: TOOLS,
	logName: 'mcp-bazaar',
});
