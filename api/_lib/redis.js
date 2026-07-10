// Shared Upstash Redis singleton. Import this instead of constructing a new
// Redis() in each module — every module constructing its own client is a
// separate HTTP connection pool entry and burns quota independently, which
// caused the June 2026 500k/mo blowout. One instance, shared across all callers
// within a single Vercel function invocation.
//
// Callers that need fail-closed / fail-open behavior on absence should check
// the returned value: `getRedis()` returns null when Upstash is not configured.
//
// Usage:
//   import { getRedis } from './redis.js';
//   const r = getRedis();
//   if (!r) { /* fallback */ }
//
// Command-level timeout
// ---------------------
// The Upstash REST client's own retry/abort layer has been observed in prod to
// take far longer than any caller can wait (live-verified 2026-07-08: POST
// requests to fresh rate-limited routes — /api/v1/ai/tts, /api/v1/ai/text-to-3d,
// /api/v1/sentiment — hung with ZERO bytes returned for 55s+ against
// three.ws, while a warm-limiter route like /api/tts/speak answered in
// <200ms). A network-level stall (as opposed to a fast WRONGPASS the auth
// breaker above already handles) never throws, so `await rl.limit(id)` just
// hangs — and every consumer's carefully-designed fail-closed/fail-open
// fallback (resilientLimiter, cache.js, usage.js) never gets the chance to run
// because the promise it awaits never settles. Race every command against a
// bounded timeout so a stalled network call surfaces as a normal (non-auth)
// rejection within seconds, letting those existing fallbacks do their job.
function commandTimeoutMs() {
	return Math.max(1_000, Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 5_000);
}

class RedisCommandTimeoutError extends Error {
	constructor(ms) {
		super(`redis command timed out after ${ms}ms`);
		this.name = 'RedisCommandTimeoutError';
		this.timedOut = true;
	}
}

