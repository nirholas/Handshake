// @ts-check
// One fetch for every third-party upstream call from api/**.
//
// The audit of 2026-08-27 found ~60 handler and helper modules calling a raw
// `fetch(url)` against an external host with no timeout, no retry, no
// Retry-After handling and no alternative source. Each of those is a place
// where one slow or rate-limited provider turns into a hung invocation or a
// 500 for the user. The building blocks already existed (cockatiel retries and
// breakers in resilience.js, the ordered-provider chain in
// src/shared/failover-fetch.js, the last-good cache in mem-cache.js); what was
// missing was one call that composed them so a handler could adopt them in a
// single line. That is this module.
//
//   fetchUpstream(url, init, opts)       Response, bounded and retried
//   fetchUpstreamJson(url, init, opts)   parsed body, same guarantees
//   fetchAnyJson([url, ...], init, opts) first host that answers, in order
//   lastGood(key, load, opts)            serve the previous value when load fails
//
// Guarantees, in order of what they protect:
// - A per-attempt timeout (default 8s) composed with any caller signal, so a
//   stalled socket can never outlive the request that opened it.
// - Retries only on transient failures: network errno, aborts, 408/425/429 and
//   5xx. A 4xx that is not a rate limit is returned to the caller unchanged so a
//   bad request is never retried into a quota.
// - Retry-After is honoured up to `maxRetryAfterMs`; beyond that the call gives
//   up immediately rather than sleeping through the whole invocation budget.
// - One consecutive-failure breaker per logical upstream (`opts.name`), so an
//   outage stops costing every request its full timeout after a few failures.
// - Non-2xx surfaces as an Error carrying `status`, `url` and a body excerpt so
//   isRetryableError (resilience.js) and callers can branch on it.
//
// What this module deliberately does not do: SSRF validation of caller-supplied
// URLs (use fetch-model.js / ssrf.js for those) and Solana/EVM RPC rotation,
// which have method-aware chains in solana/connection.js and evm/rpc.js.

import { withRetry, withBreaker, parseRetryAfter, isRetryableError } from './resilience.js';
import { createCache } from './mem-cache.js';
import { recordSource } from './brownout/provenance.js';
import { applyFault, faultFor } from './brownout/chaos.js';

export const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MAX_RETRY_AFTER_MS = 5_000;
const BODY_EXCERPT = 200;

export class UpstreamError extends Error {
	/**
	 * @param {string} message
	 * @param {{ status?: number, url?: string, body?: string, retryAfterMs?: number | null, cause?: unknown }} [info]
	 */
	constructor(message, info = {}) {
		super(message);
		this.name = 'UpstreamError';
		this.status = info.status;
		this.url = info.url;
		this.body = info.body;
		this.retryAfterMs = info.retryAfterMs ?? null;
		if (info.cause !== undefined) this.cause = info.cause;
	}
}

/** Strip query-string credentials before a URL reaches an error message or log. */
export function safeUrl(url) {
	try {
		const u = new URL(String(url));
		for (const k of [...u.searchParams.keys()]) {
			if (/key|token|secret|auth|sig/i.test(k)) u.searchParams.set(k, 'REDACTED');
		}
		return u.toString();
	} catch {
		return String(url);
	}
}

// Body text for an error message, never throwing: a non-2xx is often an HTML
// error page or an empty body, and some Response-likes (test doubles, older
// fetch shims) have no text() at all.
async function readBodyText(res) {
	try {
		return typeof res.text === 'function' ? await res.text() : '';
	} catch {
		return '';
	}
}

function composeSignal(callerSignal, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (!callerSignal) return timeout;
	return AbortSignal.any([callerSignal, timeout]);
}

/**
 * @typedef {object} UpstreamOptions
 * @property {number} [timeoutMs]        per-attempt budget (default 8000)
 * @property {number} [attempts]         total attempts including the first (default 3)
 * @property {number} [maxRetryAfterMs]  longest Retry-After we will sleep for (default 5000)
 * @property {string} [name]             logical upstream id; enables the shared breaker
 * @property {number} [breakerThreshold] consecutive failures before the breaker opens (default 5)
 * @property {number} [halfOpenAfterMs]  breaker cooldown (default 30000)
 * @property {(res: Response) => boolean} [okWhen] override "success" (default res.ok)
 * @property {string} [label]            prefix for thrown error messages
 */

