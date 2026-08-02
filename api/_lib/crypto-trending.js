// api/_lib/crypto-trending.js
//
// Composition engine behind the free GET /api/crypto/trending endpoint.
//
// "What's hot right now" = tokens ranked by MOMENTUM, not raw size. We fuse three
// live, keyless signals and reuse the platform's existing scoring primitives
// rather than inventing new market math:
//
//   • pump.fun  — the live board (frontend-api-v3) + per-coin swap-API trade feed.
//                 Windowed USD volume comes from summarizeWindowUsd() and buy
//                 pressure from scorePressure() — the exact helpers that power the
//                 paid crypto-intel `pump_trending` / `pump_volume_anomaly` topics.
//   • DexScreener — the boosted-token board via gmgn-feed.js dexScreenerTrending()
//                 (24h volume, 1h/24h price change, buy/sell txn counts). Cross-chain
//                 attention/spend signal.
//   • GMGN      — smart-money rank via gmgn-feed.js gmgnSmartMoneyRank(), best-effort:
//                 serverless egress IPs are frequently Cloudflare-blocked, so this
//                 degrades to nothing (never an error) when unavailable.
//
// ── The ranking signal (documented, stable) ──────────────────────────────────
// Each token is reduced to up-to-four momentum features, normalized WITHIN its
// source so cross-source volume-scale differences don't distort the blend:
//   volShare   = volumeUsd / max(volumeUsd in that source)        weight 0.45
//   buyDom     = clamp((buyPressure - 0.5) / 0.5, 0, 1)           weight 0.25
//   spike      = min(volumeUsd / median(peer volumeUsd), CAP)/CAP weight 0.20
//   change     = clamp(changePct / CHANGE_CAP, 0, 1)              weight 0.10
// score = 100 × Σ(weightᵢ·featureᵢ over PRESENT features) / Σ(present weights),
// so a source that can't supply one feature (e.g. no buy pressure) is scored on
// what it has rather than penalized. Tokens are ranked by `score` desc; ties break
// on volumeUsd. The volume "spike" reuses pump-volume-anomaly's median() baseline —
// the same robust peer-median an anomaly verdict is built on.

import { scorePressure } from './x402/pump-trending-score.js';
import { summarizeWindowUsd, median } from './x402/pump-volume-anomaly.js';
import { dexScreenerTrending, gmgnSmartMoneyRank } from './gmgn-feed.js';
import { gmgnTokenUrl } from '../../src/shared/trading-terminals.js';

const PUMP_FRONTEND_BASE = process.env.PUMP_FRONTEND_BASE || 'https://frontend-api-v3.pump.fun';
const PUMP_SWAP_BASE = process.env.PUMP_SWAP_BASE || 'https://swap-api.pump.fun';
const UA = 'three.ws-crypto-trending/1';
const FETCH_TIMEOUT_MS = Number(process.env.CRYPTO_TRENDING_TIMEOUT_MS || 6000);
// How many top board coins to pull trades for (trade fetch is the slow path).
const PUMP_TRADE_COINS = Number(process.env.CRYPTO_TRENDING_TRADE_COINS || 20);
const PUMP_TRADES_PER_COIN = Number(process.env.CRYPTO_TRENDING_TRADES_PER_COIN || 100);
const PUMP_CONCURRENCY = Number(process.env.CRYPTO_TRENDING_CONCURRENCY || 6);

// Ranking weights + saturation caps (see header). Exported so tests + docs read
// from one source of truth.
export const WEIGHTS = { volume: 0.45, buyDom: 0.25, spike: 0.2, change: 0.1 };
export const SPIKE_RATIO_CAP = 3; // volume ratio at which the spike term saturates
export const CHANGE_CAP = 50; // % price change at which the change term saturates

export const WINDOWS = new Set(['5m', '1h', '24h']);
const WINDOW_SEC = { '5m': 300, '1h': 3600, '24h': 86400 };

/** Map a window token → trailing seconds. Unknown → 1h. Pure. */
export function windowToSec(window) {
	return WINDOW_SEC[window] || WINDOW_SEC['1h'];
}

