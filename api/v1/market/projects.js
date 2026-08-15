// GET /api/v1/market/projects — momentum-ranked crypto projects.
//
// Unified-API surface over the aixbt bridge (api/_lib/aixbt.js). Like
// /api/v1/market/intel, this consumes the global aixbt ceiling on top of the
// gateway's per-principal budget so the shared upstream key stays protected.

import { defineEndpoint, fail } from '../../_lib/gateway.js';
import { getProjects, aixbtEnabled, mapAixbtFailure } from '../../_lib/aixbt.js';
import { limits } from '../../_lib/rate-limit.js';

export default defineEndpoint({
	name: 'v1.market.projects',
	method: 'GET',
	auth: 'optional',
	scope: 'agents:read',
	handler: async ({ query }) => {
		// See api/v1/market/intel.js — thrown as the canonical missing-env error
		// so wrap() names it to the client instead of sanitizing the message away.
		if (!aixbtEnabled()) throw new Error('Missing required env var: AIXBT_API_KEY');

		const g = await limits.aixbtGlobal();
		if (!g.success) fail(429, 'rate_limited', 'market intelligence is busy — retry shortly');

		let result;
		try {
			result = await getProjects({
				limit: query.limit,
				page: query.page,
				names: query.names,
				chain: query.chain,
			});
		} catch (err) {
			// See api/v1/market/intel.js — one shared classifier so this door and
			// /api/aixbt/* can never disagree about whose fault a failure is.
			const mapped = mapAixbtFailure(err);
			if (!mapped) throw err;
			fail(mapped.status, mapped.code, mapped.message);
		}
		return { projects: result.projects, pagination: result.pagination, source: 'aixbt' };
	},
});
