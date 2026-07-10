// Shared cache adapter — Upstash Redis (REST) primary, in-memory fallback.
//
// Why: Vercel serverless functions are stateless per-instance. Our previous
// in-memory Map cache was wiped on every cold start, which is *most* requests
// under low traffic. Upstash REST works on edge + node, no socket pooling,
// and the free tier (10k cmd/day) easily covers our portfolio/balances volume.
//
// Falls back to in-memory transparently when UPSTASH_REDIS_REST_URL is unset,
// so dev + tests need no extra config.
//
// Values above COMPRESS_MIN_BYTES are gzip-compressed before the wire (see
// encodeForWire): the large best-effort bodies — the galaxy money-feed, trending
// snapshots — are highly compressible JSON, and shipping 5-10x fewer bytes over
// Upstash REST is what keeps a far-region SET inside its command deadline instead
// of aborting on timeout. Reads transparently decompress; legacy plaintext values
// still parse, so the format change needs no migration.
//
// Env:
//   UPSTASH_REDIS_REST_URL    — https://<region>.upstash.io
//   UPSTASH_REDIS_REST_TOKEN  — REST API token (read+write)
//   (resolved through _lib/env.js, which also accepts the Vercel-marketplace
//   names three_KV_REST_API_URL/TOKEN and KV_REST_API_URL/TOKEN)

import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { env } from './env.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const memCache = new Map();
const MEM_DEFAULT_TTL_MS = 60_000;

// Short read-through memo, in front of Redis even when Redis is configured.
// A warm serverless instance often serves a burst of identical hot reads
// (trending, token config, marketplace listings) within a second or two; without
// this, each one spends a Redis GET and at platform scale that volume alone can
// exhaust the Upstash request quota. We hold the last value for MEMO_TTL_MS so
// repeated reads collapse to a single Redis round-trip per key per window. Writes
// (cacheSet/cacheDel) refresh/clear the memo so we never serve a value we just
// overwrote. Bounded: a few seconds of staleness on cache data is invisible.
const readMemo = new Map();
const MEMO_TTL_MS = 2_000;
const MEMO_MAX_ENTRIES = 5_000; // backstop against unbounded key cardinality

// In-flight GET coalescing. The read-memo above only collapses *sequential*
// reads; under a burst (the exact load that exhausts the Upstash request quota)
// N concurrent reads of the same hot key all miss the not-yet-populated memo and
// each fire their own Redis GET. Single-flight makes those N callers await one
// shared round-trip instead. Self-bounded: an entry lives only while its GET is
// in flight and is removed in `finally`.
const inflightGets = new Map();

function memoGet(key) {
	const hit = readMemo.get(key);
	if (!hit) return undefined; // undefined = no memo; null is a cached "miss"
	if (Date.now() > hit.expiresAt) {
		readMemo.delete(key);
		return undefined;
	}
	return hit.value;
}
function memoPut(key, value) {
	if (readMemo.size >= MEMO_MAX_ENTRIES) readMemo.clear();
	readMemo.set(key, { value, expiresAt: Date.now() + MEMO_TTL_MS });
}

function memSet(key, value, ttlSeconds) {
	const ttlMs = (ttlSeconds && ttlSeconds * 1000) || MEM_DEFAULT_TTL_MS;
	memCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
function memGet(key) {
	const hit = memCache.get(key);
	if (!hit) return null;
	if (Date.now() > hit.expiresAt) {
		memCache.delete(key);
		return null;
	}
	return hit.value;
}
function memDel(key) {
	memCache.delete(key);
}

// Resolve which Upstash store the cache talks to. Prefer a dedicated cache store
// (UPSTASH_CACHE_REST_*) so the large, best-effort cache writes never contend with —
// or burn the command quota of — the fail-closed rate limiter, which lives on
// UPSTASH_REDIS_REST_* (api/_lib/redis.js). Fall back to the shared store for
// back-compat, then to in-memory. Resolved per call: it's a couple of cheap env
// reads, and resolving fresh avoids pinning stale config across env changes in tests.
function cacheTarget() {
	if (env.UPSTASH_CACHE_REST_URL && env.UPSTASH_CACHE_REST_TOKEN) {
		return { url: env.UPSTASH_CACHE_REST_URL, token: env.UPSTASH_CACHE_REST_TOKEN, dedicated: true };
	}
	if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
		return { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, dedicated: false };
	}
	return null;
}

