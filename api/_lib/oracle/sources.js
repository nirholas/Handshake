// Oracle — source adapter over the data brain.
//
// This is the only place Oracle touches the platform's existing pump.fun tables.
// It reads them defensively (every query is isolated so a missing/younger table
// degrades that one slice to null instead of failing the whole assembly) and
// maps them into the single normalized `CoinIntel` shape the pure conviction
// engine consumes. Keeping the coupling here means a schema change in the brain
// only ever breaks this file, never the scoring logic or the API surface.
//
// Brain tables read:
//   pump_coin_intel    — coin record + precomputed structural/narrative signals
//   coin_smart_money   — pedigree: proven-money score + notable wallets
//   oracle_narrative   — Oracle's own cultural read (virality), if classified
//   pump_coin_wallets  — per-wallet ledger (funder clusters, proven-wallet flow)
//   wallet_reputation  — the coin creator's own launch track record
//   pump_coin_outcomes — ground-truth outcome (for the conviction backtest)

import { sql } from '../db.js';
import { knownWallet, knownIsProven } from './known-wallets.js';
import { isQuoteMint, QUOTE_MINT_LIST } from '../quote-mints.js';

const LAMPORTS = 1e9;
const n = (v) => (v == null ? null : Number(v));
const pct01 = (v) => (v == null ? null : Math.max(0, Math.min(100, Number(v) * 100)));

/** Best-effort single-row query; returns null on any error (missing table etc). */
async function tryRow(fn) {
	try {
		const rows = await fn();
		return rows && rows[0] ? rows[0] : null;
	} catch {
		return null;
	}
}
async function tryRows(fn) {
	try {
		return (await fn()) || [];
	} catch {
		return [];
	}
}

/**
 * Assemble the normalized CoinIntel for one mint from the brain. Any slice that
 * isn't available yet is simply omitted — the conviction engine tolerates gaps.
 *
 * @param {string} mint
 * @param {string} network
 * @returns {Promise<object|null>} CoinIntel, or null if the coin is unknown
 */
export async function assembleIntel(mint, network = 'mainnet') {
	// Quote/stablecoin/LST mints are never a tradeable coin — refuse to assemble
	// intel for them so they can never be scored or cached. This is the choke point
	// every scoring + lazy-score path flows through, so one guard covers them all.
	if (isQuoteMint(mint)) return null;
	// The primary existence lookup does NOT use tryRow: a swallowed DB error here
	// is indistinguishable from "coin not observed", which makes every caller
	// return a misleading 404 during a database/connection outage — a transient
	// failure clients and the CDN then cache as an authoritative "doesn't exist".
	// Let a query failure throw (callers map it to 503); only an empty result set
	// is a true "unknown coin" → null. The secondary enrichment queries below stay
	// on tryRow, since partial intel is an acceptable degradation.
	const coinRows = await sql`
		select mint, symbol, name, image_uri, category, narrative, classify_confidence,
		       creator, bonding_curve, description, twitter, telegram, website, tags,
		       created_at, first_seen_at,
		       dev_buy_lamports, dev_sold, dev_sell_lamports,
		       buy_count, sell_count, buy_volume_lamports, sell_volume_lamports,
		       unique_buyers, unique_sellers, largest_buy_lamports,
		       bundle_score, organic_score, snipe_ratio, fresh_wallet_ratio,
		       concentration_top10, bubblemap_connectivity,
		       quality_score, risk_flags, signals
		from pump_coin_intel where mint = ${mint} and network = ${network} limit 1
	`;
	const coin = coinRows[0] || null;
	if (!coin) return null;

	const [smart, narr, topBuyers, funder, provenFlow, creatorRep] = await Promise.all([
		tryRow(() => sql`
			select smart_money_score, smart_wallet_count, proven_buy_lamports, total_buy_lamports, notable
			from coin_smart_money where mint = ${mint} and network = ${network} limit 1
		`),
		tryRow(() => sql`
			select category, narrative, virality, confidence
			from oracle_narrative where mint = ${mint} and network = ${network} limit 1
		`),
		tryRows(() => sql`
			select wallet, buy_lamports, is_creator
			from pump_coin_wallets where mint = ${mint}
			order by buy_lamports desc limit 25
		`),
		// Funder clustering: among real buyers (creator excluded), how concentrated
		// is the funding source? A big single-funder cluster is a bundle wearing a
		// wide-base costume. Coverage-gated downstream so sparse enrichment never
		// fabricates a penalty.
		tryRow(() => sql`
			with buyers as (
				select wallet, funder
				from pump_coin_wallets
				where mint = ${mint} and buy_lamports > 0 and coalesce(is_creator, false) = false
			),
			clusters as (
				select funder, count(*)::int as sz from buyers where funder is not null group by funder
			)
			select (select count(*) from buyers)::int                 as total_buyers,
			       (select coalesce(sum(sz), 0) from clusters)::int    as funded_buyers,
			       (select coalesce(max(sz), 0) from clusters)::int    as largest_cluster
		`),
		// Proven-wallet flow on THIS coin: are the smart wallets that bought also
		// already selling? coin_smart_money gives the buy side; this adds the exit.
		tryRow(() => sql`
			select coalesce(sum(w.buy_lamports), 0)::numeric  as proven_buy,
			       coalesce(sum(w.sell_lamports), 0)::numeric as proven_sell,
			       count(*)::int                              as proven_wallets
			from pump_coin_wallets w
			join wallet_reputation r on r.wallet = w.wallet and r.network = ${network}
			where w.mint = ${mint}
			  and (r.label in ('smart_money', 'kol') or r.smart_money_score >= 70)
		`),
		// The creator's own track record — a serial rugger and a proven shipper
		// launch identically without this. Null for first-time / unjudged creators.
		coin.creator
			? tryRow(() => sql`
				select label, win_rate, dump_rate, smart_money_score,
				       creator_count, creator_wins, coins_traded
				from wallet_reputation where wallet = ${coin.creator} and network = ${network} limit 1
			`)
			: Promise.resolve(null),
	]);

	const intel = toCoinIntel({ coin, smart, narr, funder, provenFlow, creatorRep });
	enrichWithKnownWallets(intel, topBuyers);
	return intel;
}

