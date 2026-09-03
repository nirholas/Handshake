// @ts-check
// Per-tenant Home health: what ONE household can see about ONE of its houses.
//
// This is the deliberate other half of `api/_lib/ops/home-health.js`. That module
// scores the fleet across tenants so an operator is paged only for a correlated
// outage; this module answers the question that same design leaves a user
// holding, which is "my house is not answering, is that me or is that you".
//
// The split matters. A single house going dark is a per-tenant condition: it must
// never page anyone, and it must always be visible to its owner with a real
// reason attached. If the only place that failure appears is an operator channel
// that deliberately ignores it, nobody is told at all. So the rule is:
//
//   one house down  ->  nothing alerts, this surface explains it
//   many houses down ->  the ops module alerts, and this surface says "it is us"
//
// Everything here reads the database rather than the in-process pool. Cloud Run
// runs this service at minScale with no session affinity, so the instance
// answering a user's request usually does not hold that user's connection, and a
// pool gauge read here would report a confident zero for a house that is fine.
// `home_connections` and `home_action_log` are fleet-wide truth on every
// instance.
//
// Consumed by api/home/[id]/health.js, rendered by src/home/manage.js.

import {
	HANDSHAKE_DOWN,
	MIN_HOMES_FOR_A_VERDICT,
} from '../ops/home-health.js';
import { sql } from '../db.js';

/**
 * The window a person is asking about when they look at their own house.
 *
 * The ops module measures 15 minutes because it is hunting a deploy that broke
 * something four minutes ago. A user opening this panel means "what has my house
 * been doing today", and a window that short would show an empty panel to
 * somebody whose agent ran fine this morning and broke at lunch.
 */
export const TENANT_WINDOW_MINUTES = 24 * 60;

/**
 * How long a connected house may go without answering before its own owner is
 * told it looks stale.
 *
 * Matches `STALE_AFTER_MS` in src/home/manage.js, which draws the same house
 * grey at the same age. Two different staleness clocks on one screen is how a
 * card says "live" above a panel that says "stale".
 */
export const TENANT_STALE_MS = 90_000;

const QUERY_TIMEOUT_MS = 4_000;

/**
 * Distinct houses that must be failing before "everyone is broken" beats "your
 * house is broken" as the explanation offered to a user.
 *
 * Deliberately lower than the ops module's alerting floor. Telling somebody "we
 * think this one is us" costs nothing if we are wrong, and an operator is not
 * being woken by it; refusing to say it until the paging threshold is met would
 * leave every user during a small outage reading "check your router".
 */
export const CORRELATION_MIN_HOMES = 3;

function withTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_resolve, reject) => setTimeout(() => reject(new Error('home health query timed out')), ms)),
	]);
}

/**
 * Read one house's own signals, plus just enough of the fleet to answer "is it
 * only me".
 *
 * The fleet half is a single count over `home_connections`, not a call into
 * `readHomeSignals`. That is not a shortcut, it is required: `readHomeSignals`
 * feeds `noteSubscriberSample`, whose leak detector scores a rolling window of
 * exactly three samples. Calling it from a user-facing route would flood that
 * window with samples taken whenever somebody opened a panel, and the leak alert
 * would stop meaning anything.
 *
 * @param {{ id: string }} home
 * @param {{ windowMinutes?: number }} [options]
 */
