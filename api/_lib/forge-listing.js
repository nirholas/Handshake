// Forge x402 listing metadata — the SINGLE source of truth for the paid 3D
// generation endpoint's discovery surface. Both the live 402 challenge
// (api/x402/forge.js) and the manually-mirrored .well-known/x402.json entry
// (api/wk.js) import from here, so the listing an agent sees on x402scan /
// agentic.market / the CDP Bazaar can never drift from what the live 402 quotes.
//
// This drift is exactly the bug this module closes: the description, tags,
// serviceName, and schemas used to live as two hand-kept copies, and the mirror
// fell out of sync (stale "FLUX→TRELLIS / Base or Solana" copy on a Solana-only,
// NIM-first endpoint). One export, two importers, zero drift.
//
// Pure data + price lookups only — it imports forge-tiers.js (itself dependency-
// free) so the prices in the prose come from the same constants the 402 quotes,
// and it pulls in NO provider/LLM/R2 modules, keeping api/wk.js (a lightweight
// discovery route) cheap to cold-start.

import { priceUsdcForTier } from './forge-tiers.js';
import { buildBazaarSchema } from './x402-spec.js';

// ── Service metadata (facilitator search rows) ──────────────────────────────
// serviceName MUST be ≤32 printable-ASCII chars or the CDP Bazaar validator
// soft-drops it (see scripts/verify-x402-discovery.mjs and bazaar-helpers.js).
// Kept ASCII on purpose — the em-dash/arrow variant would be silently discarded.
export const FORGE_SERVICE_NAME = 'three.ws Forge: text/image to 3D'; // 32 chars

// Tags drive x402scan's category facets. These anchor the listing under the
// three buckets the crown-jewel endpoint belongs in — 3D, AI, and Utility —
// plus the two concrete modalities agents search for. Capped at 5 (the Bazaar
// limit); withService()/the mirror both slice to 5, so keep it at 5 exactly.
export const FORGE_TAGS = Object.freeze(['3d', 'ai', 'text-to-3d', 'image-to-3d', 'utility']);

export const FORGE_ASPECT_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '16:9', '9:16']);
export const FORGE_MAX_VIEWS = 6;

// Prices sourced from forge-tiers.js so the prose never carries a second copy of
// a number the 402 could contradict.
const DRAFT_USD = priceUsdcForTier('draft'); // "0.05"
const STANDARD_USD = priceUsdcForTier('standard'); // "0.15"
const HIGH_USD = priceUsdcForTier('high'); // "0.50"

// Leads with the agent use-case (what you build with it), then the tiers +
// prices, the keyless/no-account pledge, the free poll, and the free draft
// on-ramp — everything an autonomous buyer needs to decide and to call, in the
// order they need it. First sentence is the card headline; the rest is detail.
export const FORGE_ROUTE_DESCRIPTION =
	'three.ws Forge — pay-per-call text→3D and image→3D generation for autonomous ' +
	`agents. Turn a text prompt (or up to ${FORGE_MAX_VIEWS} reference photos of one object) into ` +
	'a production-ready GLB mesh for game assets, NFT collections, 3D scenes, and ' +
	'product visualization — the only real 3D generation on any agent marketplace. ' +
	`Three quality tiers in USDC: draft $${DRAFT_USD} (fast low-poly blockout), ` +
	`standard $${STANDARD_USD} (balanced detail, the default), high $${HIGH_USD} ` +
	'(maximum geometry + PBR textures). Pay autonomously in USDC on Solana mainnet — ' +
	'no API key, no account, no signup. Returns a job token you poll for FREE at ' +
	'GET /api/forge?job=<id>; draft prompts often finish inline and hand back the GLB ' +
	'url with status:"done". New here? Start on the free keyless draft lane at ' +
	'POST /api/3d/generate, then upgrade to a paid tier for standard/high quality or ' +
	'image→3D.';

// Example request body surfaced in the discovery UI's "try it" panel.
export const FORGE_INPUT_EXAMPLE = Object.freeze({
	prompt: 'a brass steampunk owl, full body',
	tier: 'standard',
	aspect_ratio: '1:1',
});

