// GET /api/mirror/leaderboard: performance-weighted discovery of followable
// agents for custodial copy-trading (task 09).
//
// Ranks agents by REAL, on-chain-derived performance from real fills (sniper
// closed positions + the discretionary custody ledger), never inflated. The
// trust surface of copy-trading: you find a leader by their honest track record
// (losers included) and every number traces to a real signature.
//
// Public, cached. Sort by: score (default) | pnl | followers | volume | winrate.

import { cors, json, method, rateLimited, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const SORTS = new Set(['score', 'pnl', 'followers', 'volume', 'winrate']);
// Candidate pool the ranking runs over. Bounded so one query stays cheap as the
// agent count grows; ordered (below) so the window holds the agents with the
// most evidence rather than an arbitrary 500 rows.
const CANDIDATE_POOL = 500;
const lamToSol = (l) => (l == null ? 0 : Number(BigInt(l)) / 1e9);

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = new URL(req.url, 'http://x').searchParams;
	const network = NETWORKS.has(p.get('network')) ? p.get('network') : 'mainnet';
	const sort = SORTS.has(p.get('sort')) ? p.get('sort') : 'score';
	const limit = Math.min(50, Math.max(1, parseInt(p.get('limit') || '25', 10) || 25));
	// Callers that can only work with a realized track record (the Clip Director
	// mints a card from a closed round-trip, so an agent with none is unusable to
	// it) ask for `settled_min=1` instead of over-fetching and filtering client
	// side. That filter used to live in the caller, which silently broke: the
	// composite score does not correlate with having closed trades, so the only
	// eligible agent ranked below the caller's window and the page saw an empty
	// board. Filtering here makes the window hold what the caller asked for.
	const settledMin = Math.min(1000, Math.max(0, parseInt(p.get('settled_min') || '0', 10) || 0));

	// Realized stats per agent from closed sniper round-trips: the honest P&L
	// surface. LEFT JOIN follower counts + discretionary trade activity so an agent
	// that trades only discretionarily still appears (with volume, no realized P&L).
	//
	// A DB failure is NOT caught here on purpose: an empty leaderboard is a real,
	// meaningful answer ("nobody has traded yet"), so swallowing an outage into
	// `[]` would hand back a confident lie and the CDN would cache it for a
	// minute. wrap() turns it into a 503 + Retry-After instead.
	const rows = await sql`
		WITH closed AS (
			SELECT agent_id,
			       count(*)::int AS settled,
			       count(*) FILTER (WHERE realized_pnl_lamports > 0)::int AS wins,
			       COALESCE(SUM(realized_pnl_lamports), 0)::text AS pnl_lamports,
			       COALESCE(SUM(entry_quote_lamports), 0)::text AS entry_lamports
			FROM agent_sniper_positions
			WHERE network = ${network} AND status = 'closed'
			GROUP BY agent_id
		),
		activity AS (
			SELECT agent_id,
			       count(*)::int AS trades,
			       COALESCE(SUM(amount_lamports) FILTER (WHERE asset = 'SOL'), 0)::text AS buy_lamports,
			       max(created_at) AS last_trade_at
			FROM agent_custody_events
			WHERE network = ${network} AND category = 'trade' AND status IN ('confirmed','ok')
			GROUP BY agent_id
		),
		-- Followers exclude self-follows: an owner mirroring between two agents they
		-- both own is a legitimate strategy, but counting it here let anyone buy up
		-- to 20 points of composite score (the follower nudge in rankLeaders) by
		-- creating agents and pointing them at themselves. The edge still works and
		-- still shows on the owner's own dashboard; it just no longer buys rank.
		followers AS (
			SELECT f.leader_agent_id AS agent_id,
			       count(*)::int AS followers,
			       count(*) FILTER (WHERE f.enabled)::int AS active_followers
			FROM agent_mirror_follows f
			JOIN agent_identities la ON la.id = f.leader_agent_id AND la.user_id <> f.owner_user_id
			WHERE f.network = ${network}
			GROUP BY f.leader_agent_id
		)
		SELECT a.id, a.name, a.avatar_url, a.profile_image_url,
		       COALESCE(c.settled, 0) AS settled, COALESCE(c.wins, 0) AS wins,
		       COALESCE(c.pnl_lamports, '0') AS pnl_lamports, COALESCE(c.entry_lamports, '0') AS entry_lamports,
		       COALESCE(act.trades, 0) AS trades, COALESCE(act.buy_lamports, '0') AS buy_lamports,
		       act.last_trade_at,
		       COALESCE(fl.followers, 0) AS followers, COALESCE(fl.active_followers, 0) AS active_followers
		FROM agent_identities a
		LEFT JOIN closed c ON c.agent_id = a.id
		LEFT JOIN activity act ON act.agent_id = a.id
		LEFT JOIN followers fl ON fl.agent_id = a.id
		WHERE a.deleted_at IS NULL AND a.is_public = true
		  AND (c.settled IS NOT NULL OR act.trades IS NOT NULL)
		  AND COALESCE(c.settled, 0) >= ${settledMin}
		ORDER BY COALESCE(c.settled, 0) DESC,
		         COALESCE(fl.followers, 0) DESC,
		         COALESCE(act.trades, 0) DESC,
		         a.id ASC
		LIMIT ${CANDIDATE_POOL}
	`;

	res.setHeader?.('cache-control', 'public, max-age=30, s-maxage=60');
	return json(res, 200, {
		data: { network, sort, settled_min: settledMin, leaders: rankLeaders(rows, { sort, limit, settledMin }) },
	});
});

