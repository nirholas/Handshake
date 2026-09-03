// @ts-check
// three.ws Home health: telling "one person's house is offline" apart from
// "every house went offline", which look identical from a single connection.
//
// Most failures in this lane are not ours. A user's Home Assistant is powered
// off, their token expired, their broadband dropped. Those are per-tenant
// conditions: they must always be visible to that one user, in their own UI and
// their own action log, and they must NEVER page anyone. An operator woken at
// 3am because a stranger unplugged a router stops reading the channel, and then
// the real outage arrives unread.
//
// So every rate here is computed ACROSS TENANTS. One offline house cannot move
// an aggregate over ten homes; a bad deploy, an egress change or a DNS fault
// moves all of them at once, and that is the only shape that alerts.
//
// The one exception is confirmation integrity. A guarded physical action (an
// unlock, a garage door, a disarm) that executed without a human confirmation is
// a Sev 1 at a volume of one row. It has no error budget and no rate: see
// `confirmationIntegrity` below.
//
// Consumed by:
//   - api/_lib/ops/subsystem-health.js → the `home` subsystem in /api/healthz and /api/status
//   - api/cron/home-health-alert.js    → the three alerts
//
// Shaped after api/_lib/ops/index-lag.js: a `read*` that does the IO, a pure
// `*Verdict` that scores it, and a `gather*` that never throws.

import { randomUUID } from 'node:crypto';

import { cacheGet, cacheSet } from '../cache.js';
import { sql } from '../db.js';
import { stats as runtimeStats } from '../home/runtime.js';

/** The window every rate is measured over. Long enough to average out one slow house, short enough that a deploy shows up inside two cron ticks. */
export const WINDOW_MINUTES = 15;

/** Handshake success across tenants. Under 80% with enough homes reporting is an outage, not a coincidence. */
export const HANDSHAKE_DEGRADED = 0.95;
export const HANDSHAKE_DOWN = 0.8;
/** Share of this instance's pooled homes sitting behind an open breaker. */
export const BREAKER_DEGRADED = 0.02;
export const BREAKER_DOWN = 0.1;
/** Action success across tenants. A refused action is a success: the gate worked. */
export const ACTION_DEGRADED = 0.98;
export const ACTION_DOWN = 0.95;
/** Confirmations that timed out rather than being answered. A high rate means the UI is failing people, not that they said no. */
export const EXPIRY_DEGRADED = 0.2;
export const EXPIRY_DOWN = 0.4;
/** p95 of our own leg of an action, excluding the house's own service latency. */
export const LATENCY_DEGRADED_MS = 1_500;
export const LATENCY_DOWN_MS = 4_000;

/**
 * The minimum number of distinct homes that must be reporting before a rate is
 * allowed to say anything at all.
 *
 * With three homes connected, one person's holiday cottage losing power is a
 * 33% failure rate, and scoring that as an outage is exactly the false page this
 * module exists to prevent. Below the floor the verdict is `ok` with the counts
 * stated, never `down`.
 */
export const MIN_HOMES_FOR_A_VERDICT = 10;

const QUERY_TIMEOUT_MS = 4_000;

/**
 * Consecutive health checks a subscriber count must grow across before it is
 * called a leak. Three, because two is a busy minute and four is a wasted hour.
 */
const LEAK_SAMPLES = 3;
/** The rolling subscriber samples, newest last. Per process, like the pool it measures. */
const leakSamples = [];

/**
 * This process's identity for leak reporting.
 *
 * Cloud Run gives a service no per-instance environment variable, and it runs
 * this one at minScale=6 with sessionAffinity off, so a cron tick lands on an
 * arbitrary instance and can only ever see its own pool. A random id minted at
 * module load IS the instance identity for this purpose: it lives exactly as
 * long as the process whose sockets it is counting.
 */
const INSTANCE_ID = `${process.env.K_REVISION || 'local'}-${randomUUID().slice(0, 8)}`;
/** Where every instance parks its rolling leak samples for the alert cron to read. */
const LEAK_KEY = 'home:leak:instances';
const LEAK_TTL_S = 60 * 60;
/** An instance that has not reported inside this window is gone, not leaking. */
const LEAK_STALE_MS = 15 * 60_000;

