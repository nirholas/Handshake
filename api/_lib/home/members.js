// Households: who is in this home, what they may do in it, and what they may see.
//
// This module is the single authority on that question. Every surface that acts
// on a home (the connection store's reads, the bridge runtime's acquire, the
// room graph projection, the physical-action gate, the confirm endpoint, the
// grant and layout writers, the chat tools and the MCP tools) resolves the
// caller through `requireMembership` and branches on what it returns. None of
// them keeps its own copy of the rules, and none of them falls back to
// "or the connection's user_id is the caller": a role system with a bypass is
// decoration, and the bypass is always the path an attacker takes.
//
// The rule the whole design exists for:
//
//   A guest can never confirm a guarded action.
//
// A house sitter should be able to turn the lights on and should not be able to
// authorise unlocking the front door. Home Assistant's own `intent__HassTurnOff`
// performs an unlock on a lock, so "turn something off" and "open the building"
// are the same call with different targets. `confirm` is the line between them
// and it is drawn here, server side, once.
//
// Scope is enforced here too, for the same reason. A guest given the kitchen can
// read the kitchen. The rooms they were not given are removed from the graph
// before it is serialized, not hidden by the client, because a room whose state
// reached the browser has already been disclosed.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { sql } from '../db.js';
import { withDbRetry } from '../db-retry.js';
import { summarizeClimate, summarizeLighting, summarizeSecurity } from '../../../packages/home-bridge/src/rooms.js';

/** Every role the schema's check constraint accepts, strongest first. */
export const HOME_ROLES = Object.freeze(['owner', 'admin', 'member', 'guest', 'viewer']);

/**
 * The capability vocabulary. Every enforcement point names one of these rather
 * than testing a role string, so adding a role is a change to one table below
 * instead of a grep across the codebase.
 *
 *   read        read the home's state at all
 *   act         perform an ungated action (turn a light on, set a temperature)
 *   confirm     authorise a guarded action (unlock, open, disarm)
 *   grant       create a standing allowance that clears the gate in future
 *   layout      edit the floorplan and the 3D layout
 *   invite      administer the roster: invite, change a role, remove a member
 *   disconnect  revoke the connection and take the house off the platform
 */
export const HOME_CAPABILITIES = Object.freeze(['read', 'act', 'confirm', 'grant', 'layout', 'invite', 'disconnect']);

/**
 * The role matrix. `rank` orders the roles for roster administration; `scoped`
 * says whether this role's reads and actions are narrowed by `entity_scope`.
 *
 * Read this table as the product decision it is:
 *
 *   owner   the account that connected the house. Exactly one, schema-enforced.
 *   admin   runs the household but cannot take the house off the platform.
 *   member  lives here. Acts, confirms, arranges the layout. Cannot hand out
 *           access and cannot leave a standing allowance behind.
 *   guest   is visiting. Scoped, and never a confirmation.
 *   viewer  a wall display or a monitoring seat. Scoped, and reads only.
 */
const ROLE_MATRIX = Object.freeze({
	owner: Object.freeze({ rank: 5, scoped: false, can: Object.freeze(new Set(['read', 'act', 'confirm', 'grant', 'layout', 'invite', 'disconnect'])) }),
	admin: Object.freeze({ rank: 4, scoped: false, can: Object.freeze(new Set(['read', 'act', 'confirm', 'grant', 'layout', 'invite'])) }),
	member: Object.freeze({ rank: 3, scoped: false, can: Object.freeze(new Set(['read', 'act', 'confirm', 'layout'])) }),
	guest: Object.freeze({ rank: 2, scoped: true, can: Object.freeze(new Set(['read', 'act'])) }),
	viewer: Object.freeze({ rank: 1, scoped: true, can: Object.freeze(new Set(['read'])) }),
});

/** Roles an invite or a role change may assign. Ownership is never handed out. */
export const ASSIGNABLE_ROLES = Object.freeze(HOME_ROLES.filter((r) => r !== 'owner'));

