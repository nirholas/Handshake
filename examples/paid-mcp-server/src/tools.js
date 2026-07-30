// The two tools this server registers: one free, one paid.
//
// The free tool exists on purpose. A client that has never paid an MCP tool
// needs somewhere to look up prices and the payment flow without spending
// anything, and it is consistently the first tool a new caller invokes.

import { z } from 'zod';

import { fetchModel, inspectModel, MAX_BYTES } from './gltf.js';
import { paid } from './payments.js';

export const PAID_TOOL_NAME = 'inspect_model';
export const PAID_TOOL_PRICE = '$0.002';

const PAID_TOOL_DESCRIPTION =
	'Fetch a public glTF or GLB model by URL and return its structural report: container, size, ' +
	'scene/node/mesh/material/texture/animation counts, vertex and triangle totals, declared extensions, ' +
	'and a prioritized list of optimization findings with fixes. Costs ' +
	`${PAID_TOOL_PRICE} in USDC on Solana per call.`;

const inputSchema = {
	type: 'object',
	properties: {
		url: {
			type: 'string',
			description: 'Public https:// URL of a .glb or .gltf file.',
		},
	},
	required: ['url'],
	additionalProperties: false,
};

export function buildGettingStartedTool() {
	return {
		name: 'getting_started',
		title: 'Getting started (free)',
		description:
			'FREE. Start here. Explains what this server does, what each tool costs, how the x402 ' +
			'pay-per-call flow works, and how to call the paid tool once your client can settle USDC.',
		inputSchema: {},
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		handler: async () => ({
			content: [
				{
					type: 'text',
					text: JSON.stringify(
						{
							server: 'paid-mcp-server',
							summary:
								'A worked example of an MCP server whose tools charge per call over x402. ' +
								'One free tool (this one) and one paid tool.',
							tools: [
								{ name: 'getting_started', price: 'free', summary: 'This overview.' },
								{
									name: PAID_TOOL_NAME,
									price: PAID_TOOL_PRICE,
									summary: 'Structural report and optimization findings for a glTF/GLB model.',
									arguments: { url: 'https://three.ws/avatars/cesium-man.glb' },
								},
							],
							payment: {
								protocol: 'x402',
								asset: 'USDC',
								network: 'solana mainnet',
								flow: [
									'Call a paid tool with no payment. The server answers with a PaymentRequired envelope quoting the price.',
									'Sign the payment and retry the same call with the payload in _meta["x402/payment"].',
									'The server verifies, runs the work, settles, and returns the receipt in _meta["x402/payment-response"].',
								],
								note: 'Verification precedes the work and settlement follows it, so a failed call never charges you.',
							},
							limits: {
								maxModelBytes: MAX_BYTES,
								transport: 'https only, public hosts only, redirects refused',
							},
							docs: 'https://three.ws/tutorials/monetize-mcp-server',
						},
						null,
						2,
					),
				},
			],
		}),
	};
}

export function buildInspectModelTool() {
	return {
		name: PAID_TOOL_NAME,
		title: `Inspect a 3D model (${PAID_TOOL_PRICE})`,
		description: PAID_TOOL_DESCRIPTION,
		inputSchema: { url: z.string().url().describe('Public https:// URL of a .glb or .gltf file.') },
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
		handler: paid(
			{
				toolName: PAID_TOOL_NAME,
				description: PAID_TOOL_DESCRIPTION,
				priceUsd: PAID_TOOL_PRICE,
				inputSchema,
				example: { url: 'https://three.ws/avatars/cesium-man.glb' },
			},
			async ({ url }) => {
				// Every failure path throws, which skips settlement. A caller is charged
				// only when a report was actually produced, so a bad URL, an unreachable
				// host, or a corrupt file costs them nothing and can be retried with the
				// same signed payment.
				const buffer = await fetchModel(url);
				return inspectModel(buffer, { sourceUrl: url });
			},
		),
	};
}
