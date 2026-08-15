// GET /api/v1/market/intel: recent narrative / market intelligence items.
//
// Unified-API surface over the aixbt bridge (api/_lib/aixbt.js). The shared
// upstream key is metered per-deployment, so on top of the gateway's
// per-principal budget this also consumes the global aixbt ceiling: one caller
// (or many) can't drain the shared key.

import { defineEndpoint, fail } from '../../_lib/gateway.js';
import { getIntel, aixbtEnabled, mapAixbtFailure } from '../../_lib/aixbt.js';
import { limits } from '../../_lib/rate-limit.js';

export default defineEndpoint({
	name: 'v1.market.intel',
	method: 'GET',
	auth: 'optional',
	scope: 'agents:read',
	handler: async ({ query }) => {
		// Throw the platform's canonical missing-env error (matches wrap()'s
		// `missingEnv` regex in api/_lib/http.js) so the client actually gets
		// "this endpoint is not configured on this deployment", a hand-rolled
		// fail(503, 'not_configured', <message>) instead falls into wrap's
		// generic sanitized-5xx branch and the message never reaches the caller.
		if (!aixbtEnabled()) throw new Error('Missing required env var: AIXBT_API_KEY');

		const g = await limits.aixbtGlobal();
		if (!g.success) fail(429, 'rate_limited', 'market intelligence is busy, retry shortly');

		let result;
		try {
			result = await getIntel({
				limit: query.limit,
				category: query.category,
				chain: query.chain,
			});
		} catch (err) {
			// Shared classifier (api/_lib/aixbt.js), the same one /api/aixbt/*
			// answers through: an upstream credential rejection becomes a 503
			// deployment fault instead of a 401 that reads as "your key is bad" on
			// a door that takes no client credential. An unclassified fault is
			// rethrown so wrap() sanitizes it.
			const mapped = mapAixbtFailure(err);
			if (!mapped) throw err;
			fail(mapped.status, mapped.code, mapped.message);
		}
		return { intel: result.intel, pagination: result.pagination, source: 'aixbt' };
	},
});
