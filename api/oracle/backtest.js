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
import { PREDICTED_EVENT, probabilityFromScore, hitRateFor } from '../_lib/oracle/conviction.js';

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

/**
 * Is the ladder actually ordered? The old check allowed a 5-point drop per step
 * and then reported `monotonic: true` on a ladder that visibly dipped, which the
 * /oracle page turned into "the win rate climbs at every band, the ranking is
 * calibrated, not noise". This counts an inversion only when a higher band scores
 * WORSE than a lower one and their 95% intervals are disjoint, so noise cannot
 * explain it away and a real inversion cannot be tolerated away either.
 *
 * @param {Array<object>} bands calibration bands, ascending
 * @param {string} rateKey band field holding the realized rate
 * @param {string} ciKey   band field holding that rate's Wilson interval
 * @param {number} minN    bands thinner than this are too noisy to judge
 */
/**
 * Roll the per-score aggregate into bands of 10. `predicted` is the
 * sample-weighted mean of the probability each score in the band actually claims,
 * so it follows where the coins sit instead of assuming the band midpoint.
 *
 * @param {Array<{score:number, n:number, spikes:number, wins:number}>} scoreRows
 */
export function assembleBands(scoreRows) {
	const bands = [];
	for (let lo = 0; lo < 100; lo += 10) {
		const hi = lo + 10;
		const inBand = scoreRows.filter((r) => {
			const s = Number(r.score);
			return s >= lo && (hi === 100 ? s <= 100 : s < hi);
		});
		const n = inBand.reduce((a, r) => a + r.n, 0);
		if (!n) continue;
		const wins = inBand.reduce((a, r) => a + r.wins, 0);
		const spikes = inBand.reduce((a, r) => a + r.spikes, 0);
		const scoreSum = inBand.reduce((a, r) => a + Number(r.score) * r.n, 0);
		const claimSum = inBand.reduce((a, r) => a + probabilityFromScore(Number(r.score)) * r.n, 0);
		const avgScore = Number((scoreSum / n).toFixed(1));
		bands.push({
			band: `${lo}-${hi}`,
			lo, hi, n, wins, spikes,
			avg_score: avgScore,
			predicted: Math.round((claimSum / n) * 100),
			realized: Math.round((wins / n) * 100),
			realized_spike: Math.round((spikes / n) * 100),
			// The rug-aware win rate the shipped calibration expects for this band.
			// In-sample by construction (the isotonic fit reads this same resolved
			// set), so it is the ladder's stated claim, not independent evidence.
			predicted_win: Math.round(hitRateFor(avgScore).rate * 100),
			ci: wilson(wins, n),
			spike_ci: wilson(spikes, n),
		});
	}
	return bands;
}

/**
 * Brier score against the event the model was trained on, using each score's own
 * claimed probability. Lower is better; 0.25 is a coin flip. Computed per exact
 * score rather than per band so no coin is graded against a neighbour's claim.
 *
 * @param {Array<{score:number, n:number, spikes:number}>} scoreRows
 */
export function brierScore(scoreRows) {
	let sum = 0;
	let n = 0;
	for (const r of scoreRows) {
		const p = probabilityFromScore(Number(r.score));
		sum += r.spikes * (1 - p) ** 2 + (r.n - r.spikes) * p ** 2;
		n += r.n;
	}
	return n ? Number((sum / n).toFixed(4)) : null;
}

