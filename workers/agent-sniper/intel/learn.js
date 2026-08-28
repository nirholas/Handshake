// Coin Intelligence - the learning loop.
//
// Watching is only half of "learns from watching". Here we:
//   1. labelOutcomes()  - revisit observed coins after the fact and record what
//      actually happened (graduated / pumped / flat / rugged) as ground truth.
//   2. trainWeights()   - correlate each launch-time signal with good outcomes
//      and persist per-signal weights the scorer reads. The dataset grows, the
//      weights sharpen, the sniper's judgment improves. No black box: weights
//      are plain correlations anyone can inspect.
//
// Run both from a cron (see api/cron or the worker loop). Pure-math helpers are
// exported for testing.

const PUMPFUN_COIN_API = 'https://frontend-api-v3.pump.fun/coins';
const FETCH_TIMEOUT_MS = 4_000;

// Signals we train on - all are ~0..1 (or normalized below). Counts are excluded;
// their information is already captured by the ratio signals.
export const TRAINABLE_SIGNALS = [
	'organic_score', 'bundle_score', 'snipe_ratio', 'coordination_score',
	'timing_entropy', 'concentration_top1', 'concentration_top5', 'concentration_top10',
	'fresh_wallet_ratio', 'bubblemap_connectivity',
];

// Bucket definitions for conditional win-rate explainability.
// Each entry: { col, label, buckets: [{key, test(row) -> bool}] }
// "col" is the column name on the DB row; test() assigns each row to ≤1 bucket.
const BUCKET_DIMS = [
	{
		col: 'bundle_score',
		label: 'Bundle Score',
		buckets: [
			{ key: 'clean',   test: (r) => r.bundle_score != null && r.bundle_score < 0.2 },
			{ key: 'medium',  test: (r) => r.bundle_score != null && r.bundle_score >= 0.2 && r.bundle_score < 0.5 },
			{ key: 'high',    test: (r) => r.bundle_score != null && r.bundle_score >= 0.5 },
			{ key: 'unknown', test: (r) => r.bundle_score == null },
		],
	},
	{
		col: 'organic_score',
		label: 'Organic Score',
		buckets: [
			{ key: 'low',    test: (r) => r.organic_score != null && r.organic_score < 0.3 },
			{ key: 'medium', test: (r) => r.organic_score != null && r.organic_score >= 0.3 && r.organic_score < 0.65 },
			{ key: 'high',   test: (r) => r.organic_score != null && r.organic_score >= 0.65 },
			{ key: 'unknown', test: (r) => r.organic_score == null },
		],
	},
	{
		col: 'quality_score',
		label: 'Quality Score',
		buckets: [
			{ key: '<30',  test: (r) => r.quality_score != null && r.quality_score < 30 },
			{ key: '30-50', test: (r) => r.quality_score != null && r.quality_score >= 30 && r.quality_score < 50 },
			{ key: '50-70', test: (r) => r.quality_score != null && r.quality_score >= 50 && r.quality_score < 70 },
			{ key: '>=70',  test: (r) => r.quality_score != null && r.quality_score >= 70 },
			{ key: 'unknown', test: (r) => r.quality_score == null },
		],
	},
	{
		col: 'bubblemap_connectivity',
		label: 'Bubblemaps Connectivity',
		buckets: [
			{ key: 'low',    test: (r) => r.bubblemap_connectivity != null && r.bubblemap_connectivity < 0.2 },
			{ key: 'medium', test: (r) => r.bubblemap_connectivity != null && r.bubblemap_connectivity >= 0.2 && r.bubblemap_connectivity < 0.5 },
			{ key: 'high',   test: (r) => r.bubblemap_connectivity != null && r.bubblemap_connectivity >= 0.5 },
			{ key: 'unknown', test: (r) => r.bubblemap_connectivity == null },
		],
	},
	{
		col: 'unique_buyers',
		label: 'Unique Buyers',
		buckets: [
			{ key: '<5',    test: (r) => r.unique_buyers != null && r.unique_buyers < 5 },
			{ key: '5-20',  test: (r) => r.unique_buyers != null && r.unique_buyers >= 5 && r.unique_buyers < 20 },
			{ key: '20-50', test: (r) => r.unique_buyers != null && r.unique_buyers >= 20 && r.unique_buyers < 50 },
			{ key: '>=50',  test: (r) => r.unique_buyers != null && r.unique_buyers >= 50 },
		],
	},
	{
		col: 'smart_money_count',
		label: 'Smart Money Count',
		buckets: [
			{ key: '0',   test: (r) => !r.smart_money_count || r.smart_money_count === 0 },
			{ key: '1',   test: (r) => r.smart_money_count === 1 },
			{ key: '2',   test: (r) => r.smart_money_count === 2 },
			{ key: '>=3', test: (r) => r.smart_money_count != null && r.smart_money_count >= 3 },
		],
	},
	{
		col: 'is_news_meme',
		label: 'News Meme',
		buckets: [
			{ key: 'false', test: (r) => !r.is_news_meme },
			{ key: 'true',  test: (r) => !!r.is_news_meme },
		],
	},
	{
		col: 'dev_sold',
		label: 'Dev Sold',
		buckets: [
			{ key: 'false', test: (r) => !r.dev_sold },
			{ key: 'true',  test: (r) => !!r.dev_sold },
		],
	},
	{
		col: 'category',
		label: 'Category',
		// dynamic: each distinct category value becomes its own bucket
		dynamic: true,
	},
];

