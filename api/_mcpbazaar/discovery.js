// Bazaar discovery + service metadata for the hosted x402 Bazaar MCP endpoint.
//
// The 402 challenge an unauthenticated/unpaid caller receives carries this
// metadata so x402 facilitators (CDP Bazaar, agentic.market, x402scan) index
// /api/mcp-bazaar with its own service name, tags, icon, and a v2 `bazaar`
// extension describing the JSON-RPC tools/call shape. Without it the endpoint
// inherited the main /api/mcp envelope and advertised itself as the avatar and
// model-validation server, pointing at the wrong resource URL. Mirrors
// api/_mcp3d/discovery.js for the 3D Studio and api/_mcpibm/discovery.js for
// Granite.

import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';

export const RESOURCE_DESCRIPTION =
	'three.ws x402 Bazaar MCP: Streamable HTTP (MCP 2025-06-18) that discovers and prices paid ' +
	'agent services across the live x402 facilitator network: search_services (ranked search), ' +
	'browse_services (list what is payable), get_service (exact price, networks, recipient, input ' +
	'schema, and a ready pay link), and bazaar_service_details (live per-network price for cost ' +
	'tracking). Connect with a three.ws account (OAuth) or pay per call in USDC on Base or Solana ' +
	'mainnet, no API key. Operated by three.ws.';

// Endpoint-level v2 bazaar discovery entry, shaped exactly like the validator
// expects (see api/_lib/x402-spec.js → bazaarExtension). Describes how to POST
// a JSON-RPC 2.0 tools/call and what comes back.
function bazaarServerExtension() {
	const exampleBody = {
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: {
			name: 'search_services',
			arguments: { query: 'weather', type: 'http', limit: 5 },
		},
	};
	const exampleResponse = {
		jsonrpc: '2.0',
		id: 1,
		result: {
			content: [
				{
					type: 'text',
					text: '1. Weather Now - $0.001\n   Current weather by city.\n   networks: eip155:8453',
				},
			],
			structuredContent: {
				query: 'weather',
				type: 'http',
				count: 1,
				services: [
					{
						type: 'http',
						resource: 'https://api.example.com/weather',
						name: 'Weather Now',
						price: '$0.001',
						price_atomic: 1000,
						networks: ['eip155:8453'],
					},
				],
			},
		},
	};
	const requestBodySchema = {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		required: ['jsonrpc', 'method'],
		properties: {
			jsonrpc: { type: 'string', const: '2.0' },
			id: { type: ['string', 'number'] },
			method: {
				type: 'string',
				enum: ['initialize', 'tools/list', 'tools/call', 'ping'],
				description: 'MCP JSON-RPC method.',
			},
			params: {
				type: 'object',
				description:
					'For tools/call: { name, arguments }. Tool names: getting_started (free), search_services, browse_services, get_service, bazaar_service_details, see tools/list.',
			},
		},
	};
	const responseBodySchema = {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		properties: {
			jsonrpc: { type: 'string', const: '2.0' },
			id: { type: ['string', 'number'] },
			result: {
				type: 'object',
				properties: {
					content: {
						type: 'array',
						items: {
							type: 'object',
							required: ['type', 'text'],
							properties: {
								type: { type: 'string', enum: ['text'] },
								text: { type: 'string' },
							},
						},
					},
				},
			},
			error: {
				type: 'object',
				properties: { code: { type: 'number' }, message: { type: 'string' } },
			},
		},
	};
	return {
		discoverable: true,
		info: {
			input: { type: 'http', method: 'POST', body: exampleBody, bodyType: 'json' },
			output: { type: 'json', example: exampleResponse },
		},
		schema: buildBazaarSchema({
			method: 'POST',
			bodyType: 'json',
			bodySchema: requestBodySchema,
			outputSchema: responseBodySchema,
		}),
	};
}

// The challenge override block threaded into authenticateRequest/handleSse so
// the 402 envelope advertises x402 Bazaar service metadata + discovery.
export const BAZAAR_CHALLENGE = {
	description: RESOURCE_DESCRIPTION,
	bazaar: bazaarServerExtension(),
	...withService({
		serviceName: 'three.ws x402 Bazaar MCP',
		tags: ['x402', 'mcp', 'discovery', 'bazaar', 'pricing'],
	}),
};
