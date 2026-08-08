// Pricing catalog — the single source of truth for every paid action on the
// platform, denominated in USD and settled in $THREE.
//
// WHY THIS EXISTS: before this file, prices lived scattered across endpoints
// (forge-tiers.js, per-endpoint x402 challenges) and in two currencies. The
// platform now charges in ONE currency, $THREE, through ONE rail
// (api/_lib/token: quote → settle). Each action here names:
//   • usd     — the retail price in USD (the quote unit; $THREE is the settle
//               unit, converted at the live price by the token rail). `null`
//               means the price is supplied per-call (auctions, variable mints).
//   • policy  — a key of SPLIT_POLICIES (api/_lib/token/config.js). No policy
//               burns; every spend routes to treasury + holder rewards (+ seller
//               on a marketplace sale). See the economy-policy note there.
//   • category— for grouping in the /three economy page + dashboards.
//
// Forge tier prices are READ from forge-tiers.js (their existing source of truth)
// rather than copied, so a tier price is defined in exactly one place.
//
// This module is pure (no network, no DB, no env beyond forge-tiers' constants)
// so it is safe to import on the client for display and on the server for pricing.

import { TIERS, priceUsdcForTier, priceUsdcForOutput } from '../forge-tiers.js';

// ── Split-policy aliases ───────────────────────────────────────────────────────
// Names map 1:1 to SPLIT_POLICIES keys; aliased here so call sites read in
// product terms and a policy rename is a one-line change.
export const POLICY = Object.freeze({
	CONSUMPTION: 'consumption', // pay-per-use compute → treasury + rewards
	MARKETPLACE: 'marketplace_sale', // creator/seller sale → seller + treasury + rewards
	SCARCITY: 'scarcity_mint', // limited drops / auctions / pay-to-mint → treasury + rewards
});

// Forge: draft is FREE (the NVIDIA NIM lane). Standard/High are paid in $THREE.
// Prices come from forge-tiers.js so they're never duplicated.
const FORGE_STANDARD_USD = Number(priceUsdcForTier(TIERS.standard)); // 0.15
const FORGE_HIGH_USD = Number(priceUsdcForTier(TIERS.high)); // 0.50
// Game-Ready export price, read from OUTPUTS.gameready (its source of truth) so
// it isn't duplicated. The export drives the remesh worker (real GPU cost) to turn
// any model into an engine-ready asset — a deliverable, billed per export.
const FORGE_GAMEREADY_USD = Number(priceUsdcForOutput('gameready')); // 0.10

// Premium TTS (ElevenLabs): retail USD per 1,000 synthesized characters on the
// platform key. Every platform-key synthesis is charged (no free lane; owner
// policy 2026-08-06). Upstream Flash v2.5 cost is roughly $0.11/1k chars at the
// Creator tier; $0.30 retail keeps margin for the settle rail. Cache hits and
// BYOK requests bypass the charge entirely (api/tts/eleven.js).
export const TTS_ELEVEN_USD_PER_1K = 0.3;

// OpenAI TTS (gpt-4o-mini-tts / tts-1): retail USD per 1,000 synthesized
// characters on the platform key. Upstream is ~$0.015/1k chars; $0.03 retail
// keeps the same margin shape as the ElevenLabs rung. Same policy applies —
// a vendor-billed lane never has a free tier (owner policy 2026-08-06), so
// every platform-key OpenAI synthesis is metered to the caller's credits.
export const TTS_OPENAI_USD_PER_1K = 0.03;

