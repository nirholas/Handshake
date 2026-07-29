// Shared resilience helpers — thin, reusable wrappers over `cockatiel` so every
// external call (pump.fun, Birdeye, Solana RPC, LLM proxies, …) can get a
// battle-tested circuit breaker + timeout without each endpoint hand-rolling its
// own cooldown flag. ADDITIVE: existing guards stay; this just gives new/raw call
// sites a one-liner to fail fast and degrade gracefully during an upstream outage.
//
// Serverless note: breaker + timeout state is PER-LAMBDA-INSTANCE (cockatiel
// holds it in memory), exactly like the hand-rolled cooldowns it replaces. That
// is the right model for "fail fast on a sick upstream" — it does not need to be
// distributed. Truly shared state (rate limits, holder snapshot lock) stays on
// Redis, untouched.

import {
	circuitBreaker,
	retry,
	ExponentialBackoff,
	ConsecutiveBreaker,
	handleAll,
	handleWhen,
	BrokenCircuitError,
	TaskCancelledError,
} from 'cockatiel';

// One breaker per logical upstream name, memoized for the life of the instance so
// repeated failures to the same service accumulate toward the open threshold.
const _breakers = new Map();

function getBreaker(name, { threshold, halfOpenAfterMs }) {
	const key = `${name}:${threshold}:${halfOpenAfterMs}`;
	let b = _breakers.get(key);
	if (!b) {
		b = circuitBreaker(handleAll, {
			halfOpenAfter: halfOpenAfterMs,
			breaker: new ConsecutiveBreaker(threshold),
		});
		_breakers.set(key, b);
	}
	return b;
}

/**
 * Run `fn` behind a named circuit breaker. On success, returns its value. When
 * the breaker is OPEN (recent consecutive failures) the call is rejected
 * instantly without invoking `fn` — so an influx during an upstream outage stops
 * paying the per-request timeout. On an open circuit OR an `fn` failure, resolves
 * to `fallback` (a value, or a function of the error) instead of throwing, so
 * callers degrade gracefully exactly where they already expected a soft failure.
 *
 * @template T
 * @param {string} name                       logical upstream id, e.g. 'pumpfun:creator-fees'
 * @param {() => Promise<T>} fn               the async operation (already timeout-bounded if it does I/O)
 * @param {object} [opts]
 * @param {T | ((err: unknown) => T)} [opts.fallback=null]  value/factory returned on open-circuit or failure
 * @param {number} [opts.threshold=5]         consecutive failures before the circuit opens
 * @param {number} [opts.halfOpenAfterMs=30000] cooldown before a single trial request is allowed through
 * @returns {Promise<T>}
 */
export async function withBreaker(name, fn, opts = {}) {
	const { fallback = null, threshold = 5, halfOpenAfterMs = 30_000 } = opts;
	const breaker = getBreaker(name, { threshold, halfOpenAfterMs });
	try {
		return await breaker.execute(fn);
	} catch (err) {
		// BrokenCircuitError (open), TaskCancelledError (timeout), or the operation's
		// own error — all degrade to the fallback so the caller never hard-fails on
		// a non-critical upstream.
		return typeof fallback === 'function' ? fallback(err) : fallback;
	}
}

/**
 * Whether an error came from the resilience layer short-circuiting (open circuit
 * or a cancelled/timed-out task) rather than the operation itself — useful when a
 * caller wants to log "skipped, upstream cooling down" distinctly from a real error.
 */
export function isCircuitError(err) {
	return err instanceof BrokenCircuitError || err instanceof TaskCancelledError;
}

// ── Retry ────────────────────────────────────────────────────────────────────
//
// Roughly three dozen hand-rolled `for (let attempt…) { … sleep(base * 2**a) }`
// loops existed across api/ before this, almost none of which applied jitter —
// so a shared upstream blip re-synchronized every caller into the same retry
// wave. Cockatiel's ExponentialBackoff is decorrelated-jittered by default.
// Use these helpers instead of writing another loop.

/** HTTP statuses worth retrying: rate limiting plus transient server errors. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Whether an error looks transient. Recognizes an explicit `status`/`statusCode`
 * (as attached by our fetch wrappers), Node network errno codes, and abort or
 * timeout errors. Anything else — a 400, a parse error, a bug — is not retried.
 */
export function isRetryableError(err) {
	if (!err) return false;
	const status = err.status ?? err.statusCode ?? err.response?.status;
	if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
	const code = err.code || err.cause?.code;
	if (
		code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
		code === 'EAI_AGAIN' || code === 'EPIPE' || code === 'ENOTFOUND' ||
		code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' ||
		code === 'UND_ERR_SOCKET'
	) return true;
	return err.name === 'AbortError' || err.name === 'TimeoutError';
}

/**
 * Parse a `Retry-After` header, which upstreams send either as delta-seconds or
 * as an HTTP-date. Returns milliseconds, or null when absent/unparseable.
 * Three separate copies of this existed under api/_providers.
 *
 * @param {string | null | undefined} value
 * @returns {number | null}
 */
export function parseRetryAfter(value) {
	if (value == null || value === '') return null;
	const secs = Number(value);
	if (Number.isFinite(secs)) return secs >= 0 ? Math.round(secs * 1000) : null;
	const at = Date.parse(String(value));
	if (Number.isNaN(at)) return null;
	return Math.max(0, at - Date.now());
}

/**
 * Run `fn` with jittered exponential backoff.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.attempts=3]      total attempts, including the first
 * @param {number} [opts.initialDelayMs=250]
 * @param {number} [opts.maxDelayMs=10000]
 * @param {(err: unknown) => boolean} [opts.shouldRetry=isRetryableError]
 * @param {string} [opts.label]           included in the thrown error's message
 * @returns {Promise<T>} the operation's value, or a rejection with the last error
 */
export function withRetry(fn, opts = {}) {
	const {
		attempts = 3,
		initialDelayMs = 250,
		maxDelayMs = 10_000,
		shouldRetry = isRetryableError,
		label,
	} = opts;
	const policy = retry(handleWhen(shouldRetry), {
		maxAttempts: Math.max(1, attempts) - 1,
		backoff: new ExponentialBackoff({ initialDelay: initialDelayMs, maxDelay: maxDelayMs }),
	});
	return policy.execute(fn).catch((err) => {
		if (label && err instanceof Error && !err.__labelled) {
			err.message = `${label}: ${err.message}`;
			err.__labelled = true;
		}
		throw err;
	});
}

/**
 * Retry `fn`, then degrade to `fallback` rather than throwing — the combination
 * most call sites actually want for a non-critical upstream.
 *
 * @template T
 * @param {string} name logical upstream id, for the shared breaker
 * @param {() => Promise<T>} fn
 * @param {object} [opts] accepts every `withRetry` and `withBreaker` option
 * @returns {Promise<T>}
 */
export function withRetryAndBreaker(name, fn, opts = {}) {
	return withBreaker(name, () => withRetry(fn, opts), opts);
}

// Test/ops hook — drop all memoized breakers so a fresh state can be asserted.
export function _resetBreakers() {
	_breakers.clear();
}
