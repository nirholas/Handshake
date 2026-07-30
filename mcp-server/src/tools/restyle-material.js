// `restyle_material` — paid MCP tool: re-skin an existing GLB without
// regenerating its mesh.
//
// Two modes, one tool:
//   - instruction mode  ("make it chrome", "wooden", "cyberpunk neon") — IBM
//     Granite proposes a glTF PBR material (base color, metalness, roughness,
//     emissive), applied onto the model's material(s) and re-exported. Mesh
//     geometry and UVs are byte-identical to the source; only material factors
//     change.
//   - variant mode (preset + seed + count) — fans one PBR preset out into N
//     reproducible colorway variants (same base + seed always yields the same
//     N looks) so a caller can generate a full colorway set in one call.
//
// Both modes call the SAME server logic the free web Material Studio page uses
// (api/_lib/material-studio-store.js, via api/material-studio.js) — no forked
// generation path. Pricing is flat and cheap relative to a full regeneration
// (refine_model, $0.25): this only runs a fast LLM call + a CPU-only
// glTF-Transform mutation pass, never a GPU job.
//
// Environment (all optional — sensible prod defaults):
//   MESH_FORGE_API_BASE — three.ws origin. Default https://three.ws

import { z } from 'zod';

import { paid } from '../payments.js';
import { jsonSchemaFromZod } from './_shared.js';
import { runRestyleMaterial } from './_material-core.js';

const TOOL_NAME = 'restyle_material';
const TOOL_DESCRIPTION =
	'Re-skin an existing GLB WITHOUT regenerating its mesh — mesh geometry and UVs are preserved exactly. ' +
	'Two modes: pass `instruction` (e.g. "make it chrome", "wooden", "cyberpunk neon") for an AI-proposed PBR ' +
	'material (base color, metalness, roughness, emissive) applied to the model; or pass `preset` (+ optional ' +
	'`seed`/`count`) for N reproducible colorway variants fanned out from one PBR preset — same preset + seed ' +
	'always yields the same variant set. Every call is recorded in an immutable version lineage (parent → ' +
	'child), the same lineage shape refine_model uses — pass `parent_lineage` from a previous restyle_material ' +
	'result to extend the same thread, or `parent_index` to branch off an earlier version instead of the ' +
	'latest. The source GLB is never modified; each restyle or variant is a new, separately addressable asset ' +
	'so you can always revert. Returns durable GLB URL(s), the applied PBR factors, and the lineage. ' +
	'Paid: $0.05 USDC.';

const PRESET_NAMES = [
	'chrome', 'gold', 'copper', 'brushedSteel', 'gunmetal', 'matte', 'glossy',
	'rubber', 'ceramic', 'glass', 'wood', 'stone', 'neon', 'holographic',
];

const inputZodShape = {
	glb_url: z
		.string()
		.url()
		.describe('http(s) URL of the GLB to restyle — e.g. the glbUrl a previous generation or refinement returned.'),
	instruction: z
		.string()
		.min(2)
		.max(300)
		.describe('Instruction mode: the restyle to apply in plain language, e.g. "make it chrome", "wooden", "cyberpunk neon". Omit to use variant mode instead.')
		.optional(),
	preset: z
		.enum(PRESET_NAMES)
		.describe('Variant mode: the base PBR preset to fan out into colorway variants. Used only when instruction is omitted; defaults to "chrome".')
		.optional(),
	seed: z
		.number()
		.int()
		.min(0)
		.max(4294967295)
		.describe('Variant mode: deterministic seed — the same preset + seed always produces the same variant set.')
		.optional(),
	count: z
		.number()
		.int()
		.min(1)
		.max(12)
		.describe('Variant mode: how many colorway variants to generate (1-12, default 6).')
		.optional(),
	material_index: z
		.number()
		.int()
		.min(0)
		.describe('Optional — restyle only this material index (by its position in the GLB\'s material list) instead of every material on the model.')
		.optional(),
	parent_lineage: z
		.array(z.record(z.any()))
		.describe('Optional — the lineage array from a previous restyle_material (or refine_model) result, to extend the same version history.')
		.optional(),
	parent_index: z
		.number()
		.int()
		.min(0)
		.describe('Optional — branch off an earlier version in parent_lineage (its index) instead of the latest.')
		.optional(),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

export async function buildRestyleMaterialTool() {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			scheme: 'exact',
			priceUsd: '$0.05',
			inputSchema: inputJsonSchema,
			example: { glb_url: 'https://three.ws/avatars/cesium-man.glb', instruction: 'make it chrome' },
			outputExample: {
				ok: true,
				mode: 'restyle',
				glbUrl: 'https://three.ws/cdn/material-studio/restyle/def456.glb',
				sourceGlbUrl: 'https://three.ws/avatars/cesium-man.glb',
				viewerUrl: 'https://three.ws/viewer?src=https%3A%2F%2Fthree.ws%2F...',
				instruction: 'make it chrome',
				factors: { name: 'Polished chrome', baseColorFactor: [0.79, 0.81, 0.83], metallicFactor: 1, roughnessFactor: 0.05, emissiveFactor: [0, 0, 0] },
				materialsEdited: 1,
				lineage: [
					{ index: 0, parentIndex: null, glbUrl: 'https://three.ws/avatars/cesium-man.glb', refKind: 'origin' },
					{ index: 1, parentIndex: 0, glbUrl: 'https://three.ws/cdn/material-studio/restyle/def456.glb', instruction: 'make it chrome', refKind: 'restyle' },
				],
				activeIndex: 1,
			},
		},
		(args) => runRestyleMaterial(args),
	);

	return {
		name: TOOL_NAME,
		title: 'Restyle a 3D model’s materials — AI PBR restyle or seeded colorway variants',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		// Mints a fresh GLB (or set of GLBs) anchored to the source; never
		// overwrites it and instruction mode can yield a slightly different PBR
		// proposal each call, so this is neither idempotent nor destructive.
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		handler,
	};
}