export function ladderCheck(bands, rateKey, ciKey, minN = 100) {
	const seq = bands.filter((b) => b.n >= minN && b[rateKey] != null && b[ciKey]);
	const inversions = [];
	for (let i = 1; i < seq.length; i++) {
		for (let j = 0; j < i; j++) {
			const lower = seq[j];
			const higher = seq[i];
			if (higher[rateKey] >= lower[rateKey]) continue;
			if (higher[ciKey].hi >= lower[ciKey].lo) continue; // intervals overlap: noise, not an inversion
			inversions.push({
				band: higher.band, realized: higher[rateKey],
				below_band: lower.band, below_realized: lower[rateKey],
			});
		}
	}
	return { monotonic: inversions.length === 0, judged_bands: seq.length, inversions: inversions.slice(0, 8) };
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
	// Calibration answers "does a score mean what it claims?", and that only works
	// if both halves speak the same language. Two bugs used to break that:
	//
	//   1. The band's prediction was its own midpoint, i.e. score/100 read as a
	//      percentage. The score line is NOT a percentage: 86 claims P=0.55 and 34
	//      claims P=0.05 (conviction.js SCORE_ANCHORS). Every published table
	//      therefore overstated the engine's claim by up to 4x. probabilityFromScore
	//      converts, so predicted is now what the engine actually said.
	//   2. Realized was the rug-aware win rate, which is NOT the event the model was
	//      trained to predict. That grades the ranking on a stricter question and
	//      makes a calibrated engine look broken. Both now ship side by side:
	//      realized_spike is the trained event (PREDICTED_EVENT: graduated or >= 3x
	//      ATH, a later collapse allowed), realized stays the holder-honest win.
	//
	// Grouping by exact score instead of by band keeps the Brier score exact (each
	// score carries its own claimed probability) and costs at most 101 rows.
	const scoreRows = await sql`
		select
			c.score::int                                                          as score,
			count(*)::int                                                         as n,
			count(*) filter (where o.graduated or o.ath_multiple >= 3)::int       as spikes,
			count(*) filter (where o.graduated or (o.ath_multiple >= 2 and not coalesce(o.rugged, false)))::int as wins
		from oracle_conviction c
		join pump_coin_outcomes o on o.mint = c.mint
		where c.network = ${network}
		  and (o.graduated or o.rugged or o.ath_multiple is not null)
		  ${quoteFilter}
		  ${periodFilter}
		group by 1
		order by 1
	`.catch(() => []);

	const bands = assembleBands(scoreRows);
	const calibration = bands;
	const brier = brierScore(scoreRows);

	// Market baseline: a coin drawn at random from everything Oracle scored.
	const baselineN = scoreRows.reduce((a, r) => a + r.n, 0);
	const baselineWins = scoreRows.reduce((a, r) => a + r.wins, 0);
	const baselineSpikes = scoreRows.reduce((a, r) => a + r.spikes, 0);
	const baselineWinRate = baselineN ? Math.round((baselineWins / baselineN) * 100) : null;
	const baselineSpikeRate = baselineN ? Math.round((baselineSpikes / baselineN) * 100) : null;

	// Edge summary: does conviction actually beat blind buying, and does the ladder
	// climb in the right order? Reported on both metrics, because the engine ranks
	// the spike and the page quotes the clean win.
	const primeRow = rows.find((r) => r.tier === 'prime');
	const primeResolved = primeRow ? primeRow.wins + primeRow.losses : 0;
	const primeWinRate = primeResolved ? Math.round((primeRow.wins / primeResolved) * 100) : null;
	const primeSpikeRate = primeRow?.total ? Math.round((primeRow.three_x / primeRow.total) * 100) : null;
	const primeRugRate = primeRow?.total ? Math.round((primeRow.rugged / primeRow.total) * 100) : null;
	const cleanLadder = ladderCheck(bands, 'realized', 'ci');
	const spikeLadder = ladderCheck(bands, 'realized_spike', 'spike_ci');
	const edge = {
		predicts: PREDICTED_EVENT,
		baseline_win_rate: baselineWinRate,
		baseline_spike_rate: baselineSpikeRate,
		baseline_n: baselineN,
		prime_win_rate: primeWinRate,
		prime_spike_rate: primeSpikeRate,
		prime_rug_rate: primeRugRate,
		prime_lift: (primeWinRate != null && baselineWinRate != null) ? primeWinRate - baselineWinRate : null,
		edge_multiple: (primeWinRate != null && baselineWinRate) ? Number((primeWinRate / baselineWinRate).toFixed(2)) : null,
		spike_edge_multiple: (primeSpikeRate != null && baselineSpikeRate) ? Number((primeSpikeRate / baselineSpikeRate).toFixed(2)) : null,
		monotonic: cleanLadder.monotonic,
		ladder: { clean_win: cleanLadder, spike: spikeLadder },
		brier,
		brier_of: PREDICTED_EVENT.id,
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
			// Rates on the full resolved sample for this tier. spike_rate is the event
			// the score was fitted to predict, rug_rate is the part a holder feels and
			// the score never claimed to rule out. A tier card that shows only one of
			// the three is the reason a 100/prime call on a dead chart reads as a lie.
			spike_rate: r.total ? Math.round((r.three_x / r.total) * 100) : null,
			spike_ci: wilson(r.three_x, r.total),
			rug_rate: r.total ? Math.round((r.rugged / r.total) * 100) : null,
			graduated_rate: r.total ? Math.round((r.graduated / r.total) * 100) : null,
		})),
		aggregate: agg,
		predicts: PREDICTED_EVENT,
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
