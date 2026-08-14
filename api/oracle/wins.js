/**
 * Oracle — proven wins gallery.
 *
 *   GET /api/oracle/wins
 *       ?network=mainnet     default: mainnet
 *       &period=7d|30d|90d|all  default: 30d
 *       &tier=called|prime|strong|lean|watch|avoid|all  default: called
 *       &min_ath=1           minimum ATH multiple to include
 *       &limit=50            max 100
 *       &before=<cursor>     pagination cursor, echoed from next_before
 *
 * Returns oracle_conviction rows that have a resolved outcome in
 * pump_coin_outcomes, ordered by ATH multiple descending. This is the
 * "proof of edge" view — coins the oracle called and that subsequently
 * delivered measurable returns.
 *
 * Because it claims to be proof of edge, the default scope is `called` —
 * only tiers the oracle tells people to act on (lean/strong/prime). A watch
 * or avoid coin that mooned is not proof of anything except the market;
 * pass tier=all explicitly to browse those.
 *
 * A win is graduation, or an ATH ≥ 2× on a coin that did NOT rug — a 2×
 * wick on the way to zero is exit liquidity, not a deliverable return.
 * (Definition shared with stats.js and backtest.js.)
 * Losses/duds are not shown here — that's the backtest endpoint.
 *
 * Public, IP rate-limited, 5-min CDN cache.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { isoTimestamp } from '../_lib/validate.js';
import { QUOTE_MINT_LIST } from '../_lib/quote-mints.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const TIERS    = new Set(['called', 'prime', 'strong', 'lean', 'watch', 'avoid', 'all']);
const PERIODS  = { '7d': 7, '30d': 30, '90d': 90, 'all': null };
const MINT_RE  = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NUMERIC_RE = /^\d+(\.\d+)?$/;

// The tiers the oracle actually tells people to act on.
const CALLED_TIERS = ['lean', 'strong', 'prime'];

// ── keyset pagination ─────────────────────────────────────────────────────────
// The gallery is ordered by ATH multiple, not by time, so a scored_at-only
// cursor silently drops every remaining row that happens to be newer than the
// last row of the previous page — on a 3-row page of the live feed that was 4
// of the next 6 wins, gone. The cursor therefore carries the whole sort key:
// "<ath_multiple>|<scored_at ISO>|<mint>". The ATH component is kept as the
// exact numeric string Postgres returned, never a float round-trip, so the row
// comparison lands on the same row the previous page ended on.

function parseCursor(raw) {
	if (!raw) return { ok: true, cursor: null };
	const parts = String(raw).split('|');
	// A bare timestamp is a cursor minted before the sort key landed (an open
	// tab, a bookmarked call). Honour it on scored_at alone rather than 400ing.
	if (parts.length === 1) {
		const ts = isoTimestamp(parts[0]);
		return ts ? { ok: true, cursor: { ath: null, ts, mint: null } } : { ok: false, cursor: null };
	}
	if (parts.length !== 3) return { ok: false, cursor: null };
	const [ath, rawTs, mint] = parts;
	const ts = isoTimestamp(rawTs);
	if (!NUMERIC_RE.test(ath) || !ts || !MINT_RE.test(mint)) return { ok: false, cursor: null };
	return { ok: true, cursor: { ath, ts, mint } };
}

function encodeCursor(row) {
	return `${row.ath_multiple}|${new Date(row.scored_at).toISOString()}|${row.mint}`;
}

function shapeRow(r) {
	return {
		mint:              r.mint,
		symbol:            r.symbol    || r.mint.slice(0, 6),
		name:              r.name      || null,
		image_uri:         r.image_uri || null,
		tier:              r.tier,
		score:             r.score     != null ? Number(r.score)           : null,
		category:          r.category  || null,
		// Conviction pillars at entry time
		pillars: {
			pedigree:  r.pedigree  != null ? Number(r.pedigree)  : null,
			structure: r.structure != null ? Number(r.structure) : null,
			narrative: r.narrative != null ? Number(r.narrative) : null,
			momentum:  r.momentum  != null ? Number(r.momentum)  : null,
		},
		scored_at:         r.scored_at,
		// Outcome
		ath_multiple:      r.ath_multiple  != null ? Number(r.ath_multiple)  : null,
		last_mc_usd:       r.last_market_cap_usd != null ? Number(r.last_market_cap_usd) : null,
		graduated:         !!r.graduated,
		// convenience
		pump_url: `https://pump.fun/coin/${r.mint}`,
		oracle_url: `/oracle?mint=${r.mint}`,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params  = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const periodKey = PERIODS.hasOwnProperty(params.get('period')) ? params.get('period') : '30d';
	const days    = PERIODS[periodKey];
	const tier    = TIERS.has(params.get('tier'))    ? params.get('tier')    : 'called';
	const minAth  = Math.max(1, Number(params.get('min_ath')) || 2);
	const limit   = Math.max(1, Math.min(100, parseInt(params.get('limit'), 10) || 50));

	const { ok: cursorOk, cursor } = parseCursor(params.get('before'));
	if (!cursorOk) return error(res, 400, 'validation_error', 'before must be a cursor echoed from next_before');

	const tierFilter = tier === 'all' ? sql``
		: tier === 'called' ? sql`and c.tier = any(${CALLED_TIERS}::text[])`
		: sql`and c.tier = ${tier}`;
	const periodFilter = days != null     ? sql`and c.scored_at >= now() - (${days} || ' days')::interval` : sql``;
	const beforeFilter = !cursor ? sql``
		: cursor.ath == null ? sql`and c.scored_at < ${cursor.ts}::timestamptz`
		: sql`and (o.ath_multiple, c.scored_at, c.mint) < (${cursor.ath}::numeric, ${cursor.ts}::timestamptz, ${cursor.mint})`;

	const rows = await sql`
		select
			c.mint, c.symbol, c.name, c.image_uri, c.tier, c.score, c.category,
			c.pedigree, c.structure, c.narrative, c.momentum, c.scored_at,
			o.ath_multiple, o.last_market_cap_usd, o.graduated
		from oracle_conviction c
		join pump_coin_outcomes o on o.mint = c.mint
		where c.network = ${network}
		  and o.ath_multiple >= ${minAth}
		  and (o.graduated or (o.ath_multiple >= 2 and not coalesce(o.rugged, false)))
		  and c.mint <> all(${QUOTE_MINT_LIST}::text[])
		  ${tierFilter}
		  ${periodFilter}
		  ${beforeFilter}
		order by o.ath_multiple desc, c.scored_at desc, c.mint desc
		limit ${limit}
	`.catch((e) => {
		throw new Error(`wins query failed: ${e.message}`);
	});

	// Summary counts — total wins and best ATH in the period.
	const summary = await sql`
		select
			count(*)::int                                                           as total_wins,
			count(*) filter (where o.ath_multiple >= 5)::int                       as five_x_count,
			count(*) filter (where o.ath_multiple >= 10)::int                      as ten_x_count,
			round(max(o.ath_multiple)::numeric, 2)                                 as best_ath,
			count(*) filter (where o.graduated)::int                               as graduated_count
		from oracle_conviction c
		join pump_coin_outcomes o on o.mint = c.mint
		where c.network = ${network}
		  and o.ath_multiple >= ${minAth}
		  and (o.graduated or (o.ath_multiple >= 2 and not coalesce(o.rugged, false)))
		  and c.mint <> all(${QUOTE_MINT_LIST}::text[])
		  ${tierFilter}
		  ${periodFilter}
	`.catch(() => [{}]);

	const s = summary[0] || {};
	const items = rows.map(shapeRow);
	const next_before = rows.length >= limit ? encodeCursor(rows[rows.length - 1]) : null;

	return json(res, 200, {
		network,
		period: periodKey,
		tier,
		summary: {
			total_wins:      s.total_wins      ?? 0,
			five_x_count:    s.five_x_count    ?? 0,
			ten_x_count:     s.ten_x_count     ?? 0,
			best_ath:        s.best_ath        ? Number(s.best_ath) : null,
			graduated_count: s.graduated_count ?? 0,
		},
		items,
		next_before,
	}, {
		'cache-control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=600',
	});
});