/**
 * Compute per-signal, per-bucket win-rates from labeled rows.
 * "good" = graduated or pumped. Baseline = overall fraction that are good.
 * Buckets with < MIN_BUCKET_SIZE samples are omitted (noise, not signal).
 *
 * @param {Array} rows - labeled DB rows (need direct column values)
 * @returns {{ [signal]: { [bucket]: { win_rate, count, baseline_win_rate } } }}
 */
export function computeConditionalWinRates(rows) {
	const MIN_BUCKET_SIZE = 5;
	const labels = rows.map((r) => (r.outcome === 'graduated' || r.outcome === 'pumped') ? 1 : 0);
	const baselineWinRate = labels.length ? labels.reduce((s, v) => s + v, 0) / labels.length : 0;

	const result = {};

	for (const dim of BUCKET_DIMS) {
		const dimResult = {};

		if (dim.dynamic) {
			// Category: group by distinct value
			const byValue = {};
			for (let i = 0; i < rows.length; i++) {
				const v = rows[i][dim.col] || 'unknown';
				if (!byValue[v]) byValue[v] = { wins: 0, count: 0 };
				byValue[v].count++;
				byValue[v].wins += labels[i];
			}
			for (const [val, stats] of Object.entries(byValue)) {
				if (stats.count < MIN_BUCKET_SIZE) continue;
				dimResult[val] = {
					win_rate: Number((stats.wins / stats.count).toFixed(4)),
					count: stats.count,
					baseline_win_rate: Number(baselineWinRate.toFixed(4)),
				};
			}
		} else {
			for (const bucket of dim.buckets) {
				let wins = 0, count = 0;
				for (let i = 0; i < rows.length; i++) {
					if (bucket.test(rows[i])) { count++; wins += labels[i]; }
				}
				if (count < MIN_BUCKET_SIZE) continue;
				dimResult[bucket.key] = {
					win_rate: Number((wins / count).toFixed(4)),
					count,
					baseline_win_rate: Number(baselineWinRate.toFixed(4)),
				};
			}
		}

		if (Object.keys(dimResult).length) result[dim.col] = dimResult;
	}

	return result;
}

let _sqlPromise = null;
async function getSql() {
	if (_sqlPromise) return _sqlPromise;
	_sqlPromise = import('../../../api/_lib/db.js').then((m) => m.sql).catch(() => null);
	return _sqlPromise;
}

async function fetchCoin(mint) {
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const r = await fetch(`${PUMPFUN_COIN_API}/${encodeURIComponent(mint)}`, {
			signal: ctrl.signal,
			headers: { accept: 'application/json', 'user-agent': 'three.ws-coin-intel/1' },
		});
		if (!r.ok) return null;
		return await r.json();
	} catch { return null; } finally { clearTimeout(tid); }
}

function isGraduated(c) {
	return c?.complete === true || !!c?.raydium_pool || !!c?.pump_swap_pool;
}

/**
 * Decide the outcome bucket for one coin from its current pump.fun state and the
 * market cap we recorded when we first saw it.
 * @returns {{ outcome, graduated, rugged, ath_multiple, last_market_cap_usd, ath_market_cap_usd }}
 */
