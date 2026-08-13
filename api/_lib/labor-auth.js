// Shared auth + ownership for the Agent Labor Market endpoints (api/labor/*).
// Mirrors the session-or-bearer + CSRF-on-session pattern used by a2a-hire.js so
// every money/mutation path enforces ownership server-side, never client-side.

import { authenticateBearer, extractBearer, getSessionUser } from './auth.js';
import { requireCsrf } from './csrf.js';
import { error } from './http.js';
import { sql } from './db.js';
import { isUuid } from './validate.js';

/**
 * Authenticate a write. Returns { userId, session } or null. When it returns
 * null it has ALREADY written the 401/403 response (CSRF failures included), so
 * the caller must simply `return`.
 */
export async function authWrite(req, res) {
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) {
		error(res, 401, 'unauthorized', 'sign in required');
		return null;
	}
	const userId = session?.id ?? bearer?.userId;
	if (session && !(await requireCsrf(req, res, userId))) return null;
	return { userId, session: !!session };
}

/**
 * Boundary guard for every id a labor endpoint hands to Postgres. Each of
 * agent_bounties / agent_bids / agent_jobs / agent_identities keys on a uuid
 * column, so a malformed id used to reach the database and come back as
 * SQLSTATE 22P02: an opaque 500 on the read paths, and a 400 that published the
 * raw SQLSTATE and the Postgres message on the ownership paths. Validate first
 * and answer a clean 400 that names the field.
 *
 * Writes the response and returns false when the id is bad, so the caller
 * simply `return`s; returns true when it is safe to query.
 */
export function requireUuid(res, value, field) {
	if (isUuid(value)) return true;
	error(res, 400, 'validation_error', `${field} must be a uuid`);
	return false;
}

/**
 * Narrow a thrown ownership error to a client-safe response. loadOwnedAgent and
 * requireSolanaWallet throw typed errors carrying `status`; anything else is an
 * infrastructure fault (a DB outage, a driver error) whose message must never be
 * echoed to the caller, so it is rethrown for wrap() to log and correlate.
 */
export function ownershipError(res, e) {
	if (!e?.status) throw e;
	return error(res, e.status, e.code || 'bad_request', e.message);
}

/** Load an agent and assert the caller owns it. Throws typed 404/403 errors. */
export async function loadOwnedAgent(agentId, userId) {
	const [agent] = await sql`
		SELECT id, user_id, name, meta FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL`;
	if (!agent) {
		throw Object.assign(new Error('agent not found'), { status: 404, code: 'not_found' });
	}
	if (agent.user_id !== userId) {
		throw Object.assign(new Error('you do not own this agent'), { status: 403, code: 'forbidden' });
	}
	return agent;
}

export function requireSolanaWallet(agent) {
	if (!agent.meta?.solana_address || !agent.meta?.encrypted_solana_secret) {
		throw Object.assign(new Error('this agent has no Solana wallet provisioned'), {
			status: 409, code: 'no_wallet',
		});
	}
	return agent;
}
