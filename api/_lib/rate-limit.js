// Distributed rate limiting via Upstash Redis. Falls back to Postgres for the
// buckets that must stay distributed (money, auth), and to in-memory otherwise.

import { Ratelimit } from '@upstash/ratelimit';
import { env } from './env.js';
import { sql } from './db.js';
import { getRedis, isRedisAuthError } from './redis.js';

const redis = getRedis();

// Prod signal: real deployments set NODE_ENV=production (Vercel does). Tests and
// local dev never do, so the in-memory fallback stays fully permissive there.
const IS_PRODUCTION = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';
const REDIS_CONFIGURED = Boolean(redis);

// Platform-wide hourly ceiling on PLATFORM-keyed paid 3D generations (the shared
// Replicate / self-host GPU budget). This is a circuit breaker, NOT a per-user
// limit: it stops the failure mode where an influx — or distributed abuse — sends
// many callers who each stay under their own 30/h cap but collectively drain real
// spend. Tunable via env without a code change; the default is generous enough
// that only a genuine surge or attack trips it, and when it does the free NVIDIA /
// HuggingFace lanes stay open, so paid capacity degrades instead of dead-ending.
const FORGE_PAID_GLOBAL_HOURLY = Math.max(1, Number(process.env.FORGE_PAID_GLOBAL_HOURLY) || 600);

// FORGE_SELFHOST_PRIMARY: the per-principal free-lane ceiling (mcp3dGenerateFree,
// below) is sized at 60/h to protect the RATE-LIMITED hosted NVIDIA NIM allocation
// the free lane leans on today. Once our own Cloud Run GPU fleet is primary that
// hosted allocation is out of the path, so the ceiling can rise to what the deployed
// fleet sustains. Default 240/h (4× — see the math in docs/gcp-credits.md: credit-
// window fleet of trellis_selfhost[max 2] + hunyuan3d[max 3] = 5 concurrent L4 slots
// at ~60s/asset blended ≈ 300 assets/h global, so a single heavy iterator at 240/h
// stays well under the fleet ceiling). Tunable via FORGE_FREE_HOURLY_SELFHOST once
// real per-asset latency is measured post-deploy. Reverts to 60/h the moment the
// flag is unset — abuse and per-IP paid gates are unaffected by this lever.
const FORGE_SELFHOST_PRIMARY = /^(1|true|on|yes)$/i.test(
	String(process.env.FORGE_SELFHOST_PRIMARY || '').trim(),
);
const FREE_HOURLY_BASE = FORGE_SELFHOST_PRIMARY
	? Math.max(60, Number(process.env.FORGE_FREE_HOURLY_SELFHOST) || 240)
	: 60;

// One-time startup notice when Redis is unconfigured in production. Cheap buckets
// fall back to a PER-INSTANCE in-memory map — fine for a flood guard, meaningless
// as a bound across serverless fan-out — while money/cost and auth buckets degrade
// onto the durable Postgres counter (see fallbackLimiter), so this is a "running
// degraded" notice rather than an outage. Suppressed under vitest: the Vercel build
// inherits VERCEL_ENV=production while running the test gate, which made this fire
// as scary-but-meaningless build-log noise. The fallback behavior itself is NOT
// gated on VITEST — tests exercise it deliberately.
if (IS_PRODUCTION && !REDIS_CONFIGURED && !process.env.VITEST) {
	console.error(
		'[rate-limit] CONFIG: UPSTASH_REDIS_REST_URL/TOKEN are unset in production. ' +
			'Money/auth limiters are counting in Postgres (durable, distributed, fixed-window); ' +
			'cheap per-IP limiters fall back to a non-distributed in-memory map. Restore Redis ' +
			'for sliding-window precision and to take the upsert off the database.',
	);
}

const limiters = new Map();
const memoryBuckets = new Map();

// Circuit-breaker ceiling for the generic paid-endpoint family's facilitator
// /verify fan-out (api/_lib/x402-paid-endpoint.js). A backstop against a runaway
// retry loop or a distributed junk-X-PAYMENT flood — set well above realistic
// peak and raisable via env as volume grows, so scaling up is a config change,
// not a redeploy. Floored so a fat-fingered env value can't throttle the
// platform to a crawl.
const X402_VERIFY_GLOBAL_PER_HOUR = Math.max(
	1200,
	Number(process.env.X402_VERIFY_GLOBAL_PER_HOUR) || 12000,
);

// Per-IP ceilings for the same family, tunable by env for the same reason. The
// verify bucket is failure-weighted (see limits.x402VerifyIp / x402VerifyPenalty):
// a settled payment costs 1 token, a failed verify costs X402_VERIFY_FAIL_PENALTY.
// The defaults let one paying client pull 300 datapoints/min while still cutting a
// junk-payment flood off after ~20 failures/min. Floored so a bad env value cannot
// throttle paying traffic to a crawl, or (for the penalty) disable the guard.
const X402_PROBE_IP_PER_MIN = Math.max(120, Number(process.env.X402_PROBE_IP_PER_MIN) || 600);
const X402_VERIFY_IP_PER_MIN = Math.max(20, Number(process.env.X402_VERIFY_IP_PER_MIN) || 300);
const X402_VERIFY_FAIL_PENALTY = Math.max(
	1,
	Number(process.env.X402_VERIFY_FAIL_PENALTY) || 15,
);

// Global settle/verify ceiling for OUR self-hosted facilitator
// (api/x402-facilitator). Every co-signed settle burns sponsor SOL (~5000
// lamports base fee), so an unbounded flood of tiny allowlisted transfers could
// grind the sponsor down to SPONSOR_SOL_FLOOR_LAMPORTS and halt the whole paid
// loop. Bound it. Same floor rationale as the verify ceiling above.
const X402_FACILITATOR_GLOBAL_PER_HOUR = Math.max(
	600,
	Number(process.env.X402_FACILITATOR_GLOBAL_PER_HOUR) || 12000,
);
// Per-IP facilitator ceiling. The ring tick settles every paid call through
// the self-hosted facilitator from ONE egress IP (verify + settle = 2 hits per
// call), so at 94 calls/min the old hardcoded 60/min starved the ring itself
// (observed 2026-07-25: http_429 cascade, whole ticks failing). Env-tunable
// with the old value as the floor; external abusers still hit this wall.
const X402_FACILITATOR_IP_PER_MIN = Math.max(
	60,
	Number(process.env.X402_FACILITATOR_IP_PER_MIN) || 60,
);

// A limiter that always denies. Used in production for cost/money-moving buckets
// when Redis is absent: better to 503 a paid action than to silently allow
// unbounded spend across serverless instances.
function failClosedLimiter({ limit, window }) {
	const ms = parseWindowMs(window);
	return {
		async limit() {
			return {
				success: false,
				limit,
				remaining: 0,
				reset: Date.now() + ms,
				reason: 'rate_limiter_unavailable',
			};
		},
	};
}

/**
 * @param {string} name
 * @param {{ limit: number, window: string, critical?: boolean, local?: boolean }} opts
 *   `critical: true` marks a cost/money-moving bucket. When Redis is absent in
 *   production these fail closed (deny) instead of using the unbounded in-memory
 *   fallback. Non-critical buckets keep the permissive in-memory fallback so a
 *   missing-Redis misconfig degrades read endpoints gracefully rather than
 *   taking the whole site down.
 *   `degradeToMemory: true` overrides the critical fail-closed disposition on a
 *   Redis outage: instead of denying, the bucket falls back to the per-instance
 *   memory limiter. For sensitive-but-availability-critical buckets (auth/login)
 *   where a total lockout is worse than a weaker per-instance cap. Never use it
 *   for money-moving buckets — there, denying is the correct safety posture.
 *   `local: true` deliberately enforces per-instance, in-memory only — never a
 *   Redis command. For high-frequency, cheap-read buckets (status polling) whose
 *   only job is to bound poll floods, per-instance caps bound throughput just as
 *   well (limit × warm instances, and Vercel bounds instances), and the saved
 *   commands are what keep the Upstash quota alive (June 2026 outage). Never
 *   combine with `critical`.
 */
function getLimiter(name, opts) {
	const key = `${name}:${opts.limit}:${opts.window}`;
	if (limiters.has(key)) return limiters.get(key);
	if (opts.local) {
		const lim = memoryLimiter(name, opts);
		limiters.set(key, lim);
		return lim;
	}
	if (!redis) {
		// No Redis configured at all. Money/auth buckets still get a distributed
		// counter (Postgres); cheap buckets stay in per-instance memory.
		const lim = fallbackLimiter(name, opts);
		limiters.set(key, lim);
		return lim;
	}
	const rl = new Ratelimit({
		redis,
		limiter: Ratelimit.slidingWindow(opts.limit, opts.window),
		prefix: `rl:${name}`,
		analytics: false,
	});
	const resilient = resilientLimiter(rl, name, opts);
	limiters.set(key, resilient);
	return resilient;
}

/**
 * Hand a consumed hit back to its bucket, for the one case that justifies it:
 * the request was charged, then produced nothing at all because a dependency we
 * own was unavailable. The caller keeps its window instead of paying for our
 * outage. Two conditions, both load-bearing: the bucket must be a single-use
 * window (see the Redis note in resilientLimiter, which is why this refuses any
 * other ceiling), and the refund must be unconditional at that point in the
 * handler. A refund on a path that DID something turns the limiter off.
 */
export async function refundLimit(name, opts, id) {
	if (opts.limit !== 1) {
		throw new Error(`refundLimit: ${name} is not a single-use window (limit ${opts.limit})`);
	}
	return getLimiter(name, opts).refund(id);
}

// One warn per limiter name per cooldown — a Redis outage hits every request,
// so unthrottled logging would itself become a denial-of-service on the logs.
const _degradeWarnedAt = new Map();
const DEGRADE_WARN_COOLDOWN_MS = 60_000;
function warnDegradedOnce(name, err) {
	// The shared Redis auth breaker (api/_lib/redis.js) already logged the one
	// "auth failure" line and is fast-failing every command; its short-circuit
	// rejections carry `circuitOpen`. Re-warning per limiter per cooldown on top of
	// that is pure noise — skip it and let the breaker own the signal.
	if (err?.circuitOpen) return;
	// @upstash/ratelimit catches the underlying Redis rejection and re-throws its
	// own UpstashError, dropping the `circuitOpen` tag — so an auth failure reaching
	// here on the breaker's once-per-cooldown trial command would still log, once per
	// limiter name. Across dozens of limiter names that recreates the WRONGPASS flood
	// the breaker exists to silence. The breaker already owns the single auth-failure
	// line and the rotate-the-token remediation, so suppress auth errors here too.
	if (isRedisAuthError(err)) return;
	const last = _degradeWarnedAt.get(name) || 0;
	const t = Date.now();
	if (t - last < DEGRADE_WARN_COOLDOWN_MS) return;
	_degradeWarnedAt.set(name, t);
	console.warn(
		`[rate-limit] redis degraded for "${name}", limiter served from fallback decision:`,
		err?.message || err,
	);
}

// Upstash rejects every command with this once the account's plan-wide command
// allowance is spent. It is NOT a transient blip: the counter resets on the plan's
// billing boundary, so the store stays dead for the remainder of the period. It
// therefore deserves its own, unmistakable log line — the generic "redis degraded"
// warning sends an operator hunting for a network fault that isn't there.
export function isRedisQuotaError(err) {
	return /max requests limit exceeded/i.test(String(err?.message || err || ''));
}

let _quotaWarnedAt = 0;
function warnQuotaOnce() {
	const t = Date.now();
	if (t - _quotaWarnedAt < 600_000) return;
	_quotaWarnedAt = t;
	console.error(
		'[rate-limit] FATAL CAPACITY: the Upstash store has spent its plan-wide command ' +
			'allowance. Every rate-limit command is rejected until the plan period rolls over. ' +
			'Money/auth buckets are now counting in Postgres (durable); cheap buckets count ' +
			'per-instance. Remediation: raise the Upstash plan, or cut command volume.',
	);
}

// Circuit breaker in front of Redis, mirroring api/_lib/cache.js. Without it a
// degraded store makes EVERY rate-limited request pay a full failing round-trip
// before reaching its fallback — during the 2026-07-09 over-quota incident that
// was a ~300ms tax on every single API call, plus a rejected command per request.
// After CIRCUIT_FAIL_THRESHOLD consecutive failures we skip Redis entirely for a
// cooldown and serve from the fallback directly. One trial command is admitted
// once the cooldown elapses; its success closes the breaker.
//
// The cooldown escalates ×2 per consecutive re-arm up to CIRCUIT_COOLDOWN_MAX_MS,
// so a transient blip recovers inside 5s while an over-quota store — which cannot
// recover until its plan period rolls over — settles at one probe per 10 minutes
// instead of one per request.
const CIRCUIT_FAIL_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_BASE_MS = 5_000;
const CIRCUIT_COOLDOWN_MAX_MS = 600_000;
let circuitFailures = 0;
let circuitOpenUntil = 0;
let circuitTrialInFlight = false;
let circuitRearms = 0;

function circuitAllows() {
	if (circuitOpenUntil === 0) return true;
	if (Date.now() < circuitOpenUntil) return false;
	if (circuitTrialInFlight) return false;
	circuitTrialInFlight = true; // half-open: exactly one trial
	return true;
}

function circuitRecordSuccess() {
	if (circuitOpenUntil !== 0) console.warn('[rate-limit] redis recovered — circuit closed');
	circuitFailures = 0;
	circuitOpenUntil = 0;
	circuitTrialInFlight = false;
	circuitRearms = 0;
}

function circuitRecordFailure() {
	circuitTrialInFlight = false;
	circuitFailures += 1;
	if (circuitFailures < CIRCUIT_FAIL_THRESHOLD && circuitOpenUntil === 0) return;
	const cooldown = Math.min(CIRCUIT_COOLDOWN_MAX_MS, CIRCUIT_COOLDOWN_BASE_MS * 2 ** circuitRearms);
	circuitRearms += 1;
	circuitOpenUntil = Date.now() + cooldown;
}

// Thrown to route a caller straight to its fallback while the breaker is open,
// without emitting a per-request warning (the open/close transitions log once).
class RlCircuitOpenError extends Error {
	constructor() {
		super('rate-limit redis circuit open');
		this.circuitOpen = true;
	}
}

// Observability for /healthz — is the limiter's Redis path live right now, and
// how badly has it degraded over this instance's lifetime?
export function rateLimiterHealth() {
	return {
		configured: REDIS_CONFIGURED,
		circuitOpen: circuitOpenUntil !== 0 && Date.now() < circuitOpenUntil,
		circuitReopensInMs: Math.max(0, circuitOpenUntil - Date.now()),
		quotaExhausted: _quotaWarnedAt > 0,
		durableFallback: pgAvailable(),
		// Outside production a bucket with no backend degrades to the permissive
		// memory limiter rather than denying, so "no Redis, no Postgres" is the
		// normal, healthy dev/test posture — not an outage.
		enforcing: IS_PRODUCTION,
	};
}

// Wrap a real (Redis-backed) Ratelimit so a Redis error — most importantly the
// account-wide "max requests limit exceeded" over-quota UpstashError — degrades
// instead of throwing an unhandled 500 out of every route. Non-critical buckets
// (the read/public/auth-IP limiters every page hits) FAIL OPEN: a limiter
// outage must never take down the API. Critical buckets (cost/money-moving)
// FAIL CLOSED: better to 503 a paid action than allow unbounded spend when the
// distributed limiter is blind.
function resilientLimiter(rl, name, opts) {
	const ms = parseWindowMs(opts.window);
	// Money and auth buckets must stay bounded across instances even when Redis
	// cannot answer, so they degrade onto the durable Postgres counter rather
	// than failing closed (which takes the paid product down for the length of
	// the outage) or trusting per-instance memory (which bounds nothing). See
	// fallbackLimiter. Everything else FAILS OPEN: a limiter outage must never
	// take down a read endpoint.
	const durable = opts.critical || opts.degradeToMemory ? fallbackLimiter(name, opts) : null;
	return {
		async limit(id) {
			try {
				if (!circuitAllows()) throw new RlCircuitOpenError();
				const r = await rl.limit(id);
				circuitRecordSuccess();
				return r;
			} catch (err) {
				if (!err?.circuitOpen) {
					circuitRecordFailure();
					if (isRedisQuotaError(err)) warnQuotaOnce();
					else warnDegradedOnce(name, err);
				}
				if (durable) return durable.limit(id);
				return {
					success: true,
					limit: opts.limit,
					remaining: opts.limit,
					reset: Date.now() + ms,
					reason: 'rate_limiter_degraded',
				};
			}
		},
		// Upstash has no "give one token back": resetUsedTokens clears the whole
		// identifier. That equals a refund only on a single-use window, which is
		// why refundLimit refuses any other ceiling. A refund
		// that cannot reach Redis is dropped rather than retried: the cost of
		// losing it is one caller waiting out a window they should not have
		// spent, and failing the request they are already being apologised to
		// for would be worse.
		async refund(id) {
			try {
				if (!circuitAllows()) throw new RlCircuitOpenError();
				await rl.resetUsedTokens(id);
				circuitRecordSuccess();
				return true;
			} catch (err) {
				if (!err?.circuitOpen) {
					circuitRecordFailure();
					if (isRedisQuotaError(err)) warnQuotaOnce();
					else warnDegradedOnce(name, err);
				}
				if (durable) return durable.refund(id);
				return false;
			}
		},
	};
}