// ── The label constants, and why they are what they are ──────────────────────
//
// A pump.fun bonding curve with no real reserves is worth a fixed number of SOL:
// the launch parameters put 30 virtual SOL against 1,073,000,191 virtual tokens
// over a 1e9 supply, so an untouched curve prices at
//   30 * 1e9 / 1_073_000_191 = 27.958993 SOL
// and no coin on the curve can ever be worth less. We first see a coin inside
// its opening 90 seconds, when its cap is 28-38 SOL, which means the floor is
// 73-99% of first sight.
//
// That single fact broke the old rug test. It asked whether a coin had fallen to
// 25% of first sight, which the floor makes unreachable, and then fell back on
// whether its market cap was under a hardcoded $3,000, i.e. on whether SOL was
// above roughly $107.3 that day. Of 206,428 coins it called rugged, 206,419 were
// under $3,000; of 25,180 it called survivors, the cheapest was exactly $3,000.
// Same dead curves, sorted by the SOL price. Everything downstream that
// subtracted rugs from a win rate was reading a price feed.
//
// The replacement is measured against what a holder paid, in ratios where the
// SOL price cancels. See the migration
// 20260828170000_oracle_price_independent_labels.sql for the full write-up.
const CURVE_FLOOR_SOL = 30 * 1e9 / 1_073_000_191;
const CURVE_FLOOR_TOLERANCE = 0.02;
/** Down more than half from first sight is the line between a dud and a rug. */
const RUG_HOLD_MULTIPLE = 0.5;
/**
 * Bumped whenever the labeling RULE changes, so a consumer can refuse rows an
 * older rule produced instead of silently averaging two incompatible questions.
 * 1 = the USD-threshold rule described above. 2 = price-independent ratios.
 */
export const LABEL_VERSION = 2;

export function deriveOutcome(coin, mcSolFirstSeen) {
	if (!coin) {
		return {
			outcome: 'unknown', graduated: null, rugged: null, ath_multiple: null,
			last_market_cap_usd: null, ath_market_cap_usd: null,
			retained: null, hold_multiple: null, at_floor: null, label_version: LABEL_VERSION,
		};
	}

	const graduated = isGraduated(coin);
	const usdMc = typeof coin.usd_market_cap === 'number' ? coin.usd_market_cap : null;
	const solMc = typeof coin.market_cap === 'number' ? coin.market_cap : null;
	const athUsd = typeof coin.ath_market_cap === 'number' ? coin.ath_market_cap
		: typeof coin.ath_market_cap_usd === 'number' ? coin.ath_market_cap_usd : usdMc;

	// Derive the coin's own SOL price (usd/sol) to keep the multiple unit-consistent
	// with the SOL market cap we stored at first sight.
	const solPrice = usdMc != null && solMc ? usdMc / solMc : null;
	const athSol = athUsd != null && solPrice ? athUsd / solPrice : null;
	const ath_multiple = athSol != null && mcSolFirstSeen > 0 ? athSol / mcSolFirstSeen : null;

	// Two ratios that the price of SOL cannot move, because both dollar figures
	// come out of the same API response and the price cancels between them:
	//   retained      what share of its own peak the coin still holds
	//   hold_multiple what a holder who bought at first sight would have now
	// This is the whole fix. See the header note on RUG_HOLD_MULTIPLE.
	const retained = athUsd > 0 && usdMc != null ? usdMc / athUsd : null;
	const hold_multiple = ath_multiple != null && retained != null ? ath_multiple * retained : null;

	// Exact, and independent of both: a pump.fun curve holding no real reserves
	// is worth CURVE_FLOOR_SOL, so a non-graduated coin sitting there has had
	// every lamport taken back out of it. Only computable when the API returns a
	// SOL market cap, which is why it is a bonus signal and not the label.
	const at_floor = !graduated && solMc != null ? solMc <= CURVE_FLOOR_SOL * (1 + CURVE_FLOOR_TOLERANCE) : null;

	// A rug is a collapse a holder eats, so it is measured against what they paid
	// rather than against a dollar figure. A coin that never moved is a dud, not a
	// rug: nobody was taken, there was nothing to take.
	const rugged = !graduated && hold_multiple != null && hold_multiple <= RUG_HOLD_MULTIPLE;

	let outcome;
	if (graduated) outcome = 'graduated';
	else if (ath_multiple != null && ath_multiple >= 3) outcome = 'pumped';
	else if (rugged) outcome = 'rugged';
	else outcome = 'flat';

	return {
		outcome, graduated, rugged, ath_multiple,
		last_market_cap_usd: usdMc, ath_market_cap_usd: athUsd,
		retained, hold_multiple, at_floor, label_version: LABEL_VERSION,
	};
}

