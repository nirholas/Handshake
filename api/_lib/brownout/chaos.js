// @ts-check
// Break a named upstream on purpose, for one request, in the real code path.
//
// Every fallback in this codebase is untested code until something makes the
// thing it protects against actually happen. Unit tests stub `fetch` and prove
// the stub was called; they cannot prove that /api/pump/dashboard returns a
// usable page when Birdeye 429s, because the stub replaces the very layer whose
// behaviour is in question. Infra-level chaos (kill a pod, drop a route) is the
// usual answer and is far too blunt: it cannot express "Birdeye is rate
// limiting but DexScreener is fine", which is the failure that actually happens.
//
// So the injection point is the shared fetch wrappers, and the scope is one
// request:
//
//   x-brownout-chaos: birdeye=http:429, tokens-xyz=timeout, dexscreener=network
//
// The request runs the REAL handler, the REAL provider ladder, the REAL cache
// tiers. Only the named upstreams misbehave, and only for the caller who asked.
// Nothing global changes, so a probe can run against production traffic without
// touching anybody else's request.
//
// ── Safety ──────────────────────────────────────────────────────────────────
// This is a switch that makes production misbehave, so it is gated three ways
// and every one of them must pass:
//
//   1. A token. BROWNOUT_CHAOS_TOKEN must be set and match, compared in
//      constant time. Without the env var configured, chaos is off everywhere,
//      including locally, so there is no "forgot to set it in prod" state that
//      leaves it open.
//   2. Never on a money path. A request carrying an x402 payment header, or
//      addressed to a settlement/withdraw/transfer route, is refused outright.
//      You must not be able to fault-inject something that moves funds, no
//      matter who holds the token: the blast radius of a wrong answer there is
//      not a stale price, it is a payment.
//   3. Read-shaped methods only. GET/HEAD by default; a POST is allowed only
//      when it is a declared read (a JSON-RPC query, a search), never a write.
//
// A refused directive is reported back in `x-brownout-chaos-status` rather than
// silently ignored, because a probe that thinks it broke Birdeye and did not is
// worse than one that failed loudly: it would record a green proof for a
// fallback nobody exercised.

import { timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/** @typedef {{ kind: 'timeout'|'network'|'http'|'empty'|'slow', status?: number, ms?: number }} Fault */

/** @type {AsyncLocalStorage<Map<string, Fault>>} */
const storage = new AsyncLocalStorage();

export const CHAOS_HEADER = 'x-brownout-chaos';
export const CHAOS_TOKEN_HEADER = 'x-brownout-chaos-token';
export const CHAOS_STATUS_HEADER = 'x-brownout-chaos-status';

// Routes where a wrong answer is a payment, not a stale number. Matched against
// the request path, case-insensitively, before any token is even considered.
const MONEY_PATHS =
	/\/(x402-pay|x402-facilitator|pay|payments?|settle|withdraw|transfer|checkout|purchase|subscribe|buy|sell|trade|swap|launch|mint|airdrop|claim|payout|treasury)(\/|$|\?)/i;

// Payment intent on ANY route, regardless of path.
const MONEY_HEADERS = ['x-payment', 'payment-signature', 'x-payment-response'];

/**
 * Parse a chaos directive into faults by upstream name.
 * Unknown fault kinds are dropped rather than guessed at, so a typo disables
 * that one entry instead of quietly injecting the wrong failure.
 *
 * @param {string} value
 * @returns {Map<string, Fault>}
 */
export function parseChaosDirective(value) {
	/** @type {Map<string, Fault>} */
	const out = new Map();
	if (typeof value !== 'string' || !value.trim()) return out;
	for (const part of value.split(',')) {
		const [rawName, rawSpec = 'network'] = part.split('=');
		const name = String(rawName || '').trim().toLowerCase();
		if (!name || !/^[a-z0-9:._-]{1,48}$/.test(name)) continue;
		const spec = String(rawSpec).trim().toLowerCase();
		const [kind, arg] = spec.split(':');
		if (kind === 'timeout') out.set(name, { kind: 'timeout' });
		else if (kind === 'network') out.set(name, { kind: 'network' });
		else if (kind === 'empty') out.set(name, { kind: 'empty' });
		else if (kind === 'http') {
			const status = Number(arg);
			if (Number.isInteger(status) && status >= 400 && status <= 599) out.set(name, { kind: 'http', status });
		} else if (kind === 'slow') {
			const ms = Number(arg);
			if (Number.isFinite(ms) && ms > 0 && ms <= 60_000) out.set(name, { kind: 'slow', ms: Math.round(ms) });
		}
	}
	return out;
}

function tokenMatches(supplied, expected) {
	if (!expected || typeof supplied !== 'string' || !supplied) return false;
	const a = Buffer.from(supplied);
	const b = Buffer.from(expected);
	// timingSafeEqual throws on a length mismatch, which itself leaks length, so
	// compare fixed-width digests of both sides instead of the raw values.
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Decide whether a request may inject faults, and which.
 *
 * @param {{ headers?: Record<string, any>, url?: string, method?: string }} req
 * @param {{ token?: string }} [env]
 * @returns {{ allowed: boolean, reason: string, faults: Map<string, Fault> }}
 */
export function chaosDecision(req, env = {}) {
	const headers = req?.headers || {};
	const raw = headers[CHAOS_HEADER];
	const none = new Map();
	if (!raw) return { allowed: false, reason: 'absent', faults: none };

	const expected = env.token ?? process.env.BROWNOUT_CHAOS_TOKEN;
	if (!expected) return { allowed: false, reason: 'not_configured', faults: none };
	if (!tokenMatches(headers[CHAOS_TOKEN_HEADER], expected)) {
		return { allowed: false, reason: 'bad_token', faults: none };
	}

	for (const h of MONEY_HEADERS) {
		if (headers[h]) return { allowed: false, reason: 'money_path', faults: none };
	}
	const path = String(req?.url || '').split('?')[0];
	if (MONEY_PATHS.test(path)) return { allowed: false, reason: 'money_path', faults: none };

	const method = String(req?.method || 'GET').toUpperCase();
	if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
		return { allowed: false, reason: 'write_method', faults: none };
	}

	const faults = parseChaosDirective(Array.isArray(raw) ? raw.join(',') : raw);
	if (!faults.size) return { allowed: false, reason: 'no_valid_faults', faults: none };
	return { allowed: true, reason: 'ok', faults };
}

/**
 * Run `fn` with `faults` active for the current async context.
 * @template T
 * @param {Map<string, Fault>} faults
 * @param {() => T} fn
 * @returns {T}
 */
export function withChaos(faults, fn) {
	if (!faults || !faults.size) return fn();
	return storage.run(faults, fn);
}

/**
 * The fault registered for `name` in this request, or null.
 * Names are matched case-insensitively, and a directive for `birdeye` also
 * matches the sub-scoped `birdeye:txs`, so a caller can break a provider
 * without having to enumerate every call shape the code gives it.
 *
 * @param {string|undefined} name
 * @returns {Fault|null}
 */
export function faultFor(name) {
	const faults = storage.getStore();
	if (!faults || !name) return null;
	const key = String(name).toLowerCase();
	const exact = faults.get(key);
	if (exact) return exact;
	const scope = key.split(':')[0];
	return faults.get(scope) ?? null;
}

/** True when any fault is active, for callers that want to skip work entirely. */
export function chaosActive() {
	const faults = storage.getStore();
	return !!faults && faults.size > 0;
}

/**
 * The error or Response a faulted call must produce, shaped exactly like the
 * real failure it stands in for, so the code under test cannot tell the
 * difference. A fault that produced a distinguishable error would prove only
 * that the code handles Brownout, not that it handles the outage.
 *
 * @param {Fault} fault
 * @param {string} url
 * @returns {Promise<Response>} resolves for http/empty, rejects for timeout/network
 */
export async function applyFault(fault, url) {
	if (fault.kind === 'slow') {
		await new Promise((r) => setTimeout(r, fault.ms || 0));
		return null; // caller proceeds with the real request, just later
	}
	if (fault.kind === 'timeout') {
		// undici raises TimeoutError on AbortSignal.timeout; isRetryableError and
		// every hand-rolled catch in this repo keys off exactly that name.
		throw Object.assign(new Error(`brownout: simulated timeout for ${url}`), { name: 'TimeoutError' });
	}
	if (fault.kind === 'network') {
		// The shape undici gives a refused socket: TypeError('fetch failed') with
		// the errno on `cause`. api/_lib/solana/connection.js reads that cause.
		const err = new TypeError('fetch failed');
		err.cause = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
		throw err;
	}
	if (fault.kind === 'empty') {
		return new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
	}
	const status = fault.status || 500;
	return new Response(JSON.stringify({ error: 'brownout_injected', status }), {
		status,
		headers: {
			'content-type': 'application/json',
			// A real 429 usually carries this, and whether a caller honours it is
			// exactly the kind of thing a proof should be able to check.
			...(status === 429 ? { 'retry-after': '1' } : {}),
		},
	});
}