// ── The catalog ─────────────────────────────────────────────────────────────────
// id → { label, category, policy, usd }. `usd: null` ⇒ price set per-call.
export const CATALOG = Object.freeze({
	// ── Generation & compute (real GPU / vendor cost) — POLICY.CONSUMPTION ──────
	'forge.standard': {
		label: 'Forge — Standard generation',
		category: 'generation',
		policy: POLICY.CONSUMPTION,
		usd: FORGE_STANDARD_USD,
	},
	'forge.high': {
		label: 'Forge — High generation (PBR)',
		category: 'generation',
		policy: POLICY.CONSUMPTION,
		usd: FORGE_HIGH_USD,
	},
	'forge.gameready': {
		label: 'Forge — Game-Ready export (Unity/Unreal)',
		category: 'generation',
		policy: POLICY.CONSUMPTION,
		usd: FORGE_GAMEREADY_USD,
	},
	'mcp3d.text_to_3d': {
		label: 'MCP-3D — text → 3D',
		category: 'generation',
		policy: POLICY.CONSUMPTION,
		usd: FORGE_STANDARD_USD,
	},
	'mcp3d.image_to_3d': {
		label: 'MCP-3D — image → 3D',
		category: 'generation',
		policy: POLICY.CONSUMPTION,
		usd: FORGE_STANDARD_USD,
	},
	'mcp3d.auto_rig': {
		label: 'MCP-3D — auto-rig',
		category: 'generation',
		policy: POLICY.CONSUMPTION,
		usd: 0.1,
	},
	'mcp3d.stylize': {
		label: 'MCP-3D — stylize',
		category: 'generation',
		policy: POLICY.CONSUMPTION,
		usd: 0.1,
	},
	'mcp3d.retexture': {
		label: 'MCP-3D — retexture',
		category: 'generation',
		policy: POLICY.CONSUMPTION,
		usd: FORGE_STANDARD_USD,
	},
	'voice.clone': {
		label: 'Voice Lab — custom voice clone',
		category: 'generation',
		policy: POLICY.CONSUMPTION,
		usd: 0.5,
	},
	'tts.eleven': {
		label: 'Voice: premium TTS synthesis (per 1k characters)',
		category: 'generation',
		policy: POLICY.CONSUMPTION,
		usd: null, // per-call: characters * TTS_ELEVEN_USD_PER_1K / 1000
	},
	'tts.openai': {
		label: 'Voice: OpenAI TTS synthesis (per 1k characters)',
		category: 'generation',
		policy: POLICY.CONSUMPTION,
		usd: null, // per-call: characters * TTS_OPENAI_USD_PER_1K / 1000
	},
	'selfie.reconstruct': {
		label: 'Selfie → Avatar reconstruction',
		category: 'generation',
		policy: POLICY.CONSUMPTION,
		usd: 0.25,
	},
	'granite.forecast': {
		label: 'Granite Oracle — forecast',
		category: 'data',
		policy: POLICY.CONSUMPTION,
		usd: 0.05,
	},
	'granite.vision': {
		label: 'Granite Vision — image → identity',
		category: 'data',
		policy: POLICY.CONSUMPTION,
		usd: 0.05,
	},
	'granite.proof': {
		label: 'Granite Proof — notarized forecast',
		category: 'data',
		policy: POLICY.CONSUMPTION,
		usd: 0.1,
	},

	// ── Scarcity & collectibles — POLICY.SCARCITY (price often per-call) ─────────
	'name.auction': {
		label: 'Rare *.threews.sol name',
		category: 'scarcity',
		policy: POLICY.SCARCITY,
		usd: null, // set per name by rarity tier (see api/threews/auction.js)
	},
	'collectible.mint': {
		label: 'Limited-edition collectible mint',
		category: 'scarcity',
		policy: POLICY.SCARCITY,
		usd: null, // set per drop
	},
	'genesis.id': {
		label: 'Genesis / numbered agent ID',
		category: 'scarcity',
		policy: POLICY.SCARCITY,
		usd: null, // set per number rarity
	},
	'land.plot': {
		label: 'City land plot',
		category: 'scarcity',
		policy: POLICY.SCARCITY,
		usd: null, // set per plot
	},

	// ── Creator marketplace — POLICY.MARKETPLACE (requires a seller wallet) ──────
	'skill.call': {
		label: 'Skill call (creator-priced)',
		category: 'marketplace',
		policy: POLICY.MARKETPLACE,
		usd: null,
	},
	'animation.purchase': {
		label: 'Animation purchase',
		category: 'marketplace',
		policy: POLICY.MARKETPLACE,
		usd: null,
	},
	'avatar.purchase': {
		label: 'Avatar purchase',
		category: 'marketplace',
		policy: POLICY.MARKETPLACE,
		usd: null,
	},
	'asset.download': {
		label: 'Asset download',
		category: 'marketplace',
		policy: POLICY.MARKETPLACE,
		usd: null,
	},
	'collectible.resale': {
		label: 'Collectible resale (creator royalty)',
		category: 'marketplace',
		policy: POLICY.MARKETPLACE,
		usd: null,
	},
});

/** Look up a catalog entry. Throws a typed 404 if the action id is unknown. */
export function catalogEntry(actionId) {
	const e = CATALOG[actionId];
	if (!e) {
		const err = new Error(`unknown paid action: ${actionId}`);
		err.status = 404;
		err.code = 'unknown_action';
		throw err;
	}
	return e;
}

/**
 * Resolve the USD price for an action.
 * @param {string} actionId             a key of CATALOG
 * @param {object} [opts]
 * @param {number} [opts.usd]           per-call price for variable actions (usd:null)
 * @param {number} [opts.discountBps]   holder-tier fee discount in bps (0–10000),
 *                                       applied only to fixed-price actions; ignored
 *                                       for marketplace/scarcity prices the seller set.
 * @returns {{ actionId, label, category, policy, usd }}
 */
export function priceForAction(actionId, { usd: usdOverride, discountBps = 0 } = {}) {
	const entry = catalogEntry(actionId);
	let usd = entry.usd;
	if (usd == null) {
		// Variable-price action: the caller MUST supply the per-call price.
		if (!(Number(usdOverride) > 0)) {
			const err = new Error(`action ${actionId} requires a per-call usd price`);
			err.status = 400;
			err.code = 'price_required';
			throw err;
		}
		usd = Number(usdOverride);
	} else if (discountBps > 0) {
		// Fixed-price action: apply the holder-tier discount. Discount never makes
		// a paid action free — clamp to a 1-cent floor so the rail still settles.
		const clamped = Math.max(0, Math.min(10000, Math.floor(discountBps)));
		usd = Math.max(0.01, Math.round(usd * (10000 - clamped)) / 10000);
	}
	return { actionId, label: entry.label, category: entry.category, policy: entry.policy, usd };
}

/** Public, display-safe view of the catalog (fixed prices only; variable shown as null). */
export function publicCatalog() {
	return Object.entries(CATALOG).map(([id, e]) => ({
		id,
		label: e.label,
		category: e.category,
		policy: e.policy,
		usd: e.usd,
	}));
}
