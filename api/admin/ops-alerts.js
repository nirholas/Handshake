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
import { getSessionUser } from '../_lib/auth.js';
import { isAdminUser } from '../_lib/admin.js';

const IS_PROD = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';

// Authorize a request and return the actor identity for attribution. Two ways
// in, both fail CLOSED in production:
//   1. A signed-in platform admin (session + admin wallet, the requireAdmin
//      model) — the strongest path, and the only one that yields a real per-user
//      identity for the acknowledge audit trail.
//   2. A dedicated OPS_SECRET presented as `x-ops-secret` (bookmarkable page /
//      headless). This is deliberately NOT CRON_SECRET: the ops dashboard must
//      never share a credential with the crons that move real funds, so viewing
//      health can't be escalated into triggering a payment job. Set OPS_SECRET
//      and CRON_SECRET is no longer accepted here.
// No secret configured + no admin session → allowed ONLY off-production (local
// dev); in production this denies. The endpoint exposes wallet addresses, tx
// signatures, key-rotation hints, and stack traces, so an open default is unsafe.
async function authorize(req) {
	try {
		const user = await getSessionUser(req);
		if (user && (await isAdminUser(user))) {
			return { ok: true, actor: user.wallet_address || `user:${user.id}` };
		}
	} catch {
		/* no/invalid session — fall through to the secret path */
	}
	const secret = env.OPS_SECRET;
	if (secret) {
		const provided =
			req.headers['x-ops-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
		if (provided && constantTimeEquals(provided, secret)) return { ok: true, actor: 'ops-secret' };
		return { ok: false };
	}
	// No OPS_SECRET set: open in dev for local work, closed in production.
	return { ok: !IS_PROD, actor: 'dev' };
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

	const auth = await authorize(req);
	if (!auth.ok) return error(res, 401, 'unauthorized', 'admin session or x-ops-secret required');

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
		// Attribution is server-derived from the authorized identity, never the
		// client body — a caller can't forge who acknowledged an alert.
		const by = String(auth.actor || 'admin').slice(0, 120);
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