/**
 * Record one subscriber sample and say whether the pool is leaking.
 *
 * A leak here is a subscriber that was registered and never released: an SSE
 * stream whose client vanished without the server noticing, repeated until the
 * instance dies holding hundreds of sockets into strangers' houses. It has no
 * error signature at all, which is why it is measured as a SHAPE over time
 * rather than a threshold.
 *
 * The signal is the MARGIN between registered subscribers and open streams. One
 * subscriber per stream is correct at any scale, so a margin that exists and
 * keeps growing across three consecutive checks is the fingerprint, and a
 * hundred honest streams arriving at once is not. When the runtime reports no
 * stream gauge, the pooled connection count stands in: subscribers climbing
 * while connections do not is the same shape, one step less precise.
 *
 * @param {{ subscribers: number, open: number, streams?: number|null }} sample
 * @returns {{ leaking: boolean, samples: number[], margins: number[], growth: number }}
 */
export function noteSubscriberSample({ subscribers, open, streams = null }) {
	const baseline = typeof streams === 'number' ? streams : open;
	leakSamples.push({ subscribers, baseline, margin: subscribers - baseline });
	while (leakSamples.length > LEAK_SAMPLES) leakSamples.shift();

	const samples = leakSamples.map((s) => s.subscribers);
	const margins = leakSamples.map((s) => s.margin);
	if (leakSamples.length < LEAK_SAMPLES) return { leaking: false, samples, margins, growth: 0 };

	let climbing = true;
	for (let i = 1; i < leakSamples.length; i += 1) {
		if (leakSamples[i].margin <= leakSamples[i - 1].margin) climbing = false;
	}
	const growth = margins[margins.length - 1] - margins[0];
	// A negative margin is not a leak in the other direction, it is a stream that
	// has not registered its subscriber yet. Only an unexplained surplus counts.
	return { leaking: climbing && growth > 0 && margins[margins.length - 1] > 0, samples, margins, growth };
}

/** Forget the rolling samples. Test seam, and the reset after an alert fires. */
export function resetSubscriberSamples() {
	leakSamples.length = 0;
}

function withTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_resolve, reject) => setTimeout(() => reject(new Error('home health query timed out')), ms)),
	]);
}

/**
 * Read every cross-tenant signal in one round trip per table.
 *
 * @param {{ windowMinutes?: number }} [options]
 * @returns {Promise<object>}
 */
