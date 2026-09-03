// @ts-check
// GET /api/cron/home-health-alert: the three alerts the Home lane is allowed to
// send, and nothing else.
//
// The rule this file exists to enforce: A PER-TENANT FAILURE NEVER ALERTS. One
// person's Home Assistant being unplugged, one expired token, one house behind a
// dead tunnel: those are states that user sees in their own UI and their own
// action log. Paging an operator for them trains everyone to ignore the channel,
// and then the real outage arrives unread.
//
// Three alerts, deliberately:
//
//   1. Correlated unreachability. Handshake success under 80% across at least
//      ten distinct homes in fifteen minutes. One router is noise; ten at once
//      is us, and it is almost always a deploy, an egress change or DNS.
//   2. Confirmation integrity. A guarded physical action (an unlock, a garage
//      door, a disarm) recorded as having executed with no confirmation on
//      record. This is supposed to be impossible, so a SINGLE row pages: it has
//      no rate, no threshold and no error budget.
//   3. Subscriber leak. Registered subscribers exceeding open streams by a
//      margin that grows across three consecutive checks. Nothing about this
//      shows up as an error; instances just quietly fill with sockets into
//      strangers' houses until they die.
//
// The alerting channel itself is api/_lib/alerts.js. This adds no second
// channel, and the generic degradation escalation in api/cron/uptime-check.js
// still covers the `home` subsystem as one of many.

import { cacheGet, cacheSet } from '../_lib/cache.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';
import {
	HANDSHAKE_DOWN,
	MIN_HOMES_FOR_A_VERDICT,
	readHomeSignals,
	readLeakInstances,
	WINDOW_MINUTES,
} from '../_lib/ops/home-health.js';

/** Consecutive ticks a correlated outage must persist before it re-pages, so a deploy blip pages once rather than hourly. */
const RE_ESCALATE_EVERY_TICKS = 12;
const UNREACHABLE_STREAK_KEY = 'home:alert:unreachable:streak';
const STREAK_TTL_S = 6 * 60 * 60;

export default wrapCron(async (req, res) => {
	if (!method(req, res, 'GET')) return;
	if (!requireCron(req, res)) return;

	const signals = await readHomeSignals();
	const fired = [];

	fired.push(...(await alertIntegrity(signals)));
	fired.push(...(await alertCorrelatedUnreachability(signals)));
	fired.push(...(await alertSubscriberLeak()));

	return json(res, 200, {
		ok: true,
		windowMinutes: signals.windowMinutes,
		fired: fired.map((f) => f.id),
		signals: {
			homes: signals.homes,
			handshakes: signals.handshakes,
			actions: { total: signals.actions.total, failed: signals.actions.failed, p95LatencyMs: signals.actions.p95LatencyMs },
			confirmations: signals.confirmations,
			integrity: signals.integrity,
		},
	});
});

/**
 * Alert 2. No threshold, no streak, no dedup window that could swallow a second
 * incident: the signature carries the most recent violation timestamp, so a new
 * row always pages even if an older one paged an hour ago.
 */
async function alertIntegrity(signals) {
	if (!signals.integrity.violations) return [];

	await sendOpsAlert(
		`CRITICAL: ${signals.integrity.violations} guarded home action(s) executed with no confirmation`,
		[
			`Most recent: ${signals.integrity.lastAt}`,
			'',
			'A physical action that can open a building executed without a human saying yes.',
			'This has no error budget. Treat it as Sev 1 and assume the affected homes need their owners told.',
			'',
			'Identify them:',
			"  select id, home_id, user_id, actor, channel, action, entity_ids, risk, created_at",
			"  from home_action_log",
			"  where guarded = true and confirmed_by is null and outcome = 'ok'",
			"    and created_at > now() - interval '24 hours'",
			'  order by created_at desc;',
			'',
			'Runbook: docs/ops/home-operations.md, "Confirmation integrity violation".',
		].join('\n'),
		{ severity: 'critical', signature: `home:integrity:${signals.integrity.lastAt}` },
	);
	return [{ id: 'confirmation_integrity' }];
}

