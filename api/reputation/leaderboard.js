/**
 * GET /api/reputation/leaderboard?limit=20
 *
 * The platform's real leaderboard of TRUSTED agents, ranked by the same
 * non-gameable wallet-trust score the badge shows, computed entirely from real
 * ledger + chain activity (api/_lib/trust/wallet-reputation.js). Unlike a
 * follower count, every rank here is backed by money and time and is fully
 * auditable: each row links straight to the agent's breakdown.
 *
 * Candidate pool = public agents with ANY real footprint (ledger activity, an
 * on-chain identity, or a launched coin) so we never burn cycles scoring empty
 * agents. Scoring is the expensive part (one reputation read per candidate), so
 * the pool is capped at POOL and, because the candidate set is already larger
 * than that cap, ordered by settled tip volume: the strongest candidates are
 * always scored and the same request always sees the same pool. An unordered
 * `limit` would hand Postgres an arbitrary slice, so the true #1 could vanish
 * from the board between two identical requests. We score that pool, drop the
 * honest "new" agents (no track record), and return the top `limit` by score.
 * Cached 5 min, because trust moves slowly.
 */

import { cors, json, method, wrap, rateLimited, error } from '../_lib/http.js';
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
	// A non-numeric limit used to survive as NaN all the way to slice(0, NaN),
	// which returns nothing: the caller paid for a full scoring pass and got an
	// empty board indistinguishable from "no trusted agents". Reject it up front,
	// with the same message the SDK's own client-side guard uses; numeric values
	// keep the SDK's clamp semantics so a caller never gets an error for asking
	// for more rows than exist.
	const rawLimit = (p.get('limit') || '').trim();
	// Number('') and Number(' ') are both 0, which would silently clamp a blank
	// parameter to a one-row board; a blank means "unspecified", so it defaults.
	const asked = rawLimit === '' ? 20 : Number(rawLimit);
	if (!Number.isFinite(asked)) {
		return error(res, 400, 'bad_request', 'limit must be a number between 1 and 50');
	}
	const limit = Math.min(50, Math.max(1, Math.trunc(asked)));

	const cacheKey = `walletrep:leaderboard:v2:${limit}`;
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

	// Candidate pool: public agents with a real footprint, strongest first.
	// A DB failure here is NOT swallowed: an empty board and a broken board look
	// identical to a client, so the error propagates and wrap() answers 503 with a
	// ref instead of publishing "nobody on this platform is trusted".
	const rows = await sql`
		select
			i.id, i.name,
			i.meta->>'solana_address' as solana_address,
			a.thumbnail_key as avatar_thumbnail_key,
			a.visibility    as avatar_visibility,
			(
				select coalesce(sum(e.usd), 0)
				from agent_custody_events e
				where e.agent_id = i.id and e.event_type = 'tip' and e.status in ('confirmed', 'ok')
			) as settled_usd
		from agent_identities i
		left join avatars a on a.id = i.avatar_id and a.deleted_at is null
		where i.deleted_at is null and i.is_public = true
		  and (
		    exists (select 1 from agent_custody_events e where e.agent_id = i.id)
		    or i.erc8004_agent_id is not null
		    or exists (select 1 from pump_agent_mints m where m.agent_id = i.id)
		  )
		order by settled_usd desc nulls last, i.id
		limit ${POOL}
	`;

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
				agent_url: `https://three.ws/agents/${encodeURIComponent(id)}`,
				breakdown_url: `https://three.ws/agents/${encodeURIComponent(id)}/wallet#reputation`,
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