export async function readHomeSignals({ windowMinutes = WINDOW_MINUTES } = {}) {
	const window = `${Math.max(1, Math.round(windowMinutes))} minutes`;

	const [handshakes, actions, confirmations, integrity] = await Promise.all([
		withTimeout(
			sql`
				select
					count(*)::int as live_homes,
					count(*) filter (
						where last_ok_at is not null and last_ok_at > now() - ${window}::interval
					)::int as recent_ok,
					count(*) filter (
						where last_error_at is not null
						  and last_error_at > now() - ${window}::interval
						  and (last_ok_at is null or last_error_at > last_ok_at)
					)::int as recent_failed,
					count(*) filter (where status = 'auth_failed')::int as auth_failed,
					count(*) filter (where status = 'unreachable')::int as unreachable,
					count(*) filter (where status = 'connected')::int as connected
				from home_connections
				where revoked_at is null
			`,
			QUERY_TIMEOUT_MS,
		),
		withTimeout(
			sql`
				select
					count(*)::int as total,
					count(*) filter (where outcome = 'ok')::int as ok,
					count(*) filter (where outcome = 'refused')::int as refused,
					count(*) filter (where outcome = 'failed')::int as failed,
					count(distinct home_id)::int as homes,
					percentile_disc(0.95) within group (
						order by (detail->>'latencyMs')::numeric
					) as p95_latency_ms,
					count(*) filter (where detail ? 'latencyMs')::int as timed
				from home_action_log
				where created_at > now() - ${window}::interval
			`,
			QUERY_TIMEOUT_MS,
		),
		withTimeout(
			sql`
				select
					count(*)::int as total,
					count(*) filter (where redeemed_at is not null)::int as redeemed,
					count(*) filter (where expired_at is not null or (redeemed_at is null and expires_at < now()))::int as expired
				from home_confirmations
				where created_at > now() - ${window}::interval
			`,
			QUERY_TIMEOUT_MS,
		),
		// The zero-budget invariant, over a deliberately wider window than the
		// rates: a single row is an incident and must not be able to age out of
		// the check between two cron ticks.
		withTimeout(
			sql`
				select count(*)::int as violations, max(created_at) as last_at
				from home_action_log
				where guarded = true and confirmed_by is null and outcome = 'ok'
				  and created_at > now() - interval '24 hours'
			`,
			QUERY_TIMEOUT_MS,
		),
	]);

	const h = handshakes[0] || {};
	const a = actions[0] || {};
	const c = confirmations[0] || {};
	const v = integrity[0] || {};

	const pool = safeStats();
	const leak = noteSubscriberSample({ subscribers: pool.subscribers, open: pool.open, streams: pool.streams });

	const attempts = (h.recent_ok ?? 0) + (h.recent_failed ?? 0);
	const confirmationsDecided = (c.redeemed ?? 0) + (c.expired ?? 0);

	return {
		windowMinutes,
		homes: {
			live: h.live_homes ?? 0,
			connected: h.connected ?? 0,
			unreachable: h.unreachable ?? 0,
			authFailed: h.auth_failed ?? 0,
		},
		handshakes: {
			attempts,
			ok: h.recent_ok ?? 0,
			failed: h.recent_failed ?? 0,
			rate: attempts > 0 ? (h.recent_ok ?? 0) / attempts : null,
		},
		actions: {
			total: a.total ?? 0,
			ok: a.ok ?? 0,
			refused: a.refused ?? 0,
			failed: a.failed ?? 0,
			homes: a.homes ?? 0,
			// A refused action is the safety gate doing its job, so it counts as a
			// success. Only `failed` is us not delivering.
			rate: (a.total ?? 0) > 0 ? ((a.ok ?? 0) + (a.refused ?? 0)) / a.total : null,
			timed: a.timed ?? 0,
			p95LatencyMs: a.p95_latency_ms === null || a.p95_latency_ms === undefined ? null : Math.round(Number(a.p95_latency_ms)),
		},
		confirmations: {
			total: c.total ?? 0,
			redeemed: c.redeemed ?? 0,
			expired: c.expired ?? 0,
			expiryRate: confirmationsDecided > 0 ? (c.expired ?? 0) / confirmationsDecided : null,
		},
		integrity: {
			violations: v.violations ?? 0,
			lastAt: v.last_at ? new Date(v.last_at).toISOString() : null,
		},
		pool,
		leak,
	};
}

/**
 * This instance's pool gauges. Never throws: an unreadable runtime reports
 * zeroes rather than taking the health endpoint down with it.
 */
function safeStats() {
	try {
		const s = runtimeStats();
		return {
			open: s.open ?? 0,
			subscribers: s.subscribers ?? 0,
			// The runtime has spelled its cap both ways while this lane was being
			// built. Read either rather than reporting a confident zero.
			capacity: s.capacity ?? s.pooledCap ?? 0,
			breakersOpen: s.breakersOpen ?? 0,
			byStatus: s.byStatus ?? {},
			// The admission controller's own gauges, when it is present: the open
			// SSE stream count is the denominator the leak detector wants.
			streams: s.admission?.streams ?? null,
			rung: s.admission?.rung ?? null,
		};
	} catch {
		return { open: 0, subscribers: 0, capacity: 0, breakersOpen: 0, byStatus: {}, streams: null, rung: null };
	}
}

/**
 * Score the signals. Pure: takes exactly what `readHomeSignals` returns, does no
 * IO, so every threshold in this file can be exercised directly.
 *
 * @param {Awaited<ReturnType<typeof readHomeSignals>>} s
 * @returns {{ status: string, detail: string, hint?: string }}
 */
