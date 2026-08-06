// Shared copy for the public discovery manifest at
// public/.well-known/ai-plugin.json (the legacy ChatGPT-plugins format, read
// today by third-party agents, crawlers, and plugin directories).
//
// Why this lives in its own module rather than inline in
// scripts/build-discovery-cards.mjs: that generator runs on every prebuild, so
// a hand-edit of the manifest it owns is silently reverted on the next deploy.
// Keeping the strings here lets tests/wellknown-manifests.test.js bind the
// committed manifest to exactly what the generator will write, so the two can
// never drift apart again.
//
// The free/paid split below is the whole point. three.ws runs a free, keyless
// 3D lane (the surface the ChatGPT app and the custom GPT use) alongside a
// separate, optional pay-per-call catalog. A reader of this manifest must be
// able to tell which is which in a single pass, and must never come away
// thinking the 3D generation lane costs anything.

/** 512x512 owned-IP brand mark. Same asset the app-store listings ship. */
export const PLUGIN_LOGO_URL = 'https://three.ws/pwa-512x512.png';

/** Canonical legal URL (no .html suffix), matching the served schemas. */
export const PLUGIN_LEGAL_URL = 'https://three.ws/legal/tos';

/** The free 3D lane's own OpenAPI: auth-free, price-free, self-contained. */
export const FREE_3D_SCHEMA_URL = 'https://three.ws/.well-known/3d-studio-openapi.yaml';

/** Machine-readable catalog for the separate, optional paid services. */
export const PAID_CATALOG_URL = 'https://three.ws/.well-known/x402.json';

/**
 * Human- and model-facing descriptions for ai-plugin.json.
 *
 * @param {number} paidServiceCount live paid services projected from the catalog
 * @returns {{ description_for_human: string, description_for_model: string }}
 */
export function pluginDescriptions(paidServiceCount) {
	if (!Number.isInteger(paidServiceCount) || paidServiceCount < 1) {
		throw new Error(`pluginDescriptions needs a positive service count, got ${paidServiceCount}`);
	}
	return {
		description_for_human:
			'Free, keyless 3D avatar and world generation, plus an optional paid API catalog for agents.',
		description_for_model:
			'three.ws has two clearly separate surfaces, and every 3D request belongs on the free one. ' +
			'FREE and keyless, with no account, no API key and nothing to pay: text-to-3D model and avatar ' +
			`generation at POST https://three.ws/api/3d/studio (OpenAPI ${FREE_3D_SCHEMA_URL}), the same ` +
			'generation lane over MCP at https://three.ws/api/mcp-studio, the browser model viewer, the ' +
			'augmented-reality launcher at /api/ar, and the read-only market data endpoints indexed at ' +
			`/api/crypto. PAID and entirely optional: a separate catalog of ${paidServiceCount} pay-per-call ` +
			'services under /api/x402/*, settled with the x402 protocol (HTTP 402, USDC on Solana and Base), ' +
			'covering market data, DeFi, news sentiment, agent infrastructure, and production 3D asset ' +
			`pipelines that go beyond the free lane. Prices and schemas: ${PAID_CATALOG_URL}. Nothing in the ` +
			'free lane requires or accepts payment.',
	};
}