// Request schema. Complete enough that an agent can call the endpoint from the
// schema alone: the text prompt, the reference-image (image→3D) mode, the tier
// selector, and the aspect ratio. The internal health-check canary (mode/type)
// is intentionally omitted — it is an ops probe, not part of the buyer-facing
// generation contract, and advertising it only clutters the listing.
export const FORGE_INPUT_SCHEMA = Object.freeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	description:
		'Provide exactly one of prompt (text→3D) or image_urls (image→3D). tier and ' +
		'aspect_ratio are optional; tier defaults to "standard".',
	properties: {
		prompt: {
			type: 'string',
			minLength: 3,
			maxLength: 1000,
			description: 'Describe one subject for text→3D. Omit when supplying image_urls.',
		},
		image_urls: {
			type: 'array',
			items: { type: 'string', format: 'uri' },
			minItems: 1,
			maxItems: FORGE_MAX_VIEWS,
			description:
				`Up to ${FORGE_MAX_VIEWS} public https reference views of one object for image→3D. ` +
				'Omit when supplying a prompt.',
		},
		tier: {
			type: 'string',
			enum: ['draft', 'standard', 'high'],
			default: 'standard',
			description:
				`Quality/price tier: draft $${DRAFT_USD} (low-poly), standard $${STANDARD_USD} ` +
				`(default), high $${HIGH_USD} (PBR textures). The 402 quotes the price for the ` +
				'requested tier.',
		},
		aspect_ratio: {
			type: 'string',
			enum: [...FORGE_ASPECT_RATIOS],
			default: '1:1',
			description: 'Aspect ratio of the synthesized reference view for text→3D.',
		},
	},
});

// Example response. Mirrors exactly what the handler returns for an async job
// (the free NVIDIA NIM lane accepting a text prompt): a signed poll token, the
// free poll_url, and the resolved tier/backend/price.
export const FORGE_OUTPUT_EXAMPLE = Object.freeze({
	job_id: 'f1.eyJwIjoibnZpZGlhIn0.sig',
	status: 'queued',
	poll_url: '/api/forge?job=f1.eyJwIjoibnZpZGlhIn0.sig',
	mode: 'text_to_3d',
	tier: 'standard',
	backend: 'nvidia',
	eta_seconds: 22,
	price_usdc: '0.15',
});

// Response schema. `status` is the only guaranteed field: a queued job carries
// job_id + poll_url; a job that finishes inside the submit window (the free NIM
// lane, typical for draft) carries glb_url with status:"done" and a null job_id.
export const FORGE_OUTPUT_SCHEMA = Object.freeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['status'],
	properties: {
		job_id: {
			type: ['string', 'null'],
			description: 'Poll this on GET /api/forge?job=<id>. Null when the model finished inline.',
		},
		status: { type: 'string', description: '"queued" (poll it) or "done" (glb_url is ready).' },
		poll_url: {
			type: ['string', 'null'],
			description: 'Free, provider-aware status endpoint. Null on inline completion.',
		},
		glb_url: {
			type: 'string',
			description: 'The finished GLB — present only when status is "done".',
		},
		mode: { type: 'string', enum: ['text_to_3d', 'image_to_3d'] },
		tier: { type: 'string' },
		backend: { type: 'string' },
		eta_seconds: { type: 'integer' },
		price_usdc: { type: 'string' },
	},
});

// The complete v2 bazaar discovery block — `{ discoverable, info, schema }`.
// This is the SINGLE object the live 402 challenge (as ROUTE_BAZAAR) and the
// api/wk.js discovery mirror both advertise, so the CDP Bazaar / agentic.market
// / x402scan see byte-identical input+output schemas and examples in both
// places. `info.output` carries the example; the full input AND output JSON
// Schemas live in `schema` (built by buildBazaarSchema) so an agent can both
// call the endpoint and parse its response from the listing alone.
export const FORGE_BAZAAR = Object.freeze({
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', bodyType: 'json', body: FORGE_INPUT_EXAMPLE },
		output: { type: 'json', example: FORGE_OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodyType: 'json',
		bodySchema: FORGE_INPUT_SCHEMA,
		outputSchema: FORGE_OUTPUT_SCHEMA,
	}),
});