export function homeHealthVerdict(s) {
	// The invariant outranks everything, including a completely healthy platform.
	if (s.integrity.violations > 0) {
		return {
			status: 'down',
			detail: `${s.integrity.violations} guarded physical action${s.integrity.violations === 1 ? '' : 's'} executed with no confirmation on record (most recent ${s.integrity.lastAt}). Confirmation integrity has no error budget.`,
			hint: 'Sev 1. Read docs/home-operations.md, section "Confirmation integrity violation". Identify the rows, the homes and the actor before anything else, and treat every affected house as needing its owner told.',
		};
	}

	if (s.homes.live === 0) {
		return {
			status: 'unknown',
			detail: 'no homes connected yet, so no cross-tenant rate can be computed',
		};
	}

	// Below the floor, one unplugged router is a double-digit failure rate. State
	// the counts, score nothing.
	const enoughHomes = s.homes.live >= MIN_HOMES_FOR_A_VERDICT;

	const handshakeStatus = !enoughHomes || s.handshakes.rate === null
		? 'ok'
		: rateStatus(s.handshakes.rate, HANDSHAKE_DEGRADED, HANDSHAKE_DOWN);
	const actionStatus = s.actions.rate === null
		? 'ok'
		: rateStatus(s.actions.rate, ACTION_DEGRADED, ACTION_DOWN);
	const expiryStatus = s.confirmations.expiryRate === null
		? 'ok'
		: ceilingStatus(s.confirmations.expiryRate, EXPIRY_DEGRADED, EXPIRY_DOWN);
	const breakerRate = s.pool.open > 0 ? s.pool.breakersOpen / s.pool.open : 0;
	const breakerStatus = ceilingStatus(breakerRate, BREAKER_DEGRADED, BREAKER_DOWN);
	const latencyStatus = s.actions.p95LatencyMs === null
		? 'ok'
		: ceilingStatus(s.actions.p95LatencyMs, LATENCY_DEGRADED_MS, LATENCY_DOWN_MS);
	// A leak kills the instance quietly and slowly, so it degrades rather than
	// downs: the platform is still serving every request while it happens.
	const leakStatus = s.leak.leaking ? 'degraded' : 'ok';

	const status = [handshakeStatus, actionStatus, expiryStatus, breakerStatus, latencyStatus, leakStatus].reduce(worst, 'ok');

	const parts = [
		`${s.homes.connected}/${s.homes.live} homes connected`,
		s.handshakes.attempts > 0
			? `handshakes ${pct(s.handshakes.rate)} over ${s.handshakes.attempts} homes in ${s.windowMinutes}m` + (enoughHomes ? '' : ` (under the ${MIN_HOMES_FOR_A_VERDICT}-home floor, reported not scored)`)
			: `no handshakes in ${s.windowMinutes}m`,
		s.actions.total > 0
			? `actions ${pct(s.actions.rate)} of ${s.actions.total} across ${s.actions.homes} homes` + (s.actions.failed ? `, ${s.actions.failed} failed` : '')
			: 'no actions in window',
		s.actions.p95LatencyMs === null
			? 'no action timings recorded'
			: `p95 our-leg latency ${s.actions.p95LatencyMs}ms over ${s.actions.timed} timed actions`,
		s.confirmations.total > 0
			? `confirmations ${pct(s.confirmations.expiryRate ?? 0)} expired of ${s.confirmations.total}`
			: 'no confirmations in window',
		`pool ${s.pool.open} open, ${s.pool.subscribers} subscribers` + (s.pool.streams === null ? '' : ` across ${s.pool.streams} streams`) + `, ${s.pool.breakersOpen} breakers open` + (s.pool.rung && s.pool.rung !== 'normal' ? `, admission ${s.pool.rung}` : ''),
	];

	const hint = status === 'ok'
		? undefined
		: s.leak.leaking
			? `The subscriber surplus over open streams grew across ${s.leak.margins.join(' then ')}. A stream is registering a subscriber and never releasing it. See docs/home-operations.md, "Subscriber leak".`
			: handshakeStatus !== 'ok'
				? 'Handshakes are failing across tenants, which is almost always us: a deploy, an egress change or a DNS fault. Run the correlation query in docs/home-operations.md before touching anything.'
				: actionStatus !== 'ok'
					? 'Actions are failing across homes. Group home_action_log by outcome and detail->>\'code\' to see whether this is one error or many.'
					: expiryStatus !== 'ok'
						? 'Confirmations are timing out rather than being answered. That is a UI failure, not user hesitation: check that the confirm prompt is reaching the surface the user is actually on.'
						: latencyStatus !== 'ok'
							? 'Our own leg of the act path is slow. The house is excluded from this measurement, so look at the pool: cold opens, breaker retries, or a store read on the hot path.'
							: 'Breakers are open on a large share of this instance\'s pooled homes. Correlated, that means we cannot reach houses we could reach an hour ago.';

	return { status, detail: parts.join('; ') + '.', ...(hint ? { hint } : {}) };
}