function redisConfigured() {
	return cacheTarget() !== null;
}

// A cache round-trip must be fast or not happen at all. Without a timeout a
// Upstash TCP stall (as opposed to a clean 5xx, which rejects promptly) would hang
// the fetch until the caller's function hits its hard maxDuration → a 504 on an
// endpoint whose whole point in calling us was to be fast. Cap every command so a
// degraded Redis fails fast into the in-memory fallback instead of stalling the
// request. 3s is far longer than a healthy REST GET/SET yet well under any caller's
// budget. Tunable per deploy via CACHE_REDIS_CMD_TIMEOUT_MS (resolved + clamped in
// _lib/env.js) so a cache store in a region far from the function region — the
// cause of legitimate "operation aborted due to timeout" SET failures — can be
// given more headroom without a code change. Read per command (a cheap env get) so
// the knob takes effect on the next request, not only on cold start.
function redisCmdTimeoutMs() {
	return env.CACHE_REDIS_CMD_TIMEOUT_MS;
}

// Circuit breaker around the Upstash REST call. A degraded store (commands
// timing out at REDIS_CMD_TIMEOUT_MS rather than rejecting promptly) otherwise
// makes EVERY request pay a full 3s stall before falling back to memory, and
// emits one identical "redis SET failed" warning per request — the exact flood
// seen in production on hot endpoints like /api/galaxy/flows. After
// CIRCUIT_FAIL_THRESHOLD consecutive command failures we OPEN the circuit: for
// CIRCUIT_COOLDOWN_MS every command short-circuits straight to the memory
// fallback (no fetch, no per-request warning). Once the cooldown elapses the
// circuit goes half-open and lets exactly one trial command through — its
// success closes the circuit (Redis restored), its failure re-arms the cooldown.
// Net cost of a Redis outage: one "opened" log + one trial per 30s, instead of a
// 3s-stall-plus-warning on every single request.
const CIRCUIT_FAIL_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;
// A chronically degraded store re-arms the fixed cooldown forever — one trial +
// one open/close log pair per minute, hundreds per day (the July 2026 export:
// 381 circuit opens in 10h). Escalate the cooldown ×2 per consecutive re-arm up
// to a ceiling, so a store that stays down settles at one probe per 10 minutes
// while a genuinely transient blip still recovers within the 60s base window.
const COOLDOWN_MAX_MS = 600_000;
let circuitFailures = 0;
let circuitOpenUntil = 0; // epoch ms; 0 = closed
let circuitTrialInFlight = false;
let circuitRearms = 0; // consecutive re-opens without an intervening success

// SET-path write suppression. The shared circuit breaker above keys off
// CONSECUTIVE command failures across all ops, but the production failure mode is
// a degraded Upstash that fails the large best-effort SETs while GETs stay fast
// and healthy (see the WARN_THROTTLE_MS note below). Every healthy GET resets
// circuitFailures before SET timeouts can reach the threshold, so the breaker
// stays (correctly) closed to keep serving cache reads — yet every SET still pays
// a full REDIS_CMD_TIMEOUT_MS stall and emits a warning, which is the actual log
// flood seen on hot endpoints (/api/galaxy/flows, /api/explore). The fix is a
// gate that counts SET failures on their OWN consecutive streak: once they reach
// SET_FAIL_THRESHOLD we suppress the Redis SET entirely for SET_SUPPRESS_MS —
// memory write only, no fetch, no per-request stall, no warning. One trial SET is
// admitted after the window; its success resumes writes. GET reads are never
// gated by this, so cache hits keep flowing throughout.
const SET_FAIL_THRESHOLD = 5;
const SET_SUPPRESS_MS = 60_000;
let setFailures = 0;
let setSuppressedUntil = 0; // epoch ms; 0 = writing normally
let setRearms = 0; // consecutive suppression re-arms without a successful SET

