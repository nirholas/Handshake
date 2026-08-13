// /api/legal/tos-ack: record a user's acceptance of the Terms of Service.
//
//   POST /api/legal/tos-ack   { version?, context?, path? }
//     → 200 { ok: true, version, recorded }
//     → 400 invalid_body / invalid_version, 413 payload_too_large,
//       415 unsupported_media_type when the body is not a readable acceptance
//
// The primary acceptance records are written inline by the auth endpoints
// (register / login / SIWE / SIWS / Privy verify) when the client sends
// tosAccepted with the auth call. This endpoint covers the remaining cases:
// an already-signed-in user accepting an updated Terms version, and
// pre-auth surfaces that show the agreement before an account exists.
//
// Mirrors /api/legal/risk-ack: every acceptance lands in audit_log (the
// audit-log-cleanup cron exempts 'tos-accept' rows from its 365-day
// retention, so acceptance records persist indefinitely); signed-in
// acceptances additionally stamp users.tos_accepted_version / tos_accepted_at.
//
// `recorded` reports whether the durable write actually landed. The write is
// awaited rather than fired and forgotten, because an acceptance record the
// caller was told about but that never reached the database is the one failure
// this endpoint exists to prevent. A dropped write still answers 200: the user
// did accept, and their flow must not stall on our bookkeeping.

import { getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { logAuditNow } from '../_lib/audit.js';
import { TOS_VERSION, recordTosAcceptance } from '../_lib/legal.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PATH = /^\/[\x20-\x7e]{0,199}$/;

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// An unreadable body must never become a recorded acceptance. Swallowing the
	// read error left `body` null, and a null body then took the "no version
	// sent, default to current" path below: a form POST with no JSON
	// content-type, or a body past the size limit, answered 200 and wrote an
	// evidentiary "accepted Terms v2" row for a request whose content was never
	// read. Report what actually went wrong instead (413 oversized, 415 wrong
	// content-type, 400 unparseable) and record nothing.
	let body;
	try {
		body = await readJson(req, 10_000);
	} catch (err) {
		const status = err?.status === 413 || err?.status === 415 ? err.status : 400;
		const code =
			status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_media_type' : 'bad_request';
		return error(res, status, code, err?.message || 'could not read request body');
	}
	// `{}` is a valid acceptance of the current version, but an array or any
	// other non-object JSON is not an acceptance payload at all; it only reached
	// the default-version path because `[].version` reads as undefined.
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return error(res, 400, 'invalid_body', 'body must be a JSON object');
	}
	const raw = Number(body?.version);
	const version = Number.isInteger(raw) && raw >= 1 && raw <= TOS_VERSION ? raw : TOS_VERSION;
	if (body?.version !== undefined && version !== raw) {
		return error(res, 400, 'invalid_version', `version must be an integer between 1 and ${TOS_VERSION}`);
	}
	const context = typeof body?.context === 'string' && SLUG.test(body.context) ? body.context : 'tos-ack';
	const path = typeof body?.path === 'string' && PATH.test(body.path) ? body.path : null;

	const user = await getSessionUser(req).catch(() => null);

	const recorded = user
		? await recordTosAcceptance({ userId: user.id, version, context, path, req })
		: // Anonymous acceptance (pre-auth surface): audit-only, no user row to stamp.
			await logAuditNow({
				userId: null,
				action: 'tos-accept',
				resourceId: null,
				meta: { version, context, path },
				req,
			});

	return json(res, 200, { ok: true, version, recorded });
});
