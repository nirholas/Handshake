// @ts-check
// GET /api/cron/flush-usage-events — 1-minute safety-net cron for the best-effort
// telemetry buffers.
//
// Two Redis-buffered write paths ride this cron: usage events (recordEvent) and
// x402 payment-audit rows (logPaymentEvent). Each pushes to its own Redis list
// and this cron drains both every minute — catching low-traffic periods where an
// immediate flush never triggers, QStash outages, and anything that slipped
// through while QStash was unavailable.
//
// Kept as a concrete file (not [name].js) so the import graph stays minimal —
// no shared SDK, skills, or data bundles needed for a telemetry flush.

import { json, method, wrapCron } from '../_lib/http.js';
import { flushUsageBuffer } from '../_lib/usage.js';
import { flushAuditBuffer } from '../_lib/x402/audit-log.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { requireCron } from '../_lib/cron-auth.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	// Drain both telemetry buffers concurrently — independent Redis lists and Neon
	// writes, so one slow buffer must not delay the other.
	const [result, audit] = await Promise.all([
		flushUsageBuffer({ limit: 1000 }),
		flushAuditBuffer({ limit: 2000 }),
	]);

	if (result.errors > 0) {
		sendOpsAlert(
			'usage buffer flush errors',
			`${result.errors} inserts failed. flushed=${result.flushed} remaining=${result.remaining}`,
			{ signature: 'usage-flush-errors' },
		);
	}

	if (result.remaining > 500) {
		sendOpsAlert(
			'usage buffer backlog',
			`${result.remaining} events still queued after flush. Check Neon write latency.`,
			{ signature: 'usage-buffer-backlog' },
		);
	}

	if (audit.errors > 0) {
		sendOpsAlert(
			'x402 audit buffer flush errors',
			`${audit.errors} batch inserts failed. flushed=${audit.flushed} remaining=${audit.remaining}`,
			{ signature: 'x402-audit-flush-errors' },
		);
	}

	if (audit.remaining > 2000) {
		sendOpsAlert(
			'x402 audit buffer backlog',
			`${audit.remaining} audit rows still queued after flush. Check Neon write latency.`,
			{ signature: 'x402-audit-buffer-backlog' },
		);
	}

	return json(res, 200, { usage: result, audit });
});