export async function readTenantHealth(home, { windowMinutes = TENANT_WINDOW_MINUTES } = {}) {
	const window = `${Math.max(1, Math.round(windowMinutes))} minutes`;

	const [actions, confirmations, fleet] = await Promise.all([
		withTimeout(
			sql`
				select
					count(*)::int as total,
					count(*) filter (where outcome = 'ok')::int as ok,
					count(*) filter (where outcome = 'refused')::int as refused,
					count(*) filter (where outcome = 'failed')::int as failed,
					max(created_at) filter (where outcome = 'failed') as last_failed_at,
					percentile_disc(0.95) within group (
						order by (detail->>'latencyMs')::numeric
					) as p95_latency_ms,
					count(*) filter (where detail ? 'latencyMs')::int as timed
				from home_action_log
				where home_id = ${home.id}
				  and created_at > now() - ${window}::interval
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
				where home_id = ${home.id}
				  and created_at > now() - ${window}::interval
			`,
			QUERY_TIMEOUT_MS,
		),
		// The runbook's correlation question, asked from the user's side: right
		// now, is anybody else's house failing too? Scoped to the last 15 minutes
		// rather than the user's 24-hour window, because "is it us" is a question
		// about this moment and a fault that healed at breakfast is not an answer.
		withTimeout(
			sql`
				select
					count(*)::int as live,
					count(*) filter (where status = 'connected')::int as connected,
					count(*) filter (
						where id <> ${home.id}
						  and last_error_at is not null
						  and last_error_at > now() - interval '15 minutes'
						  and (last_ok_at is null or last_error_at > last_ok_at)
					)::int as others_failing
				from home_connections
				where revoked_at is null
			`,
			QUERY_TIMEOUT_MS,
		),
	]);

	const a = actions[0] || {};
	const c = confirmations[0] || {};
	const f = fleet[0] || {};

	return {
		windowMinutes,
		home: {
			id: home.id,
			label: home.label ?? null,
			status: home.status ?? 'pending',
			statusDetail: home.status_detail ?? null,
			lastOkAt: home.last_ok_at ? new Date(home.last_ok_at).toISOString() : null,
			lastErrorAt: home.last_error_at ? new Date(home.last_error_at).toISOString() : null,
		},
		actions: {
			total: a.total ?? 0,
			ok: a.ok ?? 0,
			refused: a.refused ?? 0,
			failed: a.failed ?? 0,
			lastFailedAt: a.last_failed_at ? new Date(a.last_failed_at).toISOString() : null,
			timed: a.timed ?? 0,
			p95LatencyMs: a.p95_latency_ms === null || a.p95_latency_ms === undefined
				? null
				: Math.round(Number(a.p95_latency_ms)),
		},
		confirmations: {
			total: c.total ?? 0,
			redeemed: c.redeemed ?? 0,
			expired: c.expired ?? 0,
		},
		fleet: {
			live: f.live ?? 0,
			connected: f.connected ?? 0,
			othersFailing: f.others_failing ?? 0,
		},
	};
}

/**
 * Is the platform itself in trouble right now, judged from the user's side?
 *
 * Two conditions, both required. Enough other houses have to be failing that it
 * cannot be a coincidence (`CORRELATION_MIN_HOMES`), and they have to be a large
 * enough share of a fleet big enough to have a share at all. With four houses
 * connected, three of them failing is far more likely to be one person's three
 * test instances on one dead laptop than an outage, so below
 * `MIN_HOMES_FOR_A_VERDICT` this stays false and the user is told plainly that
 * we cannot tell.
 *
 * @param {{ live: number, othersFailing: number }} fleet
 */
export function fleetLooksCorrelated(fleet) {
	if (fleet.live < MIN_HOMES_FOR_A_VERDICT) return false;
	if (fleet.othersFailing < CORRELATION_MIN_HOMES) return false;
	return fleet.othersFailing / fleet.live > 1 - HANDSHAKE_DOWN;
}

/**
 * Score one house. Pure: takes exactly what `readTenantHealth` returns and does
 * no IO, so every branch below is exercised directly in tests.
 *
 * `fault` is the field this whole module exists to produce. It is the answer to
 * the only question a user actually has, and it is allowed to be `unknown`:
 * claiming "your router" when we cannot tell is worse than saying we cannot
 * tell, because the user then spends an evening rebooting hardware that was
 * never broken.
 *
 * @param {Awaited<ReturnType<typeof readTenantHealth>>} s
 * @param {{ now?: number }} [options]
 * @returns {{ state: string, fault: string, headline: string, reason: string, advice: string[] }}
 */