/**
 * Fetch an external URL with a timeout, transient-failure retries and an
 * optional breaker. Resolves with the Response only when `okWhen(res)` holds
 * (default `res.ok`); every other outcome rejects with an UpstreamError so no
 * caller has to remember to check `res.ok`.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {UpstreamOptions} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchUpstream(url, init = {}, opts = {}) {
	const {
		timeoutMs = DEFAULT_TIMEOUT_MS,
		attempts = DEFAULT_ATTEMPTS,
		maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
		name,
		breakerThreshold = 5,
		halfOpenAfterMs = 30_000,
		okWhen = (res) => res.ok,
		label,
	} = opts;
	const shown = safeUrl(url);

	const t0 = Date.now();
	const attempt = async () => {
		let res;
		try {
			// Brownout: a fault declared for this upstream, in this request only,
			// is raised in the shape of the real failure it stands in for, from
			// inside the same try that would have caught the genuine one. That
			// placement is the whole point: retries, Retry-After handling and the
			// breaker below all see it exactly as they would see the outage.
			const fault = faultFor(name || shown);
			if (fault) {
				const injected = await applyFault(fault, shown);
				if (injected) res = injected;
			}
			if (!res) res = await fetch(url, { ...init, signal: composeSignal(init.signal, timeoutMs) });
		} catch (err) {
			if (init.signal?.aborted) throw err;
			const e = new UpstreamError(`${shown}: ${err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err?.message || 'network error'}`, { url: shown, cause: err });
			// Mark as transient so withRetry keeps going; isRetryableError recognises the name.
			e.name = err?.name === 'TimeoutError' ? 'TimeoutError' : 'UpstreamError';
			if (e.name === 'UpstreamError') e.status = 503;
			throw e;
		}
		if (okWhen(res)) return res;
		// Read the body and the Retry-After defensively. This is the ERROR path of
		// the one wrapper every third-party call in api/ goes through, so a throw
		// raised while describing a failure would replace the upstream's real
		// status with an opaque 503, and a 429 that reads as a 5xx changes what
		// callers do next (back off versus fail over). Anything Response-shaped
		// enough to have a status must still report that status.
		const body = await readBodyText(res);
		const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'));
		const e = new UpstreamError(`${shown}: http ${res.status}${body ? ` ${body.slice(0, BODY_EXCERPT)}` : ''}`, {
			status: res.status,
			url: shown,
			body: body.slice(0, BODY_EXCERPT),
			retryAfterMs,
		});
		if (retryAfterMs != null && retryAfterMs > maxRetryAfterMs) {
			// The upstream asked for a wait longer than we will spend: fail now so the
			// caller can move to its next source instead of burning the invocation.
			e.tooLongToWait = true;
		} else if (retryAfterMs != null && retryAfterMs > 0 && isRetryableError(e)) {
			await new Promise((r) => setTimeout(r, retryAfterMs));
		}
		throw e;
	};

	const shouldRetry = (err) => !err?.tooLongToWait && !init.signal?.aborted && isRetryableError(err);
	const run = () => withRetry(attempt, { attempts, shouldRetry, label });
	// Every third-party call in api/ goes through here, which makes this the one
	// place that can record what actually happened without every call site
	// remembering to. `live` because a value that reaches this return came off
	// the wire during this request; the cache tiers stamp their own.
	const label_ = name || shown;
	const noteOk = (v) => {
		recordSource({ name: label_, outcome: 'ok', ms: Date.now() - t0, tier: 'live' });
		return v;
	};
	const noteFail = (err) => {
		recordSource({
			name: label_,
			outcome: 'fail',
			ms: Date.now() - t0,
			tier: 'live',
			detail: err?.status ?? (err?.name === 'TimeoutError' ? 'timeout' : 'error'),
		});
		throw err;
	};

	if (!name) return run().then(noteOk, noteFail);
	let failure;
	const value = await withBreaker(name, run, {
		threshold: breakerThreshold,
		halfOpenAfterMs,
		fallback: (err) => {
			failure = err;
			return null;
		},
	});
	if (value) return noteOk(value);
	return noteFail(failure instanceof Error ? failure : new UpstreamError(`${label || name}: circuit open`, { url: shown, status: 503 }));
}

/**
 * fetchUpstream + JSON parse. A body that is not JSON rejects with an
 * UpstreamError (status 502) rather than a bare SyntaxError, so a provider that
 * starts returning an HTML error page is classified as an upstream fault.
 *
 * @template T
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {UpstreamOptions} [opts]
 * @returns {Promise<T>}
 */
