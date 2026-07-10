// GET /api/agents/:id/reputation
//
// The agent's unified wallet trust score — a real, non-gameable 0–100 credibility
// signal derived entirely from real ledger + on-chain activity. The score, its
// per-pillar breakdown, the evidence links, and (for the owner) actionable
// guidance are computed by api/_lib/trust/wallet-reputation.js. Public read: the
// score is a trust signal others rely on, so owner and visitor see the same
// number; only the owner additionally receives the `guidance` block.

import { cors, json, error, method, wrap, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { getRedis } from '../../_lib/redis.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { sql } from '../../_lib/db.js';
import { getAgentReputation } from '../../_lib/trust/wallet-reputation.js';
import { saveReputation } from '../../_lib/trust/reputation-store.js';

const CACHE_TTL_S = 180; // 3 minutes — score is derived, not real-time critical.

async function resolveUserId(req) {
	try {
		const session = await getSessionUser(req);
		if (session) return session.id;
		const bearer = await authenticateBearer(extractBearer(req));
		if (bearer) return bearer.userId;
	} catch {
		/* anonymous */
	}
	return null;
}

export const handleReputation = wrap(async (req, res, agentId) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.agentProfileIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const cacheKey = `walletrep:v1:${agentId}`;
	const redis = await getRedis();
	let result = null;

	if (redis) {
		try {
			const cached = await redis.get(cacheKey);
			if (cached) {
				result = cached;
				res.setHeader('X-Cache', 'HIT');
			}
		} catch {
			/* cache miss */
		}
	}

	if (!result) {
		try {
			result = await getAgentReputation(agentId);
		} catch (err) {
			if (err.status === 404) return error(res, 404, 'not_found', 'agent not found');
			throw err;
		}
		// Only cache a complete result — never persist a degraded/partial score.
		if (redis && !result.partial) {
			redis.set(cacheKey, result, { ex: CACHE_TTL_S }).catch(() => {});
		}
		// Warm the durable store too, so the access layer and the reputation-weighted
		// leaderboard read a fresh row without waiting for the recompute cron.
		if (!result.partial) saveReputation(result).catch(() => {});
		res.setHeader('X-Cache', 'MISS');
	}

	// Owner-only guidance: strip it for everyone else.
	const userId = await resolveUserId(req);
	let isOwner = false;
	if (userId) {
		const [own] = await sql`
			select 1 from agent_identities where id = ${agentId} and user_id = ${userId} and deleted_at is null limit 1
		`.catch(() => []);
		isOwner = Boolean(own);
	}

	const payload = { ...result, is_owner: isOwner };
	if (!isOwner) delete payload.guidance;

	return json(res, 200, payload, { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' });
});
