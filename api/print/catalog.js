// GET /api/print/catalog: the Materialize price list, as data.
//
// Everything a buyer or an agent needs to build a valid quote request: the
// materials with their real constraints (minimum wall, build volume, lead time),
// the finishes and what they add, the size presets and the real-world scale
// references the /materialize slider measures against, and the shipping zones.
//
// Free and keyless like the rest of the 3D API surface. An agent can read this,
// pick a material its mesh actually fits, and call /api/print/quote without ever
// guessing. Owner-only fields (the declared margin, the sourcing citations behind
// each rate) are stripped here, so the file on disk stays the single source of
// truth without leaking how it was tuned.
//
// Prices are quoted and settled in USDC on Solana. There is no card processor,
// and the copy says so rather than apologising for it.

import { cors, json, method, wrap } from '../_lib/http.js';
import { publicCatalog } from '../_lib/print/quote.js';

// The catalog is a checked-in file, not a query. A long public cache is correct
// and the deploy that changes a price is what invalidates it.
const CACHE_CONTROL = 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const catalog = publicCatalog();
	return json(
		res,
		200,
		{
			version: catalog.version,
			currency: catalog.currency,
			chain: catalog.chain,
			pricing: catalog.pricing,
			materials: catalog.materials,
			sizePresets: catalog.sizePresets,
			scaleReferences: catalog.scaleReferences,
			shipping: catalog.shipping,
		},
		{ 'cache-control': CACHE_CONTROL },
	);
});