export async function fetchUpstreamJson(url, init = {}, opts = {}) {
	const res = await fetchUpstream(url, { headers: { accept: 'application/json' }, ...init }, opts);
	// Read the raw text so a provider that starts serving an HTML error page is
	// reported as an upstream fault with an excerpt, rather than as a bare
	// SyntaxError from JSON.parse. A Response-like that only implements json()
	// still works: this is the single wrapper for every third-party call in
	// api/, so it accepts anything response-shaped rather than demanding the
	// exact built-in.
	if (typeof res.text !== 'function') return res.json();
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		throw new UpstreamError(`${safeUrl(url)}: non-JSON body ${text.slice(0, BODY_EXCERPT)}`, { status: 502, url: safeUrl(url), body: text.slice(0, BODY_EXCERPT) });
	}
}

/**
 * Try several equivalent hosts in order and return the first parsed JSON body.
 * Each host gets its own timeout and (short) retry; a host that fails is skipped
 * for the rest of this call, and, when `opts.name` is set, tracked by its own
 * breaker (`${name}:${index}`) so a dead mirror is skipped on later calls too.
 * `opts.accept(value, url)` may reject a 2xx body that carries no usable data
 * (return false) so the chain moves on without penalising the host.
 *
 * @template T
 * @param {string[]} urls
 * @param {RequestInit} [init]
 * @param {UpstreamOptions & { accept?: (value: any, url: string) => boolean }} [opts]
 * @returns {Promise<{ value: T, url: string, index: number }>}
 */
export async function fetchAnyJson(urls, init = {}, opts = {}) {
	const { accept, name, attempts = 2, ...rest } = opts;
	const list = urls.filter(Boolean);
	if (!list.length) throw new UpstreamError(`${opts.label || 'fetchAnyJson'}: no urls configured`, { status: 503 });
	let lastErr;
	for (let i = 0; i < list.length; i++) {
		const url = list[i];
		try {
			const value = await fetchUpstreamJson(url, init, { ...rest, attempts, name: name ? `${name}:${i}` : undefined });
			if (accept && !accept(value, url)) {
				lastErr = new UpstreamError(`${safeUrl(url)}: no usable data`, { url: safeUrl(url), status: 404 });
				continue;
			}
			return { value, url, index: i };
		} catch (err) {
			lastErr = err;
			if (init.signal?.aborted) break;
		}
	}
	throw new UpstreamError(`${opts.label || 'fetchAnyJson'}: all ${list.length} sources failed (${lastErr?.message || 'unknown'})`, { status: 503, cause: lastErr });
}

// Process-wide last-known-good store. Keys are caller-chosen; values live for
// `maxAgeMs` after their last successful load. Small on purpose: this is the
// "keep the page alive through a blip" layer, not a cache.
const lastGoodStore = createCache({ max: 2_000, ttlMs: 6 * 60 * 60_000 });

/**
 * Run `load()`; on success remember the value under `key`; on failure return
 * the remembered value if it is younger than `maxAgeMs`, else rethrow. The
 * returned object says whether the value is stale so a handler can label it
 * (`x-data-stale: 1`, a "last updated" caption) instead of passing it off as live.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} load
 * @param {{ maxAgeMs?: number, onFallback?: (err: unknown, ageMs: number) => void }} [opts]
 * @returns {Promise<{ value: T, stale: boolean, ageMs: number, error?: unknown }>}
 */
export async function lastGood(key, load, opts = {}) {
	const { maxAgeMs = 15 * 60_000, onFallback } = opts;
	try {
		const value = await load();
		if (value !== undefined && value !== null) lastGoodStore.set(key, { value, at: Date.now() });
		return { value, stale: false, ageMs: 0 };
	} catch (err) {
		const hit = lastGoodStore.get(key);
		const ageMs = hit ? Date.now() - hit.at : Infinity;
		if (hit && ageMs <= maxAgeMs) {
			onFallback?.(err, ageMs);
			// The single most important thing a caller can know about a response:
			// this value is older than it was meant to be, and by how much.
			recordSource({ name: `lastgood:${key}`.slice(0, 48), outcome: 'ok', ms: ageMs, tier: 'stale', detail: 'stale' });
			return { value: hit.value, stale: true, ageMs, error: err };
		}
		throw err;
	}
}

/**
 * lastGood() for callers that only want the value: the previous good value on
 * failure (within `maxAgeMs`), else the loader's rejection. Fits directly into
 * a read-through cache loader: `cached(cache, key, () => lastGoodValue(key, load))`.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} load
 * @param {{ maxAgeMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function lastGoodValue(key, load, opts = {}) {
	return (await lastGood(key, load, {
		...opts,
		onFallback: (err, ageMs) => console.warn(`[upstream] ${key}: serving last good value (${Math.round(ageMs / 60_000)}m old) after ${err?.message || err}`),
	})).value;
}

/** Test hook: forget every remembered value. */
export function _resetLastGood() {
	lastGoodStore.clear();
}
