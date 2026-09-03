// /api/home/:id/grants: the standing allowances behind the physical-action gate.
//
//   GET     what this home has pre-approved, expired rows already filtered out
//   POST    grant one entity, optionally with an expiry
//   DELETE  revoke one entity, addressed as ?entity_id= or in the body
//
// A grant is the one thing on this surface that makes the gate stop asking, so
// it is deliberately narrow: one entity, one home, never a domain and never a
// wildcard. Home Assistant's own intent__HassTurnOff is documented as performing
// an UNLOCK on a lock, so "let the agent turn things off" would otherwise be a
// sentence that opens a front door. Granting is per entity because the blast
// radius of getting it wrong is a building.
//
// Every grant and every revoke lands in home_action_log. Changing what the agent
// may do without asking is itself an action in the house, and an owner reading
// that log has to be able to see the moment the rules changed, not just the
// actions that followed.

import { requireCsrf } from '../../_lib/csrf.js';
import { publicHome, resolveHomeAccess } from '../../_lib/home/access.js';
import { HOME_ERR, homeError, homeFailure } from '../../_lib/home/errors.js';
import { grantEntity, listGrants, logHomeAction, revokeGrant } from '../../_lib/home/store.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';

/** `domain.object_id`, which is the only shape Home Assistant ever produces. */
const ENTITY_ID = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/;

/**
 * A grant with no end is a legitimate choice ("my office door, always"), but an
 * unbounded one that was meant to be temporary is how a convenience becomes
 * permanent by accident. A year is the ceiling: long enough to mean "standing",
 * short enough that it is not forever.
 */
const MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	const access = await resolveHomeAccess(req, res, req.query?.id);
	if (!access.ok) return error(res, access.status, access.code, access.message);

	if (req.method === 'GET') return handleList(req, res, access);
	if (req.method === 'POST') return handleGrant(req, res, access);
	return handleRevoke(req, res, access);
});

async function handleList(req, res, { caller, home }) {
	const rl = await limits.homeRead(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many home reads, slow down');

	// listGrants filters expiry in SQL, so an expired allowance can never reach a
	// client (or the gate) because some caller forgot to compare a date.
	const grants = await listGrants(home.id);
	return json(res, 200, { home: publicHome(home), grants: grants.map(publicGrant) });
}

async function handleGrant(req, res, { caller, home }) {
	if (!(await requireCsrf(req, res, caller.userId))) return;

	const rl = await limits.homeAct(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many home actions, slow down');

	const body = await readJson(req, 4_000).catch(() => null);
	const entityId = normalizeEntity(body?.entity_id ?? body?.entityId);
	if (!entityId) {
		return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'Send the entity_id to allow, for example "lock.office_door".'));
	}

	let expiresAt = null;
	if (body?.expires_at ?? body?.expiresAt) {
		const parsed = Date.parse(body.expires_at ?? body.expiresAt);
		if (!Number.isFinite(parsed)) {
			return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'expires_at must be an ISO 8601 timestamp.'));
		}
		if (parsed <= Date.now()) {
			return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'expires_at is already in the past.'));
		}
		expiresAt = new Date(Math.min(parsed, Date.now() + MAX_EXPIRY_MS));
	}

	const grant = await grantEntity({ homeId: home.id, entityId, grantedBy: caller.userId, expiresAt });

	logHomeAction({
		homeId: home.id,
		userId: caller.userId,
		actor: 'user',
		channel: 'websocket',
		action: 'grant.allow',
		entityIds: [entityId],
		guarded: true,
		// The grant IS the human saying yes, so the person who made it is the
		// confirmer of every action it later waves through.
		confirmedBy: caller.userId,
		risk: null,
		outcome: 'ok',
		detail: { expires_at: expiresAt ? expiresAt.toISOString() : null },
	});

	return json(res, 201, { grant: publicGrant(grant) });
}

async function handleRevoke(req, res, { caller, home }) {
	if (!(await requireCsrf(req, res, caller.userId))) return;

	const rl = await limits.homeAct(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many home actions, slow down');

	// A DELETE carries its target in the path segment the route table captured,
	// in the query, or in a body, because all three are ordinary for a client and
	// refusing two of them is a papercut with no security value.
	const fromPath = req.query?.entity_id ?? req.query?.entityId;
	const body = fromPath ? null : await readJson(req, 2_000).catch(() => null);
	const entityId = normalizeEntity(fromPath ?? body?.entity_id ?? body?.entityId);
	if (!entityId) {
		return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'Send the entity_id to revoke.'));
	}

	const { revoked } = await revokeGrant({ homeId: home.id, entityId });

	// Idempotent: revoking an allowance that is already gone is a person clicking
	// twice, not an error. Both calls end with the agent unable to open it.
	logHomeAction({
		homeId: home.id,
		userId: caller.userId,
		actor: 'user',
		channel: 'websocket',
		action: 'grant.revoke',
		entityIds: [entityId],
		guarded: true,
		confirmedBy: caller.userId,
		risk: null,
		outcome: 'ok',
		detail: { was_present: revoked },
	});

	return json(res, 200, { revoked, entity_id: entityId });
}

function normalizeEntity(value) {
	const id = String(value || '').trim().toLowerCase();
	return ENTITY_ID.test(id) ? id : '';
}

/** `granted_by` is a user id; it stays internal, and the UI shows the entity. */
function publicGrant(row) {
	if (!row) return null;
	return {
		entity_id: row.entity_id,
		expires_at: row.expires_at ?? null,
		created_at: row.created_at,
	};
}
