// Permission-manifest primitives for @three-ws/tool-sdk.
//
// A tool declares what it is allowed to do — which hosts it may fetch from,
// how often each API may be called, and whether it may read wallet context —
// as plain, inspectable data (`PluginPermissions`, see define-tool.js). This
// module turns that declaration into two things that are cheap to enforce at
// the SDK layer, without a host runtime:
//
//   1. An in-memory token-bucket rate limiter, keyed per API name.
//   2. `guardedFetch(permissions)` — a `fetch` wrapper that throws on any
//      host outside the declared `network` allowlist. Deny-by-default: a
//      tool that declares no `network` permission may not fetch anything.
//
// Wallet access is declarative only — the SDK does not (and cannot) enforce
// it; enforcement stays with the host that grants a signer to the executor's
// `ctx`.

/**
 * @typedef {object} PluginPermissions
 * @property {string[]} [network] Allowlisted hostnames the executor may fetch
 *   from (exact match — no wildcards). Omit or leave empty to deny all
 *   outbound network access via `guardedFetch`.
 * @property {{ calls: number, perSeconds: number }} [rateLimit] Token-bucket
 *   rate limit applied per API name (e.g. `{ calls: 60, perSeconds: 60 }` for
 *   60 calls/minute).
 * @property {boolean} [wallet] Whether the executor may read a wallet address
 *   from its invocation context. Declarative metadata only.
 */

/**
 * Normalize a raw `permissions` config into a stable, deduplicated shape.
 * Safe to call with `undefined` — returns the "no permissions" default
 * (empty network allowlist, no rate limit, no wallet access).
 *
 * @param {Partial<PluginPermissions>} [permissions]
 * @returns {{ network: string[], rateLimit: { calls: number, perSeconds: number } | null, wallet: boolean }}
 */
export function normalizePermissions(permissions = {}) {
	const network = Array.isArray(permissions.network)
		? [...new Set(permissions.network.filter((host) => typeof host === 'string' && host.length > 0))]
		: [];

	const rawRateLimit = permissions.rateLimit;
	const rateLimit =
		rawRateLimit &&
		Number.isFinite(rawRateLimit.calls) &&
		rawRateLimit.calls > 0 &&
		Number.isFinite(rawRateLimit.perSeconds) &&
		rawRateLimit.perSeconds > 0
			? { calls: rawRateLimit.calls, perSeconds: rawRateLimit.perSeconds }
			: null;

	return { network, rateLimit, wallet: Boolean(permissions.wallet) };
}

/**
 * Create an in-memory token-bucket rate limiter for a normalized `rateLimit`
 * config. Returns `null` when no rate limit is declared, so callers can
 * `limiter?.tryTake(...)` unconditionally.
 *
 * Buckets are keyed by an arbitrary string (typically the API name), so one
 * limiter instance can track independent quotas per API.
 *
 * @param {{ calls: number, perSeconds: number } | null | undefined} rateLimit
 * @returns {{ tryTake(key?: string, now?: number): boolean, reset(key?: string): void } | null}
 */
export function createRateLimiter(rateLimit) {
	if (!rateLimit) return null;
	const { calls, perSeconds } = rateLimit;
	const refillPerSecond = calls / perSeconds;
	/** @type {Map<string, { tokens: number, updatedAt: number }>} */
	const buckets = new Map();

	return {
		/**
		 * Attempt to take one token from the bucket identified by `key`.
		 * @param {string} [key]
		 * @param {number} [now] Injectable clock (ms) — primarily for tests.
		 * @returns {boolean} `true` if the call is allowed, `false` if rate-limited.
		 */
		tryTake(key = 'default', now = Date.now()) {
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = { tokens: calls, updatedAt: now };
				buckets.set(key, bucket);
			}
			const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
			bucket.tokens = Math.min(calls, bucket.tokens + elapsedSeconds * refillPerSecond);
			bucket.updatedAt = now;

			if (bucket.tokens >= 1) {
				bucket.tokens -= 1;
				return true;
			}
			return false;
		},

		/**
		 * Reset one bucket (by key) or every bucket (no key).
		 * @param {string} [key]
		 */
		reset(key) {
			if (key === undefined) buckets.clear();
			else buckets.delete(key);
		},
	};
}

/**
 * Build a `fetch`-compatible function that refuses any host outside the
 * tool's declared `network` permission. Deny-by-default: if no `network`
 * hosts are declared, every call is refused.
 *
 * @param {Partial<PluginPermissions>} permissions
 * @returns {(input: string | URL | Request, init?: RequestInit) => Promise<Response>}
 */
export function guardedFetch(permissions) {
	const { network: allowlist } = normalizePermissions(permissions);
	const allow = new Set(allowlist);

	return async function guardedFetchImpl(input, init) {
		const rawUrl = typeof input === 'string' || input instanceof URL ? input : input?.url;

		let hostname;
		try {
			hostname = new URL(rawUrl).hostname;
		} catch {
			throw Object.assign(new Error(`guardedFetch: could not parse a hostname from "${rawUrl}"`), {
				code: 'INVALID_URL',
			});
		}

		if (!allow.has(hostname)) {
			const detail = allow.size > 0 ? `allowlist: [${[...allow].join(', ')}]` : 'no hosts allowlisted (deny-all by default)';
			throw Object.assign(new Error(`guardedFetch: host "${hostname}" is not permitted — ${detail}`), {
				code: 'NETWORK_NOT_ALLOWED',
				hostname,
			});
		}

		return fetch(input, init);
	};
}