/**
 * Overlay our OWN graduation ground truth on a derived outcome.
 *
 * deriveOutcome reads one source: a live pump.fun coin lookup. That source fails
 * open to 'unknown' on any hiccup (404, 429, timeout), and it is the only thing
 * that ever decided whether a coin graduated - even though we independently
 * index every graduation ourselves into pumpfun_graduations. A mint present in
 * that feed graduated; that is a fact, not an opinion, and it stays true when
 * the coin API is rate-limited or has aged the mint out of its index. Applying
 * it here rescues the single most valuable label from a third party's uptime.
 *
 * @param {ReturnType<typeof deriveOutcome>} outcome
 * @param {{ ath_market_cap?:number, market_cap_usd?:number }|null|undefined} grad
 *   the pumpfun_graduations row for this mint, if we indexed one.
 */
export function applyGraduationTruth(outcome, grad) {
	if (!grad) return outcome;
	const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
	const ath = outcome.ath_market_cap_usd ?? num(grad.ath_market_cap);
	const last = outcome.last_market_cap_usd ?? num(grad.market_cap_usd);
	const retained = ath > 0 && last != null ? last / ath : outcome.retained;
	return {
		...outcome,
		outcome: 'graduated',
		graduated: true,
		// A graduated coin is never a rug, same invariant deriveOutcome holds,
		// and it is never sitting on an empty bonding curve either: it left one.
		rugged: false,
		at_floor: false,
		ath_market_cap_usd: ath,
		last_market_cap_usd: last,
		retained,
		hold_multiple: outcome.ath_multiple != null && retained != null
			? outcome.ath_multiple * retained
			: outcome.hold_multiple,
		label_version: LABEL_VERSION,
	};
}

// How many pump.fun coin lookups run at once inside labelOutcomes. The coin API
// tolerates modest parallelism fine; 8 keeps a 500-coin batch under ~30s instead
// of the serial ~8 minutes that let the labeler drown in the firehose (labels
// stopped entirely for 11 days in Aug 2026 because inflow outpaced a serial,
// 100-per-15-min loop).
const LABEL_CONCURRENCY = 8;

// 'unknown' means "the coin API did not answer us", never "this coin had no
// outcome" - fetchCoin returns null on a 404, a 429, and a timeout alike. The
// row was still written, and the candidate query only ever looked for coins with
// NO outcome row, so a single throttled wave used to bury those mints as
// permanently unjudged: excluded from the wallet graph
// (recompute-wallet-graph.js filters outcome <> 'unknown') and from the radar's
// proven-creator query, with nothing that could ever revisit them. These two
// bounds make 'unknown' provisional instead: retried on a backoff, and only
// while the coin is young enough that a verdict is still worth having.
const RELABEL_AFTER_MINUTES = 6 * 60;
const RELABEL_MAX_AGE_DAYS = 7;
// Retry budget, ADDED to the caller's limit rather than taken out of it: the
// primary budget has to outrun a ~30k/day firehose, so retries must never
// cannibalize it.
const RELABEL_BUDGET_RATIO = 0.2;

/**
 * Label coins observed ≥ minAgeMinutes ago that have no outcome yet, plus a
 * bounded tail of coins an earlier run could only mark 'unknown'.
 *
 * Throughput is load-bearing: the firehose adds ~30k coins/day and every one of
 * them needs a verdict for the Oracle/intel learners to have ground truth.
 * Lookups run LABEL_CONCURRENCY at a time and results land in batched upserts.
 * Each labeled coin is also snapshotted into oracle_training_set, the durable
 * (never-pruned) copy of (launch-time features, outcome) that survives the
 * db-retention window pump_coin_intel/pump_coin_outcomes live under.
 *
 * A deadline bounds the wall clock (the coin API can degrade to per-call
 * timeouts); whatever isn't reached this run is picked up by the next.
 *
 * @returns {Promise<{ labeled: number, relabeled: number }>}
 */
