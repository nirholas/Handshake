// GET /api/pump/intel
// --------------------
// Read surface for the Coin Intelligence engine. The engine
// (workers/agent-sniper/intel) watches every pump.fun launch, classifies it,
// aggregates its opening trades into per-wallet stats, derives organic-vs-bundle
// signals + a 0..100 quality score, and labels outcomes after the fact. It WRITES
// pump_coin_intel / pump_coin_wallets / pump_coin_outcomes / pump_intel_weights.
// This endpoint READS them for the /coin-intel dashboard and any agent that wants
// the same intelligence the sniper trades on: nothing here writes.
//
// Views (query param `view`, default `feed`):
//   ?mint=<mint>            one coin: classification + signals + outcome + top wallets (bubble-map)
//   ?view=feed              recent observed coins, newest first (filters: category, minQuality, verdict, q)
//   ?view=leaderboard       highest-quality recent coins + confirmed winners (graduated/pumped)
//   ?view=learning          learned per-signal weights + outcome distribution (what the model learned)
//   ?view=traders           cross-coin wallet reputation: who trades these launches, and how well
//
// Public, cacheable briefly. No auth: this is read-only market intelligence.
// Degrades gracefully (200 with degraded:true) if the engine tables don't exist
// yet, so the dashboard can render its "engine warming up" state instead of 500ing.

import { cors, json, method, wrap, error } from '../_lib/http.js';
import { sql, isDbUnavailableError } from '../_lib/db.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const VIEWS = new Set(['feed', 'leaderboard', 'learning', 'traders']);