// Cumulative counters since this instance came up. Gauges (circuitOpen,
// setSuppressed) say "is it degraded right now"; these totals give the health
// snapshot in api/cron/uptime-check.js a trend to graph and let /healthz report
// "how bad has it been this instance's lifetime" — the texture a single point-in-
// time read can't show. Reset only on cold start, which is honest: a serverless
// instance's counter IS its lifetime.
let totalSetFailures = 0;
let totalCircuitOpens = 0;

// Thrown when the circuit is open. Callers treat it as a normal cache miss but
// skip the per-request warning, since the open/close transitions log once each.
class CircuitOpenError extends Error {
	constructor() {
		super('cache redis circuit open');
		this.circuitOpen = true;
	}
}

function circuitAllows() {
	if (circuitOpenUntil === 0) return true; // closed — normal operation
	if (Date.now() < circuitOpenUntil) return false; // open — fail fast to memory
	// Cooldown elapsed → half-open: admit a single trial, hold everyone else back.
	if (circuitTrialInFlight) return false;
	circuitTrialInFlight = true;
	return true;
}

function circuitRecordSuccess() {
	if (circuitOpenUntil !== 0) warnThrottled('circuit', '[cache] redis recovered — circuit closed');
	circuitFailures = 0;
	circuitOpenUntil = 0;
	circuitTrialInFlight = false;
	circuitRearms = 0;
}

function escalatedCooldownMs(baseMs, rearms) {
	return Math.min(COOLDOWN_MAX_MS, baseMs * 2 ** Math.min(10, rearms));
}

// Why is the store failing? A timeout and an exhausted plan allowance both surface
// as "degraded", but they call for opposite responses: the first is a latency knob
// (CACHE_REDIS_CMD_TIMEOUT_MS) or a co-located store, the second cannot be fixed by
// any code change until the plan period rolls over. /healthz used to advise the
// timeout remedy unconditionally, which sent operators hunting a network fault that
// did not exist during the 2026-07-09 over-quota incident. Remember the last cause
// so the health check can name it.
let lastFailureWasQuota = false;
function isQuotaError(err) {
	return /max requests limit exceeded/i.test(String(err?.message || err || ''));
}
function noteFailureCause(err) {
	lastFailureWasQuota = isQuotaError(err);
}

function circuitRecordFailure() {
	circuitTrialInFlight = false;
	if (circuitOpenUntil !== 0) {
		// A half-open trial failed — Redis still down, re-arm an escalated cooldown.
		circuitRearms++;
		circuitOpenUntil = Date.now() + escalatedCooldownMs(CIRCUIT_COOLDOWN_MS, circuitRearms);
		return;
	}
	circuitFailures++;
	if (circuitFailures >= CIRCUIT_FAIL_THRESHOLD) {
		circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
		totalCircuitOpens++;
		warnThrottled(
			'circuit',
			`[cache] redis degraded — circuit opened for ${CIRCUIT_COOLDOWN_MS / 1000}s after ${circuitFailures} consecutive failures; serving from memory`,
		);
	}
}

// Throttled warning for the memory-fallback paths. When Upstash is sustainedly
// degraded in a way the circuit breaker does NOT trip — the production case is a
// slow SET path interleaved with fast, healthy GETs: each request's successful
// GET resets the consecutive-failure counter before the SET timeout can push it
// to the threshold, so the breaker stays (correctly) closed to keep serving cache
// hits, yet every SET still logs — the per-request "redis SET failed" line floods
// the logs (hundreds per export window for one hot endpoint). The breaker should
// not open here (GETs are healthy and worth keeping), so the fix is at the log:
// collapse repeats of the same category to one line per WARN_THROTTLE_MS, with a
// suppressed-count digest so a sustained outage stays visible without the flood.
const WARN_THROTTLE_MS = 60_000;
const warnState = new Map(); // category -> { lastAt, suppressed }

