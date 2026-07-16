// /api/legal/tos-ack — record a user's acceptance of the Terms of Service.
//
//   POST /api/legal/tos-ack   { version?, context?, path? }   → 200 { ok: true, version }
//
// The primary acceptance records are written inline by the auth endpoints
// (register / login / SIWE / SIWS / Privy verify) when the client sends
// tosAccepted with the auth call. This endpoint covers the remaining cases:
// an already-signed-in user accepting an updated Terms version, and
// pre-auth surfaces that show the agreement before an account exists.
//
// Mirrors /api/legal/risk-ack: every acceptance lands in audit_log (no
// retention pruning — records persist); signed-in acceptances additionally
// stamp users.tos_accepted_version / users.tos_accepted_at.

import { getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { logAudit } from '../_lib/audit.js';
import { TOS_VERSION, recordTosAcceptance } from '../_lib/legal.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PATH = /^\/[\x20-\x7e]{0,199}$/;

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req, 10_000).catch(() => null);
	const raw = Number(body?.version);
	const version = Number.isInteger(raw) && raw >= 1 && raw <= TOS_VERSION ? raw : TOS_VERSION;
	if (body?.version !== undefined && version !== raw) {
		return error(res, 400, 'invalid_version', `version must be an integer between 1 and ${TOS_VERSION}`);
	}
	const context = typeof body?.context === 'string' && SLUG.test(body.context) ? body.context : 'tos-ack';
	const path = typeof body?.path === 'string' && PATH.test(body.path) ? body.path : null;

	const user = await getSessionUser(req).catch(() => null);

	if (user) {
		recordTosAcceptance({ userId: user.id, version, context, req });
	} else {
		// Anonymous acceptance (pre-auth surface): audit-only, no user row to stamp.
		logAudit({
			userId: null,
			action: 'tos-accept',
			resourceId: null,
			meta: { version, context, path },
			req,
		});
	}

	return json(res, 200, { ok: true, version });
});
