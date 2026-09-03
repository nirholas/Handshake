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

/**
 * The minimum number of actions in the window before their success rate is
 * scored. Below it, two failures in a quiet hour read as a 90% success rate and
 * would take the subsystem down over nothing.
 */
export const MIN_ACTIONS_FOR_A_VERDICT = 20;

/**
 * The minimum number of decided confirmations before their expiry rate is
 * scored. Three prompts in a quiet hour, two of them from someone who walked
 * away from their laptop, is not a UI failure.
 */
export const MIN_CONFIRMATIONS_FOR_A_VERDICT = 10;

const QUERY_TIMEOUT_MS = 4_000;

/**
 * Consecutive health checks a subscriber count must grow across before it is
 * called a leak. Three, because two is a busy minute and four is a wasted hour.
 */
const LEAK_SAMPLES = 3;
/**
 * Watchers per open connection above which a rising subscriber count stops
 * looking like a busy household and starts looking like nobody releasing. Four
 * people watching one home live at the same moment is a large family; forty is a
 * bug.
 */
const LEAK_PER_CONNECTION = 4;
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
 * A leak here is a subscription that was registered and never released: an SSE
 * stream whose client vanished without the server noticing, repeated until the
 * instance dies holding sockets into houses nobody is watching. It has no error
 * signature at all, which is why it is measured as a SHAPE over time rather than
 * a threshold.
 *
 * **The obvious signal does not work, and this was measured rather than
 * reasoned.** The plan was to watch the margin between registered subscribers
 * and open streams. Against the real runtime that margin is always zero:
 * `subscribe()` registers the subscriber and admits the stream in the same call,
 * so the two counters move in lockstep by construction and a detector built on
 * their difference can never fire. A run of six deliberately leaked
 * subscriptions produced `margins=[0,0,0]`.
 *
 * What actually leaks is the ABSOLUTE count: subscribers climbing and never
 * coming back down while the number of pooled connections does not grow. Honest
 * traffic fluctuates, because people close tabs. A leak only ever rises.
 *
 * The count alone is not enough either, because many people can legitimately
 * watch one house at once and that also raises subscribers against a flat
 * connection count. So the detector additionally requires more watchers per open
 * connection than a household plausibly has (`LEAK_PER_CONNECTION`), which is
 * where "a family is looking at the same home" stops being the likely
 * explanation and "nobody is releasing" starts.
 *
 * The margin is still recorded, because a NON-zero one is a different bug worth
 * seeing: a stream admitted without a subscriber, or the reverse.
 *
 * @param {{ subscribers: number, open: number, streams?: number|null }} sample
 * @returns {{ leaking: boolean, samples: number[], margins: number[], growth: number }}
 */
