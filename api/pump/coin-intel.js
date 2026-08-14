/**
 * Coin Intelligence — public read API.
 *
 *   GET /api/pump/coin-intel?mint=<mint>          → full intel for one coin
 *       &wallets=1                                  ...with the top-trader ledger
 *   GET /api/pump/coin-intel                       → live radar feed (newest first)
 *       &limit=50&min_quality=60&category=ai&network=mainnet&flag=bundle_launch
 *
 * The Coin Intelligence Engine (workers/agent-sniper/intel) watches every new
 * pump.fun coin's first seconds of trading, derives bundle/organic/concentration
 * signals, classifies it, and persists here. Any agent — user-built, MCP, or
 * external — reads the same intelligence the autonomous sniper uses. Public +
 * IP rate-limited; every number traces to an on-chain trade we observed.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const CATEGORIES = new Set([
	'meme', 'tech', 'ai', 'culture', 'community',
	'political', 'news', 'animal', 'celebrity', 'utility', 'unknown',
]);

const lamportsToSol = (v) => (v == null ? null : Number(BigInt(v)) / 1e9);
const num = (v) => (v == null ? null : Number(v));

// Danger-level risk flags — used by the market-pulse aggregate to compute the
// "flagged" share. Mirrors the danger set the radar UI renders in red.
const DANGER_FLAGS = ['bundle_launch', 'dev_dumped', 'single_whale', 'low_diversity', 'fresh_wallet_swarm'];

function shapeRow(r) {
	const sig = r.signals || {};
	const out = {
		mint: r.mint,
		network: r.network,
		symbol: r.symbol,
		name: r.name,
		creator: r.creator,
		image_uri: r.image_uri,
		description: r.description,
		socials: { twitter: r.twitter, telegram: r.telegram, website: r.website },
		created_at: r.created_at,
		first_seen_at: r.first_seen_at,
		observation_seconds: r.observation_seconds,
		// headline signals
		quality_score: r.quality_score,
		bundle_score: num(r.bundle_score),
		organic_score: num(r.organic_score),
		snipe_ratio: num(r.snipe_ratio),
		concentration_top10: num(r.concentration_top10),
		concentration_top5: sig.concentration_top5 != null ? Number(sig.concentration_top5) : null,
		concentration_top1: sig.concentration_top1 != null ? Number(sig.concentration_top1) : null,
		fresh_wallet_ratio: num(r.fresh_wallet_ratio),
		bubblemap_connectivity: num(r.bubblemap_connectivity),
		coordination_score: sig.coordination_score != null ? Number(sig.coordination_score) : null,
		timing_entropy: sig.timing_entropy != null ? Number(sig.timing_entropy) : null,
		risk_flags: r.risk_flags || [],
		// smart-money + cluster enrichment (highest-predictive signals)
		smart_money_count: r.smart_money_count ?? 0,
		smart_money_score: num(r.smart_money_score),
		cluster_count: r.cluster_count ?? 0,
		// classification
		category: r.category,
		tags: r.tags || [],
		narrative: r.narrative,
		classify_confidence: num(r.classify_confidence),
		classify_source: r.classify_source,
		is_news_meme: r.is_news_meme === true,
		news_headline: sig.news_headline ?? null,
		news_url: sig.news_url ?? null,
		// aggregates
		dev_buy_sol: lamportsToSol(r.dev_buy_lamports),
		dev_sold: r.dev_sold,
		buy_count: r.buy_count,
		sell_count: r.sell_count,
		buy_volume_sol: lamportsToSol(r.buy_volume_lamports),
		sell_volume_sol: lamportsToSol(r.sell_volume_lamports),
		net_volume_sol: sig.net_volume_sol != null ? Number(sig.net_volume_sol)
			: (lamportsToSol(r.buy_volume_lamports) ?? 0) - (lamportsToSol(r.sell_volume_lamports) ?? 0),
		buy_sell_ratio: sig.buy_sell_ratio != null ? Number(sig.buy_sell_ratio) : null,
		unique_buyers: r.unique_buyers,
		unique_sellers: r.unique_sellers,
		largest_buy_sol: lamportsToSol(r.largest_buy_lamports),
		market_cap_sol: sig.mc_sol_first_seen != null ? Number(sig.mc_sol_first_seen) : null,
		signals: sig,
	};

	// Feed query left-joins outcomes; surface a compact label when present so a
	// radar card can show a Graduated / Rugged badge without a second request.
	if (r.o_outcome !== undefined && (r.o_outcome || r.o_graduated || r.o_rugged)) {
		out.outcome = {
			outcome: r.o_outcome,
			graduated: r.o_graduated === true,
			rugged: r.o_rugged === true,
			ath_multiple: num(r.o_ath_multiple),
		};
	}
	return out;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const mint = params.get('mint');

	// ── single coin ───────────────────────────────────────────────────────────
	if (mint) {
		// Same envelope every other handler answers with ({error, error_description});
		// a bare {error} left every client that reads error_description with undefined.
		if (mint.length < 32 || mint.length > 64) {
			return error(res, 400, 'invalid_mint', 'mint must be 32 to 64 characters');
		}
		const [row] = await sql`select * from pump_coin_intel where mint = ${mint} limit 1`;
		if (!row) {
			const hint = 'coin not observed (too old, or launched before the intel engine, or still mid-observation)';
			return json(res, 404, { error: 'not_found', error_description: hint, mint, hint });
		}
		const out = shapeRow(row);
		out.smart_money_notable = Array.isArray(row.smart_money_notable) ? row.smart_money_notable : [];

		const [outcome] = await sql`
			select graduated, rugged, outcome, ath_multiple, ath_market_cap_usd, last_market_cap_usd, labeled_at
			from pump_coin_outcomes where mint = ${mint} limit 1
		`;
		out.outcome = outcome
			? {
				outcome: outcome.outcome, graduated: outcome.graduated, rugged: outcome.rugged,
				ath_multiple: outcome.ath_multiple != null ? Number(outcome.ath_multiple) : null,
				ath_market_cap_usd: outcome.ath_market_cap_usd != null ? Number(outcome.ath_market_cap_usd) : null,
				last_market_cap_usd: outcome.last_market_cap_usd != null ? Number(outcome.last_market_cap_usd) : null,
				labeled_at: outcome.labeled_at,
			}
			: null;

		if (params.get('wallets') === '1') {
			const wallets = await sql`
				select wallet, buy_count, sell_count, buy_lamports, sell_lamports,
				       is_creator, funder, first_seen_at, last_seen_at
				from pump_coin_wallets where mint = ${mint}
				order by (buy_lamports + sell_lamports) desc
				limit 50
			`;
			out.wallets = wallets.map((w) => ({
				wallet: w.wallet,
				buy_count: w.buy_count,
				sell_count: w.sell_count,
				buy_sol: lamportsToSol(w.buy_lamports),
				sell_sol: lamportsToSol(w.sell_lamports),
				net_sol: lamportsToSol(w.buy_lamports) - lamportsToSol(w.sell_lamports),
				is_creator: w.is_creator,
				funder: w.funder,
			}));
		}

		return json(res, 200, out, { 'cache-control': 'public, max-age=15, s-maxage=30' });
	}

	// ── market pulse (aggregate over the recent window) ─────────────────────────
	// One birds-eye read of the room: how many launches, the health distribution,
	// bundle/smart-money rates, and the graduated/rugged split from labeled
	// outcomes. Every figure traces to observed rows — zeros when the table is empty.
	if (params.get('stats') === '1') {
		const [agg] = await sql`
			select
				count(*) filter (where first_seen_at > now() - interval '24 hours') as observed_24h,
				count(*) filter (where first_seen_at > now() - interval '1 hour')   as observed_1h,
				round(avg(quality_score) filter (where quality_score is not null and first_seen_at > now() - interval '24 hours')) as avg_quality,
				count(*) filter (where quality_score >= 70 and first_seen_at > now() - interval '24 hours') as healthy,
				count(*) filter (where quality_score >= 40 and quality_score < 70 and first_seen_at > now() - interval '24 hours') as mixed,
				count(*) filter (where quality_score < 40 and first_seen_at > now() - interval '24 hours') as risky,
				count(*) filter (where quality_score is null and first_seen_at > now() - interval '24 hours') as unscored,
				count(*) filter (where smart_money_count > 0 and first_seen_at > now() - interval '24 hours') as smart_money_touched,
				count(*) filter (where is_news_meme and first_seen_at > now() - interval '24 hours') as news_memes,
				count(*) filter (where risk_flags && ${DANGER_FLAGS}::text[] and first_seen_at > now() - interval '24 hours') as flagged,
				round(avg(bundle_score)  filter (where bundle_score is not null  and first_seen_at > now() - interval '24 hours') * 100) as avg_bundle,
				round(avg(organic_score) filter (where organic_score is not null and first_seen_at > now() - interval '24 hours') * 100) as avg_organic
			from pump_coin_intel
			where network = ${network}
		`;
		const [out] = await sql`
			select
				count(*) filter (where o.graduated) as graduated,
				count(*) filter (where o.rugged)    as rugged,
				count(*)                            as labeled
			from pump_coin_outcomes o
			join pump_coin_intel i using (mint)
			where i.network = ${network} and o.labeled_at > now() - interval '24 hours'
		`;
		const n = (v) => (v == null ? 0 : Number(v));
		return json(res, 200, {
			network,
			window_hours: 24,
			observed_24h: n(agg?.observed_24h),
			observed_1h: n(agg?.observed_1h),
			avg_quality: agg?.avg_quality != null ? Number(agg.avg_quality) : null,
			avg_bundle: agg?.avg_bundle != null ? Number(agg.avg_bundle) : null,
			avg_organic: agg?.avg_organic != null ? Number(agg.avg_organic) : null,
			healthy: n(agg?.healthy),
			mixed: n(agg?.mixed),
			risky: n(agg?.risky),
			unscored: n(agg?.unscored),
			smart_money_touched: n(agg?.smart_money_touched),
			news_memes: n(agg?.news_memes),
			flagged: n(agg?.flagged),
			outcomes: { graduated: n(out?.graduated), rugged: n(out?.rugged), labeled: n(out?.labeled) },
			t: Date.now(),
		}, { 'cache-control': 'public, max-age=15, s-maxage=30' });
	}

	// ── radar feed ──────────────────────────────────────────────────────────────
	const limit = Math.max(1, Math.min(100, parseInt(params.get('limit'), 10) || 50));
	const minQuality = params.get('min_quality') != null ? parseInt(params.get('min_quality'), 10) : null;
	const category = CATEGORIES.has(params.get('category')) ? params.get('category') : null;
	const flag = params.get('flag') || null;
	const smartOnly = params.get('smart_money') === '1';
	const newsOnly = params.get('news') === '1';
	const q = (params.get('q') || '').trim().slice(0, 64);
	const qLike = q ? `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%` : null;

	// Whitelisted sort → ORDER BY fragment. Never interpolate the raw param.
	const SORTS = {
		new:     sql`first_seen_at desc`,
		quality: sql`quality_score desc nulls last, first_seen_at desc`,
		smart:   sql`smart_money_count desc, quality_score desc nulls last, first_seen_at desc`,
		buyers:  sql`unique_buyers desc, first_seen_at desc`,
		volume:  sql`buy_volume_lamports desc, first_seen_at desc`,
	};
	const order = SORTS[params.get('sort')] || SORTS.new;

	const rows = await sql`
		select i.*,
		       o.outcome as o_outcome, o.graduated as o_graduated,
		       o.rugged as o_rugged, o.ath_multiple as o_ath_multiple
		from pump_coin_intel i
		left join pump_coin_outcomes o using (mint)
		where i.network = ${network}
		  and (${Number.isFinite(minQuality) ? minQuality : null}::int is null or i.quality_score >= ${Number.isFinite(minQuality) ? minQuality : null})
		  and (${category}::text is null or i.category = ${category})
		  and (${flag}::text is null or ${flag} = any(i.risk_flags))
		  and (${smartOnly} = false or i.smart_money_count > 0)
		  and (${newsOnly} = false or i.is_news_meme = true)
		  and (${qLike}::text is null or i.name ilike ${qLike} or i.symbol ilike ${qLike} or i.mint ilike ${qLike})
		order by ${order}
		limit ${limit}
	`;

	return json(res, 200, {
		network,
		count: rows.length,
		coins: rows.map(shapeRow),
		t: Date.now(),
	}, { 'cache-control': 'public, max-age=10, s-maxage=20' });
});
