// JSON-RPC dispatch for the threews-agent MCP server — thin binding of the
// shared payment-free dispatcher (api/_lib/mcp-dispatch.js) to this catalog.
// (The "payment-free" refers to MCP-tool pricing; pay_and_call moves the
// USER's funds to external services, which is orthogonal to tool billing.)
import { makeDispatcher, PROTOCOL_VERSION } from '../_lib/mcp-dispatch.js';
import { TOOL_CATALOG, TOOLS } from './catalog.js';

export { PROTOCOL_VERSION };

const INSTRUCTIONS = [
	'three.ws Agent gives this assistant a real on-chain wallet on the x402 network.',
	'wallet_status shows the balance and spending caps; find_services discovers paid services;',
	'pay_and_call(resource_url) calls a paid x402 endpoint and settles the USDC payment from the',
	"user's own three.ws agent wallet, within caps. Always check wallet_status before spending, and",
	'confirm the price with the user when it is non-trivial.',
].join(' ');

export const dispatch = makeDispatcher({
	serverInfo: { name: 'threews-agent', version: '1.0.0' },
	instructions: INSTRUCTIONS,
	catalog: TOOL_CATALOG,
	tools: TOOLS,
	logName: 'mcp-agent',
});
