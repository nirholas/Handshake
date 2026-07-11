// Multi-source token market data with sequential failover + stale cache.
//
// Sources, in priority order:
//   1. Birdeye (keyed) — richest: includes holders + circulating supply.
//   2. DexScreener (keyless) — price, 24h change, volume, liquidity, market cap.
//   3. GeckoTerminal (keyless) — price, market cap, volume, liquidity, supply.
//
// Each source is normalized to one shape; a fallback source that lacks a field
// (e.g. DexScreener has no holder count) leaves it null rather than failing the
// whole read. On a cold cache where every source is down/rate-limited we return
// the last good value for up to STALE_MAX_MS, then null — callers render what
// they can and never crash on a single upstream blip. This is the market-data
// analogue of the RPC failover layer.

import { cacheGet, cacheGetFresh, cacheSet, cacheDel, acquireLock, releaseLock } from '../cache.js';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex/tokens';
const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana/tokens';

const FETCH_TIMEOUT_MS = 6000;
const DEFAULT_TTL_MS = 30_000;
// Last-good window served when EVERY source is simultaneously down. With the
// single-flight + background-refresh defenses below, the only path to stale is a
// total upstream outage (all three rate-limited at once — TASK-10), so we hold
// the last price far longer: a 25-minute-old price keeps the panel populated
// through a transient outage, which beats blanking it ("all sources failed").
const STALE_MAX_MS = 30 * 60_000;

// L2 (shared, cross-instance) cache TTL. Scaling defense: Vercel runs many
// stateless lambda instances; the per-instance L1 Map below is wiped on every
// cold start, so under a traffic spike each cold instance would independently
// fan out to all three upstreams. The L2 Upstash cache lets a cold lambda serve
// a sibling's recent fetch instead, collapsing fleet-wide upstream load to ~1
// call per key per window — the difference between "holds at 100x" and "every
// instance rate-limits Birdeye at once".
//
// 60s window (was 15s): the background refresh cron (api/cron/three-market-
// refresh) re-fetches $THREE once a minute, so this TTL is sized to outlive one
// cron cadence — on-demand reads serve the cron's warm write and almost never
// touch an upstream. 15s forced ~4× the necessary fan-out (a fresh cascade every
// time the window lapsed); 60s staleness is invisible on a token price panel and
// the cron keeps the real age ≤ one minute regardless.
const SHARED_TTL_S = 60;
const sharedKey = (mint) => `mktdata:v1:${mint}`;

// Fleet-wide single-flight lock for the live upstream fetch. When L1+L2 both
// miss (cold start, or the brief gap between cron refreshes) a traffic spike
// would otherwise have every concurrent lambda run the full Birdeye→DexScreener→
// GeckoTerminal cascade at once — the exact pattern that exhausts all three free
// quotas simultaneously. One instance wins this lock and does the real fetch;
// the losers serve last-good or briefly await the winner's L2 write instead of
// piling onto the upstreams. TTL covers a worst-case full cascade (3 × timeout)
// so the lock never expires mid-fetch and lets a second instance double-fetch.
const lockKey = (mint) => `mktlock:v1:${mint}`;
const LOCK_TTL_S = 20;
const LOCK_WAIT_TRIES = 4;
const LOCK_WAIT_STEP_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const _cache = new Map(); // mint → { value, expires, fetchedAt }
const _warnedAt = new Map();
const WARN_COOLDOWN_MS = 60_000;

// Circuit breaker: when a source reports an exhausted quota (Birdeye's monthly
// compute units) or rate-limits us, stop hitting it for a while instead of
// burning a doomed upstream call + warning on every read. Quota exhaustion
// only clears on the provider's billing cycle, so it gets a long cooldown.
//
// The breaker is FLEET-WIDE, not per-instance. The in-memory map below is wiped
// on every Vercel cold start, so a per-instance breaker lets each fresh lambda
// re-discover the exhausted quota the hard way — one more doomed Birdeye call
// (which still counts against the compute-unit budget) and one more warning, per
// cold instance, for the whole 6-hour window. Mirroring the cooldown into the L2
// (Upstash) cache lets a cold lambda inherit a sibling's verdict and skip the
// dead source immediately, collapsing fleet-wide waste to ~1 call per window.
const _sourceCooldown = new Map(); // source name → epoch ms to skip until
const QUOTA_COOLDOWN_MS = 6 * 3_600_000;
const RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;
// Single L2 key holding { source: untilMs } for every source currently cooling.
const COOLDOWN_KEY = 'mktcool:v1';