const num = (v) => {
	if (v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};
const sol = (lamports) => {
	const n = num(lamports);
	return n == null ? null : n / LAMPORTS_PER_SOL;
};
const round = (x, p = 4) => {
	if (x == null || !Number.isFinite(x)) return null;
	const f = 10 ** p;
	return Math.round(x * f) / f;
};

// Human verdict derived from the transparent quality score + hard risk flags.
// Hard flags (a coordinated launch, a dev dump, a single whale owning the float)
// force "avoid" regardless of score: those are the ones that lose money.
const HARD_FLAGS = ['bundle_launch', 'dev_dumped', 'single_whale'];
function deriveVerdict(qualityScore, riskFlags) {
	const flags = Array.isArray(riskFlags) ? riskFlags : [];
	const q = num(qualityScore) ?? 0;
	const hard = flags.some((f) => HARD_FLAGS.includes(f));
	if (hard || q < 25) return { key: 'avoid', label: 'Avoid', tone: 'danger' };
	if (q < 50 || flags.length) return { key: 'caution', label: 'Caution', tone: 'warn' };
	if (q < 72) return { key: 'watch', label: 'Watch', tone: 'neutral' };
	return { key: 'strong', label: 'Strong', tone: 'success' };
}

// Classify one trader within a single coin's order book / holder list, from its
// footprint on that coin. Labels stack: a wallet can be both a sniper and a whale.
//   creator : the coin's deployer
//   bundled : shares a SOL funder with ≥1 other buyer (coordinated launch wallet)
//   sniper  : first trade landed within seconds of the coin appearing
//   whale   : captured a large share of buy volume
//   dumped  : sold ~all of what it bought (paper hands / exit)
//   holding : bought and never sold (diamond)
//   flipped : bought and partially sold
function classifyWalletInCoin(w, { coinSeenMs, bundledClusters }) {
	const labels = [];
	if (w.is_creator) labels.push('creator');
	if (w.cluster != null && bundledClusters.has(w.cluster)) labels.push('bundled');
	if (coinSeenMs && w.first_seen_at && (w.buy_count || 0) > 0) {
		const delta = new Date(w.first_seen_at).getTime() - coinSeenMs;
		if (delta >= -2000 && delta <= 6000) labels.push('sniper');
	}
	if ((w.share || 0) >= 0.15) labels.push('whale');
	const buy = w.buy_sol || 0;
	const sellv = w.sell_sol || 0;
	if ((w.sell_count || 0) === 0 && (w.buy_count || 0) > 0) labels.push('holding');
	else if ((w.sell_count || 0) > 0 && sellv >= buy * 0.8) labels.push('dumped');
	else if ((w.sell_count || 0) > 0) labels.push('flipped');
	return labels;
}

// Shape a pump_coin_intel row into a stable JSON record for the UI/agents.
function shapeCoin(r) {
	const signals = r.signals && typeof r.signals === 'object' ? r.signals : {};
	const riskFlags = Array.isArray(r.risk_flags) ? r.risk_flags : [];
	const tags = Array.isArray(r.tags) ? r.tags : [];
	const qualityScore = num(r.quality_score);
	const firstSeenMs = r.first_seen_at ? new Date(r.first_seen_at).getTime() : null;
	return {
		mint: r.mint,
		network: r.network || 'mainnet',
		symbol: r.symbol || null,
		name: r.name || null,
		creator: r.creator || null,
		image_uri: r.image_uri || null,
		description: r.description || null,
		twitter: r.twitter || null,
		telegram: r.telegram || null,
		website: r.website || null,
		has_socials: !!(r.twitter || r.telegram || r.website),

		// classification: the "what kind of coin is this" answer
		category: r.category || 'unknown',
		tags,
		narrative: r.narrative || null,
		is_news_meme: tags.includes('news') || r.category === 'news',
		classify_confidence: num(r.classify_confidence),
		classify_source: r.classify_source || null,

		// scores
		quality_score: qualityScore,
		verdict: deriveVerdict(qualityScore, riskFlags),
		risk_flags: riskFlags,

		// headline signals (0..1) the UI charts directly
		organic_score: round(num(r.organic_score)),
		bundle_score: round(num(r.bundle_score)),
		snipe_ratio: round(num(r.snipe_ratio)),
		concentration_top10: round(num(r.concentration_top10)),
		concentration_top1: round(num(signals.concentration_top1)),
		coordination_score: round(num(signals.coordination_score)),
		timing_entropy: round(num(signals.timing_entropy)),
		fresh_wallet_ratio: round(num(r.fresh_wallet_ratio)),
		bubblemap_connectivity: round(num(r.bubblemap_connectivity)),

		// trade footprint
		dev_buy_sol: round(sol(r.dev_buy_lamports)),
		dev_sold: !!r.dev_sold,
		unique_buyers: num(r.unique_buyers) ?? 0,
		unique_sellers: num(r.unique_sellers) ?? 0,
		buy_count: num(r.buy_count) ?? 0,
		sell_count: num(r.sell_count) ?? 0,
		buy_volume_sol: round(sol(r.buy_volume_lamports)),
		sell_volume_sol: round(sol(r.sell_volume_lamports)),
		largest_buy_sol: round(sol(r.largest_buy_lamports)),
		buy_sell_ratio: num(signals.buy_sell_ratio),

		observation_seconds: num(r.observation_seconds),
		first_seen_at: r.first_seen_at || null,
		first_seen_at_ms: firstSeenMs,
		created_at: r.created_at || null,

		// full structured signals for the detail drawer (already JSON)
		signals,
	};
}

// Stable column projection: explicit so added engine columns never break us and
// missing ones surface as a clean error we can degrade on.
// Plain string (not a sql fragment) so this module can load without DATABASE_URL.
const COIN_COLS =
	'mint, network, symbol, name, creator, image_uri, description, twitter, telegram, website, ' +
	'created_at, first_seen_at, observation_seconds, ' +
	'dev_buy_lamports, dev_sold, buy_count, sell_count, ' +
	'buy_volume_lamports, sell_volume_lamports, unique_buyers, unique_sellers, largest_buy_lamports, ' +
	'signals, bundle_score, organic_score, snipe_ratio, concentration_top10, ' +
	'fresh_wallet_ratio, bubblemap_connectivity, quality_score, risk_flags, ' +
	'category, tags, narrative, classify_confidence, classify_source';

// Tagged-template helper: prepends the column projection so each query site stays
// focused on the WHERE/ORDER-BY without duplicating the column list.
// Usage: coinSql`where mint = ${mint} and network = ${net} limit 1`
function coinSql(statics, ...params) {
	const merged = [`select ${COIN_COLS} from pump_coin_intel ${statics[0]}`, ...statics.slice(1)];
	return sql(merged, ...params);
}

// ── one coin: full intel + outcome + wallet bubble-map ───────────────────────
async function getCoin(mint, network) {
	const [row] = await coinSql`
		where mint = ${mint} and network = ${network} limit 1
	`;
	if (!row) return { found: false };

	const coin = shapeCoin(row);

	// Outcome (labeled after the fact: may not exist yet).
	let outcome = null;
	try {
		const [o] = await sql`
			select outcome, graduated, rugged, ath_market_cap_usd, ath_multiple, last_market_cap_usd, labeled_at
			from pump_coin_outcomes where mint = ${mint} limit 1
		`;
		if (o) {
			outcome = {
				outcome: o.outcome || 'unknown',
				graduated: o.graduated,
				rugged: o.rugged,
				ath_market_cap_usd: num(o.ath_market_cap_usd),
				ath_multiple: round(num(o.ath_multiple), 2),
				last_market_cap_usd: num(o.last_market_cap_usd),
				labeled_at: o.labeled_at || null,
			};
		}
	} catch { /* outcomes table absent — fine */ }

	// Top wallets → classified order-book/holder list + bubble-map. Cluster by
	// shared SOL funder (bubblemaps-lite) and label each trader by behavior.
	let wallets = [];
	let clusters = [];
	try {
		const rows = await sql`
			select wallet, buy_count, sell_count, buy_lamports, sell_lamports, is_creator, funder, first_seen_at
			from pump_coin_wallets where mint = ${mint}
			order by buy_lamports desc limit 80
		`;
		const funderToCluster = new Map();
		wallets = rows.map((w) => {
			const buySol = sol(w.buy_lamports) ?? 0;
			const sellSol = sol(w.sell_lamports) ?? 0;
			const netSol = Math.max(0, buySol - sellSol);
			let cluster = null;
			if (w.funder) {
				if (!funderToCluster.has(w.funder)) funderToCluster.set(w.funder, funderToCluster.size);
				cluster = funderToCluster.get(w.funder);
			}
			return {
				wallet: w.wallet,
				is_creator: !!w.is_creator,
				buy_sol: round(buySol),
				sell_sol: round(sellSol),
				net_sol: round(netSol),
				buy_count: num(w.buy_count) ?? 0,
				sell_count: num(w.sell_count) ?? 0,
				funder: w.funder || null,
				cluster,
				first_seen_at: w.first_seen_at || null,
			};
		});
		// Summarize multi-wallet funder clusters (the bundle tell, visualized).
		const byCluster = new Map();
		for (const w of wallets) {
			if (w.cluster == null) continue;
			const c = byCluster.get(w.cluster) || { cluster: w.cluster, funder: w.funder, wallets: 0, net_sol: 0 };
			c.wallets++;
			c.net_sol = round((c.net_sol || 0) + (w.net_sol || 0));
			byCluster.set(w.cluster, c);
		}
		clusters = [...byCluster.values()].filter((c) => c.wallets >= 2).sort((a, b) => b.wallets - a.wallets);

		// Classify each trader in this coin's book/holder list.
		const bundledClusters = new Set(clusters.map((c) => c.cluster));
		const totalBuy = wallets.reduce((s, w) => s + (w.buy_sol || 0), 0) || 1;
		const coinSeenMs = coin.first_seen_at_ms;
		for (const w of wallets) {
			w.share = round((w.buy_sol || 0) / totalBuy);
			w.labels = classifyWalletInCoin(w, { coinSeenMs, bundledClusters });
		}
	} catch { /* wallets table absent — fine */ }

	return { found: true, coin, outcome, wallets, clusters };
}

// ── recent feed (the live radar) ─────────────────────────────────────────────
// How deep to look when a filter can only be evaluated after a row is shaped.
// `verdict` is derived in JS from quality_score + risk_flags, so it can't be a
// WHERE clause; filtering only the newest `limit` rows made ?verdict=strong
// &limit=60 answer with a single coin on a busy feed, which reads as "the engine
// found nothing" rather than "you were shown page one". Scan a wider recent
// window, then slice to the requested page after the filter.
const FEED_SCAN_CAP = 600;
// Escape the LIKE metacharacters so a caller searching for "100%" or "a_b" gets
// those literal strings back instead of a wildcard match. Postgres' default
// LIKE escape character is the backslash.
const likeNeedle = (s) => `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

async function getFeed({ network, limit, category, minQuality, verdict, q }) {
	const cap = Math.max(1, Math.min(120, limit || 60));
	// `q` IS expressible in SQL, so push it down rather than post-filtering: a
	// search has to reach the whole observed feed, not only its newest page.
	const needle = q ? likeNeedle(q) : null;
	const scan = verdict ? Math.min(FEED_SCAN_CAP, cap * 8) : cap;
	const rows = await coinSql`
		where network = ${network}
		  and (${category}::text is null or category = ${category})
		  and (${minQuality}::int is null or quality_score >= ${minQuality})
		  and (${needle}::text is null
		       or name ilike ${needle} or symbol ilike ${needle} or mint ilike ${needle})
		order by first_seen_at desc
		limit ${scan}
	`;
	let coins = rows.map(shapeCoin);
	if (verdict) coins = coins.filter((c) => c.verdict.key === verdict);
	return { coins: coins.slice(0, cap) };
}

// ── leaderboard: best-quality recent + confirmed winners ─────────────────────
async function getLeaderboard({ network, limit }) {
	const cap = Math.max(1, Math.min(50, limit || 20));
	const topRows = await coinSql`
		where network = ${network} and quality_score is not null
		  and first_seen_at >= now() - interval '24 hours'
		order by quality_score desc, first_seen_at desc
		limit ${cap}
	`;
	let winners = [];
	try {
		const WIN_COLS = COIN_COLS.split(', ').map((c) => `i.${c.trim()}`).join(', ');
		const winStatics = [
			`select ${WIN_COLS} from pump_coin_intel i join pump_coin_outcomes o on o.mint = i.mint where i.network = `,
			` and o.outcome in ('graduated','pumped') order by o.ath_multiple desc nulls last, o.labeled_at desc limit `,
			'',
		];
		const winRows = await sql(winStatics, network, cap);
		winners = winRows.map(shapeCoin);
	} catch { /* outcomes absent — no winners yet */ }
	return { top: topRows.map(shapeCoin), winners };
}

// ── traders: classify external wallets across every observed coin ────────────
// Aggregates the per-coin wallet ledger into a cross-coin reputation per trader,
// then labels it. win_rate is real: of this wallet's coins that the engine has
// actually labeled, the share that graduated or pumped. It is null until at
// least one of them is labeled, and `labeled` ships alongside it so a caller can
// see how thin the sample is; the smart_money label needs 3 labeled coins.
//   smart_money: proven win-rate across enough labeled coins
//   whale      : large lifetime buy volume
//   serial     : trades a high number of distinct coins
//   creator    : has deployed at least one observed coin
async function getTraders({ network, limit }) {
	const cap = Math.max(1, Math.min(100, limit || 40));
	let traders = [];
	try {
		const rows = await sql`
			select w.wallet,
				count(distinct w.mint)::int as coins,
				sum(w.buy_lamports)::numeric as buy_lamports,
				sum(w.sell_lamports)::numeric as sell_lamports,
				sum(w.buy_count)::int as buys,
				sum(w.sell_count)::int as sells,
				bool_or(w.is_creator) as ever_creator,
				count(distinct w.mint) filter (where o.outcome in ('graduated','pumped'))::int as wins,
				count(distinct w.mint) filter (where o.outcome is not null and o.outcome <> 'unknown')::int as labeled
			from pump_coin_wallets w
			join pump_coin_intel i on i.mint = w.mint and i.network = ${network}
			left join pump_coin_outcomes o on o.mint = w.mint
			where w.buy_count > 0
			group by w.wallet
			having count(distinct w.mint) >= 2
			order by sum(w.buy_lamports) desc
			limit ${cap}
		`;
		traders = rows.map((r) => {
			const buySol = sol(r.buy_lamports) ?? 0;
			const sellSol = sol(r.sell_lamports) ?? 0;
			const labeled = num(r.labeled) ?? 0;
			const wins = num(r.wins) ?? 0;
			const coins = num(r.coins) ?? 0;
			const winRate = labeled >= 1 ? round(wins / labeled, 3) : null;
			const labels = [];
			if (r.ever_creator) labels.push('creator');
			if (labeled >= 3 && winRate != null && winRate >= 0.5) labels.push('smart_money');
			if (buySol >= 50) labels.push('whale');
			if (coins >= 10) labels.push('serial');
			if (!labels.length) labels.push('active');
			return {
				wallet: r.wallet,
				coins,
				buy_sol: round(buySol),
				sell_sol: round(sellSol),
				net_sol: round(Math.max(0, buySol - sellSol)),
				buys: num(r.buys) ?? 0,
				sells: num(r.sells) ?? 0,
				wins,
				labeled,
				win_rate: winRate,
				labels,
			};
		});
	} catch { /* wallets/intel absent — fine */ }
	return { traders };
}

// ── learning: weights + outcome distribution + coverage ──────────────────────
async function getLearning({ network }) {
	let weights = null;
	let sampleSize = 0;
	let trainedAt = null;
	try {
		const [w] = await sql`
			select weights, sample_size, trained_at from pump_intel_weights
			where network = ${network} order by trained_at desc limit 1
		`;
		if (w) {
			weights = w.weights || null;
			sampleSize = num(w.sample_size) ?? 0;
			trainedAt = w.trained_at || null;
		}
	} catch { /* weights absent */ }

	let outcomes = [];
	try {
		const rows = await sql`
			select outcome, count(*)::int as n,
			       round(avg(ath_multiple)::numeric, 2) as avg_multiple
			from pump_coin_outcomes group by outcome
		`;
		outcomes = rows.map((r) => ({ outcome: r.outcome, count: num(r.n) ?? 0, avg_multiple: num(r.avg_multiple) }));
	} catch { /* outcomes absent */ }

	let coverage = { observed: 0, classified: 0, labeled: 0, by_category: [] };
	try {
		const [c] = await sql`
			select
				count(*)::int as observed,
				count(*) filter (where classify_source is not null)::int as classified,
				(select count(*)::int from pump_coin_outcomes) as labeled
			from pump_coin_intel where network = ${network}
		`;
		const cats = await sql`
			select category, count(*)::int as n from pump_coin_intel
			where network = ${network} and category is not null
			group by category order by n desc
		`;
		coverage = {
			observed: num(c?.observed) ?? 0,
			classified: num(c?.classified) ?? 0,
			labeled: num(c?.labeled) ?? 0,
			by_category: cats.map((r) => ({ category: r.category, count: num(r.n) ?? 0 })),
		};
	} catch { /* intel absent */ }

	// Present weights as a sorted, signed list the UI can bar-chart directly.
	let weightList = [];
	if (weights && typeof weights === 'object') {
		weightList = Object.entries(weights)
			.map(([signal, weight]) => ({ signal, weight: round(num(weight), 4) }))
			.filter((w) => w.weight != null)
			.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
	}

	return { weights: weightList, sample_size: sampleSize, trained_at: trainedAt, outcomes, coverage };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://localhost');
	const params = url.searchParams;
	const network = params.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const mint = (params.get('mint') || '').trim();
	const view = mint ? 'coin' : (params.get('view') || 'feed');

	// Caller mistakes are answered as caller mistakes. Everything below this point
	// reaching the `degraded` boundary means the ENGINE is down, which is what the
	// dashboard's "warming up" state is for: a typo must never be reported as an
	// outage, and an unknown view must never be silently served as the feed.
	if (mint && !MINT_RE.test(mint)) {
		return error(res, 400, 'invalid_mint', 'mint must be a base58 pump.fun address');
	}
	if (!mint && !VIEWS.has(view)) {
		return error(res, 400, 'invalid_view', `view must be one of: ${[...VIEWS].join(', ')}`);
	}
	const minQualityRaw = params.get('minQuality');
	let minQuality = null;
	if (minQualityRaw != null && minQualityRaw !== '') {
		minQuality = Number(minQualityRaw);
		if (!Number.isInteger(minQuality) || minQuality < 0 || minQuality > 100) {
			return error(res, 400, 'invalid_min_quality', 'minQuality must be an integer from 0 to 100');
		}
	}

	try {
		let payload;
		switch (view) {
			case 'coin':
				payload = await getCoin(mint, network);
				break;
			case 'leaderboard':
				payload = await getLeaderboard({ network, limit: parseInt(params.get('limit') || '20', 10) });
				break;
			case 'learning':
				payload = await getLearning({ network });
				break;
			case 'traders':
				payload = await getTraders({ network, limit: parseInt(params.get('limit') || '40', 10) });
				break;
			case 'feed':
			default:
				payload = await getFeed({
					network,
					limit: parseInt(params.get('limit') || '60', 10),
					category: params.get('category') || null,
					minQuality,
					verdict: params.get('verdict') || null,
					q: (params.get('q') || '').trim() || null,
				});
				break;
		}
		return json(res, 200, { view, network, ...payload, ts: Date.now() },
			{ 'cache-control': 'public, max-age=5, stale-while-revalidate=20' });
	} catch (err) {
		// The engine tables may not be migrated in this environment yet. Tell the
		// dashboard so it shows its "warming up" state rather than a hard failure.
		const missing = /relation .* does not exist|column .* does not exist/i.test(String(err?.message || ''));
		if (missing) {
			return json(res, 200, { view, network, degraded: true, reason: 'engine_tables_pending', ts: Date.now() },
				{ 'cache-control': 'no-store' });
		}
		if (isDbUnavailableError(err)) console.warn('[pump/intel] db unavailable:', err?.message);
		else console.error('[pump/intel] query failed', err);
		return json(res, 200, { view, network, degraded: true, reason: 'query_failed', ts: Date.now() },
			{ 'cache-control': 'no-store' });
	}
});