// Not exported as part of the public timeout contract, but resilientLimiter /
// other consumers can recognize it the same way they recognize any transient
// error — this is deliberately NOT an auth error, so it never trips the
// permanent auth breaker above (a stalled network path is worth retrying next
// request; a bad token is not).
function raceCommand(promise) {
	const ms = commandTimeoutMs();
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new RedisCommandTimeoutError(ms)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Auth-failure fast-fail breaker
// ------------------------------
// A WRONGPASS / "invalid or missing auth token" / NOPERM / NOAUTH response is a
// PERMANENT, config-level failure (a rotated or stale UPSTASH_REDIS_REST_TOKEN),
// not the transient outage the per-consumer fallbacks were written for. Without a
// breaker, every limiter, the usage buffer, the x402 feed and ~50 other consumers
// keep issuing doomed commands on EVERY request: each pays a full Upstash REST
// round-trip (latency + the request-quota the whole module exists to conserve)
// only to fail identically, and each re-logs — the 24k-warning / "operation
// aborted due to timeout" flood seen in production (prod log export 2026-06-28).
//
// So we wrap the client: the first auth failure OPENS a per-instance breaker, and
// for AUTH_BREAKER_COOLDOWN_MS every command short-circuits straight to its
// caller's existing fallback — no fetch, no quota spend, no per-request stall.
// The short-circuit rejection is tagged `circuitOpen` so consumers (cache.js
// already honors this flag; rate-limit / usage / x402-pay now do too) skip their
// own per-request warning. Once the cooldown elapses the breaker goes half-open
// and admits exactly one trial command: its success CLOSES the breaker the instant
// the token is rotated back (self-heal, no redeploy); its failure re-arms the
// cooldown. Net cost of a bad token: one log line + one trial per minute per
// instance, instead of a doomed round-trip on every request.
//
// Only auth failures trip the breaker. Transient errors (timeouts, 5xx) keep the
// existing per-consumer degrade behavior untouched — they are genuinely worth
// retrying, an auth failure never is.

import { Redis } from '@upstash/redis';
import { env } from './env.js';

let _instance = undefined; // undefined = not yet resolved; null = checked, absent

// --- Auth-failure breaker state (per serverless instance) ---
// Read per use (a cheap env get) so the cooldown can be tuned per deploy without a
// redeploy, and clamped so a fat-fingered value can't disable the breaker.
function authBreakerCooldownMs() {
	return Math.max(1_000, Number(process.env.REDIS_AUTH_BREAKER_COOLDOWN_MS) || 60_000);
}
let authOpenUntil = 0; // epoch ms; 0 = closed (commands flow normally)
let authTrialInFlight = false;

// --- Quota-exhaustion breaker state (per instance) ---
// Separate from the auth breaker so the two causes stay independently
// observable in healthz and so a token rotation can't mask an over-quota plan.
// The cooldown escalates ×2 per consecutive re-arm (60s → 10min ceiling): a
// month-long condition should not be re-probed every minute for weeks, but the
// probe must stay frequent enough that a plan upgrade heals within minutes.
const QUOTA_COOLDOWN_BASE_MS = 60_000;
const QUOTA_COOLDOWN_MAX_MS = 600_000;
let quotaOpenUntil = 0;
let quotaTrialInFlight = false;
let quotaRearms = 0;

function quotaCooldownMs() {
	return Math.min(QUOTA_COOLDOWN_MAX_MS, QUOTA_COOLDOWN_BASE_MS * 2 ** Math.min(10, quotaRearms));
}

class RedisQuotaBreakerOpenError extends Error {
	constructor() {
		super('redis quota breaker open (Upstash monthly request limit exhausted)');
		this.name = 'RedisQuotaBreakerOpenError';
		this.circuitOpen = true;
		this.quotaBreakerOpen = true;
	}
}

// Auth/permission failures are permanent until the credential changes; only these
// trip the breaker. Upstash surfaces them in the error message body it returns.
// Exported (as isRedisAuthError) so per-consumer fallbacks can recognize the same
// auth failure even when an intermediary library (e.g. @upstash/ratelimit) wraps
// the underlying rejection and strips our `circuitOpen` tag — those consumers
// defer the one auth log line to this module's breaker instead of re-logging it
// per limiter on every cooldown trial.
function isAuthError(err) {
	const m = String(err?.message || err || '');
	return /WRONGPASS|NOAUTH|NOPERM|invalid or missing auth token|\b401\b|\b403\b/i.test(m);
}
export { isAuthError as isRedisAuthError };

// Plan-quota exhaustion — "ERR max requests limit exceeded. Limit: 500000, Usage:
// 500000" — is the OTHER permanent, config-level failure mode, and the one that
// actually took production down (live 2026-07-10: healthz `cache` degraded, every
// SET rejected, every `critical` rate-limit bucket failing closed).
//
// It behaves nothing like a transient blip: the monthly counter does not reset
// until the billing cycle rolls over, so every command for the rest of the month
// is doomed. Left untreated each request still pays a full Upstash REST round-trip
// (latency on the hot path) and re-logs, exactly the flood the auth breaker exists
// to prevent. Treat it the same way: open a breaker, short-circuit to the caller's
// fallback, and re-probe on an escalating cooldown so a plan upgrade self-heals
// without a redeploy.
function isQuotaError(err) {
	const m = String(err?.message || err || '');
	return /max requests limit exceeded|max daily request limit|ERR max requests|quota exceeded/i.test(m);
}
export { isQuotaError as isRedisQuotaError };

// Thrown when the breaker is open. Tagged `circuitOpen` so consumers treat it as a
// normal "Redis unavailable" fallback WITHOUT emitting a per-request warning (the
// open/recovered transitions each log exactly once). Mirrors the convention the
// cache layer (api/_lib/cache.js) already uses for its own breaker.
class RedisAuthBreakerOpenError extends Error {
	constructor() {
		super('redis auth breaker open (invalid/stale UPSTASH_REDIS_REST_TOKEN)');
		this.name = 'RedisAuthBreakerOpenError';
		this.circuitOpen = true;
		this.authBreakerOpen = true;
	}
}

// Returns true if a command may be issued. Open → false, except once per cooldown
// it admits a single half-open trial to detect a restored credential.
function breakerAllows() {
	if (authOpenUntil === 0) return true;
	if (Date.now() < authOpenUntil) return false;
	if (authTrialInFlight) return false; // a trial is already probing; hold the rest
	authTrialInFlight = true;
	return true;
}

// Same half-open protocol as the auth breaker, on its own state.
function quotaBreakerAllows() {
	if (quotaOpenUntil === 0) return true;
	if (Date.now() < quotaOpenUntil) return false;
	if (quotaTrialInFlight) return false;
	quotaTrialInFlight = true;
	return true;
}

function quotaRecordFailure(err) {
	const wasTrial = quotaTrialInFlight;
	quotaTrialInFlight = false;
	const opening = quotaOpenUntil === 0;
	if (!opening) quotaRearms += 1;
	quotaOpenUntil = Date.now() + quotaCooldownMs();
	if (opening && !wasTrial) {
		console.error(
			'[redis] QUOTA EXHAUSTED — the Upstash plan request limit is used up; ' +
				`fast-failing all Redis commands to in-memory fallbacks for ${quotaCooldownMs() / 1000}s ` +
				'(upgrade the Upstash plan or wait for the monthly reset to restore distributed ' +
				'limiters/cache). Cause:',
			err?.message || err,
		);
	}
}

function breakerRecordSuccess() {
	if (authOpenUntil !== 0) {
		console.warn('[redis] auth recovered — UPSTASH_REDIS_REST_TOKEN valid again, commands resumed');
	}
	if (quotaOpenUntil !== 0) {
		console.warn('[redis] quota recovered — Upstash requests are being served again, commands resumed');
	}
	authOpenUntil = 0;
	authTrialInFlight = false;
	quotaOpenUntil = 0;
	quotaTrialInFlight = false;
	quotaRearms = 0;
}

function breakerRecordFailure(err) {
	const wasTrial = authTrialInFlight;
	authTrialInFlight = false;
	const opening = authOpenUntil === 0;
	authOpenUntil = Date.now() + authBreakerCooldownMs();
	if (opening && !wasTrial) {
		console.error(
			'[redis] AUTH FAILURE — UPSTASH_REDIS_REST_TOKEN is invalid or stale; ' +
				`fast-failing all Redis commands to in-memory fallbacks for ${authBreakerCooldownMs() / 1000}s ` +
				'(rotate the token in the prod env to restore distributed limiters/cache). Cause:',
			err?.message || err,
		);
	}
}

// Wrap one client method so it participates in the breaker: short-circuit while
// open, record success/auth-failure on settle. Non-auth errors pass through
// untouched (the caller's existing transient-error fallback handles them) and do
// NOT trip or reset the breaker.
function wrapCommand(fn, target) {
	return function (...args) {
		if (!breakerAllows()) return Promise.reject(new RedisAuthBreakerOpenError());
		if (!quotaBreakerAllows()) return Promise.reject(new RedisQuotaBreakerOpenError());
		let out;
		try {
			out = fn.apply(target, args);
		} catch (err) {
			// Synchronous throw (bad args, etc.) — not a transport/auth signal.
			return Promise.reject(err);
		}
		if (!out || typeof out.then !== 'function') return out; // non-promise: pass through
		return raceCommand(Promise.resolve(out)).then(
			(res) => {
				breakerRecordSuccess();
				return res;
			},
			(err) => {
				if (isAuthError(err)) breakerRecordFailure(err);
				else if (isQuotaError(err)) quotaRecordFailure(err);
				else {
					// Trial hit a transient error; release the probe slot for both breakers.
					if (authTrialInFlight) authTrialInFlight = false;
					if (quotaTrialInFlight) quotaTrialInFlight = false;
				}
				throw err;
			},
		);
	};
}

// pipeline()/multi() return a chainable builder whose commands run on .exec(). We
// don't short-circuit these (low-volume write paths), but we DO let their exec()
// trip/heal the breaker so a bad token is still detected from those paths, and
// race it against the same stall guard as single commands.
function wrapPipeline(pipe) {
	const exec = pipe.exec;
	if (typeof exec === 'function') {
		pipe.exec = function (...args) {
			return raceCommand(Promise.resolve(exec.apply(pipe, args))).then(
				(res) => {
					breakerRecordSuccess();
					return res;
				},
				(err) => {
					if (isAuthError(err)) breakerRecordFailure(err);
					else if (isQuotaError(err)) quotaRecordFailure(err);
					throw err;
				},
			);
		};
	}
	return pipe;
}

// Methods that build a chain rather than issuing a command immediately.
const CHAIN_BUILDERS = new Set(['pipeline', 'multi']);

function wrapClient(client) {
	const cache = new Map();
	return new Proxy(client, {
		get(target, prop) {
			// Read with `target` as the receiver (not our outer Proxy): the upstash
			// client may itself be an auto-pipelining Proxy whose traps key off the
			// receiver, so handing it back our wrapper would confuse method resolution.
			const value = target[prop];
			if (typeof value !== 'function') return value;
			if (CHAIN_BUILDERS.has(prop)) {
				return function (...args) {
					return wrapPipeline(value.apply(target, args));
				};
			}
			let wrapped = cache.get(prop);
			if (!wrapped) {
				wrapped = wrapCommand(value, target);
				cache.set(prop, wrapped);
			}
			return wrapped;
		},
	});
}

export function getRedis() {
	if (_instance !== undefined) return _instance;
	if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
		_instance = wrapClient(
			new Redis({
				url: env.UPSTASH_REDIS_REST_URL,
				token: env.UPSTASH_REDIS_REST_TOKEN,
			}),
		);
	} else {
		_instance = null;
	}
	return _instance;
}