function warnThrottled(category, message) {
	const now = Date.now();
	const st = warnState.get(category) || { lastAt: 0, suppressed: 0 };
	if (now - st.lastAt < WARN_THROTTLE_MS) {
		st.suppressed++;
		warnState.set(category, st);
		return;
	}
	const tail = st.suppressed > 0 ? ` (+${st.suppressed} more in last ${Math.round((now - st.lastAt) / 1000)}s)` : '';
	console.warn(message + tail);
	warnState.set(category, { lastAt: now, suppressed: 0 });
}

// Wire codec. Small values go as raw JSON (framing + gzip CPU aren't worth it
// under ~1KB); larger ones are gzipped and base64-wrapped behind a NUL-led
// sentinel. JSON text may begin only with {,[,",digit,-,t,f,n or the four legal
// whitespace bytes (space, tab, LF, CR) -- never NUL -- and our stored plaintext
// is JSON.stringify output with no leading whitespace, so the sentinel is
// unambiguous and legacy plaintext values keep parsing untouched. base64(gzip(
// json)) still lands far under the raw size for the compressible bodies we
// cache; the only-if-smaller guard keeps incompressible/tiny payloads on raw.
const GZIP_PREFIX = '\u0000gz:';
const COMPRESS_MIN_BYTES = 1024;

async function encodeForWire(payload) {
	if (payload.length < COMPRESS_MIN_BYTES) return payload;
	const encoded = GZIP_PREFIX + (await gzipAsync(payload)).toString('base64');
	return encoded.length < payload.length ? encoded : payload;
}

async function decodeFromWire(raw) {
	if (typeof raw === 'string' && raw.startsWith(GZIP_PREFIX)) {
		const buf = Buffer.from(raw.slice(GZIP_PREFIX.length), 'base64');
		return JSON.parse((await gunzipAsync(buf)).toString('utf8'));
	}
	return JSON.parse(raw);
}

async function redisCmd(args) {
	const target = cacheTarget();
	if (!target) throw new Error('cache redis not configured');
	if (!circuitAllows()) throw new CircuitOpenError();
	try {
		const r = await fetch(target.url, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${target.token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(args),
			signal: AbortSignal.timeout(redisCmdTimeoutMs()),
		});
		if (!r.ok) throw new Error(`upstash ${r.status}: ${await r.text().catch(() => '')}`);
		const json = await r.json();
		if (json.error) throw new Error(`upstash error: ${json.error}`);
		circuitRecordSuccess();
		return json.result;
	} catch (err) {
		noteFailureCause(err);
		circuitRecordFailure();
		throw err;
	}
}

// Redis read-through with in-flight GET coalescing, no read-memo in front.
// Shared by cacheGet (memo-checked) and cacheGetFresh (memo bypassed).
function redisGetThrough(key) {
	// Join an in-flight GET for this key rather than issuing a duplicate.
	const pending = inflightGets.get(key);
	if (pending) return pending;
	const p = (async () => {
		try {
			const raw = await redisCmd(['GET', key]);
			const value = raw == null ? null : await decodeFromWire(raw);
			memoPut(key, value);
			return value;
		} catch (err) {
			if (!err?.circuitOpen) warnThrottled('GET', `[cache] redis GET failed, using memory fallback: ${err?.message}`);
			return memGet(key);
		} finally {
			inflightGets.delete(key);
		}
	})();
	inflightGets.set(key, p);
	return p;
}

export async function cacheGet(key) {
	if (!redisConfigured()) return memGet(key);
	const memo = memoGet(key);
	if (memo !== undefined) return memo;
	return redisGetThrough(key);
}

/**
 * Like cacheGet, but bypasses the short read-memo. For callers that poll for a
 * value they expect to appear within the next second or two — e.g. a single-
 * flight loser awaiting the lock winner's write — where a freshly-memoized
 * "miss" (held for MEMO_TTL_MS) would otherwise make every poll see stale
 * absence and defeat the wait. Still coalesces concurrent GETs.
 * @param {string} key
 */
