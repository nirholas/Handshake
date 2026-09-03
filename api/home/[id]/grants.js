// /api/home/:id/grants: the standing allowances the physical-action gate honours.
//
//   GET     what the agent may do in this house without asking again
//   POST    grant one entity, optionally until a date
//   DELETE  withdraw one (also reachable as DELETE .../grants/:entityId)
//
// Per entity, never per domain. A user who lets their agent open the office door
// has not let it open the front door, and a `granted_domain` column is exactly
// the shortcut that turns a convenience into a burglary tool. The store refuses a
// domain-shaped id outright rather than trusting this route to check.
//
// A grant is a security decision, so it needs a session and a CSRF token even
// though reads on this surface accept a bearer. An agent must be able to ACT with
// a token; it must not be able to widen its own permissions with one.

import { logAudit } from '../../_lib/audit.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { resolveHomeAccess } from '../../_lib/home/access.js';
import { homeError, homeFailure, HOME_ERR } from '../../_lib/home/errors.js';
import { grantEntity, listGrants, logHomeAction, revokeGrant } from '../../_lib/home/store.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';

/** Home Assistant entity id: domain.object_id, both lower snake case. */
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
/** A standing allowance on a lock should not outlive the reason for it. */
const MAX_GRANT_MS = 365 * 24 * 60 * 60 * 1000;
/** Distinguishes "you sent a bad date" from "you sent no date", which is legal. */
const INVALID_EXPIRY = Symbol('invalid expiry');

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	// Reading the allowances is a read; creating or withdrawing one is a standing
	// yes to opening something, which only the owner and an admin may leave behind.
	const access = await resolveHomeAccess(req, res, req.query?.id, req.method === 'GET' ? 'read' : 'grant');
	if (!access.ok) return error(res, access.status, access.code, access.message);
	const { caller, home } = access;

	if (req.method === 'GET') {
		const rl = await limits.homeRead(caller.userId);
		if (!rl.success) return rateLimited(res, rl, 'too many home reads, slow down');
		return json(res, 200, { grants: (await listGrants(home.id)).map(shape) });
	}

	// Both writes change what the agent may do unattended, so both need a real
	// person behind them.
	if (!(await requireCsrf(req, res, caller.userId))) return;
	const rl = await limits.homeAct(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many permission changes, slow down');

	if (req.method === 'POST') return handleGrant(req, res, caller, home);
	return handleRevoke(req, res, caller, home, entityFromQuery(req));
});

async function handleGrant(req, res, caller, home) {
	const body = await readJson(req, 4_000).catch(() => null);
	const entityId = normalizeEntity(body?.entity_id ?? body?.entityId);
	if (!entityId) {
		return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'entity_id must be one Home Assistant entity, for example "lock.office_door". Grants are per entity, never per domain.'));
	}

	const expiresAt = readExpiry(body?.expires_at ?? body?.expiresAt);
	if (expiresAt === INVALID_EXPIRY) {
		return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'expires_at must be a date in the future and no more than a year away.'));
	}

	const grant = await grantEntity({ homeId: home.id, entityId, grantedBy: caller.userId, expiresAt });

	logAudit({ userId: caller.userId, action: 'grant_home_entity', resourceId: home.id, meta: { entity_id: entityId, expires_at: expiresAt }, req });
	logHomeAction({
		homeId: home.id, userId: caller.userId, actor: 'user', channel: 'websocket',
		action: 'grant.create', entityIds: [entityId], guarded: true, confirmedBy: caller.userId,
		risk: null, outcome: 'ok', detail: { expires_at: expiresAt ? new Date(expiresAt).toISOString() : null },
	});

	return json(res, 201, { grant: shape(grant) });
}

async function handleRevoke(req, res, caller, home, fromPath) {
	const body = fromPath ? null : await readJson(req, 4_000).catch(() => null);
	const entityId = fromPath ?? normalizeEntity(body?.entity_id ?? body?.entityId);
	if (!entityId) {
		return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'entity_id is required to withdraw a grant.'));
	}

	const removed = await revokeGrant({ homeId: home.id, entityId });
	if (removed) {
		logAudit({ userId: caller.userId, action: 'revoke_home_entity_grant', resourceId: home.id, meta: { entity_id: entityId }, req });
		logHomeAction({
			homeId: home.id, userId: caller.userId, actor: 'user', channel: 'websocket',
			action: 'grant.revoke', entityIds: [entityId], guarded: true, confirmedBy: caller.userId,
			risk: null, outcome: 'ok', detail: null,
		});
	}
	// Idempotent: withdrawing a grant that is already gone is the state the caller
	// asked for, so it is a 200. `changed` is how a log tells the two apart.
	return json(res, 200, { revoked: true, changed: removed, entity_id: entityId });
}

/**
 * The entity id from `DELETE /api/home/:id/grants/:entityId`.
 *
 * Also accepted as `?entity_id=`, and that is not belt and braces: a Home
 * Assistant object id may legitimately be `js` (a script named "js"), and
 * `script.js` in a path segment is stripped to `script` by the same rule that
 * lets `/api/foo.js` reach `api/foo.js`. The query form is the escape hatch for
 * every id the path shape cannot carry.
 */
function entityFromQuery(req) {
	const fromPath = normalizeEntity(req.query?.entityId);
	if (fromPath) return fromPath;
	const url = new URL(req.url, 'http://x');
	return normalizeEntity(url.searchParams.get('entity_id'));
}

function normalizeEntity(value) {
	const id = String(value ?? '').trim().toLowerCase();
	return ENTITY_RE.test(id) ? id : null;
}

/**
 * @returns {string|null|symbol} an ISO date, null for "until withdrawn", or the
 *   INVALID_EXPIRY sentinel. A sentinel rather than a throw because the
 *   caller has to answer with a worded 400, and rather than null because null is
 *   already the legitimate "no expiry" answer.
 */
function readExpiry(value) {
	if (value === null || value === undefined || value === '') return null;
	const at = new Date(value);
	if (Number.isNaN(at.getTime())) return INVALID_EXPIRY;
	const ms = at.getTime() - Date.now();
	if (ms <= 0 || ms > MAX_GRANT_MS) return INVALID_EXPIRY;
	return at.toISOString();
}

function shape(grant) {
	return {
		id: grant.id,
		entity_id: grant.entity_id,
		granted_by: grant.granted_by,
		expires_at: grant.expires_at,
		created_at: grant.created_at,
	};
}