// Eviction for the in-memory fallback. The map otherwise grows one entry per
// distinct key forever (a scanner rotating IPs would balloon a long-lived dev
// process). Only sweeps when the map is over the cap, so the amortized cost on
// the hot path is O(1); the sweep itself drops every bucket whose newest
// timestamp predates the largest window any memory limiter uses (conservative
// — never evicts an entry a live limiter could still count).
const MEMORY_BUCKETS_MAX = 10_000;
let maxMemoryWindowMs = 60_000;
function sweepMemoryBuckets(now) {
	if (memoryBuckets.size <= MEMORY_BUCKETS_MAX) return;
	const cutoff = now - maxMemoryWindowMs;
	for (const [id, timestamps] of memoryBuckets) {
		if (!timestamps.length || timestamps[timestamps.length - 1] <= cutoff) {
			memoryBuckets.delete(id);
		}
	}
}

// `name` namespaces the shared memoryBuckets map. Without it every fallback
// limiter counts against ONE array per IP, so distinct buckets contaminate
// each other the moment more than one degrades to memory (e.g. a Redis outage
// putting auth:ip and authed:read:ip in the same counter — page reads would
// then exhaust the login budget).
function memoryLimiter(name, { limit, window }) {
	const ms = parseWindowMs(window);
	if (ms > maxMemoryWindowMs) maxMemoryWindowMs = ms;
	return {
		async limit(id) {
			const key = `${name}\u0000${id}`;
			const now = Date.now();
			sweepMemoryBuckets(now);
			const bucket = memoryBuckets.get(key) || [];
			const cutoff = now - ms;
			const kept = bucket.filter((t) => t > cutoff);
			if (kept.length >= limit) {
				memoryBuckets.set(key, kept);
				return { success: false, limit, remaining: 0, reset: kept[0] + ms };
			}
			kept.push(now);
			memoryBuckets.set(key, kept);
			return { success: true, limit, remaining: limit - kept.length, reset: now + ms };
		},
		// Hand back the newest hit in this bucket. See `refund` on the exported
		// limiters for when a caller is allowed to do that.
		async refund(id) {
			const key = `${name}\u0000${id}`;
			const kept = memoryBuckets.get(key);
			if (!kept?.length) return false;
			kept.pop();
			if (kept.length) memoryBuckets.set(key, kept);
			else memoryBuckets.delete(key);
			return true;
		},
	};
}

