// GET /api/v1/pump/launches?limit=24&offset=0&network=mainnet&agent_id=<uuid>&min_tier=<tier>
//
// Free, public, paginated feed of every coin launched THROUGH three.ws (a
// pump_agent_mints row), joined with the launching agent: the platform's own
// launch directory, distinct from a generic pump.fun-wide new-mint feed. Powers
// the /launches page and the agent-detail "launched coins" card; registered
// here under the versioned, cataloged /api/v1 surface so agents can discover
// three.ws's own launch history via GET /api/v1.
//
// The query lives in api/_lib/pump-agent-launches.js `queryAgentLaunches`,
// shared with GET /api/pump/launches (api/pump/[action].js): one query, two
// doors, so the page and this endpoint can never drift.

import { defineEndpoint, fail } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { isUuid } from '../../_lib/validate.js';
import { queryAgentLaunches, TIER_RANK } from '../../_lib/pump-agent-launches.js';

const MAX_LIMIT = 100;

export default defineEndpoint({
	name: 'v1.pump.launches',
	method: 'GET',
	auth: 'public',
	handler: async ({ req, res, query }) => {
		// Dedicated-shared budget with the sibling free pump.fun v1 reads: this
		// hits the database on a cache miss, so it caps a scripted enumeration flood.
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'pump launches is capped at 60 requests/min per IP');

		const rawLimit = Number(query.limit);
		const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 24));
		const rawOffset = Number(query.offset);
		const offset = Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0);
		const network = query.network === 'devnet' ? 'devnet' : 'mainnet';

		const agentId = typeof query.agent_id === 'string' ? query.agent_id.trim() : '';
		if (agentId && !isUuid(agentId)) fail(400, 'validation_error', 'agent_id must be a uuid');

		const minTierParam = typeof query.min_tier === 'string' ? query.min_tier.trim() : '';
		if (minTierParam && !(minTierParam in TIER_RANK)) {
			fail(400, 'validation_error', `min_tier must be one of: ${Object.keys(TIER_RANK).join(', ')}`);
		}

		const { launches, has_more } = await queryAgentLaunches({
			network,
			agentId: agentId || null,
			minTierParam,
			offset,
			limit,
		});

		// Fresh launches land continuously; a short CDN window keeps polling agents
		// current without hammering the database.
		res.setHeader('cache-control', 'public, max-age=15, s-maxage=15');
		return { launches, has_more, offset, limit, network, min_tier: minTierParam || null };
	},
});
