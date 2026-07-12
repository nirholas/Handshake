// GET  /api/admin/ops-alerts        — the ops-alert feed for /admin/ops.
// POST /api/admin/ops-alerts         — { signature, action: 'ack'|'unack' }.
//
// Auth mirrors /api/ops/health exactly: an `x-ops-secret` (or Bearer) header
// equal to OPS_SECRET, falling back to CRON_SECRET so the same credential the
// ops page already uses works here too. No extra setup for the admin.
//
// The rows come from `ops_alerts`, upserted by every sendOpsAlert()
// (api/_lib/alerts.js). This surface is what replaced the Telegram-only channel:
// alerts persist here whether or not a chat is configured, so the dashboard is
// the source of truth. Acknowledging a row drops it from the active feed until
// the same signature fires again (which re-activates it).

import { wrap, cors, json, error, readJson, rateLimited } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

function authorized(req) {
	const secret = env.OPS_SECRET || env.CRON_SECRET;
	if (!secret) return true; // no secret configured (dev) → open, same as /api/ops/health
	const provided =
		req.headers['x-ops-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
	return !!provided && constantTimeEquals(provided, secret);
}

const ACTIVE_LIMIT = 200;
const RESOLVED_LIMIT = 50;

async function listAlerts() {
	// Active (unacknowledged) first — critical before warn before info, then most
	// recent. Resolved (acknowledged) shown separately, capped, for context.
	const active = await sql`
		select signature, title, detail, severity, count, environment,
		       first_seen, last_seen
		from ops_alerts
		where acknowledged_at is null
		order by
			case severity when 'critical' then 0 when 'warn' then 1 else 2 end,
			last_seen desc
		limit ${ACTIVE_LIMIT}
	`;
	const resolved = await sql`
		select signature, title, detail, severity, count, environment,
		       first_seen, last_seen, acknowledged_at, acknowledged_by
		from ops_alerts
		where acknowledged_at is not null
		order by acknowledged_at desc
		limit ${RESOLVED_LIMIT}
	`;
	const counts = {
		active: active.length,
		critical: active.filter((a) => a.severity === 'critical').length,
		warn: active.filter((a) => a.severity === 'warn').length,
		info: active.filter((a) => a.severity === 'info').length,
	};
	return { counts, active, resolved };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: 'same' })) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (!authorized(req)) return error(res, 401, 'unauthorized', 'x-ops-secret required');

	const m = req.method?.toUpperCase();

	if (m === 'GET') {
		try {
			return json(res, 200, await listAlerts());
		} catch (err) {
			// Table absent (pre-migration) or DB down — report an empty, honest feed
			// rather than 500 the dashboard.
			return json(res, 200, {
				counts: { active: 0, critical: 0, warn: 0, info: 0 },
				active: [],
				resolved: [],
				note: `alerts_unavailable: ${err?.message || 'db error'}`,
			});
		}
	}

	if (m === 'POST') {
		const body = await readJson(req).catch(() => null);
		const signature = String(body?.signature || '').trim();
		const action = String(body?.action || 'ack').trim();
		if (!signature) return error(res, 400, 'bad_request', 'signature required');
		if (action !== 'ack' && action !== 'unack') {
			return error(res, 400, 'bad_request', "action must be 'ack' or 'unack'");
		}
		const by = String(body?.by || 'admin').slice(0, 120);
		try {
			const rows =
				action === 'ack'
					? await sql`
							update ops_alerts
							set acknowledged_at = now(), acknowledged_by = ${by}
							where signature = ${signature}
							returning signature`
					: await sql`
							update ops_alerts
							set acknowledged_at = null, acknowledged_by = null
							where signature = ${signature}
							returning signature`;
			if (rows.length === 0) return error(res, 404, 'not_found', 'no alert with that signature');
			return json(res, 200, { ok: true, signature, action });
		} catch (err) {
			return error(res, 500, 'server_error', err?.message || 'update failed');
		}
	}

	return error(res, 405, 'method_not_allowed', 'GET or POST');
});