function parseWindowMs(w) {
	const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(w);
	if (!m) return 60_000;
	const n = parseInt(m[1], 10);
	const unit = m[2];
	return n * { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[unit];
}

// ── Postgres fallback limiter ─────────────────────────────────────────────
//
// The disposition of a `critical` bucket when Redis is blind used to be "deny"
// (failClosedLimiter). That is the right instinct for spend — an unmetered paid
// endpoint is worse than an unavailable one — but it is the wrong OUTCOME when
// the outage lasts: on 2026-07-09 the shared Upstash store hit its plan-wide
// command ceiling, which does not reset until the next calendar month, so every
// checkout, withdrawal, mint and trade would have 503'd for three weeks.
//
// Postgres is already a hard dependency of exactly those endpoints (their
// ledgers live in it), so a counter here is distributed, survives instance
// fan-out, and cannot succeed-when-the-action-couldn't-anyway. Fixed window,
// one atomic upsert — see the migration for the boundary-burst tradeoff.
//
// Cheap, non-critical buckets never come here: they degrade to the per-instance
// memory limiter, whose cost is zero. Only money and auth pay for an upsert.
const PG_PRUNE_INTERVAL_MS = 600_000;
let pgPrunedAt = 0;

// The widest window any bucket in `limits` declares (the daily caps: '1 d' /
// '24 h'). The prune floor below must be derived from this and NOT from
// `maxMemoryWindowMs`: that counter only rises when a limiter is CONSTRUCTED in
// the current process, so an instance whose first pg-backed bucket was, say,
// '5 m' prunes with a 10-minute floor and deletes every OTHER instance's live
// daily row. The table is shared, so one such instance silently resets the
// 5/day and 3/day spend caps for everybody (observed live: six calls against a
// 5/day bucket all succeeded, because a sibling process had wiped the row
// mid-window). Raise this if a wider window is ever added.
const PG_WIDEST_WINDOW_MS = 86_400_000;

// Drop windows that no live limiter can still be counting: 2x the widest window
// any bucket uses, so a row is only deleted once its window is long dead on
// every instance. Fire-and-forget: a failed prune is a no-op that retries on the
// next interval, never an error on the caller's request path.
function prunePgCounters(now) {
	if (now - pgPrunedAt < PG_PRUNE_INTERVAL_MS) return;
	pgPrunedAt = now;
	const cutoff = now - 2 * Math.max(PG_WIDEST_WINDOW_MS, maxMemoryWindowMs);
	sql`DELETE FROM rate_limit_counters WHERE window_start < ${cutoff}`.catch(() => {});
}

function pgLimiter(name, { limit, window }) {
	const ms = parseWindowMs(window);
	if (ms > maxMemoryWindowMs) maxMemoryWindowMs = ms;
	return {
		async limit(id) {
			const now = Date.now();
			const windowStart = Math.floor(now / ms) * ms;
			const reset = windowStart + ms;
			prunePgCounters(now);
			// One statement: increment and read the post-increment count. No
			// read-modify-write window for concurrent instances to race through.
			const [row] = await sql`
				INSERT INTO rate_limit_counters (bucket, window_start, hits)
				VALUES (${`${name}\0${id}`}, ${windowStart}, 1)
				ON CONFLICT (bucket, window_start)
				DO UPDATE SET hits = rate_limit_counters.hits + 1
				RETURNING hits
			`;
			const hits = row?.hits ?? 1;
			return {
				success: hits <= limit,
				limit,
				remaining: Math.max(0, limit - hits),
				reset,
				reason: 'rate_limiter_degraded_postgres',
			};
		},
		async refund(id) {
			const windowStart = Math.floor(Date.now() / ms) * ms;
			const [row] = await sql`
				UPDATE rate_limit_counters SET hits = greatest(0, hits - 1)
				WHERE bucket = ${`${name}\0${id}`} AND window_start = ${windowStart}
				RETURNING hits
			`;
			return Boolean(row);
		},
	};
}

// Is a durable fallback available? A limiter can only reach for Postgres if the
// connection string exists; `env.DATABASE_URL` throws when unset (it is a
// required var), so probe it without letting that escape.
function pgAvailable() {
	try {
		return Boolean(env.DATABASE_URL);
	} catch {
		return false;
	}
}

// The fallback a bucket uses when Redis cannot answer, in priority order:
//   critical / degradeToMemory → Postgres (distributed, durable)
//   …with Postgres unreachable → the bucket's original disposition
//   everything else            → per-instance memory (cost-free, good enough)
// Wrapping pgLimiter in a try/catch keeps a DB blip from turning a Redis outage
// into a hard 500: it collapses to the pre-existing behaviour instead.
function fallbackLimiter(name, opts) {
	const durable = (opts.critical || opts.degradeToMemory) && pgAvailable();
	if (!durable) {
		return opts.degradeToMemory || !(opts.critical && IS_PRODUCTION)
			? memoryLimiter(name, opts)
			: failClosedLimiter(opts);
	}
	const pg = pgLimiter(name, opts);
	const lastResort = opts.degradeToMemory
		? memoryLimiter(name, opts)
		: IS_PRODUCTION
			? failClosedLimiter(opts)
			: memoryLimiter(name, opts);
	return {
		async limit(id) {
			try {
				return await pg.limit(id);
			} catch (err) {
				warnDegradedOnce(`${name}:pg`, err);
				return lastResort.limit(id);
			}
		},
		async refund(id) {
			try {
				return await pg.refund(id);
			} catch (err) {
				warnDegradedOnce(`${name}:pg`, err);
				return lastResort.refund(id);
			}
		},
	};
}

// Preset limiters. Tune once viral traffic shape is known.
export const limits = {
	// One-click "Surprise me" avatar composition. Each call composes a rigged GLB
	// (~1s CPU + a few base-body fetches), so the ceiling stops a script from
	// hammering the composer while leaving a delighted human free to reroll fast:
	// 40 per 5 min per IP comfortably covers rapid rerolling, well under abuse.
	surpriseIp: (ip) =>
		getLimiter('avatar:surprise:ip', { limit: 40, window: '5 m', local: true }).limit(ip),
	// Gallery view tracking (/api/avatars/view). Deliberately a dedupe rather than
	// a throttle: one counted view per (IP, avatar) per 30 minutes, so a reader
	// who reopens a card ten times moves view_count by one. Keyed on
	// `${ip}:${avatarId}` so a browsing session can still count a view on every
	// distinct avatar it opens. NOT local: with several Cloud Run instances a
	// per-instance counter would let the same viewer count once per instance,
	// which is exactly the inflation this bucket exists to stop.
	avatarViewIp: (ipAndAvatar) =>
		getLimiter('avatar:view:ip', { limit: 1, window: '30 m' }).limit(ipAndAvatar),
	// Webcam sign-language transcription (/api/asl-recognition). Each call runs
	// a sub-second CPU inference on the worker; 30 per 5 min per IP covers an
	// active signed conversation while stopping scripted hammering.
	aslTranscribeIp: (ip) =>
		getLimiter('asl:transcribe:ip', { limit: 30, window: '5 m', local: true }).limit(ip),
	// Text → signed animation clip (/api/sign). The compile is pure CPU (tens of
	// milliseconds) and the response is deterministic, so the edge cache absorbs
	// repeats; 120 per 5 min per IP leaves a live console and a batching agent
	// plenty of headroom while capping how much CPU one caller can burn.
	signCompileIp: (ip) =>
		getLimiter('sign:compile:ip', { limit: 120, window: '5 m', local: true }).limit(ip),
	// GuardChain preflight (/api/agent/guard). Pure in-process policy evaluation,
	// sub-millisecond, no I/O; the cap only stops a script from using the box as
	// a free CPU treadmill. An agent preflighting every tool call in an active
	// chat session stays far under 300 evaluations per 5 minutes.
	agentGuardIp: (ip) =>
		getLimiter('agent:guard:ip', { limit: 300, window: '5 m', local: true }).limit(ip),
	// The server-side agent loop (/api/agent/run). One request can fan into
	// several LLM rounds plus tool executions against shared free-lane quotas,
	// so it gets a tighter ceiling than the plain chat proxy: 30 runs per 5
	// minutes per IP is an active conversation, not a drain.
	agentRunIp: (ip) =>
		getLimiter('agent:run:ip', { limit: 30, window: '5 m', local: true }).limit(ip),
	// Public headless-chromium renderers (/api/render/glb, /api/render/avatar-clip).
	// One call boots or borrows a chromium page, pulls up to 10 MB of GLB, and
	// holds a CPU for seconds, so this is a real cost ceiling and NOT local: a
	// per-instance counter multiplies by however many Cloud Run instances are up,
	// which is exactly the bypass that made a 60/10m cap meaningless under
	// autoscale. Both renderers share one bucket because they share the browser.
	renderIp: (ip) =>
		getLimiter('render:ip', { limit: 60, window: '10 m' }).limit(ip),
	// The terminal renderer (/api/tty). Deliberately its OWN bucket rather than
	// sharing render:ip: it uses no chromium at all (a CPU software rasterizer),
	// but it holds one connection open for up to 45 seconds while it streams
	// frames. Sharing meant a burst of browser renders could starve `curl
	// three.ws/tty`, and a burst of terminal streams could starve the OG cards.
	// Different cost shape, different ceiling. Not local, for the same
	// autoscale-bypass reason as render:ip.
	ttyIp: (ip) =>
		getLimiter('tty:ip', { limit: 40, window: '10 m' }).limit(ip),
	// Auth buckets gate credential guessing / account-creation spam. They are
	// sensitive (critical) but use degradeToMemory: on a Redis outage they fall
	// back to the per-instance memory limiter rather than failing closed. Failing
	// closed here locks every user out of login — a self-inflicted outage strictly
	// worse than the brute-force window a degraded per-instance cap leaves open,
	// especially with bcrypt already throttling the credential path per request.
	// 50/10m per IP: generous enough for shared NAT / office egress and an active
	// user retrying a forgotten password without tripping, yet far below what a
	// credential-stuffing run needs — bcrypt's per-request cost already throttles
	// the guess rate, and `registerIp` (5/h) caps account creation independently.
	authIp: (ip) =>
		getLimiter('auth:ip', { limit: 50, window: '10 m', critical: true, degradeToMemory: true }).limit(ip),
	registerIp: (ip) =>
		getLimiter('register:ip', { limit: 5, window: '1 h', critical: true, degradeToMemory: true }).limit(ip),
	// Open inference network (api/nodes/*). Node registration is an idempotent
	// upsert an operator runs once per boot, so it gets a tight per-IP ceiling.
	// The poll loop and result submission are the node's steady-state traffic:
	// one long-poll plus one result per job, so the ceiling has to clear a busy
	// operator running several capabilities without letting an unregistered IP
	// hammer the claim queue. Both are `local` on purpose: every request already
	// carries an ed25519 signature the handler verifies, so this bucket is spam
	// shaping, not the security boundary, and it should not spend the shared
	// Redis allowance.
	nodeRegisterIp: (ip) =>
		getLimiter('node:register:ip', { limit: 30, window: '10 m', local: true }).limit(ip),
	nodeJobIp: (ip) => getLimiter('node:job:ip', { limit: 600, window: '5 m', local: true }).limit(ip),
	// Session-scoped READS that fire on ordinary page loads (/api/me, home feed,
	// credits balance, profile pages, wallet balance lookups). These borrowed the
	// strict credential `authIp` bucket for years, which meant a few minutes of
	// normal browsing drained the same 50/10m budget that gates real writes —
	// users then got 429'd on the one request that mattered (e.g. creating an
	// agent). Reads are cheap DB lookups behind auth, so the ceiling is generous:
	// it only needs to stop scripted scraping, not human navigation.
	// `local` on purpose. This bucket fires on essentially every authenticated page
	// load, so it is the single hottest limiter on the platform — and its only job is
	// to bound scripted scraping of endpoints the caller is already entitled to read.
	// A per-instance cap does that (limit × warm instances, and Cloud Run bounds
	// instances) while costing zero Redis commands. Keeping it distributed is what
	// spent the shared Upstash allowance that the money buckets actually need.
	authedReadIp: (ip) => getLimiter('authed:read:ip', { limit: 300, window: '5 m', local: true }).limit(ip),
	// Agent creation (POST /api/agents) mints real EVM + Solana wallets, so it
	// keeps a strict ceiling — but a DEDICATED one. Sharing `authIp` meant page
	// browsing could exhaust the budget before the user ever pressed "create",
	// failing the flow after the avatar upload had already succeeded. 20/10m is
	// far more than any human setting up agents needs while still capping
	// scripted wallet-mint spam per IP.
	agentCreateIp: (ip) =>
		getLimiter('agent:create:ip', { limit: 20, window: '10 m', critical: true, degradeToMemory: true }).limit(ip),
	// CZ agent claim (/api/cz/claim). The GET mints a nonce row, the POST
	// redeems it against one ECDSA signature; a real claim is two calls, so 10
	// per hour leaves room for a wallet rejection and a retry while capping how
	// many rows one IP can write into cz_claims. `local` because the handler
	// writes nothing of value on the GET (a random nonce that is useless without
	// the matching signature) and the money buckets need the shared Redis
	// allowance more; per-instance is also exactly what this endpoint's previous
	// hand-rolled in-memory bucket gave, so it is not a regression.
	czClaimIp: (ip) => getLimiter('cz:claim:ip', { limit: 10, window: '1 h', local: true }).limit(ip),
	// CAPTCHA-verified login bucket. When a user solves the Altcha proof-of-work
	// puzzle (api/auth/captcha.js) they receive a signed bypass token that routes
	// their login through this separate bucket instead of authIp. It is intentionally
	// generous — a real human who solved a puzzle can retry freely — while still
	// bounding bot runs that automate puzzle solving. degradeToMemory so a Redis
	// outage never locks out a user who already solved the CAPTCHA.
	authIpCaptcha: (ip) =>
		getLimiter('auth:ip:captcha', { limit: 20, window: '10 m', critical: true, degradeToMemory: true }).limit(ip),
	// NL→strategy compile (api/sniper/compile.js) runs a real LLM call per request,
	// so it gets a dedicated, tighter-than-trading bucket: enough to iterate on a
	// strategy a few times, bounded so it can't be turned into a free LLM relay.
	sniperCompileIp: (ip) => getLimiter('sniper:compile:ip', { limit: 20, window: '10 m' }).limit(ip),
	// Tweet drafting (api/x/draft.js) fans one request out to up to three LLM
	// completions on platform-paid keys, so it gets its own bucket rather than
	// draining `authIp`, which gates the actual publish. 20 per 10 min is many
	// more rerolls than composing a tweet needs and still caps the fan-out.
	xDraftIp: (ip) => getLimiter('x:draft:ip', { limit: 20, window: '10 m' }).limit(ip),
	// Strategy backtest (api/sniper/backtest.js) is a read-only replay over captured
	// history; cached by strategy hash, so this only gates cache-miss origin work.
	sniperBacktestIp: (ip) => getLimiter('sniper:backtest:ip', { limit: 40, window: '5 m' }).limit(ip),
	// pump.fun coin metadata upload (name/symbol/image → R2 JSON). Cheap and
	// idempotent, so it gets its own bucket instead of draining the strict
	// `authIp` budget shared by on-chain buy/sell/launch actions. Iterating in
	// the launch wizard would otherwise lock the user out of trading for 10 min.
	pumpMetaIp: (ip) => getLimiter('pump:meta:ip', { limit: 60, window: '10 m' }).limit(ip),
	// IRL write buckets — /irl places real 3D agents at GPS spots and logs visitor
	// interactions, all from public (often anonymous) callers, so the write paths
	// need their own ceilings or a script could carpet a map with pins, inflate
	// view counts, or flood an owner's interaction inbox.
	//   · irlPinIp     — create/edit/delete a placement (heavier; placing dozens is abuse)
	//   · irlInteractIp — log a tap/view/message (lighter; legit viewing fans out)
	irlPinIp: (ip) => getLimiter('irl:pin:ip', { limit: 20, window: '10 m' }).limit(ip),
	irlInteractIp: (ip) => getLimiter('irl:interact:ip', { limit: 60, window: '1 m' }).limit(ip),
	// IRL shareable pin cards (api/irl/share.js) — uploads a real image to R2 per
	// call, so this sits between irlPinIp and irlInteractIp: generous enough for a
	// few reshares of the same moment, tight enough that scripting the upload path
	// can't be used as free image-hosting.
	irlShareIp: (ip) => getLimiter('irl:share:ip', { limit: 10, window: '10 m' }).limit(ip),
	// /club viewer-presence heartbeat (api/club/presence.js). Every open tab posts
	// once per 15s, so a handful of tabs behind one address sits near 20/min; 120
	// leaves a shared NAT egress plenty of room while capping how fast a script can
	// churn distinct session ids at the counter. `local` on purpose: the counter it
	// guards is per-instance in-memory state, so a per-instance bucket is exactly
	// the right scope and costs zero Redis commands on a page that polls forever.
	clubPresenceIp: (ip) => getLimiter('club:presence:ip', { limit: 120, window: '1 m', local: true }).limit(ip),
	// Living Stages tip recording (api/stage/tip.js). Each call carries a real
	// on-chain settlement signature and is deduped per signature, so the limiter
	// only blunts a forger spamming distinct fake signatures at the recorder — a
	// generous ceiling for a lively crowd that still caps that abuse surface.
	stageTipIp: (ip) => getLimiter('stage:tip:ip', { limit: 60, window: '1 m' }).limit(ip),
	// IRL proof-of-presence mint (H3) — a walking viewer re-mints a fix token only
	// when their coarse cell changes (every ~150 m of travel), so a generous 30/min
	// covers a brisk walk + a few re-tries while a token-banking sweep (mint many
	// distinct cells to scrape) trips fast. Keyed per IP.
	irlFixIp: (ip) => getLimiter('irl:fix:ip', { limit: 30, window: '1 m' }).limit(ip),
	// IRL World Lines (proof-of-presence AR quests). Three write buckets, per IP:
	//   · create    — placing a quest is heavier + accountable (auth-gated), the tightest.
	//   · challenge — issuing a single-use completion nonce; a co-located visitor may
	//                 re-issue a few times (expiry, retries) while walking the spot.
	//   · complete  — settling the agent-signed proof. A real visitor completes once, so
	//                 this only absorbs retries; a low ceiling blunts grinding the mint path.
	worldLineCreateIp: (ip) => getLimiter('wl:create:ip', { limit: 15, window: '10 m' }).limit(ip),
	worldLineChallengeIp: (ip) => getLimiter('wl:challenge:ip', { limit: 30, window: '5 m' }).limit(ip),
	worldLineCompleteIp: (ip) => getLimiter('wl:complete:ip', { limit: 20, window: '5 m' }).limit(ip),
	// IRL placement token bucket (D4) — keyed per (device_token + IP), tighter than
	// the coarse per-IP `irlPinIp` so one device can't script a rapid placement flood
	// even from a rotating IP. Two windows: a 5/min burst guard and a 30/hour ceiling.
	// Non-critical → a Redis outage fails open (degraded + logged once/min) so an
	// infra hiccup never blocks a legitimate placement.
	irlPinBurst: (key) => getLimiter('irl:pin:burst', { limit: 5, window: '1 m' }).limit(key),
	irlPinHourly: (key) => getLimiter('irl:pin:hourly', { limit: 30, window: '1 h' }).limit(key),
	// IRL report submissions (D4) — one report write per (device + IP) burst. The
	// distinct-reporter dedup in api/irl/report.js is the real anti-abuse gate; this
	// just bounds raw POST volume from one source.
	irlReportIp: (ip) => getLimiter('irl:report:ip', { limit: 10, window: '5 m' }).limit(ip),
	// Same-origin image proxy (api/img). A token-cloud view loads dozens of
	// thumbnails at once, so the ceiling is generous — but bounded so the proxy
	// can't be turned into an open bandwidth relay. Responses are CDN-cached.
	// local: those dozens-per-pageview each spent a distributed Redis command purely
	// to bound a bandwidth flood on a side-effect-free, CDN-cached read. A
	// per-instance cap bounds one IP's throughput just as well (limit × warm
	// instances) — the reasoning already applied to publicIp / widgetRead /
	// authedReadIp. After those moved this was the largest remaining source of
	// avoidable quota burn, and the Upstash plan allowance ran out on 2026-07-10.
	imgProxyIp: (ip) => getLimiter('img:ip', { limit: 300, window: '5 m', local: true }).limit(ip),
	// Live holder-cohort reads (api/coin/:mint/cohorts for un-snapshotted agent
	// tokens) fan out to a paid Helius getTokenAccounts walk. Responses are CDN-
	// cached, so this only gates cache-miss origin hits — generous for an
	// interactive panel, tight enough that one IP can't run up the Helius bill.
	cohortsIp: (ip) => getLimiter('cohorts:ip', { limit: 45, window: '5 m' }).limit(ip),
	oauthRegisterIp: (ip) =>
		getLimiter('oauth:register:ip', { limit: 10, window: '1 h' }).limit(ip),
	// zauth RepoScan pass-through (api/zauth-reposcan). Each POST forwards to
	// zauth's paid x402 endpoint and each GET polls a scan session; cap per IP
	// so one caller can't use the proxy as a relay to hammer their upstream.
	zauthScanIp: (ip) => getLimiter('zauthscan:ip', { limit: 30, window: '1 m' }).limit(ip),
	// aixbt intelligence bridge (api/aixbt/*). Each call may fall through to the
	// upstream aixbt REST API, which is rate-limited per key — cap per IP so one
	// caller can't drain the shared key's budget. Reads are cached, so this is
	// generous enough for an interactive feed. The global ceiling prevents many
	// distributed IPs from collectively exhausting the shared upstream key.
	aixbtIp: (ip) => getLimiter('aixbt:ip', { limit: 90, window: '1 m' }).limit(ip),
	aixbtGlobal: () => getLimiter('aixbt:global', { limit: 1800, window: '1 h' }).limit('global'),
	// Solana Developer Platform proxy (api/sdp/*). Each call fronts the SDP API
	// under our server-side key, and writes (wallet create / issuance / payment)
	// move real value, so cap per IP to keep that egress bounded and prevent the
	// shared key's quota from being drained by one caller. Generous enough for an
	// interactive dashboard; reads are not cached so this gates every origin hit.
	sdpIp: (ip) => getLimiter('sdp:ip', { limit: 60, window: '1 m' }).limit(ip),
	// Avatar custodial-wallet payouts (api/agent/send-sol). The per-send USD cap
	// and per-IP limit bound a single call, but neither bounds total daily outflow
	// if the demo token leaks or many IPs are used. This wallet-wide daily ceiling
	// (keyed on the wallet pubkey, not the caller) caps aggregate payouts to
	// N × per-send-cap per day. Critical → fails closed in prod without Redis so a
	// missing limiter can never silently uncap a money-moving endpoint.
	avatarPayoutDaily: (walletAddr) =>
		getLimiter('avatar:payout:daily', { limit: 50, window: '24 h', critical: true }).limit(
			walletAddr,
		),
	// Proof-of-grind gallery. Publishing verifies a signed receipt server-side then
	// writes a public rarity entry — bound per IP so one caller can't carpet the
	// gallery, but generous enough for a real owner publishing a few grinds.
	// Reads (gallery list / leaderboard / appraisal) are cheap and CDN-cacheable.
	// Referral-code availability check (GET /api/users/referral-code?code=…).
	// Debounced at 280 ms client-side; a 20-char code produces ~20 checks. Use a
	// dedicated bucket (not authIp) so typing a vanity code doesn't consume the
	// login/auth budget and lock out shared-IP users (offices, shared NAT).
	referralCodeCheckIp: (ip) =>
		getLimiter('referral:code:check:ip', { limit: 120, window: '5 m' }).limit(ip),
	// Referral-link visit beacons (public, unauthenticated). Generous — a real
	// visitor fires once per link per page-load — but bounded so the funnel
	// table can't be flooded from one IP.
	referralVisitIp: (ip) =>
		getLimiter('referral:visit:ip', { limit: 60, window: '5 m' }).limit(ip),
	vanityGalleryPublishIp: (ip) =>
		getLimiter('vanity:gallery:publish:ip', { limit: 12, window: '10 m' }).limit(ip),
	vanityGalleryReadIp: (ip) =>
		getLimiter('vanity:gallery:read:ip', { limit: 240, window: '5 m' }).limit(ip),
	// Both `local`: generous per-caller flood guards on the MCP transport, not spend
	// controls (the paid MCP tools carry their own `critical` buckets — mcpAgentPay,
	// mcp3dGenerate, mcpPumpGated — which stay distributed). At 1200/min and 600/min
	// these were among the biggest Redis-command consumers on the platform while
	// bounding nothing that costs money.
	mcpUser: (userId) => getLimiter('mcp:user', { limit: 1200, window: '1 m', local: true }).limit(userId),
	mcpIp: (ip) => getLimiter('mcp:ip', { limit: 600, window: '1 m', local: true }).limit(ip),
	// Generic per-IP bucket for authenticated app endpoints (agent screen feed,
	// task queue, etc.). Callers pass an override to size the bucket to their
	// traffic shape — a screenshot push stream needs hundreds/min, a roster poll
	// only a handful. getLimiter keys its cache by name+limit+window, so each
	// distinct override gets its own isolated bucket under the rl:api:ip prefix.
	apiIp: (ip, opts = {}) =>
		getLimiter('api:ip', { limit: 120, window: '1 m', ...opts }).limit(ip),
	// Free, unauthenticated 3D Studio (api/mcp-studio.js) abuse protection. Every
	// studio tool routes through a FREE lane (NVIDIA NIM text→3D, HF Spaces
	// image→3D) — zero marginal vendor cost — because the studio never names the
	// paid Replicate backend and this deployment has free engines configured, so
	// forge's free-first router never falls back to paid (see BACKENDS.trellis:
	// "Free deployments never route here automatically"). These per-IP caps (a
	// short burst cap that stops hammering + an hourly cap per source) still
	// enforce whenever Redis is healthy — they are real quota, not a comment.
	//
	// NON-critical on purpose (fail OPEN on a Redis outage), mirroring the paid
	// server's own free lane (mcp3dGenerateFree): "a Redis outage must never deny
	// a zero-cost generation." Failing these closed took the whole free studio
	// down during the June-2026 Upstash over-quota outage — a self-inflicted
	// denial of a free feature for no spend saved. Spend is still protected in
	// depth: /api/forge underneath fail-CLOSES its own paid-lane global breaker
	// (mcp3dGenerateGlobal), so even a misrouted paid call can't drain budget.
	studioGenBurst: (ip) =>
		getLimiter('studio:gen:burst', { limit: 4, window: '1 m' }).limit(ip),
	studioGenHourly: (ip) =>
		getLimiter('studio:gen:hourly', { limit: 30, window: '1 h' }).limit(ip),
	// Cheap per-IP cap on studio transport/discovery (initialize, tools/list,
	// ping, resources). Bounds discovery floods without touching the generation
	// budget. Non-critical: a missing-Redis misconfig degrades gracefully.
	studioIp: (ip) => getLimiter('studio:ip', { limit: 300, window: '1 m' }).limit(ip),
	// Free-studio persona writes (create_agent_persona / persona_say): each fetches
	// or restores a bounded GLB and writes a small identity record — cheap, but not
	// free, so a per-IP burst cap stops a scripted flood from filling storage. The
	// read path (get_agent_persona) rides the studioIp transport cap above.
	// Non-critical: like the generation lanes, a Redis outage must never deny a
	// zero-cost embodiment feature (spend is protected in depth downstream).
	studioPersonaWrite: (ip) =>
		getLimiter('studio:persona:write', { limit: 20, window: '1 m' }).limit(ip),
	// Per-principal ceiling on the expensive/gated pump-fun MCP tools (vanity grind,
	// whale/claim watches, metadata upload that burns shared IPFS pinning credits).
	// A bearer authorizes these for free, so without a per-principal cap one account
	// could drive unlimited expensive calls. Critical — fail closed in prod.
	mcpPumpGated: (principal) =>
		getLimiter('mcp:pump:gated', { limit: 30, window: '1 m', critical: true }).limit(principal),
	// Paid MCP tools — each call runs real compute (glTF validation / inspection
	// / optimization on a fetched model). Marked critical so they fail closed in
	// prod without Redis rather than allowing unbounded paid work per instance.
	mcpValidate: (key) =>
		getLimiter('mcp:validate', { limit: 10, window: '1 m', critical: true }).limit(key),
	mcpInspect: (key) =>
		getLimiter('mcp:inspect', { limit: 30, window: '1 m', critical: true }).limit(key),
	mcpOptimize: (key) =>
		getLimiter('mcp:optimize', { limit: 10, window: '1 m', critical: true }).limit(key),
	// 3D Studio MCP. Generation submits a real GPU job on Replicate (text→image
	// and/or image→3D reconstruction) that costs real money, so it gets a hard
	// hourly ceiling per principal. Status polling is cheap and frequent.
	mcp3dGenerate: (key) =>
		getLimiter('mcp3d:generate', { limit: 30, window: '1 h', critical: true }).limit(key),
	// Global circuit breaker on platform-keyed paid generation — the shared
	// Replicate/self-host budget. Keyed by 'global' (mirrors chatHostKeyGlobal /
	// x402PayGlobal): stops many accounts, each under their own mcp3dGenerate cap,
	// from collectively draining spend during an influx. Critical → fails closed in
	// prod without Redis, like the per-user paid bucket it backstops.
	mcp3dGenerateGlobal: () =>
		getLimiter('mcp3d:generate:global', {
			limit: FORGE_PAID_GLOBAL_HOURLY,
			window: '1 h',
			critical: true,
		}).limit('global'),
	// Free generation lane (NVIDIA NIM TRELLIS draft). No Replicate/vendor spend,
	// so it gets a much higher per-principal ceiling than the paid bucket and is
	// NON-critical: a Redis outage must never deny a zero-cost generation (fail
	// open), unlike the paid lane which fails closed to protect spend. A real
	// human iterating on a prompt routinely exceeds 12/h; this lane lets them.
	mcp3dGenerateFree: (key) =>
		getLimiter('mcp3d:generate:free', { limit: FREE_HOURLY_BASE, window: '1 h' }).limit(key),
	// Holder perk (Lever 2): $THREE tiers raise the free-generation ceiling by their
	// rate multiplier. Same per-key counter + prefix as the base free lane — the tier
	// only lifts the threshold, so a holder iterating heavily isn't throttled at 60/h.
	// `multiplier` comes from a verified tier pass (pure HMAC, no RPC on the hot path).
	mcp3dGenerateFreeTiered: (key, multiplier = 1) =>
		getLimiter('mcp3d:generate:free', {
			limit: Math.max(FREE_HOURLY_BASE, Math.round(FREE_HOURLY_BASE * (Number(multiplier) || 1))),
			window: '1 h',
		}).limit(key),
	// Material Studio (api/material-studio.js): non-destructive material edits,
	// AI restyle (one watsonx call + one gltf-transform mutation pass — cheap,
	// no GPU job), and seeded variant fan-out. Free, hosted, and non-critical
	// like mcp3dGenerateFree — a Redis outage must never deny a zero-cost edit.
	// Uploads (exporting/checkpointing a lineage version) get a higher ceiling
	// than restyle/variants since they carry no LLM/CPU-heavy cost.
	materialStudioRestyle: (key) =>
		getLimiter('material-studio:restyle', { limit: 40, window: '1 h' }).limit(key),
	materialStudioUpload: (key) =>
		getLimiter('material-studio:upload', { limit: 120, window: '1 h' }).limit(key),
	// BNB vault upload (api/bnb/vault-upload.js) — encrypts + writes a real
	// Greenfield tx + SP PUT per call, the heaviest write in the BNB vault
	// track. Tight per-IP ceiling; a seller listing dozens of items per hour is
	// already an outlier, and each call carries real Greenfield gas cost.
	bnbVaultUploadIp: (ip) => getLimiter('bnb:vault:upload:ip', { limit: 20, window: '1 h' }).limit(ip),
	// BNB vault reads (api/vault/list.js, api/vault/status.js) — free, no
	// write cost, but each call does a real `eth_getLogs`/`eth_call` against a
	// public RPC (list.js) or a Storage-Provider fetch (manifest joins), so a
	// generous but real ceiling, not unlimited.
	bnbVaultReadIp: (ip) => getLimiter('bnb:vault:read:ip', { limit: 120, window: '10 m' }).limit(ip),
	// BNB vault unlock (api/vault/unlock.js) — the one call in this track that
	// releases a real (wrapped) secret. Tighter than the read ceiling; a
	// legitimate buyer unlocks the same object at most a handful of times.
	bnbVaultUnlockIp: (ip) => getLimiter('bnb:vault:unlock:ip', { limit: 30, window: '10 m', critical: true }).limit(ip),
	// Status polling is the highest-frequency call in the generation flow (every
	// active job polls every few seconds, plus the /forge health pill). It only
	// guards against pathological poll floods, so it is enforced per instance
	// (`local`) — spending a distributed Redis command per poll is what drained
	// the Upstash quota without buying any real protection here.
	mcp3dStatus: (key) =>
		getLimiter('mcp3d:status', { limit: 240, window: '1 m', local: true }).limit(key),
	// Persona wallet identity reads (balances, reputation, holdings, nameplate) —
	// several live RPC/HTTP calls per invocation, so a tighter ceiling than plain
	// status polling but generous enough for a chat turn to check before tipping.
	mcp3dPersonaIdentity: (key) =>
		getLimiter('mcp3d:persona:identity', { limit: 60, window: '1 m', local: true }).limit(key),
	// Persona value-movement (persona_tip / persona_send) — moves real USDC, so it
	// gets a hard, critical, low-throughput ceiling independent of the per-call and
	// per-session USDC spend caps enforced inside the handler.
	mcp3dPersonaSpend: (key) =>
		getLimiter('mcp3d:persona:spend', { limit: 20, window: '1 h', critical: true }).limit(key),
	// Platform-wide hourly circuit breaker across ALL free-studio IPs, so
	// distributed callers each under their own studioGenHourly cap can't
	// collectively flood the free NVIDIA / HF allocation. Enforced whenever Redis
	// is healthy. NON-critical (fail OPEN on a Redis outage) for the same reason as
	// studioGenBurst/Hourly above: the studio's lanes are zero marginal cost, so a
	// Redis outage must never dead-end a free generation. Real paid spend is still
	// fail-CLOSED one layer down at forge's own mcp3dGenerateGlobal, which this
	// breaker only backstops. (studioIp / studioGenBurst / studioGenHourly are
	// defined above next to the other mcp buckets.)
	studioGenerateGlobal: () =>
		getLimiter('studio:generate:global', {
			limit: FORGE_PAID_GLOBAL_HOURLY,
			window: '1 h',
		}).limit('global'),
	// Forge prompt enhancer — one free-tier LLM rewrite per call. Cheap text
	// completion, but each one hits an upstream provider, so cap per principal to
	// keep that egress bounded. Non-critical: a Redis outage must never block a
	// rewrite (the enhancer degrades gracefully to the original prompt anyway).
	forgeEnhance: (key) => getLimiter('forge:enhance', { limit: 40, window: '1 h' }).limit(key),
	// Instant Agent (/start): the anonymous "one sentence to a live agent" call.
	// One real LLM completion per request with no account behind it, so it gets
	// its own bucket rather than the shared publicIp pool: a script hammering it
	// must not be able to spend provider budget, and must not be able to starve
	// the read endpoints the same visitor's page needs. 12/10m is roughly a dozen
	// honest retries while a person is deciding on their idea.
	instantAgentIp: (ip) => getLimiter('instant-agent:ip', { limit: 12, window: '10 m' }).limit(ip),
	// Self-hosted TRELLIS NIM demo (api/forge-nim) — each call is one real
	// image/text→3D inference against the NIM, so cap per principal to keep that
	// GPU egress bounded. Non-critical: a Redis blip must never block the demo.
	forgeNim: (key) => getLimiter('forge:nim', { limit: 30, window: '1 h' }).limit(key),
	// Conversational iteration (api/forge-iterate) — an ownership-preserving
	// twin of the free studio's refine_model tool, called from the signed-in
	// Forge Studio UI. Each call is one real regeneration, so cap per principal
	// like every other forge-adjacent REST endpoint. /api/forge underneath has
	// its own generation gates; this bounds the composition/lineage wrapper
	// itself. Non-critical: a Redis blip must never block an iteration.
	forgeIterate: (key) => getLimiter('forge:iterate', { limit: 60, window: '1 h' }).limit(key),
	// Forge-Off upvotes (api/forge-vote) — one cheap DB write per tap from an
	// anonymous browser. Generous so a visitor can toggle and browse a full
	// board without hitting a wall, tight enough to blunt a single IP carpeting
	// votes across the catalogue (the per-(creation,voter) PRIMARY KEY already
	// caps real influence at one vote each). Non-critical: a Redis blip must
	// never block a vote — the vote itself is idempotent.
	forgeVote: (key) => getLimiter('forge:vote', { limit: 120, window: '10 m' }).limit(key),
	// Free text→3D lane (api/v1/ai/text-to-3d) — each generation drives one real
	// NVIDIA NIM TRELLIS GPU inference, so the free tier is a per-IP daily quota
	// (10/day). Above it the endpoint returns 429 + a pointer to the paid
	// /api/x402/forge tiers rather than paywalling silently. Non-critical: a Redis
	// blip degrades to the per-instance memory limiter, never blocks generation.
	aiTextTo3d: (ip) => getLimiter('ai:text-to-3d', { limit: 10, window: '24 h' }).limit(ip),
	// Free token security check (api/v1/token/security) — reads getAccountInfo +
	// getTokenLargestAccounts off the shared RPC and DexScreener, all cached 60s at
	// the edge, so this only gates cache-miss origin hits. 20/min per IP is generous
	// for an agent screening a watchlist while capping a scripted enumeration flood.
	// Non-critical: a Redis blip degrades to the per-instance memory limiter.
	tokenSecurityIp: (ip) => getLimiter('token:security:ip', { limit: 20, window: '1 m' }).limit(ip),
	// Robinhood Chain market data (api/v1/robinhood/*) — free reads that fan out to
	// on-chain multicall (Chainlink NAV snapshot), Blockscout, DefiLlama, CoinGecko
	// and DexScreener, every one behind a short-TTL cache, so this only gates
	// cache-miss origin hits. A DEDICATED per-IP bucket (never the shared publicIp
	// pool — see the play-lobby-429 self-DoS lesson): 60/min is generous for an
	// interactive board polling the stocks/coins tabs while capping a scripted
	// enumeration flood. Non-critical: a Redis blip degrades to the per-instance
	// memory limiter, never blocks a read.
	robinhoodRead: (ip) => getLimiter('robinhood:read:ip', { limit: 60, window: '1 m' }).limit(ip),
	// Free name resolution (api/v1/resolve) — wraps the same ENS RPC failover
	// chain and SNS/Bonfida calls api/agents/ens/[name].js and api/sns.js already
	// make, all with their own in-process caches, so this only gates cache-miss
	// origin hits. 30/min per IP matches the spec's high-frequency-agent-primitive
	// budget without inviting a scripted enumeration flood. Non-critical: a Redis
	// blip degrades to the per-instance memory limiter, never blocks a resolution.
	resolveIp: (ip) => getLimiter('v1:resolve:ip', { limit: 30, window: '1 m' }).limit(ip),
	// Diorama composer (api/diorama action:compose) — one free-first LLM
	// completion per call that decomposes a sentence into a placed object set.
	// Paid upstream egress, so cap per IP and add a global hourly circuit breaker.
	// Critical: a Redis outage in prod fails closed rather than handing out
	// unbounded paid inference (the same posture as the chat/brain buckets).
	dioramaComposeIp: (ip) =>
		getLimiter('diorama:compose:ip', { limit: 20, window: '10 m', critical: true }).limit(ip),
	dioramaComposeGlobal: () =>
		getLimiter('diorama:compose:global', {
			limit: Math.max(120, Number(process.env.DIORAMA_COMPOSE_GLOBAL_HOURLY) || 600),
			window: '1 h',
			critical: true,
		}).limit('global'),
	// Portal (api/portal): fetches a caller-supplied website once and builds a
	// walkable world from it. The spend is other people's bandwidth rather than
	// ours, which is exactly why it is capped: a build is one origin request plus
	// a robots.txt read, and an uncapped endpoint would turn three.ws into a
	// crawler someone else pays for. Cached worlds do not reach this limiter, so
	// the cap governs distinct pages, not shares of the same link. Non-critical:
	// a Redis blip degrades to the per-instance limiter rather than refusing a
	// visitor a world we can build for free from cache.
	portalBuildIp: (ip) =>
		getLimiter('portal:build:ip', { limit: 30, window: '10 m' }).limit(ip),
	// Fleet-wide brake, so no distribution of IPs can point Portal at one origin
	// hard enough to look like an attack from three.ws.
	portalBuildGlobal: () =>
		getLimiter('portal:build:global', {
			limit: Math.max(200, Number(process.env.PORTAL_BUILD_GLOBAL_HOURLY) || 1200),
			window: '1 h',
		}).limit('global'),
	// GLB export of an already-built world: pure CPU on our side plus a download,
	// so it gets its own, smaller cap.
	portalExportIp: (ip) =>
		getLimiter('portal:export:ip', { limit: 12, window: '10 m' }).limit(ip),
	// Diorama save (api/diorama action:save) — persists a forged world to the
	// public gallery table. Anonymous write, so cap per IP to stop one caller
	// carpeting the gallery; non-critical so an infra hiccup never blocks a save.
	dioramaSaveIp: (ip) =>
		getLimiter('diorama:save:ip', { limit: 30, window: '10 m' }).limit(ip),
	// Diorama scene export (api/diorama action:export) — merges already-forged
	// object GLBs + a procedural ground/lights into one GLB via @gltf-transform
	// and uploads it to object storage. No LLM/GPU spend, but it does real
	// network egress (re-fetching every object GLB) and a storage write, so it
	// gets its own moderate per-IP cap; non-critical since a Redis blip should
	// degrade, not block, a local export.
	dioramaExportIp: (ip) =>
		getLimiter('diorama:export:ip', { limit: 20, window: '10 m' }).limit(ip),
	// Diorama one-shot build (api/diorama action:build) — the full server-side
	// compose → forge every object → export pipeline in a single call, for
	// agents/MCP clients with no browser to drive the progressive client flow.
	// It runs the same paid LLM completion as compose PLUS N free-lane forges,
	// so it shares compose's critical/fail-closed posture and gets a tighter
	// per-IP ceiling than compose alone.
	dioramaBuildIp: (ip) =>
		getLimiter('diorama:build:ip', { limit: 6, window: '10 m', critical: true }).limit(ip),
	dioramaBuildGlobal: () =>
		getLimiter('diorama:build:global', {
			limit: Math.max(40, Number(process.env.DIORAMA_BUILD_GLOBAL_HOURLY) || 200),
			window: '1 h',
			critical: true,
		}).limit('global'),
	// x402 Bazaar MCP. Discovery calls fan out to external facilitators, so cap
	// per principal to keep that egress bounded without throttling normal use.
	mcpBazaar: (key) =>
		getLimiter('mcp:bazaar', { limit: 60, window: '1 m', critical: true }).limit(key),
	// threews-agent MCP. Read/discovery calls are cheap; pay_and_call moves real
	// money, so it gets a much tighter ceiling on top of the per-spend caps.
	mcpAgent: (key) =>
		getLimiter('mcp:agent', { limit: 60, window: '1 m', critical: true }).limit(key),
	mcpAgentPay: (key) =>
		getLimiter('mcp:agent:pay', { limit: 20, window: '1 m', critical: true }).limit(key),
	// Labor-market write buckets, keyed per user. These had borrowed the MCP agent
	// buckets above, which coupled two unrelated surfaces: a user actively using the
	// MCP `pay_and_call`/agent tools could exhaust the shared budget and 429 their
	// bounty posts (and vice versa). Split out so each surface has its own ceiling.
	//   · laborPost — posting a bounty escrows real $THREE on-chain, so it's the
	//     money path: critical (fail closed in prod without Redis). 20/min lets an
	//     owner post a burst while bounding a runaway client.
	//   · laborBid  — bids move no money (escrow happens at post), so non-critical;
	//     60/min mirrors a worker agent placing offers across many open bounties.
	laborPost: (userId) =>
		getLimiter('labor:post', { limit: 20, window: '1 m', critical: true }).limit(userId),
	laborBid: (userId) =>
		getLimiter('labor:bid', { limit: 60, window: '1 m' }).limit(userId),
	oauthToken: (clientId) =>
		getLimiter('oauth:token', { limit: 120, window: '1 m' }).limit(clientId),
	// Stud-listing writes (POST /api/genome/stud): an owner toggling one of their
	// agents into the public stud market and pricing it in $THREE. Each call is a
	// single owner-scoped meta write, so the ceiling only needs to stop a scripted
	// flood from churning the market ordering. Non-critical: a Redis outage must
	// never lock an owner out of unlisting their own agent.
	genomeStudWrite: (userId) =>
		getLimiter('genome:stud:write', { limit: 30, window: '1 m' }).limit(userId),
	upload: (userId) => getLimiter('upload', { limit: 60, window: '1 h' }).limit(userId),
	// Auto-rig submission (api/_lib/auto-rig.js → maybeAutoRigAvatar). Every gate
	// lands BEFORE a paid UniRig GPU rerig job is submitted to Replicate / the
	// self-host backend, so these are the money path of the auto-rig program — all
	// critical (fail closed in prod without Redis, the same posture as
	// mcp3dGenerate / videoGenerateUser). The create request itself stays gated
	// only by size (enforceQuotas); the spend lives here.
	//   · rig       — per-user hourly burst ceiling on auto-rig submissions (10/h).
	//   · rigDaily  — per-user 24h hard cost cap, independent of the hourly bucket,
	//                 so a user can't drip-feed 10/h around the clock. Env-tunable
	//                 via AUTO_RIG_DAILY_PER_USER (default 20, floored at 5).
	//   · rigGlobal — platform-wide hourly circuit breaker on the shared GPU budget,
	//                 keyed 'global' (mirrors mcp3dGenerateGlobal). Env-tunable via
	//                 AUTO_RIG_GLOBAL_HOURLY (default 300, floored at 60).
	rig: (userId) => getLimiter('rig', { limit: 10, window: '1 h', critical: true }).limit(userId),
	rigDaily: (userId) =>
		getLimiter('rig:daily', {
			limit: Math.max(5, Number(process.env.AUTO_RIG_DAILY_PER_USER) || 20),
			window: '1 d',
			critical: true,
		}).limit(userId),
	rigGlobal: () =>
		getLimiter('rig:global', {
			limit: Math.max(60, Number(process.env.AUTO_RIG_GLOBAL_HOURLY) || 300),
			window: '1 h',
			critical: true,
		}).limit('global'),
	avatarPatch: (userId) => getLimiter('avatar:patch', { limit: 20, window: '1 h' }).limit(userId),
	// Attaching an avatar to an agent (api/onboarding/link-avatar). Onboarding
	// links once and reassignment is rare, so this is generous for real use while
	// bounding a script that churns an agent's body. Its own bucket rather than
	// avatarPatch's: editing avatar metadata must not exhaust the link budget.
	avatarLink: (userId) => getLimiter('avatar:link', { limit: 30, window: '1 h' }).limit(userId),
	prefsWrite: (userId) => getLimiter('prefs:write', { limit: 30, window: '1 h' }).limit(userId),
	// Walk snapshot upserts (api/walk/session.js). Sized from the client's real
	// cadence rather than the generic prefs budget: src/walk-session.js saves on a
	// 30s heartbeat (120/h) plus debounced writes on interactive changes, so a
	// 30/h ceiling silenced cross-device sync ~15 minutes into a walk. Keyed by
	// userId so one office NAT can't collapse every walker into one bucket.
	walkSessionWrite: (userId) =>
		getLimiter('walk:session:write', { limit: 240, window: '1 h' }).limit(userId),
	// Claiming a reputation-unlocked cosmetic onto an agent (api/agents/:id/unlocks).
	// A low-frequency owner action; this just bounds abusive retries.
	unlockClaim: (userId) => getLimiter('unlock:claim', { limit: 40, window: '1 h' }).limit(userId),
	// Per-user budget for the embeddings endpoint (api/agents/:id/embed — free
	// NVIDIA NIM lane first, paid Voyage fallback). Keyed by userId (not IP) so
	// the shared platform keys/quotas can't be drained by one account rotating
	// IPs. recall() embeds one query at a time, so a generous per-minute
	// ceiling still leaves headroom for interactive memory search.
	embedUser: (userId) => getLimiter('embed:user', { limit: 120, window: '1 m' }).limit(userId),
	// Token-gated 3D embeds (api/embed/gate-create.js, api/embed/gate-verify.js).
	// Create is an authenticated, low-frequency creator action — bound to stop a
	// compromised session from spraying gates. Verify is called by anonymous
	// visitors and drives a real Solana RPC read + signature check per attempt,
	// so it gets both a per-IP flood guard AND a per-wallet ceiling (the wallet
	// bucket is the one that actually matters — a distributed-IP attacker still
	// can't brute-force past a single wallet's budget without also owning it).
	embedGateCreateIp: (ip) => getLimiter('embed:gate:create:ip', { limit: 20, window: '10 m' }).limit(ip),
	embedGateVerifyIp: (ip) => getLimiter('embed:gate:verify:ip', { limit: 30, window: '5 m' }).limit(ip),
	embedGateVerifyWallet: (addr) =>
		getLimiter('embed:gate:verify:wallet', { limit: 10, window: '5 m' }).limit(addr),
	// Token-gated scene shares (api/scene/gate-check.js). Same anonymous-visitor
	// shape as the embed gate above, so it gets the same pairing: a per-IP flood
	// guard plus the per-wallet ceiling that a distributed-IP attacker cannot
	// rotate around. Its own buckets rather than the embed ones so a busy embed
	// does not lock a scene visitor out (and vice versa). The IP bucket is looser
	// than the wallet bucket because one visitor spends two calls (nonce, then
	// signature) per attempt and may legitimately switch wallets.
	sceneGateCheckIp: (ip) => getLimiter('scene:gate:check:ip', { limit: 30, window: '5 m' }).limit(ip),
	sceneGateCheckWallet: (addr) =>
		getLimiter('scene:gate:check:wallet', { limit: 10, window: '5 m' }).limit(addr),
	avatarRollback: (userId) =>
		getLimiter('avatar:rollback', { limit: 10, window: '1 h' }).limit(userId),
	// Chat inference spends real money on the host's LLM keys, so these are
	// critical: a Redis outage in prod fails closed (deny) rather than handing out
	// unbounded paid inference. chatUser/chatIp bound a single account/IP.
	chatUser: (userId) =>
		getLimiter('chat:user', { limit: 40, window: '1 m', critical: true }).limit(userId),
	chatIp: (ip) => getLimiter('chat:ip', { limit: 60, window: '1 m', critical: true }).limit(ip),
	// Embeddable concierge widget (/api/concierge) — anonymous, any-origin
	// traffic from third-party sites, so it gets its own bucket instead of
	// sharing chat:ip: a widget-hosting page must not starve the signed-in
	// viewer chat (and vice versa). Same critical fail-closed policy: this lane
	// spends free-tier LLM quota and can fall through to funded rungs.
	conciergeIp: (ip) =>
		getLimiter('concierge:ip', { limit: 20, window: '1 m', critical: true }).limit(ip),
	// Global ceiling across every embedded widget combined — bounds the total
	// free-tier draw of the whole third-party fleet, mirroring chatHostKeyGlobal.
	conciergeGlobal: () =>
		getLimiter('concierge:global', { limit: 600, window: '1 m', critical: true }).limit('global'),
	// Global ceiling on inference billed to the HOST's provider keys (i.e. callers
	// who supplied no key of their own). Stops distributed abuse — many accounts
	// each under their per-user limit collectively draining the platform's quota.
	chatHostKeyGlobal: () =>
		getLimiter('chat:hostkey:global', { limit: 1200, window: '1 m', critical: true }).limit(
			'global',
		),
	// AI bounty judge (api/bounties/:id/judge). Each run spends real LLM tokens
	// scoring a whole field of submissions, so cap per poster and fail closed
	// without Redis in prod rather than allowing unbounded paid inference.
	bountyJudge: (userId) =>
		getLimiter('bounty:judge:user', { limit: 30, window: '1 h', critical: true }).limit(userId),
	// Agent action-log append (api/agent-actions POST). Append-only, never-deleted
	// table, so cap per user to prevent unbounded storage growth from a script.
	agentActionAppend: (userId) =>
		getLimiter('agent:action:append', { limit: 120, window: '1 m' }).limit(userId),
	// Bounty creation + submission. Both are authenticated writes to public,
	// everyone-reads tables, so cap per user to stop one account scripting spam
	// that pollutes the feed and bloats storage.
	bountyCreate: (userId) =>
		getLimiter('bounty:create', { limit: 15, window: '1 h' }).limit(userId),
	bountySubmit: (userId) =>
		getLimiter('bounty:submit', { limit: 40, window: '1 h' }).limit(userId),
	// Direct messages between friends — its own bucket so DM spam can't starve
	// world-chat posting and vice versa. Mirrors world chat's order of magnitude.
	dmSend: (userId) => getLimiter('dm:send', { limit: 30, window: '1 m' }).limit(userId),
	// Demo /api/x402-pay — agent wallet pays real USDC per call, so we keep the
	// per-IP burst small (6/min ≈ $0.006/min) and rely on the agent wallet
	// balance as the global ceiling.
	x402PayIp: (ip) => getLimiter('x402:pay:ip', { limit: 6, window: '1 m' }).limit(ip),
	x402PayGlobal: () =>
		getLimiter('x402:pay:global', { limit: 600, window: '1 h', critical: true }).limit(
			'global',
		),
	// x402 checkout analytics record (api/x402-checkout-record). Public + write,
	// so bound per-IP to stop an attacker scripting fabricated revenue rows.
	x402RecordIp: (ip) => getLimiter('x402:record:ip', { limit: 30, window: '1 m' }).limit(ip),
	// Generic paid x402 endpoints (paidEndpoint(), incl. the ~4.4k-URL datapoint
	// fabric). Two tiers:
	//  • probe — every anonymous request (price-discovery 402 + paid retry).
	//    Generous + NON-critical so a Redis outage never blocks discovery or a
	//    legitimate paid call; authenticated/subscription callers skip it entirely
	//    (they have their own access-control gating). Pure anonymous-flood guard.
	//  • verify — only requests carrying an X-PAYMENT header reach the facilitator
	//    /verify round-trip. Without this, one cheap inbound request amplifies into
	//    one outbound facilitator call at our expense (cost/DDoS vector). Bounded
	//    per-IP AND a global circuit breaker, both CRITICAL (fail closed in prod):
	//    during a Redis outage, rejecting a payment retry (buyer keeps funds and
	//    retries) beats letting the amplification run unbounded.
	//
	// The per-IP verify bucket is FAILURE-WEIGHTED, not attempt-weighted. Metering
	// every attempt equally capped a *paying* client at 20 calls/min, which is
	// incoherent for a per-datapoint API whose whole value is bulk reads: a buyer
	// pulling 50 metrics got 429s despite paying for every one. The amplification
	// vector is a junk X-PAYMENT flood, and junk payments FAIL verify. So a
	// successful (settled) verify costs 1 token, while a failed verify costs
	// X402_VERIFY_FAIL_PENALTY (default 15) via x402VerifyPenalty(). At 300/min a
	// legitimate payer gets 300 paid calls/min, while a pure junk flood drains the
	// bucket after ~20 failures/min, the same bound as the old flat cap, still
	// enforced by the pre-verify gate BEFORE any facilitator call is made.
	x402ProbeIp: (ip) =>
		getLimiter('x402:probe:ip', { limit: X402_PROBE_IP_PER_MIN, window: '1 m' }).limit(ip),
	x402VerifyIp: (ip) =>
		getLimiter('x402:verify:ip', {
			limit: X402_VERIFY_IP_PER_MIN,
			window: '1 m',
			critical: true,
		}).limit(ip),
	// Burn the extra tokens that make a failed verify expensive. Called ONLY on the
	// verify-failure path; the one token for the attempt itself was already spent by
	// x402VerifyIp() at the pre-verify gate. Best-effort: a limiter fault here must
	// never convert a payment error into a 500, so it swallows its own errors.
	x402VerifyPenalty: async (ip) => {
		const extra = Math.max(0, X402_VERIFY_FAIL_PENALTY - 1);
		if (!extra) return;
		const bucket = getLimiter('x402:verify:ip', {
			limit: X402_VERIFY_IP_PER_MIN,
			window: '1 m',
			critical: true,
		});
		try {
			await Promise.all(Array.from({ length: extra }, () => bucket.limit(ip)));
		} catch {
			/* penalty is best-effort; the pre-verify gate is the hard bound */
		}
	},
	x402VerifyGlobal: () =>
		getLimiter('x402:verify:global', {
			limit: X402_VERIFY_GLOBAL_PER_HOUR,
			window: '1 h',
			critical: true,
		}).limit('global'),
	// OUR self-hosted facilitator (api/x402-facilitator/verify+settle). Its public
	// URL means anyone with a few cents of USDC can spam /settle with valid tiny
	// allowlisted transfers, each forcing a sponsor co-sign that burns ~5000
	// lamports — a fee-burn grief that can pause the paid economy at the SOL floor.
	// Per-IP is generous (60/min, NOT the tighter 20/min verify cap): legit settle
	// traffic loops back through the platform's own egress IP via callFacilitator,
	// so a small cap here would self-DoS; 60/min still bounds a single direct
	// attacker IP. CRITICAL like verify — fail closed, since rejecting a settle just
	// leaves the buyer holding funds to retry, which beats unbounded fee burn.
	x402FacilitatorIp: (ip) =>
		getLimiter('x402:facilitator:ip', {
			limit: X402_FACILITATOR_IP_PER_MIN,
			window: '1 m',
			critical: true,
		}).limit(ip),
	x402FacilitatorGlobal: () =>
		getLimiter('x402:facilitator:global', {
			limit: X402_FACILITATOR_GLOBAL_PER_HOUR,
			window: '1 h',
			critical: true,
		}).limit('global'),
	checkName: (ip) => getLimiter('check-name:ip', { limit: 60, window: '1 m' }).limit(ip),
	ensResolve: (ip) => getLimiter('ens:resolve:ip', { limit: 60, window: '1 m' }).limit(ip),
	snsResolve: (ip) => getLimiter('sns:resolve:ip', { limit: 60, window: '1 m' }).limit(ip),
	// Generic public read endpoints (explore, showcase, public agent fetch).
	// local: high-frequency public reads with no side effects — the only job is
	// flood protection, and a per-instance cap bounds one IP's throughput just as
	// well without spending a Redis command per page view.
	//
	// 240/min, NOT 60. At 60 this bucket was a self-DoS: ~166 endpoints share it,
	// and real pages fan out to many of them in one load — the agent profile fires
	// 7-8 (duplicated /reputation + /solana/networth), /crypto fires 5, oracle's
	// /activity fires 5 and re-polls all 5 every 90s, galaxy polls 2 every 6s. A
	// user opening two tabs burned the minute budget and 429'd their own page. Since
	// this is a `local` in-memory guard (no Redis cost) and every endpoint behind it
	// is an edge-cached side-effect-free read, a higher ceiling costs nothing and
	// still stops a scripted flood. Page-load-critical clusters additionally get
	// their own dedicated buckets below so one surface can never starve another.
	publicIp: (ip) => getLimiter('public:ip', { limit: 240, window: '1 m', local: true }).limit(ip),
	// Fiat onramp checkout links (/api/onramp/link). Unlike the generic public read,
	// each configured call mints a single-use session token against Coinbase's CDP
	// API, so an unauthenticated flood here is upstream quota burn, not just our CPU.
	// 20 per 5 min per IP covers a user reopening the Add funds overlay and switching
	// between USDC and SOL several times, and nothing legitimate needs more.
	onrampLinkIp: (ip) =>
		getLimiter('onramp:link:ip', { limit: 20, window: '5 m', local: true }).limit(ip),
	// /irl coordinate reads (pins nearby, drops nearby, world-lines nearby). These
	// are the only public reads that reveal WHERE another user placed something, so
	// their ceiling is a privacy budget, not a flood guard, and it must not drift
	// with the generic read bucket: when publicIp was raised 60 -> 240 for unrelated
	// page-load fan-out, the /irl grid-sweep cost quietly dropped 4x (the H7 threat
	// model still documented 60). A dedicated bucket pins the number to the surface
	// it protects. 60/min against a legit viewer's ~6/min (a 10s nearby poll) leaves
	// 10x headroom, and no page fans out to more than one of these at a time.
	// local: an in-memory bucket never throws on a Redis outage, which is what lets
	// the callers fail CLOSED on it without inventing an availability risk.
	// See docs/irl/THREAT-MODEL.md.
	irlNearbyIp: (ip) => getLimiter('irl:nearby:ip', { limit: 60, window: '1 m', local: true }).limit(ip),
	// Agent profile reads (networth, patronage, achievements, reputation, tiers).
	// One profile view fans out to 7-8 of these; isolate them so opening a few
	// profiles can't drain the budget shared with markets/home/oracle surfaces.
	agentProfileIp: (ip) =>
		getLimiter('agent-profile:ip', { limit: 240, window: '1 m', local: true }).limit(ip),
	// Market/DeFi/crypto dashboards (api/coin/*, api/defi/*, api/crypto/*). Every
	// one is an edge-cached upstream mirror, and the dashboards fan out 3-5 per load
	// (/crypto probes 5; /coins polls liquidations every 30s; /gas every 15s).
	marketDataIp: (ip) =>
		getLimiter('market-data:ip', { limit: 240, window: '1 m', local: true }).limit(ip),
	// Galaxy visualiser (/api/galaxy, /api/galaxy/flows). The only continuous
	// high-frequency drain on the platform: a 6s delta poll on the galaxy page plus
	// a 12s economy-ticker poll on home. Needs its own headroom or an idle galaxy
	// tab slowly starves every other public read in the same browser.
	galaxyIp: (ip) => getLimiter('galaxy:ip', { limit: 300, window: '1 m', local: true }).limit(ip),
	// Lobby-critical market feeds (/api/pump/trending, /api/pump/search). These
	// render the /play lobby on every page load, sit behind a 30s server cache +
	// stale fallback (so the upstream cost of a burst is near zero), and MUST NOT
	// share the generic `publicIp` bucket: ~166 endpoints drain that one 60/min
	// pool, so a browser with a few three.ws tabs open starves its own lobby and
	// /play dead-ends on a 429 it did nothing to earn (same failure mode that
	// moved /api/play/nonce to its own bucket — see playNonceIp below). local:
	// per-instance flood guard is all a cached read needs.
	marketFeedIp: (ip) =>
		getLimiter('market-feed:ip', { limit: 120, window: '1 m', local: true }).limit(ip),
	// Free x402 developer toolkit (echo / debug / verify-receipt). Free ≠
	// abusable: these decode caller-supplied payment envelopes and recompute
	// hashes, so 30/min per IP is generous for a developer iterating on their
	// integration while bounding a script that hammers the decode path.
	x402DevToolIp: (ip) => getLimiter('x402-dev-tool:ip', { limit: 30, window: '1 m' }).limit(ip),
	// Client-side error report ingestion (api/client-errors). The browser
	// reporter batches and caps itself at 25 events/page, so legitimate traffic
	// is a handful of requests per pageview even on a broken page; 30/min per
	// IP absorbs that while keeping log-flooding abuse bounded.
	// local: bounding a log flood is exactly what a per-instance cap is for —
	// spending a distributed Redis command to record that an error was reported is
	// pure quota burn, and it lands hardest precisely when the site is already broken.
	clientErrorsIp: (ip) =>
		getLimiter('client-errors:ip', { limit: 30, window: '1 m', local: true }).limit(ip),
	// Publishing a /play build to a coin's featured surface (R20). Each write stores
	// a screenshot in Redis, so cap the burst per IP to keep that bounded; reads use
	// the generic publicIp bucket.
	buildPublishIp: (ip) => getLimiter('build:publish:ip', { limit: 10, window: '10 m' }).limit(ip),
	// /play sign-in nonce (GET /api/play/nonce). Hit on every /play page load — and
	// again on each sign-in attempt — to read the gate config + mint a self-verifying
	// HMAC nonce. It has NO side effects and NO cost (no RPC, no DB), so it must NOT
	// borrow the strict credential `authIp` bucket (30/10m, shared with login/register/
	// trading): a shared office/NAT, a burst of players, or a couple of reloads would
	// exhaust that and 429 the gate on what is almost always an open game. The real
	// abuse surface is /verify (ed25519 signature + RPC balance read), which keeps
	// `authIp`. local: a per-instance flood guard is all this needs — like publicIp /
	// tokenPriceIp — and it spends zero Redis commands on a high-traffic page-load path.
	playNonceIp: (ip) =>
		getLimiter('play:nonce:ip', { limit: 120, window: '1 m', local: true }).limit(ip),
	// Browser Solana JSON-RPC proxy (api/solana-rpc). Forwards to the keyed
	// upstream (Helius), so cap per-IP burst to keep the studio launch panel
	// responsive while preventing anonymous quota drain, plus a global hourly
	// ceiling as a hard cost cap independent of any one client.
	solanaRpcIp: (ip) => getLimiter('solana-rpc:ip', { limit: 120, window: '1 m' }).limit(ip),
	solanaRpcGlobal: () =>
		getLimiter('solana-rpc:global', { limit: 12000, window: '1 h' }).limit('global'),
	// Browser EVM JSON-RPC proxy (api/evm-rpc). Same shape as the Solana proxy:
	// the chain may front a keyed Alchemy upstream, so cap per-IP burst and add a
	// global hourly ceiling as the hard cost cap.
	evmRpcIp: (ip) => getLimiter('evm-rpc:ip', { limit: 120, window: '1 m' }).limit(ip),
	evmRpcGlobal: () =>
		getLimiter('evm-rpc:global', { limit: 12000, window: '1 h' }).limit('global'),
		// Helius DAS / enhanced-API endpoints (nft/resolve getAsset, tx/explain
		// enhanced-tx, live holder cohorts getTokenAccounts). DAS is billed at a far
		// higher credit multiplier than plain RPC, and these are public. Per-endpoint
		// caches collapse repeat hits on the same key; this shared global hourly
		// ceiling is the hard cost cap against a bot enumerating many DISTINCT keys
		// (which caching can't stop). One bucket across all DAS endpoints.
		heliusDasGlobal: () =>
			getLimiter('helius-das:global', { limit: 3000, window: '1 h' }).limit('global'),
	// Free Crypto Data API family (api/crypto/*). Keyless, no-account reads an agent
	// makes mid-task (wallet portfolio, token snapshots). Some paths fan out to the
	// keyed Helius/public-RPC upstreams, so a generous-but-bounded per-IP burst keeps
	// interactive use snappy while a shared global hourly ceiling is the hard cost cap
	// against one caller (or many) draining the upstream quota. One bucket for the family.
	cryptoDataIp: (ip) => getLimiter('crypto-data:ip', { limit: 60, window: '1 m' }).limit(ip),
	cryptoDataGlobal: () =>
		getLimiter('crypto-data:global', { limit: 6000, window: '1 h' }).limit('global'),
	// Agent-to-agent economy demo (api/agent-economy/transact). Each call can send
	// a tiny real SOL payment from the server wallet, so cap per-IP and add a
	// global daily ceiling as a hard spend cap independent of wallet balance.
	// The global bucket is only consumed when a payment actually fires.
	agentEconomyIp: (ip) => getLimiter('agent-economy:ip', { limit: 10, window: '1 h' }).limit(ip),
	agentEconomyGlobal: () =>
		getLimiter('agent-economy:global', { limit: 500, window: '1 d' }).limit('global'),
	// IBM watsonx.ai Granite embeddings (api/watsonx/embed). Each call bills real
	// watsonx inference against the server key, so keep the per-IP burst small and
	// add a global hourly ceiling as a hard cost cap independent of any one client.
	watsonxEmbedIp: (ip) => getLimiter('watsonx:embed:ip', { limit: 20, window: '1 m' }).limit(ip),
	watsonxEmbedGlobal: () =>
		getLimiter('watsonx:embed:global', { limit: 600, window: '1 h' }).limit('global'),
	// IBM Granite Guardian governance (api/guardian/assess). Each request fans out
	// to one Granite Guardian classifier pass per risk against the server watsonx
	// key, so cap the per-IP burst and keep a global hourly ceiling as a cost cap.
	guardianIp: (ip) => getLimiter('guardian:ip', { limit: 30, window: '1 m' }).limit(ip),
	guardianGlobal: () =>
		getLimiter('guardian:global', { limit: 1200, window: '1 h' }).limit('global'),
	// Granite identity-integrity check (api/agents/identity-check). Each call does
	// one Granite embedding + a fan-out of Guardian passes against the server key,
	// so keep the per-IP burst tight and add a global hourly ceiling as a cost cap.
	identityCheckIp: (ip) =>
		getLimiter('identity-check:ip', { limit: 20, window: '1 m' }).limit(ip),
	identityCheckGlobal: () =>
		getLimiter('identity-check:global', { limit: 600, window: '1 h' }).limit('global'),
	// Skills marketplace browse — isolated bucket so traffic on other public endpoints
	// can't starve the skills list. 60/min per IP.
	skillsBrowse: (ip) => getLimiter('skills:browse', { limit: 60, window: '1 m' }).limit(ip),
	// Plugin manifest import (POST /api/plugins/import). Every call makes the
	// server fetch a caller-supplied URL, so this is the one plugin lane that can
	// be turned into an egress amplifier: 600/min (the generic browse ceiling) is
	// 600 outbound requests a minute per IP pointed wherever the caller likes.
	// 20 per 5 min is more imports than any human performs and still lets a
	// developer iterate on a manifest they are debugging.
	pluginImportIp: (ip) =>
		getLimiter('plugin:import:ip', { limit: 20, window: '5 m' }).limit(ip),
	// Plugin publish (POST /api/plugins/publish). Keyed on the authenticated user
	// rather than the IP because the row it writes is owned by that account.
	// Re-publishing the same identifier is an upsert, so the ceiling only bounds
	// how many DISTINCT plugin rows one account can create per hour.
	pluginPublishUser: (userId) =>
		getLimiter('plugin:publish:user', { limit: 30, window: '1 h' }).limit(userId),
	// Install-counter dedupe (POST /api/plugins/:id/install), same shape as
	// avatarViewIp: one counted install per (IP, plugin) per 30 minutes so a user
	// who reinstalls a plugin four times moves install_count by one. NOT local:
	// a per-instance counter would let the same caller count once per warm Cloud
	// Run instance, which is exactly the inflation this bucket exists to stop.
	pluginInstallDedupe: (ipAndPlugin) =>
		getLimiter('plugin:install:dedupe', { limit: 1, window: '30 m' }).limit(ipAndPlugin),
	// Marketplace agent preview chat — anonymous "try before fork" flow on the
	// agent detail page. Strict per-IP and per-agent caps so one client can't
	// drain LLM credits and one agent can't starve the global pool.
	previewIp: (ip) => getLimiter('preview:ip', { limit: 30, window: '1 h' }).limit(ip),
	previewAgent: (agentId) =>
		getLimiter('preview:agent', { limit: 200, window: '1 h' }).limit(agentId),
	widgetWrite: (userId) => getLimiter('widget:write', { limit: 60, window: '1 m' }).limit(userId),
	// local: embedded-widget read fetch — flood protection only, no side effects.
	// Widgets on third-party pages poll continuously, so a Redis command per read
	// at 600/min is pure burn; a per-instance cap bounds throughput just as well.
	widgetRead: (ip) =>
		getLimiter('widget:read', { limit: 600, window: '1 m', local: true }).limit(ip),
	// Per-widget visitor chat. Limit is dynamic — one bucket per (widgetId, perMinute).
	widgetChat: ({ ip, widgetId, perMinute }) =>
		getLimiter('widget:chat', {
			limit: Math.max(1, Math.min(60, perMinute || 8)),
			window: '1 m',
		}).limit(`${widgetId}:${ip}`),
	// We-pay LLM proxy: 60 req/min per IP (global floor), and per-agent dynamic bucket.
	// Critical: this lane spends the host's own provider keys, so a Redis outage
	// must degrade to the Postgres-backed counter rather than to no counter at all.
	embedLlmIp: (ip) =>
		getLimiter('embed:llm:ip', { limit: 60, window: '1 m', critical: true }).limit(ip),
	embedLlmAgent: (agentId, perMin) =>
		getLimiter('embed:llm:agent', {
			limit: Math.max(1, Math.min(1000, perMin || 10)),
			window: '1 m',
		}).limit(agentId),
	// Autonomous agent skill purchases: 10 per hour per buyer agent to prevent runaway spending.
	// Critical (moves real money) — fail closed in prod without Redis.
	agentBuy: (agentId) =>
		getLimiter('agent:buy', { limit: 10, window: '1 h', critical: true }).limit(agentId),
	// Gas-spending endpoints: 10 redeems per 5 minutes per IP
	strict: (key) =>
		getLimiter('permissions:redeem:strict', { limit: 10, window: '5 m' }).limit(key),
	pinUser: (userId) => getLimiter('pin:user', { limit: 30, window: '1 h' }).limit(userId),
	// local: pin-status poll — read-only progress check, flood guard only. The
	// pin UI polls this on an interval, so a per-instance cap saves a Redis
	// command per poll without weakening the throughput bound.
	pinStatusIp: (ip) =>
		getLimiter('pin:status:ip', { limit: 60, window: '1 m', local: true }).limit(ip),
	agentByAddress: (ip) =>
		getLimiter('agents:by-address', { limit: 120, window: '1 m' }).limit(ip),
	pricingPerIp: (ip) => getLimiter('pricing:ip', { limit: 120, window: '1 m' }).limit(ip),
	walletLink: (userId) => getLimiter('wallet:link', { limit: 10, window: '10 m' }).limit(userId),
	// Agent wallet read endpoints (GET balance, activity). Per authenticated user.
	// `local`: a read guard on wallet balance/holdings views (33 call sites, polled by
	// open dashboards). Reads move no funds — the send/withdraw/trade paths keep their
	// own distributed `critical` buckets.
	walletRead: (userId) => getLimiter('wallet:read', { limit: 60, window: '1 m', local: true }).limit(userId),
	// Assisted candidate scan (api/trading/scan.js). One call can cost six live
	// on-chain quotes plus six firewall simulations, so the generic authed-read
	// IP bucket (300 per 5 min) is far too loose to sit alone in front of it.
	// Owner-scoped ceiling: the UI button is single-flight and the brain caches
	// its context scan for 60s, so a real owner never approaches this.
	tradingScan: (userId) => getLimiter('trading:scan', { limit: 30, window: '5 m', local: true }).limit(userId),
	// Public cross-origin wallet embed card (GET /api/agents/wallet-embed). Served
	// CORS:* so a stranger's blog can mount the wallet chip — keyed per IP and
	// generous (a page with several embeds hydrates them all on load) but bounded
	// so the open endpoint can't be turned into a free balance-scraping relay. Reads
	// are short-TTL cached, so this only gates cache-miss origin hits.
	walletEmbedIp: (ip) => getLimiter('wallet:embed:ip', { limit: 120, window: '1 m' }).limit(ip),
	agentSuggest: (ip) => getLimiter('agents:suggest', { limit: 120, window: '1 m' }).limit(ip),
	// Signed-out "describe it, we build it" generation in the create-agent wizard.
	// The try-first flow lets anyone generate a spec before making an account, so
	// this hits the paid LLM chain with no user identity behind it — keyed per IP
	// and deliberately tight (enough to explore a few ideas and tweak, not enough
	// to turn the open endpoint into a free generation relay). The global daily
	// spend cap in api/_lib/llm.js is the second line of defence.
	agentSuggestAnon: (ip) => getLimiter('agents:suggest:anon', { limit: 10, window: '1 h' }).limit(ip),
	// On-chain agent registration (register_agent MCP tool). Each call may mint a
	// Core asset + Agent Identity PDA — real SOL spend — so this is deliberately
	// tight, keyed per authenticated user.
	agentRegister: (userId) =>
		getLimiter('agent:register', { limit: 12, window: '1 h' }).limit(userId),
	read: (ip) => getLimiter('permissions:read', { limit: 300, window: '1 m' }).limit(ip),
	permissionsGrant: (userId) =>
		getLimiter('permissions:grant', { limit: 10, window: '1 h' }).limit(userId),
	permissionsRevoke: (userId) =>
		getLimiter('permissions:revoke', { limit: 20, window: '1 h' }).limit(userId),
	// Developer API keys (api/keys). Minting is the expensive, abusable action, so
	// it keeps the tight hourly bucket. Listing and revoking get their own buckets
	// on purpose: when all three shared one, the dashboard's list-on-load plus
	// list-after-every-mutation could burn the 30/h budget and then refuse the
	// revoke, locking an owner out of killing a leaked key. A safety valve must
	// never be throttled by the thing it protects against.
	apiKeyManage: (userId) =>
		getLimiter('api-key:manage', { limit: 30, window: '1 h' }).limit(userId),
	apiKeyList: (userId) =>
		getLimiter('api-key:list', { limit: 120, window: '1 m', local: true }).limit(userId),
	apiKeyRevoke: (userId) =>
		getLimiter('api-key:revoke', { limit: 60, window: '1 h' }).limit(userId),
	// Unified API gateway (/api/v1/*). One bucket fronts every versioned endpoint,
	// keyed per principal — API key id when present, else user id, else IP — so a
	// single key's burst is bounded without one caller starving another. 120/min
	// is generous for an interactive integration while capping scripted floods;
	// individual capability handlers add their own tighter ceilings on top when
	// they fan out to a metered upstream (e.g. the shared aixbt key).
	apiV1: (key) => getLimiter('api:v1', { limit: 120, window: '1 m' }).limit(key),
	// Auth-critical (see authIp/registerIp above): brute-forcing verification
	// codes / spamming reset+verify emails must fail closed when Redis is down.
	verifyEmailIp: (ip) =>
		getLimiter('verify-email:ip', { limit: 10, window: '15 m', critical: true }).limit(ip),
	forgotPasswordEmail: (email) =>
		getLimiter('forgot-password:email', { limit: 3, window: '15 m', critical: true }).limit(
			email,
		),
	resendVerifyUser: (userId) =>
		getLimiter('resend-verify:user', { limit: 2, window: '10 m', critical: true }).limit(
			userId,
		),
	newsletterIp: (ip) => getLimiter('newsletter:ip', { limit: 5, window: '1 h' }).limit(ip),
	// Voice cloning: expensive ElevenLabs API call — 3 per user per day.
	// Critical (real per-call cost) — fail closed in prod without Redis.
	voiceClone: (userId) =>
		getLimiter('voice:clone', { limit: 3, window: '1 d', critical: true }).limit(userId),
	// Persona extraction (POST /api/persona/extract): a metered completion on the
	// shared LLM chain, 5 per user per day. Critical for the same reason its
	// sibling personaPreviewUser is: a non-critical bucket degrades to a
	// PER-INSTANCE memory counter, so on a Redis outage the daily budget is
	// silently multiplied by the live Cloud Run instance count and a free-signup
	// loop can spend past it. This is the tighter of the two persona budgets, so
	// it fails closed rather than open.
	personaExtract: (userId) =>
		getLimiter('persona:extract', { limit: 5, window: '1 d', critical: true }).limit(userId),
	// Onboarding interview (POST /api/persona/interview) in the create-agent
	// wizard. Same try-first shape as agentSuggest: signed-in callers get room to
	// re-run the interview while they tune their answers, signed-out callers get a
	// tight per-IP budget because the call hits the shared LLM chain with no user
	// attribution behind it. Keyed per IP in both cases (the wizard is one browser
	// per build) with the global daily spend cap in api/_lib/llm.js behind it.
	personaInterview: (ip) => getLimiter('persona:interview', { limit: 30, window: '1 h' }).limit(ip),
	personaInterviewAnon: (ip) =>
		getLimiter('persona:interview:anon', { limit: 8, window: '1 h' }).limit(ip),
	// Persona preview: a metered completion on the shared LLM chain (api/_lib/llm.js),
	// same as extract, not a fixed Claude-only lane. Looser than extract (it's
	// interactive) but still per-user critical so a free-signup loop can't run up an
	// unbounded LLM bill. Anonymous shouldn't reach it (auth required), so per-user.
	personaPreviewUser: (userId) =>
		getLimiter('persona:preview:user', { limit: 30, window: '1 h', critical: true }).limit(userId),
	// Oracle social ingestion: unauthenticated, state-mutating write into the
	// narrative virality/conviction scorer (up to 500 tweets/call). Tight per-IP cap
	// so it can't be driven for narrative manipulation. (Replaces a mis-wired limiter
	// that referenced an undefined bucket and dead-429'd the endpoint.)
	oracleSocialIp: (ip) =>
		getLimiter('oracle:social:ip', { limit: 20, window: '5 m' }).limit(ip),
	// Forever/inscribe: creates a real OrdinalsBot order against the platform's API
	// key. Per-IP so the platform's key/quota can't be scripted. Critical — a Redis
	// outage should fail closed rather than uncap third-party order creation.
	inscribeIp: (ip) =>
		getLimiter('inscribe:ip', { limit: 10, window: '10 m', critical: true }).limit(ip),
	// Forever/status: proxies OrdinalsBot's order lookup, also metered against the
	// platform's key. The pay screen polls every 6s while the user waits on a
	// Bitcoin confirmation, so the ceiling clears a long wait in a couple of tabs
	// (50 polls per tab per 5 min) and still caps an anonymous scripted drain.
	// Not critical: a Redis outage must never freeze a paying user's pay screen.
	inscribeStatusIp: (ip) =>
		getLimiter('inscribe:status:ip', { limit: 200, window: '5 m' }).limit(ip),
	// IBM attest submit: broadcasts a fee-paying on-chain tx from the shared attester
	// wallet. Per-attester-pubkey daily ceiling so concurrent calls can't drain the
	// wallet's SOL via fees. Critical — fail closed in prod without Redis.
	attestSubmitDaily: (pubkey) =>
		getLimiter('attest:submit:daily', { limit: 50, window: '1 d', critical: true }).limit(pubkey),
	agentDelegate: (key) => getLimiter('agent:delegate', { limit: 10, window: '1 m' }).limit(key),
	// GitHub memory seeding: expensive (GitHub API + Claude). 1 seed per agent per 24 hours.
	memorySeed: (agentId) => getLimiter('memory:seed', { limit: 1, window: '1 d' }).limit(agentId),
	// Edge TTS: free upstream but cached in R2 — limit unique synthesis requests per user/min.
	ttsEdge: (userId) => getLimiter('tts:edge', { limit: 20, window: '1 m' }).limit(userId),
	// OpenAI TTS (api/tts/speak) — paid per-character against the server key. Per
	// user, and critical so it fails closed in prod without Redis rather than
	// allowing unbounded paid synthesis. Anonymous callers (keyed by IP) get a
	// much tighter bucket since they share no accountable identity.
	ttsSpeakUser: (userId) =>
		getLimiter('tts:speak:user', { limit: 40, window: '1 h', critical: true }).limit(userId),
	ttsSpeakIp: (ip) =>
		getLimiter('tts:speak:ip', { limit: 10, window: '1 h', critical: true }).limit(ip),
	// An agent's bound voice speaking to a visitor (api/tts/eleven agent_byok lane).
	// The agent owner's own ElevenLabs account pays, so this bucket protects THEIR
	// quota from a scripted visitor: generous enough for a real back-and-forth
	// conversation, tight enough that one IP cannot drain an owner's character
	// budget. Keyed per agent AND per IP so one noisy visitor can't mute an agent
	// for everyone else. Critical — fail closed rather than uncap someone's bill.
	ttsAgentVoiceIp: (agentIdAndIp) =>
		getLimiter('tts:agent-voice:ip', { limit: 60, window: '1 h', critical: true }).limit(
			agentIdAndIp,
		),
	// NVIDIA Riva ASR (api/asr) — free upstream but credit-metered, and each call
	// streams an audio clip the server holds in memory, so meter per principal.
	// Authenticated users get a generous bucket; anonymous callers (keyed by IP) a
	// tighter one. Critical so a missing Redis in prod fails closed rather than
	// leaving an open transcription drain.
	asrUser: (userId) =>
		getLimiter('asr:user', { limit: 60, window: '1 h', critical: true }).limit(userId),
	asrIp: (ip) =>
		getLimiter('asr:ip', { limit: 15, window: '1 h', critical: true }).limit(ip),
	// Productized speech package free tier (api/v1/ai/tts, api/v1/ai/asr). A tight
	// per-IP DAILY quota that gates the free NIM lane before the x402 402
	// fall-through — the free tier is the funnel, x402 is the metered overage.
	// Kept low to protect the credit-metered NIM GPU allocation. Critical so a
	// Redis outage in prod fails closed: an over-quota caller is routed to PAY
	// (the route sends a denied free check to the 402 challenge) rather than the
	// free GPU lane being silently uncapped across serverless instances.
	aiTtsFreeIp: (ip) =>
		getLimiter('ai:tts:free:ip', { limit: 10, window: '1 d', critical: true }).limit(ip),
	aiAsrFreeIp: (ip) =>
		getLimiter('ai:asr:free:ip', { limit: 5, window: '1 d', critical: true }).limit(ip),
	// News-archive SEARCH quota (api/news/archive query mode) — same freemium
	// shape as the AI lanes above: a free daily allowance per IP is the funnel,
	// x402 ($0.001/search) is the metered overage. Each search fans out to GCS
	// month files (2–11 MB each, up to 12 per request), so an uncapped scraper
	// pulling the 660k corpus through the API is a real egress + CPU drain; 60
	// searches/day covers a heavy interactive session on /markets/archive while
	// pricing bulk extraction onto the paid rail. stats/months/trending modes
	// are cheap + cached and stay outside this quota. Critical so a Redis outage
	// fails closed to the 402 challenge rather than uncapping the scan path.
	newsArchiveFreeIp: (ip) =>
		getLimiter('news:archive:free:ip', { limit: 60, window: '1 d', critical: true }).limit(ip),
	// Grounded web search (api/web-search.js). Every call is a Vertex Gemini
	// generateContent with the google_search tool: real GCP-credit spend plus a
	// Google Search round-trip, so it must NOT sit in the generic publicIp
	// bucket where a scraper could turn our credits into a free SERP API. 20/10m
	// covers interactive use (a person refining a query) and prices bulk
	// extraction out. Critical so a Redis outage fails closed rather than
	// uncapping paid inference.
	webSearchIp: (ip) =>
		getLimiter('web-search:ip', { limit: 20, window: '10 m', critical: true }).limit(ip),
	// Premium-pass purchase lane (api/premium/*). Quote builds a Solana tx (an
	// RPC blockhash round-trip + a DB row) and subscribe replays an RPC
	// getParsedTransaction per attempt — both cheap, but neither should be
	// free-form scriptable. Status is a read for the dashboards.
	premiumQuoteIp: (ip) => getLimiter('premium:quote:ip', { limit: 10, window: '10 m' }).limit(ip),
	premiumSubscribeIp: (ip) =>
		getLimiter('premium:subscribe:ip', { limit: 30, window: '10 m' }).limit(ip),
	premiumStatusIp: (ip) =>
		getLimiter('premium:status:ip', { limit: 120, window: '1 m', local: true }).limit(ip),
	// Key management (api/premium/keys). Metered per account, not per IP: it is
	// session-gated, so the principal is the user. A rotate mints a real
	// x402_subscriptions row every call, which is the one premium action an
	// already-authenticated caller can repeat to grow a table without paying
	// anything; nobody legitimately rotates a key more than a handful of times
	// a day.
	premiumKeysUser: (userId) =>
		getLimiter('premium:keys:user', { limit: 20, window: '1 h' }).limit(userId),
	// Fact Checker (api/x402/fact-check) free daily lane. Same "free tier is the
	// funnel, x402 is the metered overage" shape as the AI speech routes above —
	// each free check runs the REAL search+LLM chain (never a degraded fake), so
	// the quota is tight to bound upstream (search + LLM token) cost. Critical so
	// a Redis outage fails closed to the paid rail rather than opening the chain.
	factCheckFreeIp: (ip) =>
		getLimiter('fact-check:free:ip', { limit: 3, window: '1 d', critical: true }).limit(ip),
	// NVIDIA Audio2Face-3D (api/a2f) — free upstream but credit-metered, and each
	// call streams a full speech clip through a bidirectional gRPC stream the
	// server holds in memory while collecting the blendshape track. Meter per
	// principal like the other free NVIDIA lanes; the per-IP bucket is tighter
	// since the optional text→speech→animation path also burns a Magpie synthesis.
	// Critical so a missing Redis in prod fails closed rather than leaving an open
	// animation drain.
	a2fUser: (userId) =>
		getLimiter('a2f:user', { limit: 40, window: '1 h', critical: true }).limit(userId),
	a2fIp: (ip) =>
		getLimiter('a2f:ip', { limit: 10, window: '1 h', critical: true }).limit(ip),
	// NVIDIA NIM vision (api/vision) — free upstream but credit-metered, and each
	// call carries an image the server may relay to the NVCF asset store. Meter
	// per principal like the other free NVIDIA lanes; critical so it fails closed
	// without Redis in prod.
	visionUser: (userId) =>
		getLimiter('vision:user', { limit: 60, window: '1 h', critical: true }).limit(userId),
	visionIp: (ip) =>
		getLimiter('vision:ip', { limit: 15, window: '1 h', critical: true }).limit(ip),
	// /brain multi-LLM proxy. Paid flagship models (Claude/GPT-4o) run on the
	// server keys, so meter per principal: authenticated users get a generous
	// per-user bucket, anonymous callers a tighter per-IP one. Both critical so a
	// missing Redis in prod fails closed instead of opening the paid floodgate.
	brainChatUser: (userId) =>
		getLimiter('brain:chat:user', { limit: 60, window: '1 m', critical: true }).limit(userId),
	brainChatIp: (ip) =>
		getLimiter('brain:chat:ip', { limit: 20, window: '1 m', critical: true }).limit(ip),
	// X (Twitter) memory seeding: 1 seed per agent per 6 hours.
	xSeed: (agentId) => getLimiter('memory:seed:x', { limit: 1, window: '6 h' }).limit(agentId),
	// Give the window back when a seed run stored nothing: X refused the read,
	// the token could not be refreshed, or the run produced no usable fact. The
	// agent's memories are untouched on all of those paths, so charging six hours
	// for them bills the owner for someone else's outage.
	xSeedRefund: (agentId) => refundLimit('memory:seed:x', { limit: 1, window: '6 h' }, agentId),
	// Consent-first GitHub memory seeding: reads the GitHub API and one LLM pass
	// per run. 1 seed per agent per 6 hours, matching the X lane.
	githubSeed: (agentId) =>
		getLimiter('memory:seed:github', { limit: 1, window: '6 h' }).limit(agentId),
	// Give the window back when a seed run wrote nothing because every model
	// provider was busy at once. Without this a platform-side outage costs the
	// owner six hours on a run that never touched their agent's memories.
	githubSeedRefund: (agentId) =>
		refundLimit('memory:seed:github', { limit: 1, window: '6 h' }, agentId),
	// Consent-first Farcaster memory seeding: reads a hub (or Neynar) and runs one
	// LLM pass per seed. 1 seed per agent per 6 hours, matching the X and GitHub
	// lanes. Issuing a signing challenge is deliberately outside this budget so a
	// user can retry the wallet step without burning the window.
	farcasterSeed: (agentId) =>
		getLimiter('memory:seed:farcaster', { limit: 1, window: '6 h' }).limit(agentId),
	// Withdrawal requests: 5 per user per day. This is the daily cap on the only
	// owner-initiated path that sweeps real funds out of custody, so it is critical
	// — a missing Redis in prod must fail closed rather than fall back to the
	// per-instance map (uncapped across serverless fan-out) and silently uncap
	// custodial withdrawals.
	withdrawalPerUser: (userId) =>
		getLimiter('withdrawal:user', { limit: 5, window: '1 d', critical: true }).limit(userId),
	// Pricing a transfer without signing it (`simulate: true` on send / fund-agent).
	// This deliberately does NOT draw on withdrawalPerUser: that budget is 5 per
	// DAY, so charging previews against it meant four price checks locked a user
	// out of their own funds until the next day. A preview moves nothing, but it
	// does spend Solana RPC reads, so it gets its own per-minute ceiling instead
	// of being free.
	walletSimulate: (userId) =>
		getLimiter('wallet:simulate', { limit: 30, window: '1 m' }).limit(userId),
	// Discretionary agent-wallet trades: server-signed buys/sells from the agent's
	// custodial wallet (POST /api/agents/:id/trade). Each one moves real funds and
	// decrypts a custodial key, so it gets its own per-user write budget separate
	// from the strict per-IP `authIp` ceiling — 30/min lets an owner actively trade
	// while still capping a runaway client or a hijacked session. Critical so a
	// Redis outage fails closed rather than uncapping custodial spends.
	tradePerUser: (userId) =>
		getLimiter('agent-trade:user', { limit: 30, window: '1 m', critical: true }).limit(userId),
	// Trading-swarm mutations (POST /api/swarms): contribute/exit move real SOL out
	// of a custodial wallet and kill/pause change a live treasury's mandate. Same
	// class as an agent trade, so it gets the same 30/min per-user write budget in
	// its own bucket (an owner actively trading must not 429 their swarm actions,
	// and vice versa). Critical: a Redis outage fails closed rather than uncapping
	// custodial spends.
	swarmMutate: (userId) =>
		getLimiter('swarm:mutate:user', { limit: 30, window: '1 m', critical: true }).limit(userId),
	// Per-user audit-log reads — the page polls on mount + "load older". 120/min
	// per user is generous for browse but discourages scraping the full year.
	// local: per-user browse/poll of one's own audit log — no side effects, no
	// shared resource. A per-instance 120/min still discourages bulk scraping
	// while spending zero Redis commands on a mount-poll + "load older" surface.
	auditLogRead: (userId) =>
		getLimiter('audit-log:read', { limit: 120, window: '1 m', local: true }).limit(userId),
	// Notifications inbox poll — the nav badge polls every 30s and re-polls on
	// each navigation + tab focus. Keyed by userId with its own generous bucket so
	// it never competes with the strict per-IP `authIp` budget (which a shared
	// office/NAT IP would otherwise exhaust, 429-ing the badge for everyone).
	// local: pure poll-flood guard on a read with no side effects and no shared
	// resource — a per-instance cap suffices, and at one Redis command per poll
	// (every 30s × focus/navigation re-polls × every signed-in user) this is one
	// of the heaviest avoidable burners. Never critical.
	notificationsRead: (userId) =>
		getLimiter('notifications:read', { limit: 120, window: '1 m', local: true }).limit(userId),
	// Web Push subscription register/unregister — one per device install plus the
	// occasional re-subscribe when the browser rotates the endpoint.
	pushSubscribe: (userId) =>
		getLimiter('push:subscribe', { limit: 30, window: '1 h' }).limit(userId),
	// Preference-center writes — debounced client, generous ceiling.
	notifPrefsWrite: (userId) =>
		getLimiter('notif:prefs:write', { limit: 60, window: '1 h' }).limit(userId),
	// Herald delivery rail (/api/herald/*). Announces are machine-written (CI,
	// crons, agents holding an API key) and land as a physical interruption on
	// the owner's screen, so the ceiling is a spam guard on their own attention
	// as much as on our Redis: 60/min is far above any sane integration and far
	// below a runaway loop. NOT local: the whole point is a global cap on how
	// often anything can interrupt one person, and a per-instance counter would
	// multiply that by the instance count.
	heraldAnnounce: (userId) =>
		getLimiter('herald:announce', { limit: 60, window: '1 m' }).limit(userId),
	// The SSE listener. One connection per open tab, re-established every ~5
	// minutes when the stream hits its duration cap, so this only has to stop a
	// reconnect storm. local: a connection budget per instance is the thing that
	// actually protects that instance.
	heraldStream: (userId) =>
		getLimiter('herald:stream', { limit: 60, window: '5 m', local: true }).limit(userId),
	// Companion (/api/companion/*). Reads are a page load plus a poll while the
	// setup page is open, so they get the same generous local bucket the bell
	// inbox uses. Writes touch encrypted credentials and are human-paced.
	companionRead: (userId) =>
		getLimiter('companion:read', { limit: 120, window: '1 m', local: true }).limit(userId),
	companionWrite: (userId) =>
		getLimiter('companion:write', { limit: 60, window: '10 m' }).limit(userId),
	// "Check now" and connection tests each open a real connection to the user's
	// provider (Telegram, an ICS host, an IMAP server), so this is a cost
	// ceiling on somebody else's infrastructure as much as on ours, and it must
	// NOT be local: a per-instance counter multiplies by the instance count.
	companionPoll: (userId) =>
		getLimiter('companion:poll', { limit: 30, window: '10 m' }).limit(userId),

	// Reading a checkout page (POST /api/companion/checkout). One call per
	// payment screen a person actually reaches, which is a handful a day for a
	// heavy shopper, so the ceiling is set to catch a loop in a content script
	// rather than to ration honest use. It is the only companion bucket that
	// gates an LLM call on untrusted third-party page text, which is why it is
	// tighter than companionWrite.
	companionCheckout: (userId) =>
		getLimiter('companion:checkout', { limit: 40, window: '10 m' }).limit(userId),
	// Visitor feedback (POST /api/feedback/report). Deliberately generous: the
	// cost of dropping a real bug report is far higher than the cost of storing a
	// few extra rows, and the reporter may be anonymous and mid-outage. Keyed to
	// the account, else a hashed browser key, else the IP.
	feedbackWrite: (id) =>
		getLimiter('feedback:write', { limit: 20, window: '1 h' }).limit(id),
	// The admin review queue (/api/feedback). One admin refreshing a dashboard.
	feedbackRead: (userId) =>
		getLimiter('feedback:read', { limit: 240, window: '1 m', local: true }).limit(userId),
	// The phone/desktop bridge (POST /api/companion/ingest). Keyed by the bridge
	// token, since the poster is a Shortcut or a shell script with no session.
	// A phone forwarding every notification it receives stays well under this;
	// a loop does not.
	companionIngest: (token) =>
		getLimiter('companion:ingest', { limit: 120, window: '5 m' }).limit(token),
	// Knock (/api/knock/*). The owner's own reads are a page load plus polling
	// while the inbox is open.
	knockRead: (userId) =>
		getLimiter('knock:read', { limit: 120, window: '1 m', local: true }).limit(userId),
	knockWrite: (userId) =>
		getLimiter('knock:write', { limit: 90, window: '10 m' }).limit(userId),
	// Public door + directory reads, keyed by IP. A door page is one read; a
	// crawler walking the directory stays inside this.
	knockPublic: (ip) =>
		getLimiter('knock:public', { limit: 120, window: '5 m' }).limit(ip),
	// Free-door knocks (POST /api/knock/send), keyed by IP. Free means there is
	// no price to make a flood expensive, so the ceiling has to do that job:
	// a person writing to a few people is fine, a script is not. Priced doors
	// go through the x402 lane and are limited by their own cost.
	knockSendIp: (ip) =>
		getLimiter('knock:send:ip', { limit: 8, window: '1 h' }).limit(ip),
	// Funnel tracking (opened/returned) — high local ceiling; one ping per
	// notification interaction, deduped server-side anyway.
	notifTrack: (userId) =>
		getLimiter('notif:track', { limit: 240, window: '1 m', local: true }).limit(userId),
	// Newsletter confirm/unsubscribe link clicks (token in URL, no auth).
	newsletterConfirmIp: (ip) =>
		getLimiter('newsletter:confirm:ip', { limit: 20, window: '1 h' }).limit(ip),
	// $THREE token payment layer (api/token/*).
	// quote: 30 per user per minute — prevents price-polling abuse; each quote
	//   hits a live price feed and signs a HMAC. Generous enough for interactive
	//   flows (spin UI, listing flow) and burst-resistant for agent consumers.
	tokenQuote: (userId) => getLimiter('token:quote', { limit: 30, window: '1 m' }).limit(userId),
	// settle: 10 per user per minute — each settle does an RPC round-trip + DB
	//   write. A real user sends 1 tx; the ceiling absorbs retries + latency.
	tokenSettle: (userId) => getLimiter('token:settle', { limit: 10, window: '1 m' }).limit(userId),
	// price: public endpoint, 120/min per IP — fast cache-served; upstream
	//   Jupiter is rate-limit-free, but the cache makes this essentially free.
	// local: cache-served price reads; upstream Jupiter is rate-limit-free, so
	// this bucket only bounds poll floods. A per-instance cap does that without
	// a Redis command per quote refresh on a high-traffic public endpoint.
	tokenPriceIp: (ip) =>
		getLimiter('token:price:ip', { limit: 120, window: '1 m', local: true }).limit(ip),
	// Livepeer LLM comparison endpoint — calls both Claude and Livepeer per POST.
	// Per-IP only (unauthenticated public demo). Critical so Redis outage in prod
	// fails closed rather than opening the LLM floodgate.
	livepeerIp: (ip) =>
		getLimiter('livepeer:ip', { limit: 20, window: '1 m', critical: true }).limit(ip),
	// Talking-avatar video generation — submits GPU jobs to Cloud Run. Each job
	// costs real compute. Per-user ceiling (authenticated endpoint). Critical.
	videoGenerateUser: (userId) =>
		getLimiter('video:generate:user', { limit: 5, window: '1 h', critical: true }).limit(userId),
	videoGenerateGlobal: () =>
		getLimiter('video:generate:global', { limit: 100, window: '1 h', critical: true }).limit(
			'global',
		),
	// Oracle personal Telegram test-alert (api/oracle/test-alert). Fires a real
	// Telegram message via the bot, so keep per-IP burst tight to prevent spamming
	// third-party chats. 5 per 10 minutes is generous enough for manual setup
	// retries while blocking scripted abuse.
	oracleTelegramTestIp: (ip) =>
		getLimiter('oracle:tg-test:ip', { limit: 5, window: '10 m' }).limit(ip),

	// Coin Clash community battles (api/clash/*). enlist verifies a wallet sig +
	// runs a balance read, so cap per IP. rally is the hot tap loop — per wallet,
	// generous enough for furious tapping but bounded so one tab can't flood; the
	// real influence ceiling is the per-wallet power cap in clash-store.js.
	clashEnlistIp: (ip) => getLimiter('clash:enlist:ip', { limit: 20, window: '5 m' }).limit(ip),
	clashRallyWallet: (wallet) =>
		getLimiter('clash:rally:wallet', { limit: 40, window: '1 m' }).limit(wallet),
	clashStateIp: (ip) =>
		getLimiter('clash:state:ip', { limit: 120, window: '1 m', local: true }).limit(ip),

	// Oracle follower subscribe/update — write path creates a DB row and will
	// eventually fan out Telegram messages, so keep post-rate tight.
	// 10 per hour per IP is enough for manual setup; bots would need more.
	oracleFollowIp: (ip) =>
		getLimiter('oracle:follow:ip', { limit: 10, window: '1 h' }).limit(ip),

	// Aggregator free tier (api/v1/x/[...slug].js). Endpoints in api/v1/_providers.js
	// may carry a `free: { perMin, perDay }` quota — an unauthenticated caller (no
	// BYOK key, no three.ws credentials) gets real, no-signup data before the x402
	// 402 challenge kicks in. Two dynamic buckets, keyed per (provider/endpoint, IP)
	// so each endpoint's own quota sizes its own counter (mirrors the widgetChat /
	// embedLlmAgent per-resource-dynamic-limit pattern above). Non-critical: a Redis
	// outage must never turn a free call into a false 402 — it degrades to the
	// per-instance memory limiter, same posture as the other zero-marginal-cost free
	// lanes (mcp3dGenerateFree, studioGenBurst) in this file.
	apiV1FreeMin: (key, perMin) =>
		getLimiter('v1:free:min', { limit: Math.max(1, Number(perMin) || 30), window: '1 m' }).limit(key),
	apiV1FreeDay: (key, perDay) =>
		getLimiter('v1:free:day', { limit: Math.max(1, Number(perDay) || 1000), window: '1 d' }).limit(key),

	// Gasless ERC-8004 registration relay (api/bnb/register-agent.js). Each call
	// either consumes a real MegaFuel-sponsored gas slot or broadcasts a real
	// self-pay tx — tighter than a generic read bucket, keyed per IP since the
	// whole point is a caller with no wallet history to key on.
	bnbRegisterIp: (ip) => getLimiter('bnb:register:ip', { limit: 10, window: '10 m', critical: true }).limit(ip),
};

// ── Fail-closed limiter call for privacy-boundary reads (H7) ─────────────────
// Most call sites fail OPEN when a limiter throws: the request is bounded by
// something else downstream (a DB cap, an ownership check), so a limiter outage
// should not deny legitimate traffic. A read that returns someone else's LOCATION
// has no such downstream bound, so its degradation path is the opposite: if the
// limiter cannot decide, deny with a retryable `rate_limiter_unavailable` verdict
// rather than open an unmetered scrape window. Shared by the three /irl coordinate
// reads (pins, drops, world-lines nearby) so the guarantee is one implementation
// instead of three drifting copies. See docs/irl/THREAT-MODEL.md.
//
// `name` ties the warning to a bucket; the cooldown keeps an outage that hits every
// request from flooding the logs with the same line.
const _failClosedWarnedAt = new Map();
const FAIL_CLOSED_WARN_COOLDOWN_MS = 60_000;
export async function limitFailClosedRead(name, fn, ...args) {
	try {
		return await fn(...args);
	} catch (err) {
		const last = _failClosedWarnedAt.get(name) || 0;
		const now = Date.now();
		if (now - last >= FAIL_CLOSED_WARN_COOLDOWN_MS) {
			_failClosedWarnedAt.set(name, now);
			console.warn(`[rate-limit] read limiter "${name}" failed, failing CLOSED (deny):`, err?.message || err);
		}
		return { success: false, reason: 'rate_limiter_unavailable', reset: Date.now() + 60_000 };
	}
}

// Trust only proxy headers that Vercel itself sets and signs. Naively reading
// X-Forwarded-For (or X-Real-IP, which clients can also supply directly) lets
// callers bypass per-IP rate limits by rotating the claimed address.
//
// Order of trust:
//   1. x-vercel-forwarded-for — set by the Vercel edge on every proxied
//      request; clients cannot inject it past the platform.
//   2. socket remote address — authoritative on direct connections (local
//      dev / tests, where no Vercel headers exist).
//   3. x-real-ip — last resort only, for non-Vercel reverse-proxy setups where
//      the socket address is the proxy's. Client-settable on direct hits, but
//      by this point there is no better signal.
// How many trailing X-Forwarded-For entries THIS deployment's own infrastructure
// appends. Google's external Application Load Balancer (three.ws prod) hands the
// backend:
//
//     X-Forwarded-For: <caller-supplied…>, <real-client-ip>, <load-balancer-ip>
//
// It appends the connecting client's IP and the forwarding rule's IP. So exactly one
// trailing hop (the LB) must be skipped, and the entry before it is the real client.
// Cloud Run reached directly (no LB in front) appends nothing → set this to 0.
const TRUSTED_PROXY_HOPS = (() => {
	const n = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '', 10);
	return Number.isInteger(n) && n >= 0 ? n : 1;
})();