export function tenantHealthVerdict(s, { now = Date.now() } = {}) {
	const correlated = fleetLooksCorrelated(s.fleet);
	const lastOk = Date.parse(s.home.lastOkAt || '');
	const stale = s.home.status === 'connected'
		&& Number.isFinite(lastOk)
		&& now - lastOk > TENANT_STALE_MS;

	// Ours before theirs. If the fleet is visibly broken, the honest headline is
	// the same one for every user reading it, whatever their own row says.
	if (correlated && s.home.status !== 'revoked' && (stale || s.home.status !== 'connected')) {
		return {
			state: stale ? 'stale' : s.home.status,
			fault: 'us',
			headline: 'This one is us, not your home.',
			reason: `${s.fleet.othersFailing} other homes stopped answering in the last 15 minutes, so this is a problem on our side rather than anything you changed.`,
			advice: [
				'Nothing to do. Your token and your Home Assistant are untouched.',
				'Your agent will pick the house back up on its own once we are healthy.',
			],
		};
	}

	switch (s.home.status) {
		case 'revoked':
			return {
				state: 'revoked',
				fault: 'none',
				headline: 'This home is disconnected.',
				reason: 'The stored token was destroyed when you disconnected it. Nothing here can reach your house.',
				advice: ['Connect it again to give your agent a new token.'],
			};

		case 'auth_failed':
			return {
				state: 'auth_failed',
				fault: 'your_home',
				headline: 'Home Assistant rejected our token.',
				// The house is answering. It is refusing us, which is a different
				// thing entirely and has a different fix.
				reason: s.home.statusDetail
					|| 'Your house answered and turned us away, which almost always means the long-lived access token was deleted or expired in Home Assistant.',
				advice: [
					'In Home Assistant, open your profile, then Security, and create a new long-lived access token.',
					'Reconnect this home with the new token. Nothing else about it changes.',
				],
			};

		case 'unreachable':
			return {
				state: 'unreachable',
				fault: 'your_home',
				headline: 'We cannot reach your house right now.',
				reason: s.home.statusDetail
					|| `Your Home Assistant stopped answering${s.home.lastErrorAt ? ` at ${s.home.lastErrorAt}` : ''}. Every other home we can see is answering normally, so the fault is between us and your house.`,
				advice: [
					'Check that Home Assistant is running and reachable at the address you gave us.',
					'If you are on a home network, check that the tunnel or remote access you set up is still up.',
					'The rooms and devices below are the last state we saw, kept so the page still works.',
				],
			};

		case 'connected':
			if (stale) {
				return {
					state: 'stale',
					fault: 'unknown',
					headline: 'Your home has gone quiet.',
					reason: `It last answered at ${s.home.lastOkAt}. That is longer than we expect, and not yet long enough for us to call it offline.`,
					advice: [
						'Nothing is broken yet. Everything below is the last state we saw.',
						'If it stays quiet, check that Home Assistant is still running.',
					],
				};
			}
			return {
				state: 'live',
				fault: 'none',
				headline: 'Your home is answering.',
				reason: s.actions.total > 0
					? `${s.actions.ok + s.actions.refused} of ${s.actions.total} actions in the last ${hours(s.windowMinutes)} went the way they should${s.actions.refused ? `, including ${s.actions.refused} the gate stopped and asked you about` : ''}.`
					: `No actions in the last ${hours(s.windowMinutes)}. Your house is connected and your agent has simply not needed to touch anything.`,
				advice: [],
			};

		default:
			return {
				state: s.home.status || 'pending',
				fault: 'unknown',
				headline: 'Still setting this home up.',
				reason: s.home.statusDetail || 'We have not completed a handshake with this house yet.',
				advice: ['Give it a moment. If it stays here, disconnect and connect it again.'],
			};
	}
}

/**
 * The whole per-tenant answer for one house. Never throws: a health panel that
 * 500s is a worse experience than one that says it could not measure.
 *
 * @param {{ id: string }} home
 * @param {{ windowMinutes?: number }} [options]
 */
export async function gatherTenantHealth(home, options = {}) {
	let signals;
	try {
		signals = await readTenantHealth(home, options);
	} catch (err) {
		return {
			state: 'unknown',
			fault: 'unknown',
			headline: 'We could not measure this home just now.',
			reason: err?.message || 'The health read did not complete.',
			advice: ['Try again in a moment. This does not affect your agent or your house.'],
			measured: false,
		};
	}
	const verdict = tenantHealthVerdict(signals);
	return {
		...verdict,
		measured: true,
		windowMinutes: signals.windowMinutes,
		lastOkAt: signals.home.lastOkAt,
		lastErrorAt: signals.home.lastErrorAt,
		actions: signals.actions,
		confirmations: signals.confirmations,
		// Deliberately only a count and a flag. A user is entitled to know whether
		// other people are affected; they are not entitled to know which homes, how
		// many exist, or anything else about a stranger's house.
		fleet: {
			othersFailing: signals.fleet.othersFailing,
			correlated: fleetLooksCorrelated(signals.fleet),
		},
	};
}

function hours(minutes) {
	if (minutes < 60) return `${minutes} minutes`;
	const h = Math.round(minutes / 60);
	if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
	const d = Math.round(h / 24);
	return `${d} day${d === 1 ? '' : 's'}`;
}
