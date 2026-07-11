// Real pump.fun launch feed — the entry trigger source for the strategy runtime.
//
// The live sniper worker consumes a WebSocket; a stateless Vercel cron can't hold
// one open, so the runtime polls the SAME pump.fun frontend API the rest of the
// codebase already uses (PUMP_FRONTEND_BASE) for the most-recent launches, sorted
// newest-first. Every field is real on-chain/feed data — no synthetic launches,
// ever. pump.fun's public launch feed is mainnet-only; devnet has no equivalent,
// so recentPumpLaunches() returns [] there (entries simply don't fire on devnet —
// open positions still exit via real on-chain re-quotes).

import { solPriceUsd as sharedSolPriceUsd } from './sol-price.js';

const PUMP_FRONTEND_BASE = process.env.PUMP_FRONTEND_BASE || 'https://frontend-api-v3.pump.fun';
const FETCH_TIMEOUT_MS = 6_000;
const UA = 'three.ws-strategy-runtime/1';

async function fetchJsonWithTimeout(url, ms = FETCH_TIMEOUT_MS) {
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), ms);
	try {
		const r = await fetch(url, {
			signal: ctrl.signal,
			headers: { accept: 'application/json', 'user-agent': UA },
		});
		if (!r.ok) return null;
		return await r.json();
	} catch {
		return null;
	} finally {
		clearTimeout(tid);
	}
}

function pickMcUsd(c, solPrice) {
	if (typeof c?.usd_market_cap === 'number') return c.usd_market_cap;
	if (typeof c?.market_cap === 'number' && solPrice > 0) return c.market_cap * solPrice;
	return null;
}

function liquiditySol(c) {
	const real = Number(c?.real_sol_reserves);
	if (Number.isFinite(real) && real > 0) return real / 1e9;
	const virt = Number(c?.virtual_sol_reserves);
	if (Number.isFinite(virt) && virt > 0) return virt / 1e9;
	return null;
}

function isGraduated(c) {
	return c?.complete === true || !!c?.raydium_pool || !!c?.pump_swap_pool;
}

/** Map a raw pump.fun coin object → the launch shape matchesEntry() expects. */
export function normalizeLaunch(c, solPrice = 0) {
	if (!c || !c.mint) return null;
	return {
		mint: c.mint,
		name: c.name || null,
		symbol: c.symbol || null,
		created_at: c.created_timestamp ? Number(c.created_timestamp) : null,
		market_cap_usd: pickMcUsd(c, solPrice),
		liquidity_sol: liquiditySol(c),
		creator: c.creator || null,
		creator_launches: null, // enriched on demand (enrichCreatorStats)
		creator_graduated: null,
		twitter: c.twitter || null,
		telegram: c.telegram || null,
		website: c.website || null,
		is_usdc_pair: false, // pump.fun bonding-curve coins are SOL-quoted
		graduated: isGraduated(c),
	};
}

// SOL/USD for USD-denominating launch market caps. Delegates to the shared
// 7-source failover helper (CoinGecko → Jupiter → Kraken → Coinbase → DefiLlama
// → DIA → Bitfinex, itself cached ~60s) so a single-provider rate-limit never
// zeroes the feed's USD figures. Returns 0 only if every source is down.
const solPriceUsd = () => sharedSolPriceUsd();

/**
 * Fetch the most-recent RAW pump.fun coin objects (newest-first), keeping the
 * "feed unreachable" case distinct from "feed genuinely empty" — the free
 * /api/crypto/launches endpoint needs that distinction for an honest `source`
 * note, while recentPumpLaunches() below collapses both to [] on purpose.
 *
 * @param {{ limit?: number }} [o] how many recent coins to pull (default 50, max 100)
 * @returns {Promise<{ kind: 'ok', coins: object[] } | { kind: 'upstream_down', coins: [] }>}
 */
export async function fetchRecentPumpCoins({ limit = 50 } = {}) {
	const n = Math.min(100, Math.max(1, Number(limit) || 50));
	const url = `${PUMP_FRONTEND_BASE}/coins?offset=0&limit=${n}&sort=created_timestamp&order=DESC&includeNsfw=false`;
	const data = await fetchJsonWithTimeout(url);
	if (data == null) return { kind: 'upstream_down', coins: [] };
	const coins = Array.isArray(data) ? data : Array.isArray(data?.coins) ? data.coins : [];
	return { kind: 'ok', coins };
}

/**
 * Fetch the most-recent pump.fun launches (newest-first), normalized. Returns []
 * on any feed outage (the runtime treats an empty feed as "no entries this
 * sweep", never as an error — entries are best-effort, exits are not).
 *
 * @param {object} o
 * @param {string} [o.network]  'mainnet' (default) — devnet has no public feed → []
 * @param {number} [o.limit]    how many recent coins to pull (default 50, max 100)
 */
export async function recentPumpLaunches({ network = 'mainnet', limit = 50 } = {}) {
	if (network !== 'mainnet') return [];
	const { coins: list } = await fetchRecentPumpCoins({ limit });
	if (!list.length) return [];
	const solPrice = await solPriceUsd();
	const out = [];
	for (const c of list) {
		const launch = normalizeLaunch(c, solPrice);
		// Only pre-graduation, SOL-quoted bonding-curve coins are buyable on the
		// agent-wallet trade path — drop graduated ones from the entry candidates.
		if (launch && !launch.graduated) out.push(launch);
	}
	return out;
}

const _creatorCache = new Map();
/**
 * Enrich a launch with the creator's launch history (count + graduated count),
 * fetched only for candidate mints a strategy actually gates on. Mutates and
 * returns the launch; leaves the fields null if the lookup fails.
 */
export async function enrichCreatorStats(launch, solPrice = 0) {
	if (!launch?.creator) return launch;
	const hit = _creatorCache.get(launch.creator);
	let coins = hit && Date.now() - hit.t < 60_000 ? hit.v : null;
	if (!coins) {
		coins = await fetchJsonWithTimeout(
			`${PUMP_FRONTEND_BASE}/coins/user-created-coins/${encodeURIComponent(launch.creator)}?offset=0&limit=100&includeNsfw=true`,
		);
		if (_creatorCache.size > 500) _creatorCache.clear();
		_creatorCache.set(launch.creator, { t: Date.now(), v: coins });
	}
	if (Array.isArray(coins)) {
		launch.creator_launches = coins.length;
		launch.creator_graduated = coins.reduce((acc, c) => acc + (isGraduated(c) ? 1 : 0), 0);
	}
	return launch;
}

export { isGraduated };