const WHOLE_HOUSE_SCOPE = Object.freeze({ mode: 'all' });
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCOPE_LIST_MAX = 500;
const EMAIL_MAX = 254;

/** Does this role hold this capability? Unknown roles hold nothing. */
export function can(role, capability) {
	return ROLE_MATRIX[role]?.can.has(capability) === true;
}

/** Is this role's view of the house narrowed by its entity scope? */
export function isScopedRole(role) {
	return ROLE_MATRIX[role]?.scoped === true;
}

/** Ordering for roster administration. An unknown role sorts below every real one. */
export function roleRank(role) {
	return ROLE_MATRIX[role]?.rank ?? 0;
}

/**
 * The whole matrix as plain data, for the member UI and for the docs to render
 * without restating it and drifting from it.
 */
export function roleMatrix() {
	return HOME_ROLES.map((role) => ({
		role,
		rank: ROLE_MATRIX[role].rank,
		scoped: ROLE_MATRIX[role].scoped,
		capabilities: Object.fromEntries(HOME_CAPABILITIES.map((c) => [c, ROLE_MATRIX[role].can.has(c)])),
	}));
}

// ── Entity scope ────────────────────────────────────────────────────────────

/**
 * Normalize a caller-supplied scope into the two shapes the schema accepts.
 *
 * A non-scoped role is always whole-house: a stale allowlist left on someone who
 * was promoted from guest to member must not silently keep narrowing them, and a
 * scope on a role that does not read it is a lie in the database.
 *
 * @param {unknown} scope
 * @param {string} [role] when given, a non-scoped role forces {mode:'all'}
 */
export function normalizeScope(scope, role) {
	if (role && !isScopedRole(role)) return { ...WHOLE_HOUSE_SCOPE };
	if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return { ...WHOLE_HOUSE_SCOPE };
	if (scope.mode !== 'allow') return { ...WHOLE_HOUSE_SCOPE };
	const clean = (list) =>
		Array.from(new Set((Array.isArray(list) ? list : []).map((v) => String(v || '').trim()).filter(Boolean))).slice(0, SCOPE_LIST_MAX);
	return { mode: 'allow', areas: clean(scope.areas), entities: clean(scope.entities) };
}

/**
 * Is this entity inside this scope?
 *
 * An entity is in scope when it was named directly, or when the area holding it
 * was named. Nothing is inferred from the domain: "all the lights" is not a
 * scope anyone can reason about while granting it, which is the same reason
 * home_entity_grants refused a domain column.
 */
export function entityInScope(scope, { entityId, areaId = null } = {}) {
	const s = normalizeScope(scope);
	if (s.mode === 'all') return true;
	if (entityId && s.entities.includes(entityId)) return true;
	return Boolean(areaId && s.areas.includes(areaId));
}

/** Every entity id in a resolved action that falls outside the scope. */
export function outOfScopeEntities(scope, targets = []) {
	return targets
		.filter((t) => {
			const spec = typeof t === 'string' ? { entityId: t } : t;
			return !entityInScope(scope, spec);
		})
		.map((t) => (typeof t === 'string' ? t : t.entityId));
}

/**
 * The room graph as this member is allowed to see it.
 *
 * Three things happen, and all three matter:
 *
 *   1. Rooms the member was not given are removed, not marked. A room the client
 *      knows the name of is a room that was disclosed.
 *   2. In a room reached through an individual entity grant, the entities that
 *      were not granted are removed AND the room's lighting, climate and
 *      security rollups are recomputed over what remains. Leaving the original
 *      rollups would report "three lights on" for a room the member can see one
 *      light in, which is the leak the filtering exists to prevent.
 *   3. Floors with no visible room are removed, because the floor list is the
 *      shape of the building.
 *
 * @param {object} graph buildHomeGraph() output
 * @param {object} scope
 */
