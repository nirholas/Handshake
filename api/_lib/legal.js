// Terms of Service acceptance: shared constants + recording helper.
//
// TOS_VERSION is the integer version of the current /legal/tos document.
// Bump it whenever the Terms change materially; new signups then record the
// new version and returning users are re-stamped on their next sign-in
// (every first-party auth surface sends tosAccepted with each sign-in, so
// coverage converges without a blocking re-acceptance interstitial).
//
// Two durable records are written per acceptance:
//   - users.tos_accepted_version / users.tos_accepted_at: the current state,
//     cheap to query (migration 20260716100000_users_tos_acceptance.sql).
//   - an audit_log 'tos-accept' row: the append-only evidentiary trail
//     (who, which version, from which flow, when, IP, user agent).

import { sql } from './db.js';
import { logAudit } from './audit.js';

export const TOS_VERSION = 2;

/**
 * Parse the optional ToS-acceptance fields from an auth request body.
 * Returns null when the client did not assert acceptance. The version is
 * clamped to [1, TOS_VERSION]: a client cannot claim a version that does
 * not exist yet; an omitted/invalid version defaults to the current one.
 *
 * @param {unknown} body  raw parsed JSON body
 * @returns {{ version: number } | null}
 */
export function tosAcceptanceFromBody(body) {
	if (body?.tosAccepted !== true) return null;
	const raw = Number(body.tosVersion);
	const version = Number.isInteger(raw) && raw >= 1 && raw <= TOS_VERSION ? raw : TOS_VERSION;
	return { version };
}

/**
 * Record a user's ToS acceptance. Fire-and-forget: auth flows must never
 * fail because acceptance bookkeeping had a bad day: the audit trail and
 * column stamp are best-effort, the acceptance UI event already happened.
 *
 * @param {{ userId: string, version: number, context: string, req?: import('http').IncomingMessage }} args
 *   context: which flow recorded it ('register', 'login', 'siwe', 'siws',
 *   'privy', 'tos-ack', …): stored in the audit row's meta.
 */
export function recordTosAcceptance({ userId, version, context, req = null }) {
	logAudit({
		userId,
		action: 'tos-accept',
		resourceId: null,
		meta: { version, context },
		req,
	});
	queueMicrotask(async () => {
		try {
			await sql`
				update users
				set tos_accepted_version = ${version},
					tos_accepted_at = now()
				where id = ${userId}
					and coalesce(tos_accepted_version, 0) <= ${version}
			`;
		} catch (err) {
			console.error('[legal] tos acceptance stamp failed', err?.message || err);
		}
	});
}
