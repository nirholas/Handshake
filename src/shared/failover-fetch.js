// Shared multi-provider failover fetch. Isomorphic: imported by browser code
// (src/*) and Vercel functions (api/_lib/*) alike.
//
// The platform rule is that no external data source is a single point of
// failure: every category of fetch (RPC, prices, token metadata, geocoding)
// runs against an ordered list of free providers, and a failure moves on to
// the next provider immediately instead of surfacing an error. Solana RPC
// (api/_lib/solana/connection.js), EVM RPC (api/_lib/evm/rpc.js), token
// market data (api/_lib/market/token-market.js) and IPFS gateways
// (src/ipfs.js) already implement this per-category; this module is the
// generic version for everything else, so new call sites don't grow their own
// bespoke retry loops.
//
// Semantics:
// - Providers are tried in order with a short per-attempt timeout, so the
//   worst case is bounded (~timeoutMs × providers) and the common case — the
//   first healthy provider — costs nothing extra.
// - A provider that errors (network failure, timeout, non-2xx) goes into a
//   per-process cooldown and is skipped on subsequent calls until it expires,
//   so one dead host doesn't tax every future request with its timeout.
// - A provider whose `parse` returns null/undefined is a MISS, not a failure:
//   "this source doesn't know this token" shouldn't cool the source down for
//   callers asking about other tokens. The chain just moves on.
// - If every provider is cooling down, they're all tried anyway (a full chain
//   of dead providers must still probe for recovery rather than fail cold).

const _cooldowns = new Map(); // provider name -> epoch ms until which it is skipped

// Brownout hooks. This module is isomorphic (the browser bundle imports it), and
// provenance/chaos are node:async_hooks, so they are loaded lazily behind an
// isServer() gate exactly as api/_lib/solana/connection.js loads the shared
// cache. In a browser both resolve to no-ops, which is correct: there is no
// request to attribute a source to, and nothing should be able to inject a
// fault from the client side.
let _brownoutPromise;
// Resolved module, once the import lands. Recording has to be SYNCHRONOUS in the
// hot path: the response header is written when the handler ends, and an await
// here would let a record arrive after its own response had already gone out.
// That is not a lost log line, it is a trace that omits the rung that answered.
let _brownoutMod = null;
function brownout() {
	if (_brownoutPromise !== undefined) return _brownoutPromise;
	_brownoutPromise = null;
	if (typeof window === 'undefined') {
		_brownoutPromise = import('../../api/_lib/brownout/index.js')
			.then((m) => {
				_brownoutMod = m;
				return m;
			})
			.catch(() => null);
	}
	return _brownoutPromise;
}
// Warm the import at module load on the server, so by the time a request runs
// the module is in hand and every record is written synchronously.
brownout();

function noteSource(rec) {
	if (_brownoutMod) {
		_brownoutMod.recordSource?.(rec);
		return;
	}
	// Only on the very first call of a cold process, before the import lands.
	const pending = brownout();
	if (pending) void pending.then((m) => m?.recordSource?.(rec));
}
async function faultForProvider(name) {
	if (_brownoutMod) return _brownoutMod.faultFor?.(name) ?? null;
	const mod = await brownout();
	return mod?.faultFor?.(name) ?? null;
}

/**
 * @typedef {object} Provider
 * @property {string} name                       Stable id; keys the cooldown map.
 * @property {string} url                        Request URL.
 * @property {RequestInit} [init]                Extra fetch options (headers, method…).
 * @property {(res: Response) => Promise<any>} [parse]
 *   Extract the value from a 2xx response. Defaults to `res.json()`. Return
 *   null/undefined to signal "no data here, try the next provider" without
 *   penalising this provider. Throw to penalise it.
 */

/**
 * Try each provider in order until one yields a value.
 *
 * @param {Provider[]} providers   Ordered preference list.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=4000]    Per-provider attempt timeout.
 * @param {number} [opts.cooldownMs=60000]  Skip window after a provider errors.
 * @param {string} [opts.label]             Prefix for the aggregate error message.
 * @returns {Promise<{value: any, source: string}>}
 * @throws when every provider fails or misses.
 */