export function filterGraphForScope(graph, scope) {
	const s = normalizeScope(scope);
	if (!graph || s.mode === 'all') return graph;

	const areas = new Set(s.areas);
	const entities = new Set(s.entities);

	const rooms = [];
	for (const room of graph.rooms || []) {
		const wholeRoom = areas.has(room.id);
		const kept = wholeRoom ? room.entities || [] : (room.entities || []).filter((e) => entities.has(e.entityId));
		if (!wholeRoom && kept.length === 0) continue;
		rooms.push(
			wholeRoom
				? room
				: {
						...room,
						entities: kept,
						lighting: summarizeLighting(kept),
						climate: summarizeClimate(kept),
						secured: summarizeSecurity(kept),
					},
		);
	}

	const visibleFloors = new Set(rooms.map((r) => r.floorId).filter(Boolean));
	return {
		...graph,
		floors: (graph.floors || []).filter((f) => visibleFloors.has(f.id)),
		rooms,
		unassigned: (graph.unassigned || []).filter((e) => entities.has(e.entityId)),
	};
}

// ── Membership resolution ───────────────────────────────────────────────────

function shapeMembership(row) {
	if (!row) return null;
	return {
		homeId: row.home_id,
		userId: row.user_id,
		role: row.role,
		scope: normalizeScope(row.entity_scope, row.role),
		scoped: isScopedRole(row.role),
		invitedBy: row.invited_by || null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * This caller's membership in this home, or null.
 *
 * Null covers three cases on purpose and does not distinguish between them: the
 * home does not exist, the home was revoked, and the caller is not a member.
 * A caller who is not in the household must not be able to learn that a home id
 * is real, which is why every endpoint above this answers 404 and never 403.
 */
export async function resolveMembership(homeId, userId) {
	if (!homeId || !userId) return null;
	const [row] = await withDbRetry(
		() => sql`
			SELECT m.home_id, m.user_id, m.role, m.entity_scope, m.invited_by, m.created_at, m.updated_at
			FROM home_members m
			JOIN home_connections c ON c.id = m.home_id AND c.revoked_at IS NULL
			WHERE m.home_id = ${homeId} AND m.user_id = ${userId}
		`,
	);
	return shapeMembership(row);
}

/**
 * The authorisation call every enforcement point makes.
 *
 * Returns a discriminated result rather than throwing, because the two failure
 * modes need different HTTP answers and the caller is the only one that knows
 * which surface it is:
 *
 *   { ok: false, status: 404 }  not a member (or no such home). Says nothing.
 *   { ok: false, status: 403 }  a member, but this role may not do this. Says
 *                               which role and which capability, because a
 *                               guest who is refused an unlock deserves to be
 *                               told it is their role and not a broken door.
 *
 * @param {string} homeId
 * @param {string} userId
 * @param {string} capability one of HOME_CAPABILITIES
 */
export async function requireMembership(homeId, userId, capability) {
	const membership = await resolveMembership(homeId, userId);
	if (!membership) {
		return { ok: false, status: 404, code: 'home_not_found', reason: 'home not found', membership: null };
	}
	if (capability && !can(membership.role, capability)) {
		return {
			ok: false,
			status: 403,
			code: 'role_forbidden',
			reason: `the ${membership.role} role cannot ${capability} in this home`,
			role: membership.role,
			capability,
			membership,
		};
	}
	return { ok: true, membership, role: membership.role, scope: membership.scope };
}

/** Every live home this user is a member of, with the role they hold in each. */
export async function listMembershipHomes(userId) {
	if (!userId) return [];
	return withDbRetry(
		() => sql`
			SELECT m.home_id, m.role, m.entity_scope, c.label, c.base_url, c.status, c.status_detail,
			       c.capabilities, c.transport, c.last_ok_at, c.created_at
			FROM home_members m
			JOIN home_connections c ON c.id = m.home_id AND c.revoked_at IS NULL
			WHERE m.user_id = ${userId}
			ORDER BY c.created_at DESC
		`,
	);
}

// ── The roster ──────────────────────────────────────────────────────────────

/** Who is in this household, strongest role first, with their account identity. */
export async function listMembers(homeId) {
	const rows = await withDbRetry(
		() => sql`
			SELECT m.home_id, m.user_id, m.role, m.entity_scope, m.invited_by, m.created_at, m.updated_at,
			       u.email, u.username, u.display_name
			FROM home_members m
			JOIN users u ON u.id = m.user_id
			WHERE m.home_id = ${homeId}
			ORDER BY m.created_at ASC
		`,
	);
	return rows
		.map((row) => ({
			...shapeMembership(row),
			email: row.email || null,
			username: row.username || null,
			displayName: row.display_name || null,
		}))
		.sort((a, b) => roleRank(b.role) - roleRank(a.role) || String(a.createdAt) - String(b.createdAt));
}

/**
 * May this actor administer this target's membership?
 *
 * Strictly-lower rank, always. An admin may create a peer admin and may not
 * remove one; only the owner can. The owner row is never a target: there is
 * exactly one, the schema enforces it, and the way out of a household is to
 * disconnect the house, not to leave it ownerless.
 */
export function canManageMember(actorRole, targetRole) {
	if (!can(actorRole, 'invite')) return false;
	if (targetRole === 'owner') return false;
	return roleRank(actorRole) > roleRank(targetRole);
}

/** May this actor hand out this role? Peers yes, ownership never. */
export function canAssignRole(actorRole, role) {
	if (!can(actorRole, 'invite')) return false;
	if (!ASSIGNABLE_ROLES.includes(role)) return false;
	return roleRank(actorRole) >= roleRank(role);
}

/**
 * Change a member's role, normalizing their scope to the new role.
 *
 * Promoting a guest to a member widens them to the whole house in the same
 * statement, so no stale allowlist survives the promotion.
 */
export async function setMemberRole({ homeId, userId, role, scope }) {
	const next = normalizeScope(scope, role);
	const [row] = await withDbRetry(
		() => sql`
			UPDATE home_members
			SET role = ${role}, entity_scope = ${JSON.stringify(next)}::jsonb, updated_at = now()
			WHERE home_id = ${homeId} AND user_id = ${userId} AND role <> 'owner'
			RETURNING home_id, user_id, role, entity_scope, invited_by, created_at, updated_at
		`,
	);
	return shapeMembership(row);
}

/**
 * Remove a member and revoke every standing allowance they left behind, in one
 * transaction.
 *
 * The two halves are inseparable. A standing allowance is a permanent yes to
 * unlocking one specific thing, recorded with the account that said it. Leaving
 * a removed member's allowances in place means the front door still opens on
 * the authority of someone who no longer lives there, and nothing in the UI
 * would ever show it. That is the bug that gets somebody burgled, so it is a
 * transaction and not two calls with a hopeful comment between them.
 *
 * @returns {Promise<{removed: boolean, grantsRevoked: string[]}>}
 */
export async function removeMember({ homeId, userId }) {
	const doomed = await withDbRetry(
		() => sql`SELECT entity_id FROM home_entity_grants WHERE home_id = ${homeId} AND granted_by = ${userId} ORDER BY entity_id`,
	);
	const [[removed]] = await sql.transaction([
		sql`DELETE FROM home_members WHERE home_id = ${homeId} AND user_id = ${userId} AND role <> 'owner' RETURNING user_id`,
		sql`DELETE FROM home_entity_grants WHERE home_id = ${homeId} AND granted_by = ${userId}`,
		sql`UPDATE home_invites SET revoked_at = now() WHERE home_id = ${homeId} AND accepted_by = ${userId} AND revoked_at IS NULL`,
	]);
	return { removed: Boolean(removed), grantsRevoked: doomed.map((r) => r.entity_id) };
}

// ── Invitations ─────────────────────────────────────────────────────────────

function hashInviteToken(token) {
	return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Constant-time comparison of two invite token hashes. */
function hashesMatch(a, b) {
	const left = Buffer.from(String(a), 'utf8');
	const right = Buffer.from(String(b), 'utf8');
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

function shapeInvite(row, { token } = {}) {
	if (!row) return null;
	return {
		id: row.id,
		homeId: row.home_id,
		email: row.email,
		role: row.role,
		scope: normalizeScope(row.entity_scope, row.role),
		invitedBy: row.invited_by,
		expiresAt: row.expires_at,
		acceptedAt: row.accepted_at || null,
		acceptedBy: row.accepted_by || null,
		revokedAt: row.revoked_at || null,
		createdAt: row.created_at,
		...(token ? { token } : {}),
	};
}

/**
 * Create a single-use, expiring, role-bound invitation.
 *
 * The plaintext token is returned exactly once, on this call, and is never
 * readable again: the row holds sha256 of it. A re-invite to the same address
 * replaces the outstanding one rather than stacking a second working key.
 *
 * @param {object} input
 * @param {string} input.homeId
 * @param {string} input.email
 * @param {string} input.role one of ASSIGNABLE_ROLES
 * @param {object} [input.scope]
 * @param {string} input.invitedBy
 * @param {number} [input.ttlMs]
 */
export async function createInvite({ homeId, email, role, scope, invitedBy, ttlMs = INVITE_TTL_MS }) {
	const address = String(email || '').trim().toLowerCase().slice(0, EMAIL_MAX);
	if (!address) throw new Error('an invite needs an email address');
	if (!ASSIGNABLE_ROLES.includes(role)) throw new Error(`invalid invite role: ${role}`);

	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + ttlMs);
	const normalized = JSON.stringify(normalizeScope(scope, role));

	const [row] = await sql.transaction([
		sql`UPDATE home_invites SET revoked_at = now() WHERE home_id = ${homeId} AND lower(email) = ${address} AND accepted_at IS NULL AND revoked_at IS NULL`,
		sql`
			INSERT INTO home_invites (home_id, email, role, entity_scope, token_hash, invited_by, expires_at)
			VALUES (${homeId}, ${address}, ${role}, ${normalized}::jsonb, ${hashInviteToken(token)}, ${invitedBy}, ${expiresAt})
			RETURNING id, home_id, email, role, entity_scope, invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at
		`,
	]).then((results) => results[1]);

	return shapeInvite(row, { token });
}

/** Outstanding invitations for this home, newest first. Never the token. */
export async function listInvites(homeId, { includeSpent = false } = {}) {
	const rows = await withDbRetry(
		() =>
			includeSpent
				? sql`SELECT id, home_id, email, role, entity_scope, invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at
				      FROM home_invites WHERE home_id = ${homeId} ORDER BY created_at DESC LIMIT 200`
				: sql`SELECT id, home_id, email, role, entity_scope, invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at
				      FROM home_invites WHERE home_id = ${homeId} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
				      ORDER BY created_at DESC LIMIT 200`,
	);
	return rows.map((r) => shapeInvite(r));
}

/** Withdraw an invitation before anyone has used it. Idempotent. */
export async function revokeInvite({ homeId, inviteId }) {
	const [row] = await withDbRetry(
		() => sql`UPDATE home_invites SET revoked_at = now() WHERE home_id = ${homeId} AND id = ${inviteId} AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
	);
	return Boolean(row);
}

/**
 * The invitation behind a token, without spending it, for the acceptance screen
 * to say "you were invited to Home as a guest" before asking anyone to sign in.
 * Returns the reason it cannot be used rather than null, because "expired" and
 * "never existed" are different screens.
 */
export async function inspectInvite(token) {
	const hash = hashInviteToken(token);
	const [row] = await withDbRetry(
		() => sql`
			SELECT i.id, i.home_id, i.email, i.role, i.entity_scope, i.invited_by, i.expires_at,
			       i.accepted_at, i.accepted_by, i.revoked_at, i.created_at, i.token_hash,
			       c.label, c.revoked_at AS home_revoked_at
			FROM home_invites i
			JOIN home_connections c ON c.id = i.home_id
			WHERE i.token_hash = ${hash}
		`,
	);
	if (!row || !hashesMatch(row.token_hash, hash)) return { ok: false, code: 'invite_not_found', reason: 'this invitation link is not valid' };
	if (row.home_revoked_at) return { ok: false, code: 'home_revoked', reason: 'this home has been disconnected' };
	if (row.revoked_at) return { ok: false, code: 'invite_revoked', reason: 'this invitation was withdrawn' };
	if (row.accepted_at) return { ok: false, code: 'invite_spent', reason: 'this invitation has already been used' };
	if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, code: 'invite_expired', reason: 'this invitation has expired' };
	return { ok: true, invite: shapeInvite(row), homeLabel: row.label };
}

/**
 * Redeem an invitation for an account that already exists.
 *
 * Single use is enforced in the UPDATE's own WHERE clause rather than by a read
 * followed by a write, so two people opening the same link at the same moment
 * cannot both become members: exactly one UPDATE matches a row, and the other
 * sees zero and is told the invite is spent.
 *
 * An account that is already in this household keeps the role it has. An invite
 * is a way in, not a way to be quietly demoted by a stale link.
 */
export async function acceptInvite({ token, userId }) {
	const inspected = await inspectInvite(token);
	if (!inspected.ok) return inspected;

	const { invite } = inspected;
	const existing = await resolveMembership(invite.homeId, userId);
	if (existing) {
		await withDbRetry(
			() => sql`UPDATE home_invites SET accepted_at = now(), accepted_by = ${userId} WHERE id = ${invite.id} AND accepted_at IS NULL`,
		);
		return { ok: true, alreadyMember: true, membership: existing, homeLabel: inspected.homeLabel };
	}

	const [claimed, member] = await sql.transaction([
		sql`UPDATE home_invites SET accepted_at = now(), accepted_by = ${userId} WHERE id = ${invite.id} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING id`,
		sql`
			INSERT INTO home_members (home_id, user_id, role, entity_scope, invited_by)
			VALUES (${invite.homeId}, ${userId}, ${invite.role}, ${JSON.stringify(invite.scope)}::jsonb, ${invite.invitedBy})
			ON CONFLICT (home_id, user_id) DO NOTHING
			RETURNING home_id, user_id, role, entity_scope, invited_by, created_at, updated_at
		`,
	]);

	if (!claimed?.[0]) return { ok: false, code: 'invite_spent', reason: 'this invitation has already been used' };
	return { ok: true, alreadyMember: false, membership: shapeMembership(member?.[0]), homeLabel: inspected.homeLabel };
}

/**
 * Remove an identity from every household it is in.
 *
 * The deprovisioning path. When an SSO identity is deactivated upstream, losing
 * the session is not enough: the account has standing membership in buildings,
 * and membership outlives a session. Sessions are revoked by the existing auth
 * paths; this is the half that reaches the houses.
 *
 * Owner rows are left alone. An owner's home is their own record, and cascading
 * a deprovision into deleting somebody's house is not a decision an SSO webhook
 * gets to make. Their allowances are still revoked.
 */
export async function revokeAllMemberships(userId) {
	const homes = await withDbRetry(
		() => sql`SELECT home_id, role FROM home_members WHERE user_id = ${userId}`,
	);
	const [removed] = await sql.transaction([
		sql`DELETE FROM home_members WHERE user_id = ${userId} AND role <> 'owner' RETURNING home_id`,
		sql`DELETE FROM home_entity_grants WHERE granted_by = ${userId}`,
		sql`UPDATE home_invites SET revoked_at = now() WHERE accepted_by = ${userId} AND revoked_at IS NULL`,
	]);
	return { removedFrom: removed.map((r) => r.home_id), ownedHomes: homes.filter((h) => h.role === 'owner').map((h) => h.home_id) };
}
