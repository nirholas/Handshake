// Bazaar discovery + service metadata for the Agent Identity Studio A2MCP
// endpoint (/api/okx/3d/identity-studio).
//
// The 402 envelope an unpaid caller receives carries this metadata, and buying
// agents read its `bazaar` extension to learn how to call the service. Without
// an endpoint-specific extension the envelope inherited build402Body's default,
// which describes the main /api/mcp server: it told a buyer to call
// `validate_model` with a `url` argument, a tool this server does not expose.
// An agent that followed it would pay for create_identity and then send a call
// the dispatcher rejects. Mirrors api/_mcp3d/discovery.js.

import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { X402_HEADER_ERROR } from '../_lib/x402-xlayer-okx.js';
import { catalogEntry } from '../_lib/okx-catalog.js';

const ENTRY = catalogEntry('identity-studio');

export const RESOURCE_DESCRIPTION =
	'three.ws Agent Identity Studio, A2MCP (MCP Streamable HTTP) service that turns an AI ' +
	"agent's brand brief into a complete 3D identity: rigged GLB avatar + posed studio renders " +
	`with an OKX-avatar-slot PFP crop. $${ENTRY.priceUsd} per identity, USDC via x402; job ` +
	'status polling is free. Operated by three.ws.';

// Endpoint-level v2 bazaar discovery entry, in the shape agentic.market's
// validator expects (see api/_lib/x402-spec.js → bazaarExtension). Describes a
// JSON-RPC 2.0 tools/call against THIS server's tools and the job handle that
// comes back.
function identityBazaarExtension() {
	const exampleBody = {
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: {
			name: ENTRY.tool,
			arguments: {
				agent_name: 'Atlas',
				brief: 'a calm, precise research agent with a cobalt-and-steel look',
			},
		},
	};
	const exampleResponse = {
		jsonrpc: '2.0',
		id: 1,
		result: {
			content: [
				{
					type: 'text',
					text: 'Identity job accepted. Poll identity_status with this job_id until status is "done" (ETA ~3-6 min). job_id: idj_abc123',
				},
			],
			structuredContent: {
				ok: true,
				job_id: 'idj_abc123',
				status: 'running',
				stage: 'generate',
				eta_seconds: 300,
				poll_tool: 'identity_status',
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
					`For tools/call: { name, arguments }. Tool names: ${ENTRY.tool} (paid, $${ENTRY.priceUsd}), ` +
					'identity_status (free job polling), getting_started (free overview). See tools/list.',
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

// The challenge override threaded into authenticateRequest/handleSse so the 402
// envelope advertises Identity Studio metadata and discovery instead of the
// shared MCP defaults. `tags` is capped at 5 by the Bazaar spec (withService
// truncates silently), so "okx" earns its slot here, this surface exists to be
// found on OKX.AI.
export const IDENTITY_CHALLENGE = {
	description: RESOURCE_DESCRIPTION,
	// Name the x402 v2 header an OKX buyer actually sends, not the v1 default.
	// See the same override on every forge row in api/_okx3d/forge.js.
	error: X402_HEADER_ERROR,
	bazaar: identityBazaarExtension(),
	...withService({
		serviceName: 'three.ws Agent Identity Studio',
		tags: ['x402', 'mcp', '3d', 'identity', 'okx'],
	}),
};
