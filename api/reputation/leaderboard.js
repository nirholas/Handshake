/**
 * GET /api/reputation/leaderboard?limit=20&network=mainnet
 *
 * The platform's real leaderboard of TRUSTED agents — ranked by the same
 * non-gameable wallet-trust score the badge shows, computed entirely from real
 * ledger + chain activity (api/_lib/trust/wallet-reputation.js). Unlike a
 * follower count, every rank here is backed by money and time and is fully
 * auditable: each row links straight to the agent's breakdown.
 *
 * Candidate pool = public agents with ANY real footprint (ledger activity, an
 * on-chain identity, or a launched coin) so we never burn cycles scoring empty
 * agents. We score that pool, drop the honest "new" agents (no track record),
 * and return the top `limit` by score. Cached 5 min — trust moves slowly.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { thumbnailUrl } from '../_lib/r2.js';
import { getRedis } from '../_lib/redis.js';
import { scoreAgentsLite } from '../_lib/trust/wallet-reputation.js';

const POOL = 90; // max candidates scored per request

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const limit = Math.min(50, Math.max(1, Number(p.get('limit') || 20)));

	const cacheKey = `walletrep:leaderboard:v1:${limit}`;
	const redis = await getRedis();
	if (redis) {
		try {
			const cached = await redis.get(cacheKey);
			if (cached) {
				res.setHeader('X-Cache', 'HIT');
				return json(res, 200, cached, { 'cache-control': 'public, max-age=120, s-maxage=300' });
			}
		} catch {
			/* miss */
		}
	}

	// Candidate pool — public agents with a real footprint.
	const rows = await sql`
		select
			i.id, i.name,
			i.meta->>'solana_address' as solana_address,
			a.thumbnail_key as avatar_thumbnail_key,
			a.visibility    as avatar_visibility
		from agent_identities i
		left join avatars a on a.id = i.avatar_id and a.deleted_at is null
		where i.deleted_at is null and i.is_public = true
		  and (
		    exists (select 1 from agent_custody_events e where e.agent_id = i.id)
		    or i.erc8004_agent_id is not null
		    or exists (select 1 from pump_agent_mints m where m.agent_id = i.id)
		  )
		limit ${POOL}
	`.catch(() => []);

	const byId = new Map(rows.map((r) => [r.id, r]));
	const reps = await scoreAgentsLite([...byId.keys()]);

	const ranked = [...reps.entries()]
		.filter(([, rep]) => rep && !rep.isNew)
		.sort((a, b) => b[1].score - a[1].score)
		.slice(0, limit)
		.map(([id, rep], idx) => {
			const r = byId.get(id) || {};
			const thumbPub = r.avatar_visibility === 'public' || r.avatar_visibility === 'unlisted';
			return {
				rank: idx + 1,
				id,
				name: r.name || null,
				avatar_thumbnail_url: r.avatar_thumbnail_key && thumbPub ? thumbnailUrl(r.avatar_thumbnail_key) : null,
				solana_address: typeof r.solana_address === 'string' ? r.solana_address : null,
				score: rep.score,
				tier: rep.tier,
				tier_label: rep.tierLabel,
				totals: rep.totals,
				agent_url: `https://three.ws/agent/${encodeURIComponent(id)}`,
				breakdown_url: `https://three.ws/agent/${encodeURIComponent(id)}/wallet#reputation`,
			};
		});

	const payload = {
		generated_at: new Date().toISOString(),
		count: ranked.length,
		scored: reps.size,
		agents: ranked,
	};

	if (redis && ranked.length) {
		redis.set(cacheKey, payload, { ex: 300 }).catch(() => {});
	}
	res.setHeader('X-Cache', 'MISS');
	return json(res, 200, payload, { 'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=120' });
});
