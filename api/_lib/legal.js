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
import { logAuditNow } from './audit.js';

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
 * Record a user's ToS acceptance. Never throws and never rejects: auth flows
 * must not fail because acceptance bookkeeping had a bad day, and the
 * acceptance UI event already happened either way.
 *
 * Awaiting is optional. Auth endpoints call it fire-and-forget (an extra DB
 * round trip on the sign-in path buys them nothing); /api/legal/tos-ack awaits
 * the returned promise because reporting whether the record landed is that
 * endpoint's whole job.
 *
 * @param {{ userId: string, version: number, context: string, path?: string|null, req?: import('http').IncomingMessage }} args
 *   context: which flow recorded it ('register', 'login', 'siwe', 'siws',
 *   'privy', 'tos-ack', …): stored in the audit row's meta.
 *   path: the page the acceptance happened on, when the caller knows it.
 * @returns {Promise<boolean>} true when both the audit row and the user-row
 *   stamp landed.
 */
export async function recordTosAcceptance({ userId, version, context, path = null, req = null }) {
	const meta = { version, context };
	if (path) meta.path = path;
	const [logged, stamped] = await Promise.all([
		logAuditNow({ userId, action: 'tos-accept', resourceId: null, meta, req }),
		stampTosVersion(userId, version),
	]);
	return logged && stamped;
}

async function stampTosVersion(userId, version) {
	try {
		await sql`
			update users
			set tos_accepted_version = ${version},
				tos_accepted_at = now()
			where id = ${userId}
				and coalesce(tos_accepted_version, 0) <= ${version}
		`;
		return true;
	} catch (err) {
		console.error('[legal] tos acceptance stamp failed', err?.message || err);
		return false;
	}
}
