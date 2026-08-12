// Whale / large-buy scanning over the public pump.fun feeds.
//
// Powers the FREE GET /api/crypto/whales endpoint. A "whale buy" is a single
// pump.fun trade of type=buy that moves at least `minSol` SOL. Two scopes:
//
//   · token  — whale BUYS of one specific mint (per-transaction rows).
//   · market — the top whale WALLETS active across pump.fun right now, each row
//              aggregating that wallet's qualifying buys (solMoved = sum, txHash
//              + ts = its largest single qualifying buy).
//
// The buy/sell/neutral SIGNAL is a deterministic buy-pressure rule (documented
// in computeSignal + docs/crypto-api.md) — never an LLM. All fetches degrade to
// an empty result on upstream failure so the endpoint answers 200, never 500.
//
// Data source: pump.fun public swap-api (trades) + frontend-api-v3 (top coins),
// read through api/_lib/pump-feed-fetch.js so a market scan shares its cached
// board and trade pulls with every other pump.fun reader instead of re-tripping
// Cloudflare's rate limit. Both are keyless. Reuses the same hosts + trade shape
// as the paid api/x402/pump-agent-audit.js whale oracle, exposed here free and
// cleaner.

import { fetchPumpTrades, fetchPumpBoard } from './pump-feed-fetch.js';

export const WHALE_MIN_SOL_DEFAULT = Number(process.env.PUMP_WHALE_SOL_THRESHOLD || 5);
export const WHALE_LIMIT_DEFAULT = 10;
export const WHALE_LIMIT_MAX = 25;

// How many top-market-cap coins to sample trades from in market scope. Kept
// small so one call stays within the pump.fun rate budget and our function
// timeout; each coin fetch runs concurrently.
const MARKET_COINS_SAMPLE = 8;
// Trades pulled per coin per sweep (pump swap-api caps this; 100 is plenty to
// surface recent whales without deep pagination).
const TRADES_PER_COIN = 100;

const SOURCE = 'pump.fun';

function parseNum(v) {
	const n = typeof v === 'string' ? parseFloat(v) : Number(v);
	return Number.isFinite(n) ? n : null;
}

// pump trade timestamps arrive as unix-seconds (or ms) numbers, or ISO strings.
// Normalize to an ISO string; null when unresolvable.
function normalizeTs(v) {
	if (v == null) return null;
	if (typeof v === 'string') {
		const t = Date.parse(v);
		return Number.isFinite(t) ? new Date(t).toISOString() : null;
	}
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return null;
	// < 1e12 → seconds, else milliseconds.
	const ms = n < 1e12 ? n * 1000 : n;
	return new Date(ms).toISOString();
}

// Pull a single normalized trade into { side, sol, wallet, txHash, ts }, or null
// if it can't be understood. Defensive against pump's field-name drift.
export function normalizeTrade(t) {
	if (!t || typeof t !== 'object') return null;
	const side = String(t.type ?? t.txType ?? t.side ?? '').toLowerCase();
	if (side !== 'buy' && side !== 'sell') return null;
	const sol = parseNum(t.amountSol ?? t.sol_amount ?? t.solAmount ?? t.amount_sol);
	if (sol == null || sol <= 0) return null;
	const wallet = t.userAddress ?? t.user ?? t.wallet ?? t.trader ?? null;
	if (!wallet) return null;
	const txHash = t.signature ?? t.txHash ?? t.tx ?? t.transaction ?? null;
	const ts = normalizeTs(t.timestamp ?? t.createdAt ?? t.created_at ?? t.ts);
	return { side, sol, wallet: String(wallet), txHash: txHash ? String(txHash) : null, ts };
}

// ── Deterministic buy-pressure signal ─────────────────────────────────────────
// Whales only ever appear here on qualifying trades, so the signal reads NET
// whale flow: SOL bought by whales minus SOL sold by whales, both over the
// `minSol` threshold. A net move of at least one whale-sized position decides
// direction; anything smaller (or no whale activity at all) is neutral.
//
//   netFlow = whaleBuySol − whaleSellSol
//   · no qualifying whale trades at all   → neutral
//   · netFlow ≥ +minSol (net accumulation) → bullish
//   · netFlow ≤ −minSol (net distribution) → bearish
//   · otherwise (balanced)                 → neutral
//
// Scales with the caller's minSol, so the rule means the same thing at any
// threshold. Pure + total-ordering deterministic — no randomness, no clock.
export function computeSignal({ whaleBuySol, whaleSellSol, buyCount, sellCount }, minSol) {
	const buys = Number(whaleBuySol) || 0;
	const sells = Number(whaleSellSol) || 0;
	if ((buyCount || 0) === 0 && (sellCount || 0) === 0) return 'neutral';
	const netFlow = buys - sells;
	if (netFlow >= minSol) return 'bullish';
	if (netFlow <= -minSol) return 'bearish';
	return 'neutral';
}