/**
 * Funder-cluster concentration as a 0..100 share of the buyer book, or null when
 * funder enrichment is too sparse to be trustworthy. Pure, exported for testing.
 *
 * @param {object|null} funder { total_buyers, funded_buyers, largest_cluster }
 */
export function funderClusterPct(funder) {
	if (!funder) return null;
	const total = n(funder.total_buyers) || 0;
	const funded = n(funder.funded_buyers) || 0;
	const largest = n(funder.largest_cluster) || 0;
	// Need a real book and real funder coverage before a cluster means anything.
	if (total < 8 || funded < 5 || funded / total < 0.3) return null;
	return Math.max(0, Math.min(100, (largest / total) * 100));
}

/**
 * Fold the known-wallet prior into a coin's pedigree. For each top buyer that's
 * a known smart-money/KOL/sniper wallet (gmgn seed), ensure it's in `notable`
 * with its known label + a synthetic score, and recount proven wallets. This is
 * what gives a brand-new launch real pedigree signal before the brain has
 * judged its buyers. Mutates `intel.smartMoney` in place.
 *
 * @param {object} intel  normalized CoinIntel
 * @param {Array<{wallet:string, buy_lamports:any}>} topBuyers
 */
export function enrichWithKnownWallets(intel, topBuyers = []) {
	const sm = intel.smartMoney || (intel.smartMoney = { notable: [] });
	const notable = Array.isArray(sm.notable) ? sm.notable : (sm.notable = []);
	const byWallet = new Map(notable.map((w) => [w.wallet, w]));

	for (const b of topBuyers) {
		const known = knownWallet(b.wallet);
		if (!known) continue;
		const buySol = Number(b.buy_lamports || 0) / LAMPORTS;
		const existing = byWallet.get(b.wallet);
		if (existing) {
			// Only upgrade an unlabeled/weaker brain entry with the known prior.
			if (!existing.label || existing.label === 'unproven') {
				existing.label = known.label;
				existing.score = existing.score || known.score;
				existing.source = 'gmgn';
				existing.tag = existing.tag || known.tag;
			}
		} else {
			const entry = { wallet: b.wallet, label: known.label, score: known.score, buy_sol: buySol, source: 'gmgn', tag: known.tag };
			notable.push(entry);
			byWallet.set(b.wallet, entry);
		}
	}

	// Recount proven wallets across brain + prior so the pedigree pillar sees them.
	const provenCount = notable.filter((w) => knownIsProven(w.label) || Number(w.score) >= 70).length;
	if (provenCount > (Number(sm.smartWalletCount) || 0)) sm.smartWalletCount = provenCount;
}