function num(v) {
	const n = typeof v === 'string' ? parseFloat(v) : v;
	return Number.isFinite(n) ? n : null;
}

function clamp01(n) {
	return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round(n, dp = 2) {
	if (!Number.isFinite(n)) return null;
	const f = 10 ** dp;
	return Math.round(n * f) / f;
}

/**
 * Assign a 0–100 momentum score to each token in a single-source set and return
 * a NEW array sorted by score desc (ties broken on volumeUsd desc). Pure — the
 * whole ranking signal lives here so it's unit-testable without any network.
 *
 * @param {Array<{ mint, symbol?, name?, marketCapUsd?, volumeUsd?, buyPressure?, changePct? }>} tokens
 * @returns {Array<object>} tokens with `score` added, ranked
 */
export function rankTokens(tokens) {
	const list = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
	if (!list.length) return [];

	const vols = list.map((t) => num(t.volumeUsd)).filter((v) => v != null && v > 0);
	const maxVol = vols.length ? Math.max(...vols) : 0;
	// Robust peer baseline for the "spike" term — the same median() an anomaly
	// verdict is built on. Zero when there aren't enough peers to compare against.
	const baseline = median(vols);

	const scored = list.map((t) => {
		const vol = num(t.volumeUsd);
		const bp = num(t.buyPressure);
		const chg = num(t.changePct);

		let weighted = 0;
		let presentWeight = 0;

		if (vol != null && vol > 0 && maxVol > 0) {
			weighted += WEIGHTS.volume * clamp01(vol / maxVol);
			presentWeight += WEIGHTS.volume;
			if (baseline > 0) {
				const ratio = vol / baseline;
				weighted += WEIGHTS.spike * clamp01(Math.min(ratio, SPIKE_RATIO_CAP) / SPIKE_RATIO_CAP);
				presentWeight += WEIGHTS.spike;
			}
		}
		if (bp != null) {
			weighted += WEIGHTS.buyDom * clamp01((bp - 0.5) / 0.5);
			presentWeight += WEIGHTS.buyDom;
		}
		if (chg != null) {
			weighted += WEIGHTS.change * clamp01(chg / CHANGE_CAP);
			presentWeight += WEIGHTS.change;
		}

		const score = presentWeight > 0 ? round((100 * weighted) / presentWeight) : 0;
		return { ...t, volumeUsd: vol, changePct: chg, score };
	});

	scored.sort((a, b) => b.score - a.score || (num(b.volumeUsd) ?? 0) - (num(a.volumeUsd) ?? 0));
	return scored;
}

/**
 * Merge scored token sets from several sources, dedupe by mint (keep the highest
 * score), re-sort desc, and slice to `limit`. Pure. Later argument order does not
 * matter — the max-score winner is kept regardless.
 */
export function mergeAndRank(sets, limit) {
	const byMint = new Map();
	for (const set of sets) {
		for (const t of set || []) {
			if (!t || !t.mint) continue;
			const prev = byMint.get(t.mint);
			if (!prev || t.score > prev.score) byMint.set(t.mint, t);
		}
	}
	const merged = [...byMint.values()].sort(
		(a, b) => b.score - a.score || (num(b.volumeUsd) ?? 0) - (num(a.volumeUsd) ?? 0),
	);
	return merged.slice(0, Math.max(0, limit));
}

/** Shape a ranked internal token into the public output row. Pure. */
export function toOutputRow(t) {
	return {
		mint: t.mint,
		symbol: t.symbol || null,
		name: t.name || null,
		marketCapUsd: num(t.marketCapUsd),
		volumeUsd: num(t.volumeUsd),
		change: num(t.changePct),
		score: t.score,
		url: t.url || null,
	};
}

// ── live fetch layer ─────────────────────────────────────────────────────────

async function fetchJson(url) {
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const r = await fetch(url, {
			headers: { accept: 'application/json', 'user-agent': UA },
			signal: ctrl.signal,
		});
		if (!r.ok) return null;
		return await r.json();
	} catch {
		return null;
	} finally {
		clearTimeout(tid);
	}
}

