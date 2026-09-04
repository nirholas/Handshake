// Scaling-control primitives for the /forge generation pipeline. Three protections
// that keep an influx of concurrent generations from:
//   (a) exhausting serverless workers on the BLOCKING free lane,
//   (b) slamming a single provider's account quota in a burst, and
//   (c) paying GPU cost N times over for one identical, already-in-flight request.
//
// All are best-effort and FAIL OPEN: when Upstash Redis is absent (local/dev) or a
// command errors, every primitive degrades to "allow / no-op" so generation keeps
// working. They are protective throttles, not correctness gates — losing them costs
// efficiency under load, never a wrong result. (Contrast the cost/money limiters in
// rate-limit.js, which deliberately fail CLOSED.)
//
// One shared Redis client (redis.js) — never construct another here; per-module
// clients are what caused the June 2026 quota blowout.

import { createHash, randomUUID } from 'node:crypto';
import { getRedis } from './redis.js';

const redis = getRedis();

// ── In-flight request coalescing ─────────────────────────────────────────────
// A viral prompt, a double-click, or a retry storm can submit the identical
// (path, tier, backend, prompt, images) request many times within the same minute.
// Each would otherwise run the full FLUX→reconstruct GPU pipeline independently.
// Instead we map a request fingerprint → the first job handle for a short window;
// duplicate submits within the window return that handle and poll the same job.
// One generation, N viewers. High tier is never coalesced (it is paid/gated per
// caller — see the call site), so this only ever shares free/standard work.

const INFLIGHT_PREFIX = 'fc:inflight:';
const INFLIGHT_TTL_S = 360; // ~ the longest a generation stays pollable end-to-end