function cooldownFor(err) {
	const msg = String(err?.message || '');
	if (/usage limit exceeded|quota exceeded/i.test(msg)) return QUOTA_COOLDOWN_MS;
	if (/^429\b|rate ?limit/i.test(msg)) return RATE_LIMIT_COOLDOWN_MS;
	return 0;
}

// Pull the shared cooldown map from L2 and merge any still-active entries into
// the in-process map, so a cold lambda inherits the fleet's view of dead sources
// before it tries (and re-burns) them. Best-effort: a cache miss/error just
// leaves the in-memory map as-is and the read proceeds normally.
async function hydrateCooldowns(now) {
	try {
		const shared = await cacheGet(COOLDOWN_KEY);
		if (!shared || typeof shared !== 'object') return;
		for (const [source, until] of Object.entries(shared)) {
			if (Number(until) > now && Number(until) > (_sourceCooldown.get(source) || 0)) {
				_sourceCooldown.set(source, Number(until));
			}
		}
	} catch {
		/* fall through — local breaker still applies */
	}
}

// Publish the in-process cooldowns (only those still active) to L2 so siblings
// inherit them. TTL tracks the longest remaining cooldown; once it expires the
// key vanishes and sources are retried. Best-effort.
function publishCooldowns(now) {
	const active = {};
	let maxRemainingMs = 0;
	for (const [source, until] of _sourceCooldown) {
		if (until > now) {
			active[source] = until;
			maxRemainingMs = Math.max(maxRemainingMs, until - now);
		}
	}
	if (maxRemainingMs <= 0) return;
	cacheSet(COOLDOWN_KEY, active, Math.ceil(maxRemainingMs / 1000)).catch(() => {});
}

function warnThrottled(key, msg) {
	const now = Date.now();
	if (now - (_warnedAt.get(key) || 0) < WARN_COOLDOWN_MS) return;
	_warnedAt.set(key, now);
	console.warn(msg);
}

async function fetchJson(url, opts = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const r = await fetch(url, { ...opts, signal: ctrl.signal });
		if (!r.ok) {
			const body = (await r.text().catch(() => '')).slice(0, 200);
			throw new Error(body ? `${r.status} ${body}` : `${r.status}`);
		}
		return await r.json();
	} finally {
		clearTimeout(timer);
	}
}

function shape(partial, source) {
	return {
		price_usd: null,
		price_change_24h: null,
		market_cap: null,
		volume_24h: null,
		holders: null,
		liquidity: null,
		supply: null,
		decimals: 6,
		source,
		...partial,
	};
}

const num = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

async function fromBirdeye(mint) {
	const key = process.env.BIRDEYE_API_KEY;
	if (!key) return null;
	// Birdeye requires the x-chain header; omitting it is a 400, not a default.
	const data = await fetchJson(`${BIRDEYE_BASE}/defi/token_overview?address=${mint}`, {
		headers: { 'X-API-KEY': key, 'x-chain': 'solana', accept: 'application/json' },
	});
	const ov = data?.data;
	if (!ov || !(num(ov.price) > 0)) return null;
	return shape(
		{
			price_usd: num(ov.price),
			price_change_24h: num(ov.priceChange24hPercent),
			market_cap: num(ov.mc ?? ov.marketCap),
			volume_24h: num(ov.v24hUSD ?? ov.volume24h),
			holders: num(ov.holder ?? ov.uniqueWallet30m),
			liquidity: num(ov.liquidity),
			supply: num(ov.supply),
			decimals: num(ov.decimals) ?? 6,
		},
		'birdeye',
	);
}