/** Bounded-concurrency map preserving order. */
async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		for (;;) {
			const i = cursor++;
			if (i >= items.length) break;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

async function fetchPumpBoard(limit) {
	const url = new URL('/coins', PUMP_FRONTEND_BASE);
	url.searchParams.set('offset', '0');
	url.searchParams.set('limit', String(limit));
	url.searchParams.set('sort', 'market_cap');
	url.searchParams.set('order', 'DESC');
	url.searchParams.set('includeNsfw', 'false');
	const body = await fetchJson(url.toString());
	const coins = Array.isArray(body) ? body : Array.isArray(body?.coins) ? body.coins : null;
	if (!Array.isArray(coins)) return null;
	return coins
		.filter((c) => c && typeof c.mint === 'string' && c.mint.length >= 32)
		.map((c) => ({
			mint: c.mint,
			symbol: c.symbol || null,
			name: c.name || c.symbol || null,
			marketCapUsd: num(c.usd_market_cap),
		}));
}

async function fetchCoinTrades(mint) {
	const body = await fetchJson(`${PUMP_SWAP_BASE}/v2/coins/${mint}/trades?limit=${PUMP_TRADES_PER_COIN}`);
	return Array.isArray(body) ? body : Array.isArray(body?.trades) ? body.trades : [];
}

/**
 * Live pump.fun momentum set: board coins scored by windowed USD volume +
 * per-coin buy pressure, using the shared pure scorers. Returns [] on outage
 * (never throws) so the aggregate call degrades gracefully.
 */
export async function fetchPumpfunTrending({ windowSec, limit, nowMs = Date.now() }) {
	const board = await fetchPumpBoard(Math.min(50, Math.max(limit, 20)));
	if (!board || !board.length) return [];
	const top = board.slice(0, Math.min(PUMP_TRADE_COINS, board.length));

	const enriched = await mapLimit(top, PUMP_CONCURRENCY, async (c) => {
		const trades = await fetchCoinTrades(c.mint);
		const { usd } = summarizeWindowUsd(trades, nowMs, windowSec);
		// scorePressure() is the crypto-intel buy-pressure primitive; feed it a
		// single-coin group to get this coin's buy/sell balance for the window.
		const { buyPressure, totalBuys, totalSells } = scorePressure([{ mint: c.mint, trades }]);
		const hasFlow = totalBuys + totalSells > 0;
		return {
			...c,
			volumeUsd: usd,
			buyPressure: hasFlow ? buyPressure : null,
			changePct: null, // pump.fun swap feed carries no per-window % change; left honest-null
			url: `https://pump.fun/coin/${c.mint}`,
			_source: 'pumpfun',
		};
	});

	// Keep only coins that actually traded in the window — a board coin with zero
	// window volume isn't "hot right now", it's just large.
	return rankTokens(enriched.filter((t) => (num(t.volumeUsd) ?? 0) > 0));
}

/** Map a gmgn-feed dexScreenerTrending() rank row → internal token. Pure. */
export function mapDexRow(row, window) {
	const buys = num(row.txns_h1_buys);
	const sells = num(row.txns_h1_sells);
	const flow = (buys ?? 0) + (sells ?? 0);
	const changePct = window === '24h' ? num(row.price_change_24h) : num(row.price_change_1h);
	return {
		mint: row.address,
		symbol: row.symbol || null,
		name: row.name || null,
		marketCapUsd: num(row.market_cap),
		volumeUsd: num(row.volume),
		buyPressure: flow > 0 ? (buys ?? 0) / flow : null,
		changePct,
		url: `https://dexscreener.com/solana/${row.address}`,
		_source: 'dexscreener',
	};
}

/** Live DexScreener boosted-token momentum set. Returns [] on outage. */
export async function fetchDexTrending({ window }) {
	const res = await dexScreenerTrending({ chain: 'sol' }).catch(() => null);
	if (!res || !res.ok || !Array.isArray(res.rank) || !res.rank.length) return [];
	const tokens = res.rank
		.filter((r) => r && typeof r.address === 'string' && r.address.length >= 32)
		.map((r) => mapDexRow(r, window));
	return rankTokens(tokens);
}

/** Map a raw GMGN smart-money rank row → internal token. Pure, fully guarded. */
export function mapGmgnRow(row, window) {
	if (!row || typeof row.address !== 'string' || row.address.length < 32) return null;
	const smartBuy = num(row.smart_buy_24h ?? row.smartbuy_24h);
	const smartSell = num(row.smart_sell_24h ?? row.smartsell_24h);
	const flow = (smartBuy ?? 0) + (smartSell ?? 0);
	const changePct =
		window === '24h'
			? num(row.price_change_percent24h ?? row.price_change_percent)
			: num(row.price_change_percent1h ?? row.price_change_percent);
	return {
		mint: row.address,
		symbol: row.symbol || null,
		name: row.name || row.symbol || null,
		marketCapUsd: num(row.market_cap_usd ?? row.market_cap),
		volumeUsd: num(row.volume ?? row.volume_24h),
		buyPressure: flow > 0 ? (smartBuy ?? 0) / flow : null,
		changePct,
		url: gmgnTokenUrl(row.address),
		_source: 'gmgn',
	};
}

/**
 * Best-effort GMGN smart-money momentum set. Serverless IPs are usually
 * Cloudflare-blocked, so this returns [] far more often than not — by design,
 * never an error.
 */
export async function fetchGmgnTrending({ window }) {
	const interval = window === '24h' ? '24h' : '1h';
	const res = await gmgnSmartMoneyRank({ chain: 'sol', interval }).catch(() => null);
	if (!res || !res.ok || !Array.isArray(res.rank) || !res.rank.length) return [];
	const tokens = res.rank.map((r) => mapGmgnRow(r, window)).filter(Boolean);
	return rankTokens(tokens);
}

/**
 * Compose the ranked trending list across the requested sources.
 *
 * @param {{ window: string, limit: number, source: 'pumpfun'|'all', nowMs?: number,
 *   deps?: { pumpfun?, dexscreener?, gmgn? } }} opts
 *   `deps` overrides the live source fetchers (each returns a scored token array);
 *   used by tests to exercise source filtering / limit cap / dedupe without network.
 * @returns {Promise<{ window, tokens, count, ts, sources: string[], note?: string }>}
 */
export async function composeTrending({ window, limit, source, nowMs = Date.now(), deps = {} }) {
	const windowSec = windowToSec(window);
	const cappedLimit = Math.min(50, Math.max(1, limit));
	const pumpfun = deps.pumpfun || (() => fetchPumpfunTrending({ windowSec, limit: cappedLimit, nowMs }));
	const dexscreener = deps.dexscreener || (() => fetchDexTrending({ window }));
	const gmgn = deps.gmgn || (() => fetchGmgnTrending({ window }));

	const jobs = [];
	jobs.push({ name: 'pumpfun', run: pumpfun });
	if (source === 'all') {
		jobs.push({ name: 'dexscreener', run: dexscreener });
		jobs.push({ name: 'gmgn', run: gmgn });
	}

	const settled = await Promise.all(
		jobs.map(async (j) => {
			try {
				return { name: j.name, rows: await j.run() };
			} catch {
				// A source helper already swallows its own errors; this is the last
				// guard so one bad upstream can never fail the whole aggregate call.
				return { name: j.name, rows: [] };
			}
		}),
	);

	const contributing = settled.filter((s) => s.rows.length > 0);
	const sources = contributing.map((s) => s.name);
	const tokens = mergeAndRank(contributing.map((s) => s.rows), cappedLimit).map(toOutputRow);

	const out = {
		window,
		tokens,
		count: tokens.length,
		ts: new Date(nowMs).toISOString(),
		sources,
	};
	if (!sources.length) {
		out.note = 'All upstream market sources were unavailable — returning an empty ranking. Retry shortly.';
	} else if (source === 'all' && sources.length < jobs.length) {
		const down = settled.filter((s) => s.rows.length === 0).map((s) => s.name);
		out.note = `Partial data: ${down.join(', ')} unavailable; ranked from ${sources.join(', ')}.`;
	}
	return out;
}