/**
 * Park this instance's leak state where the alert cron can read it.
 *
 * Fire and forget, and deliberately tolerant of a lost update: several instances
 * read-modify-write the same map, so a concurrent write occasionally drops one
 * sample. That delays a slow leak's detection by one tick and never invents one,
 * which is the correct trade for a gauge nobody is billed on.
 *
 * @param {{ leaking: boolean, samples: number[], margins: number[] }} leak
 */
export async function publishLeakSample(leak) {
	try {
		const map = (await cacheGet(LEAK_KEY)) || {};
		const now = Date.now();
		const next = {};
		for (const [id, entry] of Object.entries(map)) {
			if (entry && now - Number(entry.at || 0) < LEAK_STALE_MS) next[id] = entry;
		}
		next[INSTANCE_ID] = { at: now, leaking: leak.leaking, samples: leak.samples, margins: leak.margins };
		await cacheSet(LEAK_KEY, next, LEAK_TTL_S);
	} catch {
		// A gauge that cannot be parked must not take the health block down.
	}
}

/**
 * Every instance's current leak state, stale entries dropped.
 * @returns {Promise<Array<{ instanceId: string, leaking: boolean, samples: number[], margins: number[], at: number }>>}
 */
export async function readLeakInstances() {
	try {
		const map = (await cacheGet(LEAK_KEY)) || {};
		const now = Date.now();
		return Object.entries(map)
			.filter(([, entry]) => entry && now - Number(entry.at || 0) < LEAK_STALE_MS)
			.map(([instanceId, entry]) => ({
				instanceId,
				leaking: Boolean(entry.leaking),
				samples: Array.isArray(entry.samples) ? entry.samples : [],
				margins: Array.isArray(entry.margins) ? entry.margins : [],
				at: Number(entry.at || 0),
			}));
	} catch {
		return [];
	}
}

/**
 * The `home` subsystem block for /api/healthz and /api/status. Never throws.
 * @returns {Promise<{ name: string, label: string, status: string, detail: string, hint?: string, metrics?: object }>}
 */
export async function gatherHomeHealth() {
	const base = { name: 'home', label: 'Home Assistant bridge' };
	let signals;
	try {
		signals = await readHomeSignals();
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'home signals unreadable' };
	}
	// Every instance answers its own /api/healthz, so gathering here is the one
	// place that reliably samples all of them. Not awaited: the health block must
	// not wait on a cache write.
	publishLeakSample(signals.leak);
	return { ...base, ...homeHealthVerdict(signals), metrics: signals };
}

function rateStatus(rate, degradedBelow, downBelow) {
	if (rate === null || rate === undefined) return 'unknown';
	if (rate < downBelow) return 'down';
	if (rate < degradedBelow) return 'degraded';
	return 'ok';
}

function ceilingStatus(value, degradedAt, downAt) {
	if (value === null || value === undefined) return 'unknown';
	if (value > downAt) return 'down';
	if (value >= degradedAt) return 'degraded';
	return 'ok';
}

const RANK = { down: 3, degraded: 2, unknown: 1, ok: 0 };
function worst(a, b) {
	return RANK[a] >= RANK[b] ? a : b;
}

function pct(rate) {
	return rate === null || rate === undefined ? 'unknown' : `${(rate * 100).toFixed(1)}%`;
}
