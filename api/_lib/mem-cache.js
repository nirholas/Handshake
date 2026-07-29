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
 * @template V
 * @param {LRUCache<string, V>} cache
 * @param {string} key
 * @param {() => Promise<V>} load
 * @returns {Promise<V>}
 */
export function cached(cache, key, load) {
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
			if (value !== undefined) cache.set(key, value);
			return value;
		} finally {
			inflight.delete(key);
		}
	})();
	inflight.set(key, p);
	return p;
}

// Per-cache in-flight maps, keyed weakly so a discarded cache is collectable.
const _inflight = new WeakMap();