/**
 * Current auth-breaker state, for health/diagnostics endpoints
 * (api/admin/redis-health.js). `open` true means the shared token is failing and
 * commands are being short-circuited to fallbacks on this instance.
 */
export function redisAuthBreakerState() {
	return {
		open: authOpenUntil !== 0 && Date.now() < authOpenUntil,
		openUntil: authOpenUntil || null,
		cooldownMs: authBreakerCooldownMs(),
	};
}

/**
 * Current quota-breaker state, for health/diagnostics endpoints. `open` true means
 * the Upstash plan's request limit is exhausted and commands are short-circuiting
 * to per-instance fallbacks on this instance. Unlike the auth breaker, the remedy
 * is a plan upgrade (or the monthly reset), not a token rotation.
 */
export function redisQuotaBreakerState() {
	return {
		open: quotaOpenUntil !== 0 && Date.now() < quotaOpenUntil,
		openUntil: quotaOpenUntil || null,
		cooldownMs: quotaCooldownMs(),
		rearms: quotaRearms,
	};
}

/** Test-only: reset the breakers between cases. */
export function __resetRedisAuthBreaker() {
	authOpenUntil = 0;
	authTrialInFlight = false;
	quotaOpenUntil = 0;
	quotaTrialInFlight = false;
	quotaRearms = 0;
	_instance = undefined;
}
