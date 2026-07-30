// `refine_model` — paid MCP tool: conversational, iterative 3D.
//
// Carry a model you already generated forward with a natural-language change
// ("make it metallic", "bigger helmet", "add wings"). This is a REAL anchored
// re-generation — the prior prompt is folded into the new one so form, subject,
// and materials carry forward, and an optional reference image of the current
// model anchors it as image→3D. No faked diffing: the composed prompt is what
// the generator actually runs.
//
// Every refinement is recorded in an immutable version lineage (parent → child)
// so the caller can branch or revert — a pointer move over the returned array,
// never a mutation. Pass `parent_lineage` from a previous result to extend the
// same thread; omit it to start a fresh lineage rooted at `glb_url`.
//
// Pricing: $0.25 USDC (a full regeneration, priced like mesh_forge). Settled
// `exact` on Solana. The generation logic lives in `_studio-core.js`
// (runRefineModel) so the paid stdio transport and the hosted FREE 3D Studio
// endpoint (/api/mcp-studio) share ONE implementation and never drift. Iteration
// carries no royalty/wallet surface — that lives only on the remix rails.
//
// Environment (all optional — sensible prod defaults):
//   MESH_FORGE_API_BASE     — three.ws origin. Default https://three.ws
//   REFINE_MODEL_TIMEOUT_MS — overall reconstruct poll budget. Default 180000.
//   REFINE_MODEL_POLL_MS    — poll interval. Default 3000.

import { z } from 'zod';

import { paid } from '../payments.js';
import { jsonSchemaFromZod } from './_shared.js';
import { runRefineModel } from './_studio-core.js';

const TOOL_NAME = 'refine_model';
const TOOL_DESCRIPTION =
	'Iterate on a 3D model by describing a change in plain language ("make it metallic", "bigger helmet", ' +
	'"add wings"). Re-generates a NEW version anchored to the previous model: the prior prompt is carried ' +
	'forward and folded with your change, and an optional reference image of the current model anchors the ' +
	'regeneration as image→3D. Real generation — never a fake diff. Each refinement is appended to an ' +
	'immutable version lineage (parent → child) so you can branch off an earlier version (parent_index) or ' +
	'revert (a pointer move over the returned lineage). Pass parent_lineage from a previous refine_model ' +
	'result to extend the same thread; omit it to start a fresh lineage rooted at glb_url. Returns the new ' +
	'GLB URL, a three.ws viewer link, the composed prompt, the full lineage, and the active version index. ' +
	'Paid: $0.25 USDC.';

const inputZodShape = {
	glb_url: z
		.string()
		.url()
		.describe('http(s) URL of the model to refine — e.g. the glbUrl a previous generation or refinement returned.'),
	instruction: z
		.string()
		.min(1)
		.max(500)
		.describe('The change to make, in plain language: "make it metallic", "bigger helmet", "add a cape".'),
	parent_prompt: z
		.string()
		.max(1000)
		.describe('Optional — the prompt that produced the model being refined, so the change builds on it instead of starting over.')
		.optional(),
	reference_image_url: z
		.string()
		.url()
		.describe('Optional http(s) image of the current model to anchor the regeneration (image→3D). Omit for text-guided refinement.')
		.optional(),
	parent_lineage: z
		.array(z.record(z.any()))
		.describe('Optional — the lineage array from a previous refine_model result, to extend the same version history.')
		.optional(),
	parent_index: z
		.number()
		.int()
		.min(0)
		.describe('Optional — branch off an earlier version in parent_lineage (its index) instead of the latest.')
		.optional(),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

export async function buildRefineModelTool() {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			scheme: 'exact',
			priceUsd: '$0.25',
			inputSchema: inputJsonSchema,
			example: { glb_url: 'https://three.ws/avatars/cesium-man.glb', instruction: 'make it metallic', parent_prompt: 'a round robot mascot' },
			outputExample: {
				ok: true,
				mode: 'refine',
				glbUrl: 'https://three.ws/cdn/creations/def456/mesh.glb',
				viewerUrl: 'https://three.ws/viewer?src=https%3A%2F%2Fthree.ws%2F...',
				composedPrompt: 'a round robot mascot, metallic',
				instruction: 'make it metallic',
				anchored: false,
				lineage: [
					{ index: 0, parentIndex: null, glbUrl: 'https://three.ws/avatars/cesium-man.glb', instruction: null, refKind: 'origin' },
					{ index: 1, parentIndex: 0, glbUrl: 'https://three.ws/cdn/creations/def456/mesh.glb', instruction: 'make it metallic', refKind: 'text' },
				],
				activeIndex: 1,
			},
		},
		(args) => runRefineModel(args),
	);

	return {
		name: TOOL_NAME,
		title: 'Refine a 3D model by describing a change',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		// Mints a fresh version anchored to the parent; never overwrites the source
		// and a given change can yield a slightly different mesh each call.
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		handler,
	};
}