export async function cacheGetFresh(key) {
	if (!redisConfigured()) return memGet(key);
	return redisGetThrough(key);
}

export async function cacheSet(key, value, ttlSeconds = 60) {
	if (!redisConfigured()) return memSet(key, value, ttlSeconds);
	// While SETs are known-degraded, skip Redis entirely — go straight to memory.
	// Saves the per-request REDIS_CMD_TIMEOUT_MS stall and the warning flood; one
	// trial SET is admitted once the window elapses to detect recovery.
	const now = Date.now();
	if (setSuppressedUntil !== 0 && now < setSuppressedUntil) {
		readMemo.delete(key);
		return memSet(key, value, ttlSeconds);
	}
	try {
		const payload = JSON.stringify(value);
		// Compress before measuring: the size gate below must reflect the bytes
		// that actually go over the wire, not the raw JSON. A body that gzips well
		// (the money-feed, trending snapshots) now lands in Redis where the raw
		// length would have wrongly shunted it to memory-only.
		const body = await encodeForWire(payload);
		// An oversized value over Upstash REST is a guaranteed timeout from a
		// non-co-located region: it can never finish inside the command deadline,
		// so it would burn the failure streak and flap the suppression gate all
		// day without ever landing. Keep it memory-only and leave the streak to
		// reflect the store's real health. Gated on the compressed wire size.
		if (body.length > env.CACHE_REDIS_MAX_VALUE_BYTES) {
			// Memo the value too: with Redis healthy a GET is a clean miss (null),
			// not an error, so it would never consult the memory fallback — the memo
			// is what keeps near-term reads coherent with this write.
			memoPut(key, value);
			warnThrottled('set-size', `[cache] value for "${key}" exceeds ${env.CACHE_REDIS_MAX_VALUE_BYTES} bytes compressed — memory-only (raise CACHE_REDIS_MAX_VALUE_BYTES to override)`);
			return memSet(key, value, ttlSeconds);
		}
		await redisCmd(['SET', key, body, 'EX', String(ttlSeconds)]);
		if (setSuppressedUntil !== 0) warnThrottled('set-gate', '[cache] redis SET recovered — resuming cache writes');
		setFailures = 0;
		setSuppressedUntil = 0;
		setRearms = 0;
		memoPut(key, value); // keep the memo coherent with what we just wrote
	} catch (err) {
		readMemo.delete(key);
		memSet(key, value, ttlSeconds);
		if (err?.circuitOpen) return; // shared breaker already logged the open transition
		if (setSuppressedUntil !== 0) {
			// A post-window trial failed — writes still down. Re-arm quietly with an
			// escalated window so a chronically degraded store settles at one trial
			// per 10 minutes instead of flapping every 60s.
			setRearms++;
			setSuppressedUntil = now + escalatedCooldownMs(SET_SUPPRESS_MS, setRearms);
			return;
		}
		setFailures++;
		totalSetFailures++;
		if (setFailures >= SET_FAIL_THRESHOLD) {
			setSuppressedUntil = now + SET_SUPPRESS_MS;
			warnThrottled(
				'set-gate',
				`[cache] redis SET degraded — suppressing cache writes for ${SET_SUPPRESS_MS / 1000}s after ${setFailures} consecutive failures; serving from memory`,
			);
		} else {
			warnThrottled('SET', `[cache] redis SET failed, using memory fallback: ${err?.message}`);
		}
	}
}

export async function cacheDel(key) {
	readMemo.delete(key);
	if (!redisConfigured()) return memDel(key);
	try {
		await redisCmd(['DEL', key]);
	} catch {
		memDel(key);
	}
}

export function cacheBackend() {
	return redisConfigured() ? 'upstash' : 'memory';
}

