/**
 * Oracle: conviction accuracy backtest.
 *
 *   GET /api/oracle/backtest?period=7d&tier=prime&network=mainnet
 *
 * Joins oracle_conviction (what the engine scored) against pump_coin_outcomes
 * (ground truth: graduated, rugged, ATH multiple) and returns hit-rate stats
 * per tier. This is the honest answer to "does the oracle engine actually work?"
 *
 * Only coins with a resolved outcome are counted: open positions are excluded
 * from the win-rate calculation so the denominator is accurate.
 *
 * Params:
 *   period   : 1d | 7d | 30d | 90d | all (default: 30d)
 *   tier     : prime | strong | lean | watch | avoid | all (default: all)
 *   network  : mainnet | devnet (default: mainnet)
 *
 * Cached for 5 minutes: the DB table is large and this query is expensive.
 */

import { cors, json, method, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { QUOTE_MINT_LIST } from '../_lib/quote-mints.js';

const PERIODS = { '1d': 1, '7d': 7, '30d': 30, '90d': 90, 'all': null };
const TIERS = new Set(['prime', 'strong', 'lean', 'watch', 'avoid', 'all']);
const TIER_ORDER = { prime: 5, strong: 4, lean: 3, watch: 2, avoid: 1 };
const NETWORKS = new Set(['mainnet', 'devnet']);

const CACHE_TTL_MS = 5 * 60_000;
const _cache = new Map(); // key → { data, at }

function cacheKey(period, tier, network) { return `${period}:${tier}:${network}`; }

/**
 * Wilson score interval: the honest 95% confidence band for a win rate. Unlike
 * the naive ±√(p(1-p)/n), it stays inside [0,1] and is well-behaved at small n,
 * which is exactly the regime a young backtest lives in. Returned as integer
 * percentages so the UI can render "68% (54-80)" without further math.
 *
 * @param {number} wins
 * @param {number} n      resolved sample (wins + losses)
 * @param {number} z      z-score (1.96 ≈ 95%)
 * @returns {{lo:number, hi:number, width:number}|null}
 */
export function wilson(wins, n, z = 1.96) {
	if (!n || n <= 0) return null;
	const p = wins / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const centre = (p + z2 / (2 * n)) / denom;
	const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
	const lo = Math.max(0, Math.round((centre - margin) * 100));
	const hi = Math.min(100, Math.round((centre + margin) * 100));
	return { lo, hi, width: hi - lo };
}

async function query(days, tier, network) {
	const key = cacheKey(days, tier, network);
	const hit = _cache.get(key);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

	// ── per-tier breakdown ────────────────────────────────────────────────────
	const tierFilter = tier !== 'all' ? sql`and c.tier = ${tier}` : sql``;
	const periodFilter = days != null ? sql`and c.scored_at >= now() - (${days} || ' days')::interval` : sql``;
	// Quote/stablecoin/LST mints are not coins, so exclude them from every accuracy
	// calc so a stray cached USDC row can't poison the win-rate or top performers.
	const quoteFilter = sql`and c.mint <> all(${QUOTE_MINT_LIST}::text[])`;

	// Win = graduated OR (ath ≥ 2 AND not rugged). The "not rugged" clause is
	// load-bearing: a bundle that spikes 2× and collapses is an exit-liquidity
	// event, not a win: counting it would let pump-and-dumps inflate the very
	// number that's supposed to expose them. Keep in sync with stats.js/wins.js.
	const rows = await sql`
		select
			c.tier,
			count(*)::int                                                                 as total,
			count(*) filter (where o.graduated or (o.ath_multiple >= 2 and not coalesce(o.rugged, false)))::int as wins,
			count(*) filter (where o.rugged or (o.ath_multiple is not null and o.ath_multiple < 1.2 and not o.graduated))::int as losses,
			count(*) filter (where o.ath_multiple is not null)::int                       as with_ath,
			round(avg(o.ath_multiple)::numeric, 2)                                        as avg_ath,
			round(percentile_cont(0.5) within group (order by o.ath_multiple)::numeric, 2) as median_ath,
			count(*) filter (where o.ath_multiple >= 3)::int                             as three_x,
			count(*) filter (where o.ath_multiple >= 5)::int                             as five_x,
			count(*) filter (where o.ath_multiple >= 10)::int                            as ten_x,
			count(*) filter (where o.graduated)::int                                      as graduated,
			count(*) filter (where o.rugged)::int                                         as rugged
		from oracle_conviction c
		join pump_coin_outcomes o on o.mint = c.mint
		where c.network = ${network}
		  and (o.graduated or o.rugged or o.ath_multiple is not null)
		  ${quoteFilter}
		  ${tierFilter}
		  ${periodFilter}
		group by c.tier
		order by min(case c.tier when 'prime' then 5 when 'strong' then 4 when 'lean' then 3 when 'watch' then 2 when 'avoid' then 1 else 0 end) desc
	`;

	// ── aggregate across tiers ────────────────────────────────────────────────
	let agg = { total: 0, wins: 0, losses: 0, three_x: 0, five_x: 0, ten_x: 0, graduated: 0, rugged: 0 };
	for (const r of rows) {
		agg.total += r.total;
		agg.wins += r.wins;
		agg.losses += r.losses;
		agg.three_x += r.three_x;
		agg.five_x += r.five_x;
		agg.ten_x += r.ten_x;
		agg.graduated += r.graduated;
		agg.rugged += r.rugged;
	}
	const resolved = agg.wins + agg.losses;
	agg.win_rate = resolved ? Math.round((agg.wins / resolved) * 100) : null;
	agg.ci = wilson(agg.wins, resolved);

	// ── score-band calibration + Brier score ───────────────────────────────────
	// The conviction score claims to rank coins by win probability. Calibration is
	// the proof: bucket every resolved coin by its score band and measure the
	// REALIZED win rate per band. A trustworthy engine produces a monotonic ladder
	// (higher band → higher realized rate) that tracks the band's own prediction.
	// Brier = mean squared error of score/100 (treated as a probability) vs the
	// 0/1 outcome: one number for "how well-calibrated overall" (lower is better).
	// This pass is unconditional on tier so the baseline is the true market rate.
	const calRows = await sql`
		select
			least(width_bucket(c.score, 0, 100, 10), 10)                          as bucket,
			count(*)::int                                                         as n,
			count(*) filter (where o.graduated or (o.ath_multiple >= 2 and not coalesce(o.rugged, false)))::int as wins,
			round(avg(c.score)::numeric, 1)                                       as avg_score
		from oracle_conviction c
		join pump_coin_outcomes o on o.mint = c.mint
		where c.network = ${network}
		  and (o.graduated or o.rugged or o.ath_multiple is not null)
		  ${quoteFilter}
		  ${periodFilter}
		group by 1
		order by 1
	`.catch(() => []);

	const calibration = calRows
		.filter((r) => r.bucket >= 1 && r.bucket <= 10)
		.map((r) => {
			const lo = (r.bucket - 1) * 10;
			const hi = r.bucket * 10;
			const realized = r.n ? Math.round((r.wins / r.n) * 100) : null;
			return {
				band: `${lo}-${hi}`,
				lo, hi,
				n: r.n,
				wins: r.wins,
				avg_score: r.avg_score != null ? Number(r.avg_score) : (lo + hi) / 2,
				predicted: Math.round((lo + hi) / 2),       // band midpoint as a % prediction
				realized,                                    // realized win rate in the band
				ci: wilson(r.wins, r.n),
			};
		});

	// Market baseline: a coin drawn at random from everything Oracle scored.
	const baseRow = await sql`
		select
			count(*)::int                                                   as n,
			count(*) filter (where o.graduated or (o.ath_multiple >= 2 and not coalesce(o.rugged, false)))::int as wins,
			round(avg(power((c.score / 100.0) - (case when o.graduated or (o.ath_multiple >= 2 and not coalesce(o.rugged, false)) then 1 else 0 end), 2))::numeric, 4) as brier
		from oracle_conviction c
		join pump_coin_outcomes o on o.mint = c.mint
		where c.network = ${network}
		  and (o.graduated or o.rugged or o.ath_multiple is not null)
		  ${quoteFilter}
		  ${periodFilter}
	`.then((r) => r[0] || {}).catch(() => ({}));

	const baselineN = Number(baseRow.n) || 0;
	const baselineWinRate = baselineN ? Math.round((Number(baseRow.wins) / baselineN) * 100) : null;
	const brier = baseRow.brier != null ? Number(baseRow.brier) : null;

	// Edge summary: does conviction actually beat blind buying, and does the ladder
	// climb in the right order?
	const primeRow = rows.find((r) => r.tier === 'prime');
	const primeResolved = primeRow ? primeRow.wins + primeRow.losses : 0;
	const primeWinRate = primeResolved ? Math.round((primeRow.wins / primeResolved) * 100) : null;
	const orderedRealized = calibration.map((c) => c.realized).filter((v) => v != null);
	const monotonic = orderedRealized.length >= 2
		&& orderedRealized.every((v, i) => i === 0 || v >= orderedRealized[i - 1] - 5); // ≤5pt tolerance
	const edge = {
		baseline_win_rate: baselineWinRate,
		baseline_n: baselineN,
		prime_win_rate: primeWinRate,
		prime_lift: (primeWinRate != null && baselineWinRate != null) ? primeWinRate - baselineWinRate : null,
		edge_multiple: (primeWinRate != null && baselineWinRate) ? Number((primeWinRate / baselineWinRate).toFixed(2)) : null,
		monotonic,
		brier,
	};

	// ── top performers in the period ─────────────────────────────────────────
	const topFilter = days != null ? sql`and c.scored_at >= now() - (${days} || ' days')::interval` : sql``;
	const topTierFilter = tier !== 'all' ? sql`and c.tier = ${tier}` : sql``;
	const top = await sql`
		select c.mint, c.symbol, c.name, c.score, c.tier, o.ath_multiple, o.graduated, o.rugged
		from oracle_conviction c
		join pump_coin_outcomes o on o.mint = c.mint
		where c.network = ${network}
		  and o.ath_multiple is not null
		  ${quoteFilter}
		  ${topTierFilter}
		  ${topFilter}
		order by o.ath_multiple desc nulls last
		limit 10
	`;

	const data = {
		period: days != null ? `${days}d` : 'all',
		tier,
		network,
		by_tier: rows.map((r) => ({
			tier: r.tier,
			total: r.total,
			wins: r.wins,
			losses: r.losses,
			win_rate: (r.wins + r.losses) > 0 ? Math.round((r.wins / (r.wins + r.losses)) * 100) : null,
			ci: wilson(r.wins, r.wins + r.losses),
			avg_ath: r.avg_ath ? Number(r.avg_ath) : null,
			median_ath: r.median_ath ? Number(r.median_ath) : null,
			three_x: r.three_x,
			five_x: r.five_x,
			ten_x: r.ten_x,
			graduated: r.graduated,
			rugged: r.rugged,
		})),
		aggregate: agg,
		calibration,
		edge,
		top_performers: top.map((r) => ({
			mint: r.mint,
			symbol: r.symbol,
			name: r.name,
			score: r.score,
			tier: r.tier,
			ath_multiple: r.ath_multiple ? Number(r.ath_multiple) : null,
			graduated: r.graduated,
			rugged: r.rugged,
		})),
	};

	_cache.set(key, { data, at: Date.now() });
	return data;
}

export default async function handleOracleBacktest(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const periodKey = PERIODS.hasOwnProperty(params.get('period')) ? params.get('period') : '30d';
	const days = PERIODS[periodKey];
	const tier = TIERS.has(params.get('tier')) ? params.get('tier') : 'all';
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';

	try {
		const data = await query(days, tier, network);
		return json(res, 200, data, { 'cache-control': 'public, max-age=300, s-maxage=300' });
	} catch (err) {
		console.error('[oracle/backtest]', err);
		return json(res, 503, { error: 'backtest_unavailable', message: 'Could not run backtest query.' });
	}
}