async function fromDexScreener(mint) {
	const data = await fetchJson(`${DEXSCREENER_BASE}/${mint}`);
	const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
	if (!pairs.length) return null;
	// The deepest-liquidity pair is the canonical market for price/volume.
	const best = pairs.reduce((a, b) => ((b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a));
	const price = num(best.priceUsd);
	if (!(price > 0)) return null;
	const marketCap = num(best.marketCap ?? best.fdv);
	return shape(
		{
			price_usd: price,
			price_change_24h: num(best.priceChange?.h24),
			market_cap: marketCap,
			volume_24h: num(best.volume?.h24),
			liquidity: num(best.liquidity?.usd),
			// supply ≈ marketCap / price when the source omits it explicitly
			supply: marketCap && price ? marketCap / price : null,
		},
		'dexscreener',
	);
}

async function fromGeckoTerminal(mint) {
	const data = await fetchJson(`${GECKOTERMINAL_BASE}/${mint}`);
	const a = data?.data?.attributes;
	const price = num(a?.price_usd);
	if (!(price > 0)) return null;
	const decimals = num(a.decimals) ?? 6;
	const totalSupplyAtomic = num(a.total_supply);
	return shape(
		{
			price_usd: price,
			market_cap: num(a.market_cap_usd) ?? num(a.fdv_usd),
			volume_24h: num(a.volume_usd?.h24),
			liquidity: num(a.total_reserve_in_usd),
			supply: totalSupplyAtomic != null ? totalSupplyAtomic / 10 ** decimals : null,
			decimals,
		},
		'geckoterminal',
	);
}

// DefiLlama coins oracle (keyless) — price-only, but a fully independent
// aggregator (its own multi-DEX sourcing), so it survives when Birdeye,
// DexScreener AND GeckoTerminal are simultaneously down/rate-limited. It carries
// no market cap / volume / liquidity / holders, so those stay null when it's the
// answering source — a price-only panel beats a blank one.
async function fromLlamaCoins(mint) {
	const key = `solana:${mint}`;
	const data = await fetchJson(`https://coins.llama.fi/prices/current/${key}`);
	const c = data?.coins?.[key];
	const price = num(c?.price);
	if (!(price > 0)) return null;
	return shape({ price_usd: price, decimals: num(c?.decimals) ?? 6 }, 'llama');
}

const SOURCES = [fromBirdeye, fromDexScreener, fromGeckoTerminal, fromLlamaCoins];

// Store a value in the per-instance L1 cache (with the bounded-size eviction the
// fetch path uses) and return it. Shared by the live, L2-hit, and lock-loser
// paths so they all keep L1 coherent the same way.
function storeL1(mint, value, now, ttlMs) {
	_cache.set(mint, { value, expires: now + ttlMs, fetchedAt: now });
	if (_cache.size > 256) _cache.delete(_cache.keys().next().value);
	return value;
}

// Lock-loser path: another instance holds the single-flight lock and is fetching
// live right now. Poll the shared cache a few times for its write rather than
// firing our own redundant upstream cascade. Returns the freshly-published value
// or null if the winner hasn't landed within the short wait budget.
async function waitForSharedWrite(mint, ttlMs) {
	for (let i = 0; i < LOCK_WAIT_TRIES; i++) {
		await sleep(LOCK_WAIT_STEP_MS);
		try {
			// Bypass the read-memo: the winner's write is expected momentarily and a
			// freshly-memoized miss would make every poll see stale absence.
			const shared = await cacheGetFresh(sharedKey(mint));
			if (shared && shared.price_usd > 0) return storeL1(mint, shared, Date.now(), ttlMs);
		} catch {
			/* keep waiting, then fall through */
		}
	}
	return null;
}

/**
 * Normalized market data for a mint, with multi-source failover and a stale
 * cache. Returns null only when every source fails and no recent value exists.
 * @param {string} mint
 * @param {{ fresh?: boolean, ttlMs?: number }} [opts]
 */
export async function fetchTokenMarketData(mint, { fresh = false, ttlMs = DEFAULT_TTL_MS } = {}) {
	const now = Date.now();
	const hit = _cache.get(mint);
	if (!fresh && hit && hit.expires > now) return hit.value; // L1: warm in-process

	// L2: shared cross-instance cache. A cold lambda (no L1) serves a sibling's
	// recent fetch instead of hitting three upstreams — the core scaling defense.
	// cache.js already single-flights + memoizes GETs, so a burst of cold reads
	// collapses to one Redis round-trip. Best-effort: any cache error falls through
	// to a live fetch, never failing the read.
	if (!fresh) {
		try {
			const shared = await cacheGet(sharedKey(mint));
			if (shared && shared.price_usd > 0) return storeL1(mint, shared, now, ttlMs);
		} catch {
			/* fall through to live fetch */
		}
	}

	// Single-flight the live fetch across the fleet. A cold/expired cache under a
	// traffic spike would otherwise have every concurrent lambda run the full
	// source cascade at once — the pattern that rate-limits all three upstreams
	// simultaneously (TASK-10). One instance wins the lock and fetches; the losers
	// serve last-good immediately, or briefly await the winner's L2 write, instead
	// of duplicating the upstream calls. fresh:true (the background cron, explicit
	// quote refreshes) deliberately bypasses this — those callers want live data
	// and don't fan out. When Redis is unconfigured acquireLock returns true, so
	// dev/tests keep the direct path.
	let locked = false;
	if (!fresh) {
		locked = await acquireLock(lockKey(mint), LOCK_TTL_S);
		if (!locked) {
			if (hit && now - hit.fetchedAt < STALE_MAX_MS) {
				hit.expires = now + Math.min(ttlMs, 5_000); // re-check soon for the winner's write
				return hit.value;
			}
			const shared = await waitForSharedWrite(mint, ttlMs);
			if (shared) return shared;
			// Winner never landed (its lambda may have died) — fall through and
			// fetch ourselves, trading one extra cascade for correctness in a rare
			// cold-and-contended corner.
		}
	}

	// Live fetch ahead — inherit the fleet's circuit-breaker state so a cold
	// lambda skips a source another instance already found exhausted.
	await hydrateCooldowns(now);

	try {
		for (const src of SOURCES) {
			if ((_sourceCooldown.get(src.name) || 0) > now) continue;
			try {
				const result = await src(mint);
				if (result && result.price_usd > 0) {
					// Publish to the shared cache for sibling instances (best-effort).
					cacheSet(sharedKey(mint), result, SHARED_TTL_S).catch(() => {});
					return storeL1(mint, result, now, ttlMs);
				}
			} catch (err) {
				const cooldown = cooldownFor(err);
				if (cooldown) {
					_sourceCooldown.set(src.name, now + cooldown);
					// Broadcast the verdict so sibling lambdas skip this dead source too.
					publishCooldowns(now);
					warnThrottled(`${src.name}:cooldown`, `[market] ${src.name} quota/rate-limited — skipping it for ${Math.round(cooldown / 60_000)}min: ${err?.message}`);
				} else {
					warnThrottled(`${mint}:${src.name}`, `[market] ${src.name} failed for ${mint.slice(0, 6)}…: ${err?.message}`);
				}
			}
		}
	} finally {
		if (locked) releaseLock(lockKey(mint)); // best-effort; lock also auto-expires
	}

	// Every source failed — serve the last good value if it's still fresh enough.
	if (hit && now - hit.fetchedAt < STALE_MAX_MS) {
		warnThrottled(`${mint}:stale`, `[market] all sources failed for ${mint.slice(0, 6)}… — serving stale (${Math.round((now - hit.fetchedAt) / 1000)}s old)`);
		hit.expires = now + Math.min(ttlMs, 15_000); // brief backoff before retrying upstreams
		return hit.value;
	}
	return null;
}

/** Just the USD price — convenience for the price/quote path. */
export async function fetchTokenPriceUsd(mint, opts) {
	const md = await fetchTokenMarketData(mint, opts);
	return md?.price_usd ?? null;
}

/** Test seam: clear the in-memory caches (and the shared cooldown key) between cases. */
export function __resetMarketCache() {
	_cache.clear();
	_warnedAt.clear();
	_sourceCooldown.clear();
	// Drop the L2 cooldown key so breaker state doesn't leak across cases. On the
	// in-memory (unconfigured-Upstash) path this runs synchronously.
	cacheDel(COOLDOWN_KEY);
}
