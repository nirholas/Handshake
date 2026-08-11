// Transient-failure handling for Robinhood Chain RPC reads.
//
// The public RPC (rpc.mainnet.chain.robinhood.com) sheds load by answering a
// perfectly valid `eth_getLogs` with JSON-RPC -32602 "Missing or invalid
// parameters". Measured live: the identical range that failed succeeds on the
// next attempt, every time. viem never retries -32602 (it classifies it as a
// caller mistake, not a server condition), so a single shed request aborts a
// whole cold-start backfill. Everything that reads logs or blocks in bulk goes
// through withRpcRetry.

const RETRYABLE_CODES = new Set([
	-1, // viem "unknown error"
	-32005, // limit exceeded
	-32603, // internal error
	-32602, // this RPC's load-shed response (see above)
	429, // some providers return the HTTP code in the JSON-RPC body
]);

const RETRYABLE_STATUS = new Set([408, 413, 429, 500, 502, 503, 504]);

const RETRYABLE_TEXT = /(fetch failed|socket hang up|econnreset|etimedout|econnrefused|eai_again|enotfound|timed out|timeout|rate limit|too many requests|service unavailable|bad gateway)/i;

/** True when an RPC error is a server-side/transient condition worth retrying. */
export function isTransientRpcError(err) {
	if (!err) return false;
	if (err.name === 'AbortError') return false;
	for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
		if (typeof e.code === 'number' && RETRYABLE_CODES.has(e.code)) return true;
		if (typeof e.status === 'number' && RETRYABLE_STATUS.has(e.status)) return true;
		if (typeof e.code === 'string' && RETRYABLE_TEXT.test(e.code)) return true;
		if (typeof e.message === 'string' && RETRYABLE_TEXT.test(e.message)) return true;
	}
	return false;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

/**
 * Run an RPC read, retrying transient failures with exponential backoff + jitter.
 * A non-transient error (bad ABI, malformed address) throws on the first attempt
 * so real bugs stay loud.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, baseDelayMs?: number, onRetry?: (info: { attempt: number, delayMs: number, error: Error }) => void }} [opts]
 * @returns {Promise<T>}
 */
export async function withRpcRetry(fn, { attempts = 4, baseDelayMs = 300, onRetry } = {}) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			if (attempt === attempts || !isTransientRpcError(err)) throw err;
			const delayMs = Math.round(baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.4));
			onRetry?.({ attempt, delayMs, error: err });
			await sleep(delayMs);
		}
	}
	throw lastError;
}
