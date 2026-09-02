// @ts-check
// GET /api/cron/print-orders-sync — reconcile live print jobs and surface
// stalls.
//
// Webhooks are the fast path and they are not enough on their own. A delivery
// gets lost, a partner's callback queue backs up, a lane has no webhook at all
// (the manual one does not, by design). Without a sweep the failure mode is the
// worst one a physical product has: an order that is genuinely finished sits in
// `printing` forever and nobody finds out until the buyer asks.
//
// Two passes, deliberately separate:
//
//   1. RECONCILE. For every order a configured adapter still owns, ask the
//      adapter what it thinks the status is and apply the answer through the
//      state machine. An adapter with no news returns null and nothing moves,
//      so this is safe to run often. The manual lane answers null by
//      construction (the operator console is already its source of truth), so
//      hand-run jobs cost one database read and never a spurious transition.
//   2. STALL. For every order past its own recorded lead time plus a grace
//      margin, page the operator channel once and stamp stall_alerted_at so the
//      next sweep stays quiet. This is the pass that catches a job nobody is
//      working on, which no amount of polling a healthy provider will find.
//
// A provider being down must not fail the sweep: each order is reconciled
// independently and its failure is counted, not thrown, so one broken lane
// never hides a stall in another.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';
import {
	listOpenProviderOrders,
	listStalledOrders,
	markStallAlerted,
	printStoreEnabled,
} from '../_lib/print/fulfillment-queries.js';
import { reconcileOrder } from '../_lib/print/fulfillment.js';
import { jobSummaryLines, notifyOperators } from '../_lib/print/ops-notify.js';

// A job is a stall once it is this many days past its recorded lead time. Two
// days absorbs a weekend and a slow carrier scan without crying wolf.
const STALL_GRACE_DAYS = 2;
// One page per stalled order per day. Enough to stay on an operator's radar,
// infrequent enough that a known-slow job does not train them to ignore it.
const STALL_REALERT_HOURS = 24;
const RECONCILE_BATCH = 100;
const STALL_BATCH = 25;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;
	if (!printStoreEnabled()) {
		return error(res, 503, 'not_configured', 'the fulfillment sweep needs a configured database');
	}

	const open = await listOpenProviderOrders({ limit: RECONCILE_BATCH });
	let polled = 0;
	let applied = 0;
	/** @type {Array<{ order_id: string, error: string }>} */
	const failures = [];

	for (const order of open) {
		try {
			const result = await reconcileOrder(order);
			if (result.polled) polled += 1;
			if (result.applied) applied += 1;
		} catch (err) {
			// One unreachable partner must not stop the sweep: the stall pass below
			// is exactly what catches the orders that partner is sitting on.
			failures.push({ order_id: order.id, error: String(err?.message || err).slice(0, 300) });
		}
	}

	const stalled = await listStalledOrders({
		graceDays: STALL_GRACE_DAYS,
		realertHours: STALL_REALERT_HOURS,
		limit: STALL_BATCH,
	});

	for (const order of stalled) {
		const lateBy = daysSince(order.submitted_at) - (Number(order.lead_time_days) || 0);
		await notifyOperators({
			title: `Print job stalled: ${Math.max(Math.round(lateBy), 0)} days past its lead time`,
			lines: [
				...jobSummaryLines(order),
				`Status ${order.status} with ${order.provider || 'no lane'} since ${formatDay(order.submitted_at)}`,
			],
			orderId: order.id,
			alert: true,
		});
	}
	const alerted = await markStallAlerted(stalled.map((o) => o.id));

	return json(res, 200, {
		ok: true,
		open: open.length,
		polled,
		applied,
		stalled: stalled.length,
		alerted,
		failures,
	});
});

/** @param {string|Date|null} at */
function daysSince(at) {
	if (!at) return 0;
	return (Date.now() - new Date(at).getTime()) / 86_400_000;
}

/** @param {string|Date|null} at */
function formatDay(at) {
	if (!at) return 'an unknown date';
	return new Date(at).toISOString().slice(0, 10);
}