function round(n) {
	return Math.round((Number(n) || 0) * 1000) / 1000;
}

// ── Aggregation (pure — unit-tested directly) ────────────────────────────────
// From a flat list of normalized trades, split whale buys/sells over `minSol`
// and shape the endpoint response body for the given scope.
export function buildWhaleResult({ trades, scope, mint, minSol, limit }) {
	const norm = trades.map(normalizeTrade).filter(Boolean);

	const whaleBuys = norm.filter((t) => t.side === 'buy' && t.sol >= minSol);
	const whaleSells = norm.filter((t) => t.side === 'sell' && t.sol >= minSol);

	const whaleBuySol = whaleBuys.reduce((s, t) => s + t.sol, 0);
	const whaleSellSol = whaleSells.reduce((s, t) => s + t.sol, 0);

	let whales;
	if (scope === 'token') {
		// Per-buy rows, largest first.
		whales = whaleBuys
			.slice()
			.sort((a, b) => b.sol - a.sol)
			.slice(0, limit)
			.map((t) => ({ wallet: t.wallet, solMoved: round(t.sol), txHash: t.txHash, ts: t.ts }));
	} else {
		// Market scope: aggregate qualifying buys per wallet. Row solMoved = total
		// SOL that wallet moved; txHash/ts = its single largest qualifying buy.
		const byWallet = new Map();
		for (const t of whaleBuys) {
			const cur =
				byWallet.get(t.wallet) || { wallet: t.wallet, solMoved: 0, top: t };
			cur.solMoved += t.sol;
			if (t.sol > cur.top.sol) cur.top = t;
			byWallet.set(t.wallet, cur);
		}
		whales = Array.from(byWallet.values())
			.sort((a, b) => b.solMoved - a.solMoved)
			.slice(0, limit)
			.map((w) => ({
				wallet: w.wallet,
				solMoved: round(w.solMoved),
				txHash: w.top.txHash,
				ts: w.top.ts,
			}));
	}

	// whaleCount reflects the distinct whale entities in `whales` semantics:
	// per-buy count for token scope, distinct whale wallets for market scope.
	const whaleCount =
		scope === 'token'
			? whaleBuys.length
			: new Set(whaleBuys.map((t) => t.wallet)).size;

	const signal = computeSignal(
		{
			whaleBuySol,
			whaleSellSol,
			buyCount: whaleBuys.length,
			sellCount: whaleSells.length,
		},
		minSol,
	);

	return {
		scope,
		mint: scope === 'token' ? mint : null,
		whales,
		whaleCount,
		totalSolMoved: round(whaleBuySol),
		signal,
		ts: new Date().toISOString(),
		source: SOURCE,
	};
}

// ── Upstream fetches (network boundary — always degrade, never throw) ─────────
// Both helpers answer `{ rows, stale }` or null, where null means the call FAILED
// with nothing cached to fall back on. That lets `degraded` below mean "the feed
// is down" rather than "this mint is quiet": a mint with no recent trades is a
// real, reportable answer, not an outage.

export async function fetchCoinTrades(mint, limit = TRADES_PER_COIN) {
	return fetchPumpTrades(mint, { limit });
}

export async function fetchTopCoins(limit = 20) {
	return fetchPumpBoard({ limit });
}

// Token scope — whale buys of one specific mint. Upstream down → empty result.
export async function scanTokenWhales({ mint, minSol, limit }) {
	const feed = await fetchCoinTrades(mint, TRADES_PER_COIN);
	const out = {
		...buildWhaleResult({ trades: feed?.rows || [], scope: 'token', mint, minSol, limit }),
		degraded: feed === null,
	};
	if (feed?.stale) out.stale = true;
	return out;
}

// Market scope — top whale wallets across the top pump.fun coins right now.
// Upstream down → empty result (never throws). Degraded only when the board is
// unreachable or every sampled coin's trade pull failed; a board that is simply
// quiet reports an honest empty set.
export async function scanMarketWhales({ minSol, limit }) {
	const board = await fetchTopCoins(20);
	if (!board || !board.rows.length) {
		return {
			...buildWhaleResult({ trades: [], scope: 'market', mint: null, minSol, limit }),
			degraded: true,
		};
	}
	const sample = board.rows.slice(0, MARKET_COINS_SAMPLE);
	const results = await Promise.allSettled(sample.map((c) => fetchCoinTrades(c.mint, TRADES_PER_COIN)));
	const answered = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
	const trades = answered.flatMap((f) => f.rows);
	const out = {
		...buildWhaleResult({ trades, scope: 'market', mint: null, minSol, limit }),
		degraded: answered.length === 0,
	};
	if (board.stale || answered.some((f) => f.stale)) out.stale = true;
	return out;
}
