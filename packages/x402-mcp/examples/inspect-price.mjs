// inspect-price.mjs: discover real paid x402 services, then read one
// endpoint's price WITHOUT paying for it.
//
// Exercises the two free, read-only tools on this server against live data:
//   1. find_services   searches the live x402 bazaar (PayAI + Coinbase CDP)
//   2. inspect_endpoint probes a 402 challenge and reports every accepted
//                       scheme, network, asset, atomic price, and pay-to address
//
// This example NEVER calls pay_and_call and never signs anything. It is the
// honest way to learn what a call would cost before committing money: the
// output is exactly the challenge pay_and_call would settle.
//
//   node examples/inspect-price.mjs
//   node examples/inspect-price.mjs "image upscale"
//   node examples/inspect-price.mjs "3d model" https://your-endpoint.example/paid
//
// No key, no signer, no funds required.

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url));
const FORWARDED_ENV = ['THREE_WS_BASE', 'THREE_WS_TIMEOUT_MS', 'SOLANA_RPC_URL'];

const [queryArg, urlArg] = process.argv.slice(2);
const QUERY = queryArg || '3d model';

// A live three.ws x402 route. Model Check charges per call and takes its input
// as a query param, so the probe URL carries one; the value is the endpoint's
// own documented example asset. Pass a second CLI arg to probe anything else,
// including a `resource` printed by step 1.
const TARGET_URL =
	urlArg || 'https://three.ws/api/x402/model-check?url=https://three.ws/avatars/mannequin.glb';

function childEnv() {
	const env = getDefaultEnvironment();
	for (const key of FORWARDED_ENV) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

/** Unwrap an MCP tool result's JSON payload from its text content block. */
function payload(result) {
	const text = result?.content?.find((c) => c.type === 'text')?.text ?? '';
	try {
		return JSON.parse(text);
	} catch {
		return { ok: false, raw: text };
	}
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [SERVER_PATH],
	env: childEnv(),
	stderr: 'inherit',
});
const client = new Client({ name: 'x402-mcp-inspect-price-example', version: '1.0.0' });
await client.connect(transport);

// ── 1. find_services: what can this agent buy? ─────────────────────────────
console.log(`\nfind_services: searching the live bazaar for "${QUERY}"`);
const found = payload(
	await client.callTool({
		name: 'find_services',
		arguments: { query: QUERY, type: 'http', limit: 5 },
	}),
);
if (!found.ok) {
	console.error('find_services failed:', found.message || found.error || found.raw);
	await client.close();
	process.exit(1);
}
console.log(`  ${found.count} service(s) matched`);
for (const service of found.services) {
	console.log(`  - ${service.price ?? 'price unlisted'}  ${service.resource}`);
	if (service.name) console.log(`      ${service.name}`);
}

// ── 2. inspect_endpoint: what does one of them charge? ─────────────────────
console.log(`\ninspect_endpoint: probing ${TARGET_URL}`);
const probe = payload(
	await client.callTool({
		name: 'inspect_endpoint',
		arguments: { url: TARGET_URL, method: 'GET' },
	}),
);
if (!probe.ok) {
	console.error('inspect_endpoint failed:', probe.message || probe.error || probe.raw);
	await client.close();
	process.exit(1);
}

if (!probe.paid) {
	console.log(`  not paywalled (HTTP ${probe.status}); call it directly, no x402 needed`);
} else {
	console.log(`  402 payment required, ${probe.accepts.length} way(s) to settle:`);
	for (const accept of probe.accepts) {
		console.log(`  - ${accept.network}  ${accept.scheme}`);
		console.log(`      price:   ${accept.price ?? 'unstated'} atomic (${accept.price_display ?? 'no decimals advertised'})`);
		console.log(`      asset:   ${accept.asset ?? 'unstated'}`);
		console.log(`      pay to:  ${accept.pay_to ?? 'unstated'}`);
	}
	console.log(
		`\n  this wallet could settle it: ${probe.payable_with_this_wallet ? 'yes, a solana:* accept is offered' : 'no solana:* accept offered'}`,
	);
}

console.log('\nNo payment was made. Nothing was signed, no key was read.');
console.log('To actually buy the result, call pay_and_call with confirm: true and a funded SOLANA_SECRET_KEY.');

await client.close();