/**
 * Map raw brain rows → normalized CoinIntel. Pure given its inputs (exported so
 * it can be unit-tested without a DB).
 */
export function toCoinIntel({ coin, smart, narr, funder, provenFlow, creatorRep } = {}) {
	const riskFlags = Array.isArray(coin.risk_flags) ? coin.risk_flags : [];
	const devBuy = n(coin.dev_buy_lamports);
	const buyVol = n(coin.buy_volume_lamports) || 0;
	const largest = n(coin.largest_buy_lamports);

	// Single-biggest-buyer share of buy volume — a top-holder proxy.
	const topHolderPct = largest != null && buyVol > 0 ? (largest / buyVol) * 100 : null;
	// Dev footprint as a share of buy volume — a creator-hold proxy.
	const creatorHoldPct = devBuy != null && buyVol > 0 ? (devBuy / buyVol) * 100 : null;
	const devSoldPct = coin.dev_sold && devBuy
		? (n(coin.dev_sell_lamports) || 0) / devBuy * 100
		: 0;

	const bundleScore = pct01(coin.bundle_score);          // 0..100
	const organicScore = pct01(coin.organic_score);
	const snipeRatio = pct01(coin.snipe_ratio);            // 0..100, buy vol in first seconds
	const freshWalletRatio = pct01(coin.fresh_wallet_ratio); // 0..100, farmed-wallet share
	const top10Pct = pct01(coin.concentration_top10);
	const connectivity = pct01(coin.bubblemap_connectivity);
	const bundleFlag = riskFlags.includes('bundle_launch') || (bundleScore != null && bundleScore >= 60);

	// Narrative: Oracle's own classification (has virality) wins; else fall back
	// to the brain's category with a virality proxy derived from quality/organic.
	const narrative = narr
		? { category: narr.category, virality: n(narr.virality), confidence: n(narr.confidence) }
		: {
			category: coin.category || 'unknown',
			virality: n(coin.quality_score) != null ? Math.round(n(coin.quality_score) * 0.8 + (organicScore || 0) * 0.2) : null,
			confidence: n(coin.classify_confidence) ?? 0.5,
		};

	const notable = Array.isArray(smart?.notable) ? smart.notable
		: (typeof smart?.notable === 'string' ? safeJson(smart.notable) : []);

	// Proven-wallet flow observed on this coin (smart money's actual buy AND sell
	// here). Prefer coin_smart_money's precomputed buy total; the join below adds
	// the exit side and backfills the buy total when smart-money hasn't run yet.
	const provenBuy = n(smart?.proven_buy_lamports) || n(provenFlow?.proven_buy) || 0;
	const provenSell = n(provenFlow?.proven_sell) || 0;

	const uniqueSellers = n(coin.unique_sellers) || 0;

	return {
		mint: coin.mint,
		symbol: coin.symbol,
		name: coin.name,
		image_uri: coin.image_uri,
		category: narrative.category,
		createdAt: coin.created_at || coin.first_seen_at,

		// Raw launch-time signals exactly as the intel watcher recorded them
		// (organic_score, timing_entropy, concentration_top1, mc_sol_first_seen,
		// buy_sell_ratio, ...). The fitted conviction model reads these directly:
		// they are the same values the model was trained on, so no unit drift
		// between training and inference. The derived fields below remain for
		// display and for callers that predate the model.
		launch: coin.signals && typeof coin.signals === 'object' ? coin.signals : {},

		// Off-chain signal the classifier weighs (link presence lifts virality) and
		// the API surfaces. Previously never threaded through — a dead input.
		social: {
			description: coin.description || null,
			twitter: coin.twitter || null,
			telegram: coin.telegram || null,
			website: coin.website || null,
			tags: Array.isArray(coin.tags) ? coin.tags : [],
		},

		// The wallet that launched the coin and its own track record. Null history
		// for a first-time or not-yet-judged creator (treated as neutral, not bad).
		creator: {
			wallet: coin.creator || null,
			label: creatorRep?.label || null,
			winRate: n(creatorRep?.win_rate),
			dumpRate: n(creatorRep?.dump_rate),
			smartMoneyScore: n(creatorRep?.smart_money_score),
			launches: n(creatorRep?.creator_count) || 0,
			launchWins: n(creatorRep?.creator_wins) || 0,
		},

		smartMoney: {
			score: n(smart?.smart_money_score),
			smartWalletCount: n(smart?.smart_wallet_count) || (Array.isArray(notable) ? notable.length : 0),
			provenBuyLamports: provenBuy,
			provenSellLamports: provenSell,
			totalBuyLamports: n(smart?.total_buy_lamports) || buyVol,
			notable: Array.isArray(notable) ? notable : [],
		},
		structure: {
			uniqueBuyers: n(coin.unique_buyers) || 0,
			uniqueSellers,
			topHolderPct,
			creatorHoldPct,
			devSoldPct,
			organicScore,
			bundleScore,
			snipeRatio,
			freshWalletRatio,
			funderClusterPct: funderClusterPct(funder),
			top10Pct,
			bubblemapConnectivity: connectivity,
			bundleFlag,
		},
		narrative,
		behavior: {
			devBuySol: devBuy != null ? devBuy / LAMPORTS : null,
			buyCount: n(coin.buy_count) || 0,
			sellCount: n(coin.sell_count) || 0,
			buyVolSol: buyVol / LAMPORTS,
			sellVolSol: (n(coin.sell_volume_lamports) || 0) / LAMPORTS,
			earlyBuyerCount: n(coin.unique_buyers) || 0,
			uniqueSellers,
		},
		riskFlags,
		qualityScore: n(coin.quality_score),
	};
}

