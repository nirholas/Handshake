// /api/legal/risk-ack — record a user's acceptance of the Risk Disclosure.
//
//   POST /api/legal/risk-ack   { version, context?, path? }
//     → 200 { ok: true, recorded }
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
//
// `recorded` reports whether the durable write actually landed, and the write
// is awaited rather than fired and forgotten: an acceptance the caller was
// told about but that never reached the database is exactly the failure this
// endpoint exists to prevent. A dropped write still answers 200, because the
// user did accept and their money action must not stall on our bookkeeping.

import { getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { logAuditNow } from '../_lib/audit.js';
// The version constant is owned by the client gate, which is dependency-free
// and importable from both worlds (see its header). Importing it here rather
// than restating the number keeps the accepted version bound to the disclosure
// that was actually shown; a client cannot record acceptance of a revision
// that does not exist yet.
import { RISK_ACK_VERSION } from '../../public/risk-ack.js';

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
	if (!Number.isInteger(version) || version < 1 || version > RISK_ACK_VERSION) {
		return error(
			res,
			400,
			'invalid_version',
			`version must be an integer between 1 and ${RISK_ACK_VERSION}`,
		);
	}
	const context = typeof body?.context === 'string' && SLUG.test(body.context) ? body.context : null;
	const path = typeof body?.path === 'string' && PATH.test(body.path) ? body.path : null;

	const user = await getSessionUser(req).catch(() => null);

	const recorded = await logAuditNow({
		userId: user?.id ?? null,
		action: 'risk-ack-accept',
		resourceId: null,
		meta: { version, context, path },
		req,
	});

	return json(res, 200, { ok: true, recorded });
});