export async function labelOutcomes({ network = 'mainnet', limit = 100, minAgeMinutes = 60, deadlineMs = 180_000 } = {}) {
	const sql = await getSql();
	if (!sql) return { labeled: 0, relabeled: 0 };
	const startedAt = Date.now();

	const primaryLimit = Math.max(1, Math.min(2000, limit | 0));
	const retryLimit = Math.max(1, Math.round(primaryLimit * RELABEL_BUDGET_RATIO));

	const [fresh, retries] = await Promise.all([
		sql`
			select i.mint, i.signals, i.category, i.first_seen_at,
			       wr.creator_count, wr.creator_wins, wr.dump_rate
			from pump_coin_intel i
			left join pump_coin_outcomes o on o.mint = i.mint
			left join wallet_reputation wr on wr.wallet = i.creator and wr.network = i.network
			where i.network = ${network}
			  and o.mint is null
			  and i.first_seen_at <= now() - (${minAgeMinutes} || ' minutes')::interval
			order by i.first_seen_at asc
			limit ${primaryLimit}
		`,
		// Oldest-stamped unknown first, so the retry tail drains FIFO and no coin
		// is perpetually overtaken.
		sql`
			select i.mint, i.signals, i.category, i.first_seen_at,
			       wr.creator_count, wr.creator_wins, wr.dump_rate
			from pump_coin_outcomes o
			join pump_coin_intel i on i.mint = o.mint
			left join wallet_reputation wr on wr.wallet = i.creator and wr.network = i.network
			where i.network = ${network}
			  and o.outcome = 'unknown'
			  and o.labeled_at <= now() - (${RELABEL_AFTER_MINUTES} || ' minutes')::interval
			  and i.first_seen_at > now() - (${RELABEL_MAX_AGE_DAYS} || ' days')::interval
			order by o.labeled_at asc
			limit ${retryLimit}
		`,
	]);
	const rows = [...fresh, ...retries];
	const retryMints = new Set(retries.map((r) => r.mint));

	// Our own graduation index - authoritative, and unaffected by whatever the
	// coin API is doing this minute. One round trip for the whole batch.
	const gradByMint = new Map();
	if (rows.length) {
		try {
			const grads = await sql`
				select mint, ath_market_cap, market_cap_usd
				from pumpfun_graduations
				where mint = any(${rows.map((r) => r.mint)})
			`;
			for (const g of grads) gradByMint.set(g.mint, g);
		} catch (err) {
			// Losing the overlay costs accuracy on this batch, never the batch.
			console.warn('[coin-intel] graduation truth read failed:', err?.message);
		}
	}

	// Fetch pump.fun state concurrently in fixed-size waves.
	const results = [];
	for (let i = 0; i < rows.length; i += LABEL_CONCURRENCY) {
		if (Date.now() - startedAt > deadlineMs) break;
		const wave = rows.slice(i, i + LABEL_CONCURRENCY);
		const coins = await Promise.all(wave.map((row) => fetchCoin(row.mint)));
		for (let j = 0; j < wave.length; j++) {
			const row = wave[j];
			const mcSol = Number(row.signals?.mc_sol_first_seen) || 0;
			results.push({ row, o: applyGraduationTruth(deriveOutcome(coins[j], mcSol), gradByMint.get(row.mint)) });
		}
	}

	let labeled = 0;
	let relabeled = 0;
	const BATCH = 50;
	for (let i = 0; i < results.length; i += BATCH) {
		const batch = results.slice(i, i + BATCH);
		try {
			await sql`
				insert into pump_coin_outcomes (
					mint, graduated, rugged, ath_market_cap_usd, ath_multiple,
					last_market_cap_usd, outcome, retained, hold_multiple, at_floor, label_version
				)
				select u.mint, u.graduated, u.rugged, u.ath_market_cap_usd,
				       u.ath_multiple, u.last_market_cap_usd, u.outcome,
				       u.retained, u.hold_multiple, u.at_floor, u.label_version
				from unnest(
					${batch.map((b) => b.row.mint)}::text[],
					${batch.map((b) => b.o.graduated)}::boolean[],
					${batch.map((b) => b.o.rugged)}::boolean[],
					${batch.map((b) => b.o.ath_market_cap_usd)}::double precision[],
					${batch.map((b) => b.o.ath_multiple)}::double precision[],
					${batch.map((b) => b.o.last_market_cap_usd)}::double precision[],
					${batch.map((b) => b.o.outcome)}::text[],
					${batch.map((b) => b.o.retained)}::double precision[],
					${batch.map((b) => b.o.hold_multiple)}::double precision[],
					${batch.map((b) => b.o.at_floor)}::boolean[],
					${batch.map((b) => b.o.label_version ?? LABEL_VERSION)}::smallint[]
				) as u(mint, graduated, rugged, ath_market_cap_usd, ath_multiple, last_market_cap_usd,
				       outcome, retained, hold_multiple, at_floor, label_version)
				on conflict (mint) do update set
					graduated = excluded.graduated, rugged = excluded.rugged,
					ath_market_cap_usd = excluded.ath_market_cap_usd,
					ath_multiple = excluded.ath_multiple,
					last_market_cap_usd = excluded.last_market_cap_usd,
					outcome = excluded.outcome,
					retained = excluded.retained,
					hold_multiple = excluded.hold_multiple,
					at_floor = excluded.at_floor,
					label_version = excluded.label_version,
					labeled_at = now()
			`;
			labeled += batch.length;
			// A retry only counts as rescued when it came back with a real verdict;
			// one that is still 'unknown' just had its backoff re-armed.
			relabeled += batch.filter((b) => retryMints.has(b.row.mint) && b.o.outcome !== 'unknown').length;
		} catch (err) {
			console.warn('[coin-intel] label outcome batch failed:', err?.message);
			continue;
		}

		// Durable training snapshot: only for coins with a real verdict.
		const judged = batch.filter((b) => b.o.outcome && b.o.outcome !== 'unknown');
		if (!judged.length) continue;
		try {
			await sql`
				insert into oracle_training_set (
					mint, network, features, category,
					creator_launches, creator_wins, creator_dump_rate,
					outcome, graduated, rugged, ath_multiple, first_seen_at,
					retained, hold_multiple, label_version
				)
				select u.mint, ${network}, u.features::jsonb, u.category,
				       u.creator_launches, u.creator_wins, u.creator_dump_rate,
				       u.outcome, u.graduated, u.rugged, u.ath_multiple, u.first_seen_at,
				       u.retained, u.hold_multiple, u.label_version
				from unnest(
					${judged.map((b) => b.row.mint)}::text[],
					${judged.map((b) => JSON.stringify(b.row.signals || {}))}::text[],
					${judged.map((b) => b.row.category)}::text[],
					${judged.map((b) => b.row.creator_count)}::int[],
					${judged.map((b) => b.row.creator_wins)}::int[],
					${judged.map((b) => b.row.dump_rate)}::real[],
					${judged.map((b) => b.o.outcome)}::text[],
					${judged.map((b) => b.o.graduated)}::boolean[],
					${judged.map((b) => b.o.rugged)}::boolean[],
					${judged.map((b) => b.o.ath_multiple)}::double precision[],
					${judged.map((b) => b.row.first_seen_at)}::timestamptz[],
					${judged.map((b) => b.o.retained)}::double precision[],
					${judged.map((b) => b.o.hold_multiple)}::double precision[],
					${judged.map((b) => b.o.label_version ?? LABEL_VERSION)}::smallint[]
				) as u(mint, features, category, creator_launches, creator_wins, creator_dump_rate,
				       outcome, graduated, rugged, ath_multiple, first_seen_at,
				       retained, hold_multiple, label_version)
				-- This clause used to do nothing on conflict, which meant a training
				-- label could never be corrected once written: a row judged by a broken
				-- rule stayed judged by it forever and the corpus could not heal even
				-- after the rule was fixed. Only ever upgrade, never downgrade, so a
				-- stale worker replaying an old rule cannot walk a corrected row back.
				on conflict (mint, network) do update set
					outcome = excluded.outcome,
					graduated = excluded.graduated,
					rugged = excluded.rugged,
					ath_multiple = excluded.ath_multiple,
					retained = excluded.retained,
					hold_multiple = excluded.hold_multiple,
					label_version = excluded.label_version,
					labeled_at = now()
				where excluded.label_version >= oracle_training_set.label_version
			`;
		} catch (err) {
			console.warn('[coin-intel] training snapshot batch failed:', err?.message);
		}
	}
	return { labeled, relabeled };
}

