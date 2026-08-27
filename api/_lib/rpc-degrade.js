// Shared "the RPC chain is down" plumbing for public Solana read endpoints.
//
// During an RPC outage every read handler used to answer its own flavour of 5xx
// (a bare 502, an unhandled throw, a hang past the gateway timeout). This module
// gives them one vocabulary:
//   - isRpcOutageError(err)   recognises transport/chain-exhaustion failures
//   - rpcUnavailableError()   the typed retryable 503 those failures map to
//   - withDeadline(p, ms)     a hard cap so a stalled lane fails fast enough to
//                             fall back to a last-good value inside the request
//   - staleEnvelope(body, at) the `{ ...body, stale: true, as_of }` marker every
//                             last-good tier serves at HTTP 200
//
// The actual last-good storage stays with the caller (api/_lib/cache.js keys are
// endpoint-specific); this module only shapes the failure and the marker.

// Solana RPC errors arrive as fetch failures, JSON-RPC envelopes, or the
// rotating connection's "all N endpoints failed" summary. None carry an HTTP
// status the resilience helper recognises, so match on the message families.
const OUTAGE_RE =
	/fetch failed|failed to get|failed to fetch|all .* endpoints failed|rpc_unavailable|\b429\b|too many requests|rate.?limit|max usage|\b50[234]\b|timed? ?out|aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i;

export const RPC_RETRY_AFTER_S = 15;

/**
 * True when `err` describes an RPC lane being unreachable, throttled, or
 * exhausted, as opposed to a real on-chain answer (account missing, bad input).
 * @param {unknown} err
 */
export function isRpcOutageError(err) {
	if (!err) return false;
	if (err.code === 'rpc_unavailable' || err.code === 'rpc_error' || err.code === 'rpc_rate_limited') return true;
	if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
	const status = err.status ?? err.statusCode;
	if (status === 429 || status === 502 || status === 503 || status === 504) return true;
	const causeCode = err.cause?.code;
	if (typeof causeCode === 'string' && /^(ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR)/.test(causeCode)) return true;
	return OUTAGE_RE.test(String(err.message || err));
}

/**
 * A typed, retryable 503 the http helpers already know how to render. Callers
 * set `Retry-After: RPC_RETRY_AFTER_S` alongside it.
 * @param {string} [message]
 * @param {unknown} [cause]
 */
export function rpcUnavailableError(message = 'Solana RPC is temporarily unavailable, retry shortly', cause) {
	const e = new Error(message);
	e.status = 503;
	e.code = 'rpc_unavailable';
	e.retryAfter = RPC_RETRY_AFTER_S;
	if (cause !== undefined) e.cause = cause;
	return e;
}

/**
 * Race `promise` against a hard deadline. On timeout rejects with a typed
 * rpc_unavailable error whose message names `label`, so the caller falls into
 * its last-good branch instead of hanging until the gateway cuts the request.
 * The timer is always cleared, so a resolved promise never keeps the loop alive.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export function withDeadline(promise, ms, label = 'rpc read') {
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(rpcUnavailableError(`${label} exceeded ${ms}ms deadline`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Mark a last-good body as stale. `at` is the epoch-ms the value was captured;
 * `as_of` is ISO so a UI can say "as of N minutes ago" without guessing units.
 * @template {object} T
 * @param {T} body
 * @param {number} at
 * @returns {T & { stale: true, as_of: string }}
 */
export function staleEnvelope(body, at) {
	return { ...body, stale: true, as_of: new Date(at).toISOString() };
}
