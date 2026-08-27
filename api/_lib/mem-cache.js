// Shared in-process caches, backed by `lru-cache`.
//
// Before this module, ~57 files under api/ carried their own `Map` + timestamp
// cache. The bounded ones all repeated the same line:
//
//     if (m.size > MAX) m.delete(m.keys().next().value)
//
// which evicts the OLDEST INSERTED entry, not the least recently used — so a
// hot key inserted early is dropped while cold keys inserted later survive.
// Others called `m.clear()` at the cap, throwing away the whole cache
// periodically, and the majority were unbounded and simply grew.
//
// `LRUCache` fixes all three: true recency ordering, per-entry TTL, and a hard
// item cap. This is per-instance memory (same model as the Maps it replaces);
// cross-instance state still belongs in Redis via `cache.js`.

import { LRUCache } from 'lru-cache';

/**
 * Create a bounded, TTL'd cache.
 *
 * @template V
 * @param {object} [opts]
 * @param {number} [opts.max=512]     maximum entries before LRU eviction
 * @param {number} [opts.ttlMs]       per-entry lifetime; omit for no expiry
 * @param {boolean} [opts.updateAgeOnGet=false] whether a read refreshes the TTL
 * @returns {LRUCache<string, V>}
 */
export function createCache({ max = 512, ttlMs, updateAgeOnGet = false } = {}) {
	return new LRUCache({
		max: Math.max(1, max),
		// Wall-clock TTL, for parity with the `Date.now()` expiry the hand-rolled
		// Maps used (TTLs here are minutes long, so drift is immaterial). The
		// indirection matters: lru-cache captures this object once, at
		// construction, and caches are built at module load — resolving `Date`
		// inside the call keeps TTL behaviour observable under fake timers
		// instead of frozen against a clock captured before the test ran.
		perf: { now: () => Date.now() },
		// Read the clock on every TTL check. By default lru-cache memoizes "now"
		// and clears it from a timer, which makes expiry granular and leaves a
		// stale timestamp behind whenever that timer is discarded. One Date.now()
		// per read is not worth the imprecision.
		ttlResolution: 0,
		...(ttlMs ? { ttl: ttlMs, updateAgeOnGet } : {}),
	});
}

/**
 * Read-through helper with single-flight de-duplication: concurrent misses for
 * the same key share one `load()` call instead of stampeding the upstream.
 * Four separate inflight-dedupe Maps existed across api/ before this.
 *
 * Stale-on-error: every value that `load()` produces is also mirrored into a
 * per-cache last-known-good tier that outlives the entry's TTL (default 30
 * minutes, `staleMs`). When a later `load()` throws, the caller gets that
 * last-good value instead of the rejection. Before this, eleven DefiLlama
 * handlers and the Fear & Greed endpoint went straight from "upstream blipped"
 * to a 502 while a sixty-second-old payload sat in the same process. Pass
 * `staleMs: 0` to opt out where an error must surface (a write, a probe).
 *
 * @template V
 * @param {LRUCache<string, V>} cache
 * @param {string} key
 * @param {() => Promise<V>} load
 * @param {{ staleMs?: number, onStale?: (err: unknown) => void }} [opts]
 * @returns {Promise<V>}
 */
export function cached(cache, key, load, opts = {}) {
	const { staleMs = DEFAULT_STALE_MS, onStale } = opts;
	const hit = cache.get(key);
	if (hit !== undefined) return Promise.resolve(hit);

	let inflight = _inflight.get(cache);
	if (!inflight) {
		inflight = new Map();
		_inflight.set(cache, inflight);
	}
	const pending = inflight.get(key);
	if (pending) return pending;

	const p = (async () => {
		try {
			const value = await load();
			if (value !== undefined) {
				cache.set(key, value);
				if (staleMs > 0) lastGoodTier(cache, staleMs).set(key, value, { ttl: staleMs });
			}
			return value;
		} catch (err) {
			const stale = staleMs > 0 ? lastGoodTier(cache, staleMs).get(key) : undefined;
			if (stale === undefined) throw err;
			if (onStale) onStale(err);
			else warnStale(key, err);
			return stale;
		} finally {
			inflight.delete(key);
		}
	})();
	inflight.set(key, p);
	return p;
}

/** True when `cached()` has a last-good copy of `key` it could serve on error. */
export function hasLastGood(cache, key) {
	const tier = _lastGood.get(cache);
	return tier ? tier.get(key) !== undefined : false;
}

const DEFAULT_STALE_MS = 30 * 60_000;

// One last-good tier per cache, sized like its parent so it cannot outgrow it.
function lastGoodTier(cache, staleMs) {
	let tier = _lastGood.get(cache);
	if (!tier) {
		tier = new LRUCache({ max: cache.max || 512, ttl: staleMs, perf: { now: () => Date.now() }, ttlResolution: 0 });
		_lastGood.set(cache, tier);
	}
	return tier;
}

// One warning per key per minute: an outage should be visible in the logs,
// not fill them.
const _warnedAt = new Map();
function warnStale(key, err) {
	const now = Date.now();
	if ((_warnedAt.get(key) || 0) > now - 60_000) return;
	_warnedAt.set(key, now);
	console.warn(`[mem-cache] load failed for "${key}" (${err?.message || err}); serving last-good`);
}

// Per-cache in-flight maps and last-good tiers, keyed weakly so a discarded
// cache is collectable.
const _inflight = new WeakMap();
const _lastGood = new WeakMap();
