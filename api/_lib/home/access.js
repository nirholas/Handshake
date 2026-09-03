// Who is allowed to touch a home, resolved once, for every /api/home/* route.
//
// Three things go wrong when each route answers this for itself, and all three
// have shipped in real products:
//
//   1. One route authenticates with a session and another forgets the bearer
//      path, so the agent lane silently 401s (or worse, the reverse).
//   2. One route checks ownership with a `WHERE user_id` and another fetches the
//      row and compares in JavaScript. The second one is a tenancy bug waiting
//      for a refactor to drop the comparison.
//   3. One route answers 403 for somebody else's home. A 403 confirms the id is
//      real, which turns a list of uuids into an oracle for "is this a house".
//      Across a tenancy boundary the answer is always 404.
//
// So: `resolveHomeAccess` is the only door. It authenticates, it reads the home
// through the store's ownership-filtered query, and it returns a discriminated
// result rather than throwing, because the caller is the only code that knows
// whether it is answering an SSE stream or a JSON POST.

import { authenticateBearer, extractBearer, getSessionUser } from '../auth.js';

import { getConnection } from './store.js';

/**
 * Who is calling. Session first, then bearer, because a browser sends both a
 * cookie and (on the agent lane) nothing else, and checking the cookie first
 * keeps the common path off the token verification.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} [res]
 * @returns {Promise<{ userId: string, via: 'session'|'bearer', scope: string|null }|null>}
 */
export async function resolveCaller(req, res) {
	const session = await getSessionUser(req, res).catch(() => null);
	if (session) return { userId: session.id, via: 'session', scope: null };

	const bearer = await authenticateBearer(extractBearer(req)).catch(() => null);
	if (bearer) return { userId: bearer.userId, via: 'bearer', scope: bearer.scope ?? null };

	return null;
}

/**
 * Authenticate, then resolve one home the caller is entitled to.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} homeId from `req.query.id`
 * @returns {Promise<
 *   | { ok: true, caller: { userId: string, via: string, scope: string|null }, home: object }
 *   | { ok: false, status: 401, code: 'unauthorized', message: string }
 *   | { ok: false, status: 404, code: 'not_found', message: string }
 * >}
 */
export async function resolveHomeAccess(req, res, homeId) {
	const caller = await resolveCaller(req, res);
	if (!caller) {
		return { ok: false, status: 401, code: 'unauthorized', message: 'Sign in to reach your home.' };
	}

	// A malformed id is answered exactly like a real id that is not yours. A 400
	// here would tell an unauthenticated prober which of their guesses were even
	// shaped like a home id.
	const home = homeId ? await getConnection(homeId, caller.userId) : null;
	if (!home) {
		return { ok: false, status: 404, code: 'not_found', message: 'No such home.', caller };
	}

	return { ok: true, caller, home };
}

/**
 * The credential-free projection every route returns for a home.
 *
 * Built here rather than in each route so a new column added to the table does
 * not leak by default: a field reaches a client because it is listed below, not
 * because it happened to be on the row. `access_token_enc` never reaches this
 * function at all (the store's SAFE_COLUMNS drops it in SQL), so this is the
 * second of two independent guards, not the only one.
 *
 * @param {object} row a row from api/_lib/home/store.js
 */
export function publicHome(row) {
	if (!row) return null;
	return {
		id: row.id,
		label: row.label,
		base_url: row.base_url,
		transport: row.transport,
		relay_id: row.relay_id ?? null,
		status: row.status,
		status_detail: row.status_detail ?? null,
		capabilities: row.capabilities ?? {},
		last_ok_at: row.last_ok_at ?? null,
		last_error_at: row.last_error_at ?? null,
		created_at: row.created_at,
		updated_at: row.updated_at,
		revoked_at: row.revoked_at ?? null,
	};
}
