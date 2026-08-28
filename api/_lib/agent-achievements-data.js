/**
 * Agent achievements — data loader (the I/O layer).
 * =================================================
 *
 * Gathers every REAL input the pure engine (agent-achievements.js) scores and
 * returns the computed achievement body, Redis-cached. Shared by:
 *   · GET /api/agents/:id/achievements  (the profile panel)
 *   · GET /api/og/agent                  (top badge on the shareable card)
 *   · the reputation leaderboard         (achievement counts per ranked agent)
 *
 * Keeping the gather+cache here (not in the HTTP handler) means every consumer
 * sees the same numbers off the same cache, and a warm entry makes the OG card
 * and leaderboard pay nothing for the live market lookups.
 */

import { sql } from './db.js';
import { getRedis } from './redis.js';
import { computeAchievements, isLaunchGraduated } from './agent-achievements.js';
import { pumpFetchJson } from './pump-feed-fetch.js';

const PUMP_FRONTEND_BASE = 'https://frontend-api-v3.pump.fun';
const CACHE_TTL_S = 120;
const CACHE_KEY = (id) => `agent-achievements:v1:${id}`;
// Cap the live market lookups so a creator with dozens of launches can't fan out
// into dozens of upstream calls per request. Newest 30 covers every milestone in
// practice; older launches that already graduated keep the badge regardless.
const MARKET_LOOKUP_CAP = 30;

/** Live pump.fun coin object for a mint, or null on any failure (best-effort). */
async function fetchCoin(mint) {
	try {
		// Called once per mint for up to thirty mints in a request, so a throttle
		// silently un-awards a batch of achievements. Retrying on the lane's own
		// Retry-After is what keeps that from happening on a busy launch day.
		const resp = await pumpFetchJson(String(new URL(`/coins/${mint}`, PUMP_FRONTEND_BASE)), { timeoutMs: 7000 });
		if (!resp.ok) return null;
		return resp.body;
	} catch {
		return null;
	}
}

/**
 * Load (or compute) an agent's achievements.
 *
 * @param {string} agentId — agent UUID (caller validates the shape)
 * @param {object} [opts]
 * @param {boolean} [opts.fresh] — bypass the Redis read (still writes the cache)
 * @returns {Promise<object|null>} the achievement body, or null if no such agent
 */
export async function loadAgentAchievements(agentId, { fresh = false } = {}) {
	const cacheKey = CACHE_KEY(agentId);
	const redis = await getRedis();

	if (!fresh && redis) {
		try {
			const cached = await redis.get(cacheKey);
			if (cached) return { ...cached, _cache: 'HIT' };
		} catch {
			/* cache miss — recompute */
		}
	}

	const [agent] = await sql`
		SELECT id, name, created_at
		FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return null;

	// Launches + aggregate supporter & burn stats across all of this agent's
	// mints, in parallel — three independent reads.
	const [launchRows, [paymentStats], [burnStats]] = await Promise.all([
		sql`
			SELECT mint, network, created_at
			FROM pump_agent_mints
			WHERE agent_id = ${agentId}
			ORDER BY created_at DESC
		`,
		sql`
			SELECT
				count(*) FILTER (WHERE p.status='confirmed')::int                       AS confirmed_payments,
				count(DISTINCT p.payer_wallet) FILTER (WHERE p.status='confirmed')::int AS unique_payers
			FROM pump_agent_payments p
			JOIN pump_agent_mints m ON m.id = p.mint_id
			WHERE m.agent_id = ${agentId}
		`,
		sql`
			SELECT count(*) FILTER (WHERE b.status='confirmed')::int AS runs
			FROM pump_buyback_runs b
			JOIN pump_agent_mints m ON m.id = b.mint_id
			WHERE m.agent_id = ${agentId}
		`,
	]);

	// Enrich mainnet launches with live market data (graduation + market cap).
	// Devnet launches have no pump.fun market. Capped + parallel + best-effort.
	const mainnet = launchRows.filter((r) => r.network !== 'devnet').slice(0, MARKET_LOOKUP_CAP);
	const coins = await Promise.all(mainnet.map((r) => fetchCoin(r.mint)));
	const marketByMint = new Map();
	mainnet.forEach((r, i) => marketByMint.set(r.mint, coins[i]));

	const launches = launchRows.map((r) => {
		const coin = marketByMint.get(r.mint);
		const mcap = Number(coin?.usd_market_cap);
		return {
			mint: r.mint,
			network: r.network,
			created_at: r.created_at,
			graduated: r.network !== 'devnet' && isLaunchGraduated(coin),
			mcap: Number.isFinite(mcap) ? mcap : 0,
		};
	});

	// Reputation tier — best-effort. The reputation read does on-chain + ledger
	// work, so a failure must never block the achievements: the two reputation
	// badges simply stay locked.
	let reputation = null;
	try {
		const { getAgentReputation } = await import('./trust/wallet-reputation.js');
		const { TIERS } = await import('../../src/shared/agent-financial-reputation.js');
		const rep = await getAgentReputation(agentId, { lite: true });
		if (rep && rep.tier) {
			reputation = {
				tier: rep.tier,
				tierLabel: rep.tierLabel || TIERS[rep.tier]?.label || rep.tier,
				rank: TIERS[rep.tier]?.rank ?? 0,
				score: rep.score ?? null,
			};
		}
	} catch {
		reputation = null;
	}

	const result = computeAchievements({
		agentCreatedAt: agent.created_at,
		launches,
		payments: paymentStats || {},
		burns: burnStats || {},
		reputation,
	});

	const body = {
		agent_id: agent.id,
		name: agent.name,
		...result,
		computed_at: new Date().toISOString(),
	};

	if (redis) {
		try {
			await redis.set(cacheKey, body, { ex: CACHE_TTL_S });
		} catch {
			/* cache write best-effort */
		}
	}
	return body;
}