// Pearson correlation of a signal against a binary good/bad label. Returns 0
// when there's no variance (degenerate) - a 0 weight, i.e. "no information".
export function correlation(pairs) {
	const xs = [], ys = [];
	for (const [x, y] of pairs) {
		if (x == null || !Number.isFinite(x)) continue;
		xs.push(x); ys.push(y);
	}
	const n = xs.length;
	if (n < 5) return 0;
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let num = 0, dx = 0, dy = 0;
	for (let i = 0; i < n; i++) {
		const ex = xs[i] - mx, ey = ys[i] - my;
		num += ex * ey; dx += ex * ex; dy += ey * ey;
	}
	if (dx === 0 || dy === 0) return 0;
	const r = num / Math.sqrt(dx * dy);
	return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : 0;
}

/**
 * Recompute per-signal weights from all labeled coins and persist them.
 * "good" = graduated or pumped. Skips quietly until there's enough signal.
 *
 * Also computes conditional win-rates (per-bucket explainability) and stores
 * them alongside the Pearson weights so agents and humans can inspect "why."
 *
 * @returns {Promise<{ trained: boolean, sample_size: number, weights?: object, conditional_win_rates?: object }>}
 */
export async function trainWeights({ network = 'mainnet', minSamples = 50, maxSamples = 20_000 } = {}) {
	const sql = await getSql();
	if (!sql) return { trained: false, sample_size: 0 };

	// Pull signals JSONB + all direct columns needed for conditional bucketing.
	// Bridge 1: LEFT JOIN oracle_realized_outcomes so a coin the fleet actually
	// traded carries its REAL realized win/loss (ro.realized_win). Realized PnL is
	// higher-fidelity ground truth than the chart-based ATH label, so the label
	// below prefers it when present.
	//
	// Bounded to the freshest maxSamples labeled coins: the unbounded form OOMed
	// the cron once the labeled set passed ~64k rows (each carries the full
	// signals JSONB), and launch-meta regimes shift (e.g. the 2026-07-21 BOOST
	// cutover), so the newest window is both the safe and the better training set.
	const cap = Math.max(1, Math.min(200_000, maxSamples | 0));
	const rows = await sql`
		select
			i.signals, o.outcome, ro.realized_win,
			i.bundle_score, i.organic_score, i.quality_score,
			i.bubblemap_connectivity, i.unique_buyers,
			i.smart_money_count, i.is_news_meme,
			i.dev_sold, i.category
		from pump_coin_intel i
		join pump_coin_outcomes o on o.mint = i.mint
		left join oracle_realized_outcomes ro on ro.mint = i.mint and ro.network = i.network
		where i.network = ${network} and o.outcome <> 'unknown'
		order by i.first_seen_at desc
		limit ${cap}
	`;
	if (rows.length < minSamples) return { trained: false, sample_size: rows.length };

	// Pearson correlation weights. A traded coin's realized win/loss overrides the
	// chart label; untraded coins fall back to graduated/pumped as before.
	const labels = rows.map((r) => (
		r.realized_win != null ? Number(r.realized_win)
			: ((r.outcome === 'graduated' || r.outcome === 'pumped') ? 1 : 0)
	));
	const weights = {};
	for (const key of TRAINABLE_SIGNALS) {
		const pairs = rows.map((r, i) => [r.signals?.[key], labels[i]]);
		weights[key] = Number(correlation(pairs).toFixed(4));
	}

	// Per-signal conditional win-rates (explainability)
	const conditional_win_rates = computeConditionalWinRates(rows);

	await sql`
		insert into pump_intel_weights (network, weights, sample_size, conditional_win_rates)
		values (
			${network},
			${JSON.stringify(weights)}::jsonb,
			${rows.length},
			${JSON.stringify(conditional_win_rates)}::jsonb
		)
	`;
	return { trained: true, sample_size: rows.length, weights, conditional_win_rates };
}

/**
 * Turn signals + learned weights into a 0..1 learned score the scorer can blend.
 * With no weights yet, returns null so the scorer falls back to its baseline.
 */
export function learnedScore(signals, weights) {
	if (!weights || !signals) return null;
	let dot = 0, used = 0;
	for (const key of TRAINABLE_SIGNALS) {
		const w = weights[key];
		const v = signals[key];
		if (w == null || v == null || !Number.isFinite(v)) continue;
		dot += w * v; used++;
	}
	if (!used) return null;
	// Logistic squash to 0..1.
	return Number((1 / (1 + Math.exp(-dot))).toFixed(4));
}
