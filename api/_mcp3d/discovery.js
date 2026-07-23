// Bazaar discovery + service metadata for the hosted 3D Studio MCP endpoint.
//
// The 402 challenge an unauthenticated/unpaid caller receives carries this
// metadata so x402 facilitators (CDP Bazaar, agentic.market, x402scan) index
// /api/mcp-3d with a 3D-Studio-specific service name, tags, icon, and a v2
// `bazaar` extension describing the JSON-RPC tools/call shape. Without it the
// endpoint inherited the main /api/mcp envelope and advertised itself as the
// avatar/validation server. Mirrors api/_mcpibm/discovery.js for Granite.

import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';

export const RESOURCE_DESCRIPTION =
	'three.ws 3D Studio MCP: Streamable HTTP (MCP 2025-06-18) that turns text or images into ' +
	'interactive, animation-ready 3D models: text_to_3d (prompt → GLB), image_to_3d (1–4 reference ' +
	'views → GLB), generation_status (poll a job for the finished model), auto_rig_model, plus mesh ' +
	'editing (retexture, remesh, stylize, segment) and PBR material generation. Connect with a ' +
	'three.ws account (OAuth) or pay per call in USDC on Base or Solana mainnet, no API key. ' +
	'Operated by three.ws.';

// Endpoint-level v2 bazaar discovery entry, shaped exactly like the validator
// expects (see api/_lib/x402-spec.js → bazaarExtension). Describes how to POST
// a JSON-RPC 2.0 tools/call and what comes back.
function studioBazaarExtension() {
	const exampleBody = {
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: {
			name: 'text_to_3d',
			arguments: { prompt: 'a brass steampunk owl, full body', tier: 'standard' },
		},
	};
	const exampleResponse = {
		jsonrpc: '2.0',
		id: 1,
		result: {
			content: [
				{
					type: 'text',
					text: '{"job_id":"abc123def4567890","status":"queued","eta_seconds":60}',
				},
			],
			structuredContent: {
				ok: true,
				job_id: 'abc123def4567890',
				status: 'queued',
				tier: 'standard',
				eta_seconds: 60,
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
					'For tools/call: { name, arguments }. Tool names: text_to_3d, image_to_3d, generation_status, auto_rig_model, retexture_model, remesh_model, stylize_model, segment_model, generate_material, direct_prompt, see tools/list.',
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
// the 402 envelope advertises 3D Studio service metadata + discovery.
export const STUDIO_CHALLENGE = {
	description: RESOURCE_DESCRIPTION,
	bazaar: studioBazaarExtension(),
	...withService({
		serviceName: 'three.ws 3D Studio MCP',
		tags: ['x402', 'mcp', '3d', 'text-to-3d', 'glb'],
	}),
};