// The caller's IP, as the key for every per-IP rate limiter on the platform.
//
// Two ways to get this wrong, both of which this function used to:
//
//  1. Trust `req.socket.remoteAddress`. Behind a load balancer the socket peer is
//     ALWAYS the balancer, so every visitor on earth collapses into ONE bucket key.
//     After the Vercel→Cloud Run migration this was the live behaviour (the Vercel
//     header below is never set on GCP), which silently turned every per-IP limit
//     into a platform-wide global limit — a self-DoS, not a control. It is why
//     /api/irl/privacy answered 429 to its very first caller.
//
//  2. Trust the LEFTMOST X-Forwarded-For entry, or any header a caller can set
//     (`x-vercel-forwarded-for`, `x-real-ip`). Everything left of the hops our own
//     infrastructure appends is attacker-controlled: a sweeper sending a random
//     X-Forwarded-For on each request mints a fresh limiter bucket every time.
//
// So: read X-Forwarded-For, walk it from the RIGHT, skip the hops we append, and
// take the next address. Fall back to the socket only when there is no XFF at all
// (local dev, tests, direct container access) — there, the socket IS the client.
export function clientIp(req) {
	const xff = req.headers?.['x-forwarded-for'];
	if (xff) {
		const hops = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
		if (hops.length) {
			// Clamp: a shorter-than-expected chain (direct hit, or a stripped header)
			// must degrade to the leftmost real entry, never to a negative index.
			const ip = hops[Math.max(0, hops.length - 1 - TRUSTED_PROXY_HOPS)];
			if (ip) return ip;
		}
	}
	const sock = req.socket?.remoteAddress;
	if (sock) return sock;
	return '0.0.0.0';
}