export function noteSubscriberSample({ subscribers, open, streams = null }) {
	const baseline = typeof streams === 'number' ? streams : subscribers;
	leakSamples.push({ subscribers, open, margin: subscribers - baseline });
	while (leakSamples.length > LEAK_SAMPLES) leakSamples.shift();

	const samples = leakSamples.map((s) => s.subscribers);
	const margins = leakSamples.map((s) => s.margin);
	if (leakSamples.length < LEAK_SAMPLES) return { leaking: false, samples, margins, growth: 0 };

	let climbing = true;
	for (let i = 1; i < leakSamples.length; i += 1) {
		// Strictly rising subscribers, and connections that are not rising with
		// them. A fleet genuinely taking on more houses grows both.
		if (leakSamples[i].subscribers <= leakSamples[i - 1].subscribers) climbing = false;
		if (leakSamples[i].open > leakSamples[i - 1].open) climbing = false;
	}
	const latest = leakSamples[leakSamples.length - 1];
	const crowded = latest.subscribers > LEAK_PER_CONNECTION * Math.max(1, latest.open);
	const growth = samples[samples.length - 1] - samples[0];
	return { leaking: climbing && crowded && growth > 0, samples, margins, growth };
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
					count(distinct home_id) filter (where outcome = 'failed')::int as failed_homes,
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
		//
		// A null `confirmed_by` is NOT on its own a violation, and finding that out
		// against real rows is what stopped this alert from firing on every
		// legitimate unlock. A standing per-entity allowance in
		// `home_entity_grants` is a yes the user already gave, recorded once rather
		// than re-asked every time, so the act path clears the gate through the
		// allow list and stamps `detail.allowed_by_grant`. Those rows are counted
		// and reported, never paged.
		//
		// What remains a violation is the shape with no yes behind it at all:
		// guarded, executed, nobody confirmed it, and no grant claimed.
		withTimeout(
			sql`
				select
					count(*) filter (where coalesce(detail->>'allowed_by_grant', 'false') <> 'true')::int as violations,
					max(created_at) filter (where coalesce(detail->>'allowed_by_grant', 'false') <> 'true') as last_at,
					count(*) filter (where detail->>'allowed_by_grant' = 'true')::int as grant_backed,
					count(*) filter (
						where detail->>'allowed_by_grant' = 'true'
						  and not exists (
							select 1 from home_entity_grants g
							where g.home_id = home_action_log.home_id
							  and g.entity_id = any(home_action_log.entity_ids)
						)
					)::int as grant_backed_without_grant
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
			// Failures confined to ONE home are that home's problem, exactly like a
			// handshake failure is. Without this, a single house with a broken
			// integration downs the subsystem for everybody.
			failedHomes: a.failed_homes ?? 0,
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
			// Guarded actions a standing grant let through. Reported so the number
			// is visible, never scored: the user said yes once, on purpose.
			grantBacked: v.grant_backed ?? 0,
			// Of those, the ones whose entity has no grant row now. Usually a grant
			// the user revoked after the fact, which is why this reports rather than
			// alerts. A number that climbs while nobody is revoking anything is
			// worth reading.
			grantBackedWithoutGrant: v.grant_backed_without_grant ?? 0,
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
			hint: 'Sev 1. Read docs/ops/home-operations.md, section "Confirmation integrity violation". Identify the rows, the homes and the actor before anything else, and treat every affected house as needing its owner told.',
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
	// Actions get the same cross-tenant guard as handshakes, for the same reason.
	// A house whose Z-Wave stick fell out fails every action sent to it; scoring
	// that as a platform outage pages an operator for somebody's loose USB port.
	// It has to be thin traffic or one house before it stops counting, never both
	// ignored: real correlated breakage shows up across homes and at volume.
	const actionsScoreable = s.actions.rate !== null && s.actions.total >= MIN_ACTIONS_FOR_A_VERDICT;
	// Failures confined to ONE home do not move this verdict at all, and that is
	// stronger than it first looks. Capping them at `degraded` was not enough:
	// api/cron/uptime-check.js escalates `degraded` exactly like `down` and
	// re-pages roughly hourly for as long as it lasts, so a single user whose
	// Z-Wave stick fell out would page an operator every hour indefinitely. That
	// is the alert-fatigue failure this whole module exists to prevent, arriving
	// through the status field instead of through an alert.
	//
	// Measured, not reasoned: on 2026-09-03 the live fleet sat at `degraded` from
	// 1 failed action out of 23, in 1 home out of 25 connected.
	//
	// The failure is not swallowed. It stays in `detail` below, it is in that
	// home's own action log, and GET /api/home/:id/health tells its owner
	// directly. A per-tenant fault has an audience of exactly one, and it is not
	// the operator.
	const actionStatus = !actionsScoreable || s.actions.failedHomes <= 1
		? 'ok'
		: rateStatus(s.actions.rate, ACTION_DEGRADED, ACTION_DOWN);
	const decidedConfirmations = s.confirmations.redeemed + s.confirmations.expired;
	const expiryStatus = s.confirmations.expiryRate === null || decidedConfirmations < MIN_CONFIRMATIONS_FOR_A_VERDICT
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
			? `actions ${pct(s.actions.rate)} of ${s.actions.total} across ${s.actions.homes} homes`
				+ (s.actions.failed ? `, ${s.actions.failed} failed in ${s.actions.failedHomes} home${s.actions.failedHomes === 1 ? ' (that house, not us)' : 's'}` : '')
				+ (s.actions.total >= MIN_ACTIONS_FOR_A_VERDICT ? '' : ` (under the ${MIN_ACTIONS_FOR_A_VERDICT}-action floor, reported not scored)`)
			: 'no actions in window',
		s.actions.p95LatencyMs === null
			? 'no action timings recorded'
			: `p95 our-leg latency ${s.actions.p95LatencyMs}ms over ${s.actions.timed} timed actions`,
		s.confirmations.total > 0
			? `confirmations ${pct(s.confirmations.expiryRate ?? 0)} expired of ${s.confirmations.total}`
				+ (decidedConfirmations >= MIN_CONFIRMATIONS_FOR_A_VERDICT ? '' : ` (under the ${MIN_CONFIRMATIONS_FOR_A_VERDICT}-confirmation floor, reported not scored)`)
			: 'no confirmations in window',
		s.integrity.grantBacked ? `${s.integrity.grantBacked} guarded action(s) cleared by a standing grant` : null,
		`pool ${s.pool.open} open, ${s.pool.subscribers} subscribers` + (s.pool.streams === null ? '' : ` across ${s.pool.streams} streams`) + `, ${s.pool.breakersOpen} breakers open` + (s.pool.rung && s.pool.rung !== 'normal' ? `, admission ${s.pool.rung}` : ''),
	];

	const hint = status === 'ok'
		? undefined
		: s.leak.leaking
			? `Subscribers climbed ${s.leak.samples.join(' then ')} across three checks while open connections did not, at more than ${LEAK_PER_CONNECTION} watchers per connection. A subscription is being registered and never released. See docs/ops/home-operations.md, "Subscriber leak".`
			: handshakeStatus !== 'ok'
				? 'Handshakes are failing across tenants, which is almost always us: a deploy, an egress change or a DNS fault. Run the correlation query in docs/ops/home-operations.md before touching anything.'
				: actionStatus !== 'ok'
					? 'Actions are failing across more than one home, so this is not one house having a bad day. Group home_action_log by outcome and detail->>\'code\' to see whether this is one error or many.'
					: expiryStatus !== 'ok'
						? 'Confirmations are timing out rather than being answered. That is a UI failure, not user hesitation: check that the confirm prompt is reaching the surface the user is actually on.'
						: latencyStatus !== 'ok'
							? 'Our own leg of the act path is slow. The house is excluded from this measurement, so look at the pool: cold opens, breaker retries, or a store read on the hot path.'
							: 'Breakers are open on a large share of this instance\'s pooled homes. Correlated, that means we cannot reach houses we could reach an hour ago.';

	return { status, detail: parts.filter(Boolean).join('; ') + '.', ...(hint ? { hint } : {}) };
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