function safeJson(s) {
	try { return JSON.parse(s); } catch { return []; }
}

/**
 * Recent coins worth (re)scoring — newest first from the brain's coin table.
 * Used by the ingestion augmentor and as a fallback when oracle_conviction is
 * cold.
 *
 * @param {object} opts { network, limit, sinceSeconds }
 * @returns {Promise<string[]>} mints
 */
export async function recentMints({ network = 'mainnet', limit = 100, sinceSeconds = 6 * 3600 } = {}) {
	const rows = await tryRows(() => sql`
		select mint from pump_coin_intel
		where network = ${network}
		  and first_seen_at > now() - (${sinceSeconds} || ' seconds')::interval
		  and mint <> all(${QUOTE_MINT_LIST}::text[])
		order by first_seen_at desc
		limit ${Math.min(500, Math.max(1, limit))}
	`);
	return rows.map((r) => r.mint);
}

/**
 * A wallet's reputation + recent footprint, for the wallet profile endpoint.
 * @param {string} wallet
 * @param {string} network
 */
export async function walletProfile(wallet, network = 'mainnet') {
	const rep = await tryRow(() => sql`
		select wallet, coins_traded, early_entries, wins, early_wins, duds, dumps,
		       creator_count, creator_wins, win_rate, early_win_rate, dump_rate,
		       smart_money_score, label, first_seen_at, last_active_at
		from wallet_reputation where wallet = ${wallet} and network = ${network} limit 1
	`);
	const recent = await tryRows(() => sql`
		select w.mint, w.buy_count, w.sell_count, w.buy_lamports, w.sell_lamports,
		       w.base_bought, w.base_sold, w.is_creator, w.first_seen_at, w.last_seen_at,
		       i.symbol, i.name, i.image_uri, i.category, i.quality_score, i.narrative,
		       o.graduated, o.rugged, o.ath_multiple, o.last_market_cap_usd
		from pump_coin_wallets w
		left join pump_coin_intel i on i.mint = w.mint
		left join pump_coin_outcomes o on o.mint = w.mint
		where w.wallet = ${wallet}
		order by w.last_seen_at desc
		limit 60
	`);
	return { rep, recent };
}

/**
 * Ground-truth outcome for a mint (for the conviction-tier backtest).
 * @param {string} mint
 */
export async function coinOutcome(mint, network = 'mainnet') {
	return tryRow(() => sql`
		select graduated, rugged, ath_multiple, last_market_cap_usd
		from pump_coin_outcomes where mint = ${mint} limit 1
	`).catch(() => null);
}
