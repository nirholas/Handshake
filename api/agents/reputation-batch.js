// GET|POST /api/agents/reputation-batch?ids=a,b,c
//
// Compact wallet-trust scores for a list of agents, so discovery surfaces
// (trending, marketplace cards, the galaxy) can render a reputation badge on
// every agent without N round-trips. Returns only the public, list-relevant
// fields per agent — never the owner-only guidance block. Each score is the same
// real computation as the per-agent endpoint, in `lite` mode (skips the optional
// EVM registry RPC) so a page of cards stays fast while every number stays real.

import { cors, json, error, method, wrap, rateLimited, readBody } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getRedis } from '../_lib/redis.js';
import { getAgentReputation } from '../_lib/trust/wallet-reputation.js';

const MAX_IDS = 60;
const CACHE_TTL_S = 180;

function compact(rep) {
	return {
		agent_id: rep.agent_id,
		score: rep.score,
		max: rep.max,
		tier: rep.tier,
		tierLabel: rep.tierLabel,
		accent: rep.accent,
		isNew: rep.isNew,
		totals: rep.totals,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.agentProfileIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let ids = [];
	if (req.method === 'POST') {
		const body = await readBody(req, 8192).catch(() => null);
		let parsed = null;
		try {
			parsed = body ? JSON.parse(body) : null;
		} catch {
			return error(res, 400, 'validation_error', 'invalid JSON body');
		}
		ids = Array.isArray(parsed?.ids) ? parsed.ids : [];
	} else {
		const url = new URL(req.url, 'http://x');
		ids = (url.searchParams.get('ids') || '').split(',');
	}

	ids = [...new Set(ids.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, MAX_IDS);
	if (!ids.length) return json(res, 200, { data: {} });

	const redis = await getRedis();

	const settled = await Promise.allSettled(
		ids.map(async (id) => {
			const cacheKey = `walletrep:lite:v1:${id}`;
			if (redis) {
				try {
					const cached = await redis.get(cacheKey);
					if (cached) return [id, cached];
				} catch {
					/* miss */
				}
			}
			const rep = await getAgentReputation(id, { lite: true });
			const small = compact(rep);
			if (redis && !rep.partial) {
				redis.set(cacheKey, small, { ex: CACHE_TTL_S }).catch(() => {});
			}
			return [id, small];
		}),
	);

	const data = {};
	for (const r of settled) {
		if (r.status === 'fulfilled' && r.value) {
			const [id, val] = r.value;
			data[id] = val;
		}
	}

	return json(res, 200, { data }, { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' });
});
