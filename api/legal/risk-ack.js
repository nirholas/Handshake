// /api/legal/risk-ack — record a user's acceptance of the Risk Disclosure.
//
//   POST /api/legal/risk-ack   { version, context?, path? }   → 200 { ok: true }
//
// The client-side gate (public/risk-ack.js) fires this after the user accepts
// the real-funds risk acknowledgment. The acceptance itself lives in the
// browser (localStorage, versioned); this endpoint writes the durable
// server-side record into audit_log — who (when signed in), which disclosure
// version, from which feature ('trade', 'snipe', 'x402-pay', …), when, from
// where. The audit-log-cleanup cron exempts 'risk-ack-accept' (and
// 'tos-accept') rows from its 365-day retention, so acceptance records
// persist indefinitely.
//
// Anonymous acceptances are recorded too (userId null): the gate also runs in
// third-party x402 embeds and pre-auth flows where no session exists.

import { getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { logAudit } from '../_lib/audit.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PATH = /^\/[\x20-\x7e]{0,199}$/;

export default wrap(async function handler(req, res) {
	// '*' origin: the acknowledgment modal also runs inside the drop-in x402
	// embed on merchant sites; acceptance recording must not be blocked there.
	// Those requests are credential-less, so '*' is safe.
	if (cors(req, res, { origins: '*', methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req, 10_000).catch(() => null);
	const version = Number(body?.version);
	if (!Number.isInteger(version) || version < 1 || version > 1_000) {
		return error(res, 400, 'invalid_version', 'version must be a positive integer');
	}
	const context = typeof body?.context === 'string' && SLUG.test(body.context) ? body.context : null;
	const path = typeof body?.path === 'string' && PATH.test(body.path) ? body.path : null;

	const user = await getSessionUser(req).catch(() => null);

	logAudit({
		userId: user?.id ?? null,
		action: 'risk-ack-accept',
		resourceId: null,
		meta: { version, context, path },
		req,
	});

	return json(res, 200, { ok: true });
});