export async function fetchFirst(providers, { timeoutMs = 4000, cooldownMs = 60_000, label = 'fetchFirst' } = {}) {
	const now = Date.now();
	const hot = providers.filter((p) => (_cooldowns.get(p.name) || 0) <= now);
	const order = hot.length ? hot : providers;

	let lastErr;
	for (const p of order) {
		const startedAt = Date.now();
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		// A caller-supplied signal (stale-search abort) composes with the
		// per-attempt timeout rather than being replaced by it.
		const signal = p.init?.signal ? AbortSignal.any([ctrl.signal, p.init.signal]) : ctrl.signal;
		try {
			// A declared fault stands in for the real one, in the same position the
			// real failure would occupy, so the ladder below fails over identically.
			const fault = await faultForProvider(p.name);
			let res;
			if (fault) {
				const mod = _brownoutMod || (await brownout());
				const injected = await mod.applyFault(fault, p.url);
				if (injected) res = injected;
			}
			if (!res) {
				res = await fetch(p.url, {
					headers: { accept: 'application/json' },
					...p.init,
					signal,
				});
			}
			if (!res.ok) throw new Error(`http_${res.status}`);
			const value = await (p.parse ? p.parse(res) : res.json());
			if (value != null) {
				// The rung that answered is `live`; the ones before it are recorded
				// in the catch below, so a trace shows the whole walk, not just the
				// winner. That is the difference between "we have a ladder" and
				// "here is the ladder working".
				noteSource({ name: p.name, outcome: 'ok', ms: Date.now() - startedAt, tier: 'live' });
				return { value, source: p.name };
			}
			// Miss: provider is healthy but has no data for this query.
			noteSource({ name: p.name, outcome: 'skip', ms: Date.now() - startedAt, tier: 'live', detail: 'no_data' });
			lastErr = new Error(`${p.name}: no_data`);
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			noteSource({
				name: p.name,
				outcome: 'fail',
				ms: Date.now() - startedAt,
				tier: 'live',
				detail: /http_(\d{3})/.exec(lastErr.message)?.[1] || (lastErr.name === 'TimeoutError' ? 'timeout' : 'error'),
			});
			// Caller abandoned the request (stale search) — stop the whole chain
			// and don't penalise the provider for it.
			if (p.init?.signal?.aborted) {
				clearTimeout(timer);
				break;
			}
			_cooldowns.set(p.name, Date.now() + cooldownMs);
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error(`${label}: all ${order.length} providers failed (${lastErr?.message || 'unknown'})`);
}

/**
 * Like fetchFirst but resolves to `fallback` (default null) instead of
 * throwing — for best-effort call sites where missing data is a designed
 * state (metadata enrichment, place labels) rather than an error.
 *
 * @param {Provider[]} providers
 * @param {object} [opts]  Same options as fetchFirst, plus `fallback`.
 * @returns {Promise<any>} The first provider's parsed value, or `fallback`.
 */
export async function fetchFirstOrNull(providers, opts = {}) {
	const { fallback = null, ...rest } = opts;
	try {
		return (await fetchFirst(providers, rest)).value;
	} catch {
		return fallback;
	}
}

const RETRYABLE_STATUSES = [408, 425, 429, 500, 502, 503, 504];

/**
 * fetch with a bounded retry for a single URL: network errors and retryable
 * statuses (429, 5xx) are retried with exponential backoff; any other response
 * is returned as-is on the first attempt. The last retryable response is
 * returned (not thrown) once attempts are exhausted, so callers keep their
 * normal `res.ok` handling. Use this for an idempotent GET against one host;
 * a POST that must run exactly once (a swap build) stays single-shot.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {object} [opts]
 * @param {number} [opts.attempts=3]        Total attempts, including the first.
 * @param {number} [opts.backoffMs=400]     Base delay; doubles per retry.
 * @param {number} [opts.timeoutMs]         Per-attempt deadline (composes with init.signal).
 * @param {number[]} [opts.retryOn]         Statuses that trigger a retry.
 * @returns {Promise<Response>}
 */
export async function retryFetch(url, init = {}, { attempts = 3, backoffMs = 400, timeoutMs, retryOn = RETRYABLE_STATUSES } = {}) {
	let lastErr;
	for (let i = 0; i < attempts; i++) {
		if (i > 0) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (i - 1)));
		const signals = [];
		if (init.signal) signals.push(init.signal);
		if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
		try {
			const res = await fetch(url, signal ? { ...init, signal } : init);
			if (!retryOn.includes(res.status) || i === attempts - 1) return res;
			lastErr = new Error(`http_${res.status}`);
		} catch (err) {
			// The caller gave up (stale request): stop, and never mask that as a retry.
			if (init.signal?.aborted) throw err;
			lastErr = err;
			if (i === attempts - 1) throw err;
		}
	}
	throw lastErr;
}
