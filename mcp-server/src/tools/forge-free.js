// `forge_free` — FREE MCP tool: text prompt → textured 3D GLB. No payment, no key.
//
// The zero-cost counterpart to `mesh_forge` / `text_to_avatar`. It drives the
// three.ws /api/forge pipeline pinned to the FREE NVIDIA NIM (Microsoft TRELLIS)
// text→3D lane — the same free engine the /forge web page uses for prompt
// drafts — so anyone can turn a text prompt into a downloadable, viewable 3D
// model with NO x402 payment and NO API key.
//
// The generation logic lives in `_studio-core.js` (runForgeFree), the same core
// the rest of the stdio server's generators are built on, so none of them drift.
// The hosted FREE 3D Studio endpoint (/api/mcp-studio) pins the same free lane
// over /api/forge through its own client, api/_mcp-studio/forge-client.js.
//
// Environment (all optional — sensible prod defaults):
//   FORGE_FREE_API_BASE   — three.ws origin. Default https://three.ws
//   FORGE_FREE_TIMEOUT_MS — overall reconstruct poll budget. Default 180000.
//   FORGE_FREE_POLL_MS    — poll interval. Default 3000.

import { z } from 'zod';

import { free } from '../payments.js';
import { jsonSchemaFromZod } from './_shared.js';
import { runForgeFree } from './_studio-core.js';

const TOOL_NAME = 'forge_free';
const TOOL_DESCRIPTION =
	'Generate a textured 3D GLB model from a text prompt — FREE: no x402 payment, no API key, no wallet. ' +
	'Drives the three.ws /api/forge pipeline on the free NVIDIA NIM (Microsoft TRELLIS) text→3D lane — ' +
	'the same zero-cost engine the /forge web page uses for prompt drafts. Returns a durable GLB URL, a ' +
	'three.ws viewer link that renders the model in the browser, the quality tier used, and the backend ' +
	'that actually produced it. Choose tier draft (fast, default), standard, or high — all free; higher ' +
	'tiers just take longer. Text-only (NVIDIA\'s hosted TRELLIS preview does not accept uploaded photos); ' +
	'for image/multi-view → 3D or the Granite-directed paid chain use mesh_forge. Feed the returned glbUrl ' +
	'to rig_mesh to make it animation-ready. Free — no payment required.';

const inputZodShape = {
	prompt: z
		.string()
		.min(3)
		.max(1000)
		.describe(
			'Natural-language description of the single object or character to model, e.g. "a friendly round robot mascot, glossy white plastic". The free TRELLIS lane conditions on ~77 characters, so lead with the subject plus its key materials and colors.',
		),
	tier: z
		.enum(['draft', 'standard', 'high'])
		.describe(
			'Geometry/texture budget: draft = fast preview (default), standard = balanced, high = densest mesh. All three are free on the NVIDIA NIM lane — higher tiers only cost more time, never money.',
		)
		.optional(),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

export function buildForgeFreeTool() {
	const handler = free({ toolName: TOOL_NAME, inputSchema: inputJsonSchema }, (args) =>
		runForgeFree(args),
	);

	return {
		name: TOOL_NAME,
		title: 'Free text → 3D (TRELLIS)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		// Mints a fresh hosted GLB artifact via the free generation lane; destroys
		// nothing, and the same prompt can yield a different mesh each call.
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		handler,
	};
}