/**
 * Rank raw leaderboard rows. Pure: same rows in, same ranking out, so the 60s
 * edge cache never serves two different orderings of the same data.
 * @param {Array<object>} rows raw SQL rows (lamport sums arrive as strings)
 * @param {{sort?: string, limit?: number, settledMin?: number}} opts settledMin drops
 *   agents with fewer closed round-trips, so a caller that needs a realized
 *   track record never has to filter (and mis-window) the ranking itself
 * @returns {Array<object>} ranked leaders, rank 1 first
 */
export function rankLeaders(rows, { sort = 'score', limit = 25, settledMin = 0 } = {}) {
	const leaders = rows.map((r) => {
		const pnlSol = lamToSol(r.pnl_lamports);
		const entrySol = lamToSol(r.entry_lamports);
		const settled = Number(r.settled || 0);
		const wins = Number(r.wins || 0);
		const winRate = settled > 0 ? (wins / settled) * 100 : null;
		const roiPct = entrySol > 0 ? (pnlSol / entrySol) * 100 : null;
		const buyVolSol = lamToSol(r.buy_lamports);
		const followers = Number(r.followers || 0);
		// Composite score: realized ROI weighted by sample size (so a 1-trade fluke
		// can't top a consistent trader), plus a small follower-trust nudge. Honest:
		// an agent with no settled trades scores on volume/activity alone.
		const sample = Math.min(1, settled / 8);
		const score = Math.round(
			(roiPct != null ? roiPct * sample : 0) +
			(winRate != null ? (winRate - 50) * 0.5 * sample : 0) +
			Math.min(20, followers * 2) +
			Math.min(10, buyVolSol),
		);
		return {
			agent_id: r.id,
			name: r.name,
			avatar: r.avatar_url || r.profile_image_url || null,
			settled, wins, win_rate: winRate == null ? null : round2(winRate),
			pnl_sol: round4(pnlSol), roi_pct: roiPct == null ? null : round2(roiPct),
			trades: Number(r.trades || 0), volume_sol: round4(buyVolSol),
			followers, active_followers: Number(r.active_followers || 0),
			last_trade_at: r.last_trade_at || null,
			score,
		};
	}).filter((l) => l.settled >= settledMin);

	const cmp = COMPARATORS[sort] || COMPARATORS.score;
	// Tiebreak on agent_id so equal-scoring agents rank in one fixed order
	// instead of shuffling between cache fills.
	leaders.sort((a, b) => cmp(a, b) || String(a.agent_id).localeCompare(String(b.agent_id)));
	return leaders.slice(0, limit).map((l, i) => ({ rank: i + 1, ...l }));
}

const COMPARATORS = {
	score: (a, b) => b.score - a.score,
	pnl: (a, b) => b.pnl_sol - a.pnl_sol,
	followers: (a, b) => b.followers - a.followers,
	volume: (a, b) => b.volume_sol - a.volume_sol,
	winrate: (a, b) => (b.win_rate ?? -1) - (a.win_rate ?? -1),
};

function round2(x) { return Math.round(x * 100) / 100; }
function round4(x) { return Math.round(x * 1e4) / 1e4; }