/**
 * Alert 1. Requires BOTH a low rate and enough distinct homes reporting, because
 * a low rate over three homes is one person's router and must never page.
 */
async function alertCorrelatedUnreachability(signals) {
	const { attempts, rate, failed } = signals.handshakes;
	const correlated = rate !== null && rate < HANDSHAKE_DOWN && attempts >= MIN_HOMES_FOR_A_VERDICT;

	const streak = Number((await cacheGet(UNREACHABLE_STREAK_KEY)) || 0);

	if (!correlated) {
		if (streak > 0) {
			await cacheSet(UNREACHABLE_STREAK_KEY, 0, STREAK_TTL_S);
			await sendOpsAlert(
				'Recovered: home handshakes are succeeding across tenants again',
				`${(rate === null ? 0 : rate * 100).toFixed(1)}% success over ${attempts} homes in the last ${signals.windowMinutes} minutes.`,
				{ severity: 'info', signature: 'home:unreachable:recovered' },
			);
			return [{ id: 'correlated_unreachability_recovered' }];
		}
		return [];
	}

	const next = streak + 1;
	await cacheSet(UNREACHABLE_STREAK_KEY, next, STREAK_TTL_S);
	// Page on the first tick, then hourly while it persists, rather than every
	// five minutes forever.
	if (next !== 1 && next % RE_ESCALATE_EVERY_TICKS !== 0) return [];

	await sendOpsAlert(
		`Home handshakes failing across tenants: ${(rate * 100).toFixed(1)}% success over ${attempts} homes`,
		[
			`${failed} of ${attempts} distinct homes failed their last handshake inside ${signals.windowMinutes} minutes.`,
			`Connected now: ${signals.homes.connected}/${signals.homes.live}. Unreachable: ${signals.homes.unreachable}. Auth failed: ${signals.homes.authFailed}.`,
			next === 1 ? '' : `Still failing after ${next} consecutive checks.`,
			'',
			'This many houses do not go dark at once on their own. Suspect us first:',
			'  1. Did anything deploy in the last 20 minutes? curl -s https://three.ws/api/version',
			'  2. Egress: gcloud run services describe three-ws-api --region us-central1 --format="value(spec.template.metadata.annotations)" | tr "," "\\n" | grep vpc',
			'  3. Logs: gcloud logging read \'resource.type="cloud_run_revision" resource.labels.service_name="three-ws-api" textPayload:"home-runtime"\' --freshness=30m',
			'',
			'Runbook: docs/ops/home-operations.md, "Correlated unreachability".',
		].filter(Boolean).join('\n'),
		{ severity: 'critical', signature: `home:unreachable:${next}` },
	);
	return [{ id: 'correlated_unreachability' }];
}

/**
 * Alert 3. Reads the per-instance samples every process publishes when its
 * health block is gathered, because the pool is per-instance and this cron runs
 * on whichever instance answered the request.
 */
async function alertSubscriberLeak() {
	const leaking = (await readLeakInstances()).filter((i) => i.leaking);
	if (!leaking.length) return [];

	await sendOpsAlert(
		`Home subscriber leak on ${leaking.length} instance(s)`,
		[
			...leaking.map(
				(i) => `  ${i.instanceId}: subscriber surplus over open streams grew ${i.margins.join(' then ')} (subscribers ${i.samples.join(' then ')})`,
			),
			'',
			'A subscription is being registered and never released, so the instance is holding sockets into houses nobody is watching.',
			'It has no error signature; it ends as an out-of-memory restart.',
			'',
			'Runbook: docs/ops/home-operations.md, "Subscriber leak".',
		].join('\n'),
		{ severity: 'critical', signature: `home:leak:${leaking.map((i) => i.instanceId).sort().join(',')}` },
	);
	return [{ id: 'subscriber_leak' }];
}