/**
 * Point-in-time health of the cache adapter, for /healthz and the status page.
 * Pure read of module state — no I/O. `degraded` is true whenever Redis is
 * configured but we're currently short-circuiting to memory (breaker open or
 * SET-suppression active), which is the exact production condition the log
 * export surfaced. When no Redis is configured we report the in-memory backend
 * as healthy (that's the intended dev/test posture, not a degradation).
 * @returns {{ backend: string, configured: boolean, degraded: boolean,
 *   circuitOpen: boolean, circuitReopensInMs: number, setSuppressed: boolean,
 *   consecutiveFailures: number, consecutiveSetFailures: number,
 *   totalSetFailures: number, totalCircuitOpens: number }}
 */
export function cacheHealth() {
	const now = Date.now();
	const configured = redisConfigured();
	const circuitOpen = circuitOpenUntil !== 0 && now < circuitOpenUntil;
	const setSuppressed = setSuppressedUntil !== 0 && now < setSuppressedUntil;
	return {
		backend: cacheBackend(),
		configured,
		degraded: configured && (circuitOpen || setSuppressed),
		circuitOpen,
		circuitReopensInMs: circuitOpen ? circuitOpenUntil - now : 0,
		setSuppressed,
		consecutiveFailures: circuitFailures,
		consecutiveSetFailures: setFailures,
		totalSetFailures,
		totalCircuitOpens,
		quotaExhausted: lastFailureWasQuota,
	};
}

/**
 * Best-effort cross-instance lock built on Redis `SET key val NX EX`. Returns
 * true if THIS caller acquired the lock, false if someone else holds it. Use to
 * coordinate an expensive recompute (a full on-chain scan, a snapshot rebuild)
 * across serverless instances so a traffic spike against a cold cache fans out
 * into ONE recompute platform-wide instead of N.
 *
 * The TTL is a safety valve: if the lock holder's lambda dies mid-work, the lock
 * auto-expires so the work isn't wedged forever — size it longer than the work
 * takes. When Redis is unavailable we return true (degrade to "no cross-instance
 * coordination"); pair with an in-process single-flight for the common case.
 *
 * @param {string} key
 * @param {number} ttlSeconds
 * @returns {Promise<boolean>}
 */
export async function acquireLock(key, ttlSeconds) {
	if (!redisConfigured()) return true;
	try {
		const res = await redisCmd(['SET', key, '1', 'NX', 'EX', String(ttlSeconds)]);
		return res === 'OK';
	} catch (err) {
		if (!err?.circuitOpen) warnThrottled('acquireLock', `[cache] acquireLock failed, proceeding without lock: ${err?.message}`);
		return true;
	}
}

/**
 * Release a lock taken with acquireLock. Best-effort — a failed release just
 * leaves the lock to expire on its TTL.
 * @param {string} key
 */
export async function releaseLock(key) {
	if (!redisConfigured()) return;
	try {
		await redisCmd(['DEL', key]);
	} catch {
		/* lock will expire on its own TTL */
	}
}

/**
 * Read-through cache: return the cached value for `key`, or compute it with
 * `fn()`, store it for `ttlSeconds`, and return it. Use to shield expensive but
 * staleness-tolerant work (full-table COUNT(*) aggregates, leaderboards) from
 * every request — at 100x traffic these are the queries that fall over.
 *
 * `null`/`undefined` results are NOT cached (so a transient failure isn't pinned
 * as "no data"); a thrown `fn` propagates and caches nothing.
 *
 * @template T
 * @param {string} key
 * @param {number} ttlSeconds
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function cacheWrap(key, ttlSeconds, fn) {
	const hit = await cacheGet(key);
	if (hit !== null && hit !== undefined) return hit;
	const value = await fn();
	if (value !== null && value !== undefined) {
		// Don't block the response on the write-back. The value is already in hand;
		// the cache is an optimization, not part of the result. Awaiting here put a
		// degraded Upstash (writes timing out at REDIS_CMD_TIMEOUT_MS) directly on
		// the request's critical path — up to 3s of dead latency per miss for a SET
		// that then falls back to memory anyway. cacheSet swallows its own errors
		// (never rejects), so fire-and-forget is safe; the .catch is belt-and-braces.
		cacheSet(key, value, ttlSeconds).catch(() => {});
	}
	return value;
}