// Stable fingerprint of what makes two generations interchangeable. Prompt is
// normalized (trim + lowercase) and image lists are order-independent so the same
// multi-view set in any order collapses to one key. Truncated to 32 hex chars —
// 128 bits of collision resistance is ample for a 6-minute dedup window.
//
// The output-affecting options belong in the fingerprint for the same reason they
// belong in the result-cache key (forge-cache.js forgeResultCacheKey, which lists
// exactly these four): two requests are interchangeable only when every input that
// changes the mesh matches. Leaving them out made `seed` unusable, which is the
// whole point of a seed. Two submits of one prompt with different seeds are two
// DIFFERENT models by definition, and the second was being handed the first's job
// for the rest of the 360s window (the record is not cleared on success), so it
// came back byte-identical. That also silently defeated Refine, which replays a
// job's seed one tier up. A null option keeps the key identical to a request that
// never sent options, so existing callers coalesce exactly as before.
export function forgeRequestHash({ path, tier, backend, prompt, images, options }) {
	const tierId = typeof tier === 'string' ? tier : tier?.id || '';
	const imgs = Array.isArray(images) ? images.filter(Boolean).slice().sort() : [];
	const opt = options || {};
	const basis = JSON.stringify([
		path || '',
		tierId,
		backend || '',
		String(prompt || '').trim().toLowerCase(),
		imgs,
		opt.seed ?? null,
		opt.outputFormat || 'glb',
		opt.textureSize ?? null,
		opt.targetPolycount ?? null,
	]);
	return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

// Existing in-flight job handle for this fingerprint, or null. The caller hands the
// returned handle straight back to the client (which polls it), skipping all GPU.
export async function coalesceInFlight(hash) {
	if (!redis || !hash) return null;
	try {
		const v = await redis.get(`${INFLIGHT_PREFIX}${hash}`);
		return typeof v === 'string' && v ? v : null;
	} catch {
		return null;
	}
}

// Record the job handle that now serves this fingerprint. NX so only the FIRST
// writer wins — a later, slower submitter of the same request can't clobber the
// live handle that other clients are already polling. TTL-bounded.
export async function registerInFlight(hash, jobHandle) {
	if (!redis || !hash || !jobHandle) return;
	try {
		await redis.set(`${INFLIGHT_PREFIX}${hash}`, String(jobHandle), {
			nx: true,
			ex: INFLIGHT_TTL_S,
		});
	} catch {
		/* best-effort */
	}
}

// Drop the mapping when a generation fails to start, so the next identical request
// isn't pinned to a dead job for the rest of the TTL window.
export async function clearInFlight(hash) {
	if (!redis || !hash) return;
	try {
		await redis.del(`${INFLIGHT_PREFIX}${hash}`);
	} catch {
		/* best-effort */
	}
}

// ── Self-host lane occupancy ─────────────────────────────────────────────────
// How many generations WE have in flight on each of our own GPU lanes right now.
//
// This exists because liveness is not capacity. Our GPU workers accept a job
// with a 202 and run it on a background task, so an overloaded worker still
// answers /health instantly and still reads `ok` to the health-aware router,
// which then hands it the next job, and the next. Cloud Run cannot see the
// backlog either: request concurrency never rises above the poll traffic, so the
// autoscaler leaves the service at one instance no matter how deep the queue is.
// A 10-job load test on 2026-09-04 landed all ten on the single warm TRELLIS
// instance and 7 were still queued 12 minutes later, while the Hunyuan3D worker
// (a different accelerator, its own quota, min-scale 1, completely idle) and both
// free external lanes sat unused.
//
// The count is of OUR OWN submissions, not a guess at the worker's internals: one
// sorted-set member per live job keyed by its handle, scored with an expiry, so
// an instance that dies without ever seeing the job finish cannot pin the lane
// (the same self-healing eviction acquireBlockingSlot uses below). Best-effort
// throughout: without Redis every lane reports 0 occupancy and routing behaves
// exactly as it did before this existed.

const LANE_BUSY_PREFIX = 'fc:lane:';
// A generation that has not reached a terminal poll by now is not still running:
// it is a client that closed the tab, or a job whose successor took over. Matches
// INFLIGHT_TTL_S, the same "longest a generation stays pollable" horizon.
const LANE_BUSY_TTL_S = INFLIGHT_TTL_S;

// Record that `jobHandle` now occupies `backendId`. Called at submit.
export async function markLaneJobStarted(backendId, jobHandle) {
	if (!redis || !backendId || !jobHandle) return;
	const key = `${LANE_BUSY_PREFIX}${backendId}`;
	try {
		await redis.zadd(key, { score: Date.now() + LANE_BUSY_TTL_S * 1000, member: String(jobHandle) });
		await redis.expire(key, LANE_BUSY_TTL_S + 10);
	} catch {
		/* best-effort: a missed mark just means the lane looks emptier */
	}
}

// Release a lane slot. Called when a poll reaches a terminal status, and when a
// submit throws before the job ever ran.
export async function markLaneJobFinished(backendId, jobHandle) {
	if (!redis || !backendId || !jobHandle) return;
	try {
		await redis.zrem(`${LANE_BUSY_PREFIX}${backendId}`, String(jobHandle));
	} catch {
		/* the score-based eviction reclaims it */
	}
}

// Live occupancy for a set of lane ids, as { [id]: count }. Expired members are
// evicted first so a stale entry can never make a lane look permanently full.
// Returns an empty object (every lane unconstrained) without Redis or on error.
export async function laneOccupancy(backendIds = []) {
	const ids = [...new Set(backendIds)].filter(Boolean);
	if (!redis || !ids.length) return {};
	const now = Date.now();
	try {
		const counts = await Promise.all(
			ids.map(async (id) => {
				const key = `${LANE_BUSY_PREFIX}${id}`;
				await redis.zremrangebyscore(key, 0, now);
				return [id, Number(await redis.zcard(key)) || 0];
			}),
		);
		return Object.fromEntries(counts);
	} catch {
		return {};
	}
}

// ── Bounded-concurrency lease (for the blocking free lane) ────────────────────
// The HuggingFace Spaces lane BLOCKS a serverless worker for up to ~280s per call
// (see huggingface.js HF_INFERENCE_TIMEOUT_MS). Past a few dozen concurrent holds,
// Vercel workers exhaust and the whole /forge function stalls for everyone. This is
// a counted lease implemented as a sorted set of {token → expiry}: expired tokens
// are evicted on every acquire, so a worker killed at the 300s wall (its release()
// never running) can never permanently pin a slot — the lease self-heals. A tiny
// over-admission under a race is acceptable; this is backpressure, not a mutex.

const SLOT_PREFIX = 'fc:slot:';

export async function acquireBlockingSlot(name, { max, ttlMs }) {
	const noop = { ok: true, release: async () => {} };
	if (!redis) return noop; // dev / no-redis: single instance, no fan-out to protect
	const key = `${SLOT_PREFIX}${name}`;
	const token = `${Date.now()}-${randomUUID()}`;
	const now = Date.now();
	try {
		// Evict expired leases, then count live holders.
		await redis.zremrangebyscore(key, 0, now);
		const live = await redis.zcard(key);
		if (live >= max) return { ok: false, release: async () => {} };
		await redis.zadd(key, { score: now + ttlMs, member: token });
		// Safety expiry on the whole set so an idle gate doesn't linger forever.
		await redis.expire(key, Math.ceil(ttlMs / 1000) + 10);
		let released = false;
		return {
			ok: true,
			release: async () => {
				if (released) return;
				released = true;
				try {
					await redis.zrem(key, token);
				} catch {
					/* the TTL will reclaim it */
				}
			},
		};
	} catch {
		// Redis hiccup → fail open. Under an outage we'd rather serve the lane than
		// block every free generation behind a blind gate.
		return noop;
	}
}

// ── Per-provider submit throttle ──────────────────────────────────────────────
// Caps how many generations we hand a single provider account per window, so a
// burst can't blow through (e.g.) the platform Replicate quota and turn into
// account-wide 429s across every user at once. Fixed-window counter — cheap (one
// INCR + occasional EXPIRE), which keeps the Upstash command budget intact. When
// the cap is hit the caller treats it as upstream-unavailable and degrades to the
// free lane, so over-cap traffic is shed gracefully rather than hard-failed.

const SUBMIT_PREFIX = 'fc:psub:';

export async function providerSubmitAllowed(provider, { limit, windowS }) {
	if (!redis) return true;
	const bucket = Math.floor(Date.now() / (windowS * 1000));
	const key = `${SUBMIT_PREFIX}${provider}:${bucket}`;
	try {
		const n = await redis.incr(key);
		if (n === 1) await redis.expire(key, windowS + 1);
		return n <= limit;
	} catch {
		return true;
	}
}

// ── Per-provider rate slot (queue, not shed) ──────────────────────────────────
// A leaky-bucket / GCRA gate that PACES submissions to a hard upstream rate
// instead of shedding over-cap traffic. Where providerSubmitAllowed() drops a
// burst to a free lane, this reserves the next free slot and tells the caller how
// long to wait for it — so a lane with no free fallback (the paid Replicate
// text→image backstop) queues gracefully behind the rate rather than firing
// straight into a throttle 429. Replicate holds a reduced-rate account to "6
// requests per minute with a burst of 1"; under an influx every text→3D request
// that falls past the free NIM/Vertex lanes lands here, and without pacing they
// stampede that limit (106× "Request was throttled" in one window). The gate is
// account-wide per provider key, so concurrent serverless instances all reserve
// from the same bucket.
//
// GCRA: one emission every `interval` ms; a `burst`-deep allowance (τ) lets an
// idle bucket admit up to `burst` immediately. The reservation (advancing the
// theoretical-arrival-time) and the wait computation run as one Lua script so
// concurrent reservers can't both claim the same slot. A reservation is only
// taken when the wait fits the caller's budget — an over-budget request leaves
// the bucket untouched and is told to retry, so a rejected caller never steals a
// slot from one that will actually wait for it. Fail-OPEN without Redis (dev /
// outage): no bucket to coordinate, so every caller proceeds immediately.

const RATE_PREFIX = 'fc:rate:';

// KEYS[1] = bucket; ARGV = now, interval(ms), tau(ms), maxWait(ms). Returns
// {allowed(0|1), waitMs}. Virtual-scheduling GCRA: `tat` is the theoretical
// arrival time of the next conforming request. This request is served at the
// later of `now` and `tat - tau` — the τ slack ( (burst-1)·interval ) is what
// lets an idle bucket admit a burst back-to-back. The reservation advances tat to
// max(now, tat) + interval, and is only taken when the wait fits the budget; the
// key's TTL tracks the live reservation horizon so an idle bucket self-clears.
const RATE_RESERVE_LUA = `local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local tau = tonumber(ARGV[3])
local maxWait = tonumber(ARGV[4])
local tat = tonumber(redis.call('GET', KEYS[1]))
if not tat then tat = now end
local serveAt = tat - tau
if serveAt < now then serveAt = now end
local waitMs = serveAt - now
if waitMs > maxWait then
  return {0, math.floor(waitMs)}
end
local newTat = tat
if now > newTat then newTat = now end
newTat = newTat + interval
redis.call('SET', KEYS[1], tostring(newTat), 'PX', math.floor(newTat - now + 5000))
return {1, math.floor(waitMs)}`;

// Reserve the next submission slot for `provider`, pacing to `ratePerMin`
// (`burst`-deep). Returns { ok, waitMs }: when ok, the caller sleeps `waitMs`
// (0..maxWaitMs) then submits — the slot is reserved. When !ok the queue is
// deeper than maxWaitMs; no slot is taken and `waitMs` is the time until one
// would open, so the caller can surface a retry hint. Fail-open (ok, 0) on a
// missing or erroring Redis — pacing is a protective throttle, never a gate.
export async function reserveProviderRateSlot(
	provider,
	{ ratePerMin, burst = 1, maxWaitMs, now = Date.now() },
) {
	if (!redis) return { ok: true, waitMs: 0 };
	const interval = Math.max(1, Math.floor(60_000 / Math.max(1, ratePerMin)));
	const tau = Math.max(0, (Math.max(1, burst) - 1) * interval);
	try {
		const r = await redis.eval(
			RATE_RESERVE_LUA,
			[`${RATE_PREFIX}${provider}`],
			[String(now), String(interval), String(tau), String(Math.max(0, Math.floor(maxWaitMs)))],
		);
		const ok = Array.isArray(r) && Number(r[0]) === 1;
		const waitMs = Array.isArray(r) ? Math.max(0, Number(r[1]) || 0) : 0;
		return { ok, waitMs };
	} catch {
		return { ok: true, waitMs: 0 };
	}
}

// Tunables, overridable per-deployment via env. Defaults are conservative ceilings
// chosen to protect the worker pool / provider quota without throttling normal use.
function intEnv(name, fallback) {
	const v = typeof process !== 'undefined' ? process.env?.[name] : null;
	const n = v == null || v === '' ? NaN : Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const SCALE_LIMITS = Object.freeze({
	// Max concurrent blocking HuggingFace Spaces holds across the whole fleet.
	hfConcurrent: intEnv('FORGE_HF_MAX_CONCURRENT', 12),
	// Lease TTL ≥ the function maxDuration so a killed worker's slot always reclaims.
	hfSlotTtlMs: 305_000,
	// Platform Replicate submits per 10s window before we shed to the free lane.
	replicateSubmitLimit: intEnv('FORGE_REPLICATE_SUBMIT_LIMIT', 40),
	replicateSubmitWindowS: 10,
	// Account-wide rate the platform Replicate token is paced to by the text→image
	// backstop queue. Mirrors the reduced-rate state Replicate imposes when account
	// credit is low: 6 predictions/min, burst of 1 (no fallback lane to shed to, so
	// we queue instead — see reserveProviderRateSlot). A request whose slot is more
	// than replicateQueueMaxMs out is told to retry rather than blocking a worker.
	replicateRatePerMin: intEnv('FORGE_REPLICATE_RATE_PER_MIN', 6),
	replicateRateBurst: intEnv('FORGE_REPLICATE_RATE_BURST', 1),
	replicateQueueMaxMs: intEnv('FORGE_REPLICATE_QUEUE_MAX_MS', 15_000),
	// Max PLATFORM-keyed paid generations one identity (browser client) may run per
	// UTC day — the layer per-IP and the global hourly cap don't cover.
	paidDailyPerClient: intEnv('FORGE_PAID_DAILY_CAP', 60),
});

// ── Per-identity daily paid cap ───────────────────────────────────────────────
// Bounds how many PLATFORM-keyed paid generations a single identity can run per UTC
// day, on top of the per-IP hourly limiter and the platform-wide hourly ceiling.
// Closes the rotating-IP / multi-session abuse path: one actor can stay under every
// per-request cap yet drain paid spend across a day. Keyed by the forge client id
// (the identity the rest of forge already scopes by). Counts attempts — a protective
// daily ceiling is allowed to be slightly conservative. Fail-open without Redis.

const DAILY_PREFIX = 'fc:daily:';

export async function dailyPaidAllowed(identity, { limit }) {
	if (!redis || !identity) return { ok: true, used: 0, limit };
	const day = Math.floor(Date.now() / 86_400_000); // UTC day index
	const key = `${DAILY_PREFIX}${identity}:${day}`;
	try {
		const used = await redis.incr(key);
		if (used === 1) await redis.expire(key, 86_400 + 3600);
		return { ok: used <= limit, used, limit };
	} catch {
		return { ok: true, used: 0, limit };
	}
}

// ── Shared circuit breaker ────────────────────────────────────────────────────
// A consecutive-failure breaker whose state lives in Redis so EVERY serverless
// instance sees the same open/closed decision. Without it each instance
// rediscovers a provider outage independently — e.g. the seed cron burns N× the
// retry latency before N instances each open their own in-memory breaker. Falls
// back to a per-instance object when Redis is absent (the behavior callers had
// before this was shared). Counters self-expire so a long-idle breaker clears.

const CIRCUIT_PREFIX = 'fc:circuit:';
const CIRCUIT_TTL_S = 24 * 3600;
const _circuitMem = new Map(); // name -> { failures, openUntil }

function memCircuit(name) {
	let c = _circuitMem.get(name);
	if (!c) {
		c = { failures: 0, openUntil: 0 };
		_circuitMem.set(name, c);
	}
	return c;
}

// Current breaker state: { open, failures, openUntil }.
export async function circuitState(name) {
	if (!redis) {
		const c = memCircuit(name);
		return { open: c.openUntil > Date.now(), failures: c.failures, openUntil: c.openUntil };
	}
	try {
		const [failures, openUntil] = await Promise.all([
			redis.get(`${CIRCUIT_PREFIX}${name}:failures`),
			redis.get(`${CIRCUIT_PREFIX}${name}:openUntil`),
		]);
		const o = Number(openUntil) || 0;
		return { open: o > Date.now(), failures: Number(failures) || 0, openUntil: o };
	} catch {
		// Blind breaker → fail open (treat as closed) so an outage of the limiter
		// store doesn't itself silence the cron.
		return { open: false, failures: 0, openUntil: 0 };
	}
}

// Record one failure; opens the breaker for (failures × baseMs) once threshold is
// reached, clamped to maxMs. Returns the new consecutive-failure count.
//
// The clamp is load-bearing. `failures` only resets on a success, and the counter
// key is refreshed on every recorded failure, so a provider outage that outlives
// one retry cycle keeps extending the window: 12 consecutive failures already park
// a per-minute cron for two hours, and it grows from there with no natural
// ceiling. That turns a transient upstream blip into a seeder that has gone quiet
// for most of a day, which reads from the outside as a dead cron rather than a
// backed-off one. Capping the window keeps the retry cadence bounded, so the cron
// re-probes the provider at least once per CIRCUIT_MAX_OPEN_MS and resumes on its
// own the moment the outage clears.
const CIRCUIT_MAX_OPEN_MS = 60 * 60_000;

const openWindowMs = (failures, baseMs, maxMs) => Math.min(failures * baseMs, maxMs);

export async function circuitRecordFailure(name, { threshold, baseMs, maxMs = CIRCUIT_MAX_OPEN_MS }) {
	if (!redis) {
		const c = memCircuit(name);
		c.failures++;
		if (c.failures >= threshold) c.openUntil = Date.now() + openWindowMs(c.failures, baseMs, maxMs);
		return c.failures;
	}
	try {
		const failures = await redis.incr(`${CIRCUIT_PREFIX}${name}:failures`);
		await redis.expire(`${CIRCUIT_PREFIX}${name}:failures`, CIRCUIT_TTL_S);
		if (failures >= threshold) {
			await redis.set(
				`${CIRCUIT_PREFIX}${name}:openUntil`,
				String(Date.now() + openWindowMs(failures, baseMs, maxMs)),
				{ ex: CIRCUIT_TTL_S },
			);
		}
		return failures;
	} catch {
		return 0;
	}
}

// Clear the breaker on a success.
export async function circuitRecordSuccess(name) {
	if (!redis) {
		const c = memCircuit(name);
		c.failures = 0;
		c.openUntil = 0;
		return;
	}
	try {
		await redis.del(`${CIRCUIT_PREFIX}${name}:failures`, `${CIRCUIT_PREFIX}${name}:openUntil`);
	} catch {
		/* best-effort */
	}
}
