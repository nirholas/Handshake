/**
 * Oracle — conviction movers.
 *
 *   GET /api/oracle/movers?network=mainnet&hours=24&direction=rising&limit=30
 *
 * Finds coins whose conviction score changed most significantly over the given
 * window by joining oracle_conviction against oracle_conviction_history. Only
 * coins with at least 2 history snapshots in the window are included so the
 * delta is real signal, not a single-point artefact.
 *
 * direction=rising  → top gainers (score went up most)
 * direction=falling → top losers (score dropped most)
 * direction=all     → both, sorted by absolute delta
 *
 * Each item includes the coin's current conviction fields PLUS:
 *   delta        — numeric change in score (positive = rising, negative = falling)
 *   first_score  — score at the start of the window
 *   last_score   — score at the end of the window (== current score)
 *   first_tier   — tier at start of window
 *   tier_changed — boolean: first_tier !== current tier
 *   first_at     — timestamp of the first snapshot in the window
 *
 * Public, IP rate-limited, 90-second CDN cache.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql, isDbUnavailableError } from '../_lib/db.js';
import { QUOTE_MINT_LIST } from '../_lib/quote-mints.js';

const NETWORKS   = new Set(['mainnet', 'devnet']);
const DIRECTIONS = new Set(['rising', 'falling', 'all']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p         = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network   = NETWORKS.has(p.get('network'))     ? p.get('network')    : 'mainnet';
	const hours     = Math.min(48, Math.max(1, Number(p.get('hours')) || 24));
	const direction = DIRECTIONS.has(p.get('direction')) ? p.get('direction')  : 'rising';
	const limit     = Math.min(60, Math.max(1, Number(p.get('limit'))  || 30));
	const minDelta  = Math.max(1, Number(p.get('min_delta')) || 5);

	// For each coin that has history in the window, find:
	//   first snapshot score (oldest in window)
	//   latest snapshot score (newest in window, should match conviction table)
	//   delta = latest - first
	// Then join back to oracle_conviction for the full current fields.
	const rows = await sql`
		with history_window as (
			select
				h.mint,
				h.network,
				first_value(h.score)     over w as first_score,
				first_value(h.tier)      over w as first_tier,
				first_value(h.scored_at) over w as first_at,
				last_value(h.score)      over w as last_score,
				last_value(h.tier)       over w as last_tier,
				row_number()             over (partition by h.mint, h.network order by h.scored_at desc) as rn
			from oracle_conviction_history h
			where h.network = ${network}
			  and h.scored_at > now() - (${hours} || ' hours')::interval
			window w as (
				partition by h.mint, h.network
				order by h.scored_at
				rows between unbounded preceding and unbounded following
			)
		),
		deduped as (
			select mint, network, first_score, first_tier, first_at, last_score, last_tier
			from history_window
			where rn = 1
		)
		select
			c.mint, c.symbol, c.name, c.image_uri, c.score, c.tier,
			c.pedigree, c.structure, c.narrative, c.momentum,
			c.badges, c.category, c.smart_wallet_count, c.scored_at, c.coin_first_seen_at,
			d.first_score, d.first_tier, d.first_at,
			(c.score - d.first_score)::int as delta
		from deduped d
		join oracle_conviction c on c.mint = d.mint and c.network = d.network
		where abs(c.score - d.first_score) >= ${minDelta}
		  and c.mint <> all(${QUOTE_MINT_LIST}::text[])
		  and (
		        ${direction}::text = 'all'
		     or (${direction}::text = 'rising'  and c.score > d.first_score)
		     or (${direction}::text = 'falling' and c.score < d.first_score)
		  )
		order by
			case when ${direction}::text = 'falling' then (d.first_score - c.score) else (c.score - d.first_score) end desc,
			c.score desc
		limit ${limit}
	`.catch((err) => {
		// This query IS the response. A connectivity failure used to become a
		// confident "nothing is moving" with a 90-second CDN cache, so a blip
		// lasting seconds flatlined the movers panel for the next minute and a
		// half. Rethrow so wrap() answers 503 + Retry-After and nothing caches
		// the lie; a statement-level fault still degrades to an empty board.
		if (isDbUnavailableError(err)) throw err;
		return [];
	});

	const items = rows.map((r) => ({
		mint:             r.mint,
		symbol:           r.symbol,
		name:             r.name,
		image_uri:        r.image_uri,
		score:            r.score,
		tier:             r.tier,
		pillars: {
			pedigree:  r.pedigree,
			structure: r.structure,
			narrative: r.narrative,
			momentum:  r.momentum,
		},
		badges:           r.badges || [],
		category:         r.category,
		smart_wallet_count: r.smart_wallet_count,
		scored_at:        r.scored_at,
		coin_first_seen_at: r.coin_first_seen_at,
		delta:            r.delta,
		first_score:      r.first_score,
		first_tier:       r.first_tier,
		tier_changed:     r.first_tier !== r.tier,
		first_at:         r.first_at,
	}));

	return json(res, 200, {
		network,
		hours,
		direction,
		count: items.length,
		items,
		generated_at: new Date().toISOString(),
	}, { 'Cache-Control': 'public, max-age=90, stale-while-revalidate=180' });
});
