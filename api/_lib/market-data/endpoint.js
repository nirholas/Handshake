// Market Data API endpoint factory — builds each live /api/x402/market-*
// paidEndpoint from its registry entry (./registry.js) and fetcher (./fetch.js).
//
// The thin route files in api/x402/market-*.js are one line each:
//   export default marketEndpoint('market-coins');
//
// The 402 challenge, bazaar discovery block, pricing (env-overridable via
// X402_PRICE_MARKET_<CATEGORY>), and access-control bypass all follow the
// standard paid-endpoint rail (api/_lib/x402-paid-endpoint.js) — identical to
// token-intel and the other cataloged services, so facilitators see one
// consistent contract across the whole storefront.

import { paidEndpoint } from '../x402-paid-endpoint.js';
import { buildBazaarSchema } from '../x402-spec.js';
import { installAccessControl } from '../x402/access-control.js';
import { withService } from '../x402/bazaar-helpers.js';
import { priceFor } from '../x402-prices.js';
import { MARKET_CATEGORY_BY_SLUG, MARKET_SERVICE_NAME } from './registry.js';
import { MARKET_FETCHERS } from './fetch.js';

// Registry and fetchers must cover exactly the same slugs — a mismatch is a
// wiring bug that should fail at module load (deploy time), not at request time.
for (const slug of MARKET_CATEGORY_BY_SLUG.keys()) {
	if (typeof MARKET_FETCHERS[slug] !== 'function') {
		throw new Error(`market-data: registry entry "${slug}" has no fetcher`);
	}
}
for (const slug of Object.keys(MARKET_FETCHERS)) {
	if (!MARKET_CATEGORY_BY_SLUG.has(slug)) {
		throw new Error(`market-data: fetcher "${slug}" has no registry entry`);
	}
}

export function marketEndpoint(slug) {
	const entry = MARKET_CATEGORY_BY_SLUG.get(slug);
	if (!entry) throw new Error(`market-data: unknown category "${slug}"`);
	const fetcher = MARKET_FETCHERS[slug];
	const route = `/api/x402/${slug}`;

	return paidEndpoint({
		route,
		method: 'GET',
		priceAtomics: priceFor(slug, entry.priceAtomics),
		networks: ['solana', 'base'],
		description: entry.description,
		bazaar: {
			description: entry.description,
			useCases: entry.useCases,
			input: { type: 'query', example: entry.inputExample, schema: entry.inputSchema },
			output: { type: 'json', example: entry.outputExample },
			schema: buildBazaarSchema({ method: 'GET', queryParamsSchema: entry.inputSchema }),
		},
		service: withService({ serviceName: MARKET_SERVICE_NAME, tags: entry.tags }),
		accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
		async handler({ req }) {
			const params = new URL(req.url, 'http://x').searchParams;
			return fetcher(params);
		},
	});
}
