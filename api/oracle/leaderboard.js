/**
 * Oracle: agent conviction leaderboard.
 *
 *   GET /api/oracle/leaderboard?network=mainnet&limit=20&min_actions=3
 *
 * Returns agents ranked by Oracle conviction win rate across their full action
 * ledger. Only agents with at least `min_actions` resolved (non-open) actions
 * are included: this prevents 1-trade wonders from dominating. Includes name,
 * avatar, and summary stats so the caller needs no extra fetch.
 *
 * Cache: 120s public CDN.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

/** parseInt that never leaks NaN into a bound query parameter. */
function intParam(raw, fallback, min, max) {
	const n = parseInt(raw ?? '', 10);
	return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
}

export default wrap(async function handleOracleLeaderboard(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const ip = clientIp(req);
	const rl = await limits.publicIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const limit = intParam(params.get('limit'), 20, 1, 50);
	const minActions = intParam(params.get('min_actions'), 3, 1, 1000);

	// Aggregate per agent: count wins, losses, open, realized PnL, total size.
	// Join agent_identities for display fields (its portrait lives in
	// profile_image_url, with avatar_url as the fallback: there is no
	// image_url column, and selecting one returned an empty board on every
	// request). Filter to agents with enough resolved actions to trust the
	// win rate. No .catch() swallow here: this query IS the response, so an
	// empty array must mean "nobody qualifies", never "the query broke".
	const rows = await sql`
		select
			a.agent_id,
			i.name            as agent_name,
			coalesce(i.profile_image_url, i.avatar_url) as agent_image,
			count(*)::int     as total,
			count(*) filter (where a.outcome = 'win')::int   as wins,
			count(*) filter (where a.outcome = 'loss')::int  as losses,
			count(*) filter (where a.outcome = 'open' or a.outcome is null)::int as open,
			coalesce(sum(a.realized_pnl_sol), 0)::float      as realized_pnl_sol,
			coalesce(sum(a.size_sol), 0)::float               as deployed_sol
		from oracle_watch_actions a
		left join agent_identities i on i.id = a.agent_id and i.deleted_at is null
		where a.network = ${network}
		group by a.agent_id, i.name, i.profile_image_url, i.avatar_url
		having count(*) filter (where a.outcome in ('win','loss')) >= ${minActions}
		order by
			round(
				count(*) filter (where a.outcome = 'win')::numeric /
				nullif(count(*) filter (where a.outcome in ('win','loss')), 0) * 100
			) desc nulls last,
			count(*) desc
		limit ${limit}
	`;

	const agents = rows.map((r, idx) => {
		const resolved = r.wins + r.losses;
		const win_rate = resolved > 0 ? Math.round((r.wins / resolved) * 100) : null;
		const roi_pct = r.deployed_sol > 0
			? Math.round((r.realized_pnl_sol / r.deployed_sol) * 100)
			: null;
		return {
			rank: idx + 1,
			agent_id: r.agent_id,
			name: r.agent_name || null,
			image_url: r.agent_image || null,
			trader_url: `https://three.ws/trader/${encodeURIComponent(r.agent_id)}`,
			total: r.total,
			wins: r.wins,
			losses: r.losses,
			open: r.open,
			win_rate,
			realized_pnl_sol: +Number(r.realized_pnl_sol).toFixed(4),
			roi_pct,
		};
	});

	return json(res, 200, {
		network,
		min_actions: minActions,
		agents,
	}, { 'cache-control': 'public, max-age=120, s-maxage=120' });
});
