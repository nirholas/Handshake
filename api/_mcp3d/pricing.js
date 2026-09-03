// Per-tool x402 pricing for the hosted 3D Studio MCP server (/api/mcp-3d).
//
// Before this map existed, every x402 call — including a high-tier GPU
// generation — settled for the flat env minimum (~$0.001) while the same job
// cost $0.05–0.50 via /api/x402/forge. Pricing is now coherent across
// surfaces: generation tools charge the SAME tier prices as the REST endpoint
// (single source: forge-tiers.js), mesh-editing tools carry flat per-call
// prices, and read-only tools (status polling, previews, inspection) stay
// free. OAuth-authenticated three.ws principals are unaffected — they remain
// operator-funded and never hit the x402 path. See api/mcp-3d.js.

import { priceAtomicsForTier, priceUsdcForTier } from '../_lib/forge-tiers.js';

const USDC_DECIMALS = 6;
function usdcToAtomicString(amountUsdc) {
	return String(Math.round(Number(amountUsdc) * 10 ** USDC_DECIMALS));
}

// Generation tools price by the requested quality tier — identical numbers to
// POST /api/x402/forge so an agent pays the same regardless of transport.
const TIER_PRICED_TOOLS = Object.freeze(new Set(['text_to_3d', 'image_to_3d']));
const DEFAULT_TIER = 'standard';

// Flat per-call USDC prices for the mesh-editing and direction tools.
// GPU-backed mesh ops sit between the Granite LLM tools ($0.02–0.05) and a
// full generation; pure-LLM helpers price like a Granite chat call.
export const TOOL_PRICING = Object.freeze({
	text_to_3d: {
		amount_usdc: Number(priceUsdcForTier(DEFAULT_TIER)),
		description: `Per call — text → textured GLB. Priced by tier: $${priceUsdcForTier('draft')} draft / $${priceUsdcForTier('standard')} standard / $${priceUsdcForTier('high')} high.`,
	},
	image_to_3d: {
		amount_usdc: Number(priceUsdcForTier(DEFAULT_TIER)),
		description: `Per call — image(s) → textured GLB. Priced by tier: $${priceUsdcForTier('draft')} draft / $${priceUsdcForTier('standard')} standard / $${priceUsdcForTier('high')} high.`,
	},
	auto_rig_model: {
		amount_usdc: 0.05,
		description: 'Per call — add an animation-ready skeleton to a GLB',
	},
	capture_scene: {
		amount_usdc: 0.05,
		description: 'Per call — video → 3D scene reconstruction (coloured .ply point cloud)',
	},
	retexture_model: {
		amount_usdc: 0.05,
		description: 'Per call — repaint a full mesh from a text prompt',
	},
	retexture_region: {
		amount_usdc: 0.05,
		description: 'Per call — magic-brush retexture of a masked region',
	},
	stylize_model: {
		amount_usdc: 0.02,
		description: 'Per call — voxel / brick / voronoi / lowpoly restyle',
	},
	remesh_model: {
		amount_usdc: 0.02,
		description: 'Per call — repair, simplify, or convert mesh format',
	},
	segment_model: {
		amount_usdc: 0.02,
		description: 'Per call — split a mesh into named parts',
	},
	remove_background: {
		amount_usdc: 0.01,
		description: 'Per call — cut a subject from a reference photo',
	},
	pose_model: {
		amount_usdc: 0.01,
		description: 'Per call — pose a rigged model from a text prompt',
	},
	apply_animation: {
		amount_usdc: 0.01,
		description: 'Per call — retarget a library clip onto a rigged GLB',
	},
	direct_prompt: {
		amount_usdc: 0.01,
		description: 'Per call — rewrite a vague idea into a tight 3D spec',
	},
	generate_material: {
		amount_usdc: 0.01,
		description: 'Per call — PBR material parameters from a description',
	},
	anchor_provenance: {
		amount_usdc: 0.05,
		description: 'Per call — sign a content credential and anchor its hash on Solana',
	},
});

export function priceFor(toolName) {
	return TOOL_PRICING[toolName] || null;
}

// Tools deliberately served at no per-call charge: discovery, status polling,
// previews, local analysis, and the persona/identity ops whose authorization is
// the 120-bit persona_id capability rather than a payment. Listing them
// explicitly (instead of letting "absent from TOOL_PRICING" silently mean free)
// is what lets tests/api/mcp-3d-challenge.test.js assert that EVERY catalog tool
// is a deliberate decision: add a GPU-backed tool to the catalog without pricing
// it and the classification test fails, rather than the tool shipping free. That
// silent-free failure is exactly the outage this module was written to end.
export const FREE_TOOLS = Object.freeze(
	new Set([
		'getting_started',
		'generation_status',
		'preview_3d',
		'save_avatar',
		'create_agent_persona',
		'get_agent_persona',
		'persona_say',
		'validate_spatial_response',
		'export_ar',
		'verify_provenance',
		// The physics grade is free for the same reason the authenticity check is:
		// a gate nobody can afford to call gates nothing. An agent that can grade
		// an asset before paying to generate, buy, or rig it spends less overall,
		// which is the point.
		'grade_sim_readiness',
		// Free on purpose and permanently. An assurance check that costs money is one
		// nobody calls, and one nobody calls prevents nothing.
		'x402_preflight',
		'persona_identity',
		'persona_tip',
		'persona_send',
		'inspect_model',
		'optimize_model',
		'list_animations',
		'animation_signature',
		'find_similar_animations',
		'text_to_animation',
	]),
);

// The x402 `amount` (atomic-unit string) for a studio tools/call, or null for
// the free tools above. Tier-priced tools read the caller's `tier` argument so
// the 402 quote, the verified payment, and the settled charge all match the work
// actually requested; an unknown tier resolves to the standard price
// (resolveTier's fallback) rather than under-charging.
export function studioX402Amount(toolName, args) {
	if (TIER_PRICED_TOOLS.has(toolName)) {
		return String(priceAtomicsForTier(args?.tier || DEFAULT_TIER));
	}
	const price = priceFor(toolName);
	if (!price || !(price.amount_usdc > 0)) return null;
	return usdcToAtomicString(price.amount_usdc);
}
