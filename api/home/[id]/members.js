// The household roster: /api/home/:id/members
//
//   GET     list the members and the outstanding invitations
//   POST    invite somebody, by email, to a named role and scope
//   PATCH   change a member's role or scope
//   DELETE  remove a member, or withdraw an invitation
//
// Every branch resolves the caller through api/_lib/home/members.js and acts on
// what it says. There is no "or the connection belongs to you" path here: a
// non-member gets 404 (never 403, which would confirm the home exists), and a
// member who lacks the capability gets 403 naming their role, because "your
// role cannot do this" and "that home does not exist" are different facts and
// only one of them is safe to disclose.

import { logAudit } from '../../_lib/audit.js';
import { sendHouseholdInviteEmail } from '../../_lib/email.js';
import { getConnection } from '../../_lib/home/store.js';
import { getSessionUser } from '../../_lib/auth.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { assertMemberCapacity, HomeQuotaError } from '../../_lib/home/entitlements.js';
import {
	ASSIGNABLE_ROLES,
	canAssignRole,
	canManageMember,
	createInvite,
	listInvites,
	listMembers,
	normalizeScope,
	removeMember,
	requireMembership,
	resolveMembership,
	revokeInvite,
	roleMatrix,
	setMemberRole,
} from '../../_lib/home/members.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { isUuid } from '../../_lib/validate.js';

/**
 * The invite link a new member follows. Absolute, because it is emailed.
 *
 * `/smart-home/join` is a real route with a real page behind it (pages/
 * smart-home-join.html): the link tells the holder what they were invited to
 * before it asks them to sign in, and sends them through the existing register
 * and login flow and back to the same link if they need an account.
 */
function inviteUrl(req, token) {
	const host = req.headers['x-forwarded-host'] || req.headers.host || 'three.ws';
	const proto = /^localhost|^127\./.test(String(host)) ? 'http' : 'https';
	return `${proto}://${host}/smart-home/join?invite=${encodeURIComponent(token)}`;
}

/** "an admin" / "a member": role names are user-facing copy, not identifiers. */
function a(role) {
	return /^[aeiou]/i.test(String(role)) ? `an ${role}` : `a ${role}`;
}

function emailish(value) {
	const v = String(value || '').trim().toLowerCase();
	return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && v.length <= 254 ? v : null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,PATCH,DELETE,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;

	const homeId = req.query?.id;
	if (!homeId || !isUuid(homeId)) return error(res, 400, 'bad_request', 'valid home id required');

	const user = await getSessionUser(req, res).catch(() => null);
	if (!user) return error(res, 401, 'unauthorized', 'sign in to manage this household');

	// Reading the roster is a plain member capability: you should be able to see
	// who else has keys to the house you are in. Everything that changes it needs
	// `invite`.
	if (req.method === 'GET') {
		const gate = await requireMembership(homeId, user.id, 'read');
		if (!gate.ok) return error(res, gate.status, gate.code, gate.reason);

		// Metered on the same bucket as every other read on this surface, so a
		// panel that polls the roster competes with the rest of a person's reads
		// rather than sitting outside the ceiling everything else is held to.
		const rl = await limits.homeRead(user.id).catch(() => ({ success: true }));
		if (rl && rl.success === false) return rateLimited(res, rl, 'too many home reads, slow down');
		const [members, invites] = await Promise.all([listMembers(homeId), listInvites(homeId)]);
		return json(res, 200, {
			role: gate.role,
			scope: gate.scope,
			can_manage: gate.membership && canAssignRole(gate.role, 'member'),
			assignable_roles: gate.role ? ASSIGNABLE_ROLES.filter((r) => canAssignRole(gate.role, r)) : [],
			matrix: roleMatrix(),
			members: members.map((m) => ({
				user_id: m.userId,
				role: m.role,
				scoped: m.scoped,
				scope: m.scope,
				email: m.email,
				username: m.username,
				display_name: m.displayName,
				created_at: m.createdAt,
				can_manage: canManageMember(gate.role, m.role),
			})),
			invites: invites.map((i) => ({
				id: i.id,
				email: i.email,
				role: i.role,
				scope: i.scope,
				expires_at: i.expiresAt,
				created_at: i.createdAt,
			})),
		});
	}

	if (!(await requireCsrf(req, res, user.id))) return;

	const gate = await requireMembership(homeId, user.id, 'invite');
	if (!gate.ok) return error(res, gate.status, gate.code, gate.reason);

	const body = await readJson(req).catch(() => null);

	if (req.method === 'POST') {
		// An invite is a bearer credential for a role in a building. Rate limit it
		// like one, per account, so a compromised session cannot spray keys.
		const rl = await limits.homeInvite(user.id).catch(() => ({ success: true }));
		if (rl && rl.success === false) return rateLimited(res, rl, 'too many invitations, try again shortly');

		const email = emailish(body?.email);
		if (!email) return error(res, 400, 'bad_request', 'a valid email address is required');

		const role = String(body?.role || '').trim();
		if (!canAssignRole(gate.role, role)) {
			return error(res, 403, 'role_forbidden', `${a(gate.role)} cannot invite somebody as ${role ? a(role) : 'that role'}`);
		}

		// Seats are billed to the home's owner, not to whoever sent the invite, and
		// the ceiling counts outstanding invitations as well as members: an unspent
		// invite is a seat about to be taken, and discovering the refusal at the
		// moment somebody accepts is the worst time to discover it.
		try {
			await assertMemberCapacity(homeId);
		} catch (err) {
			if (!(err instanceof HomeQuotaError)) throw err;
			return error(res, err.status, err.code, err.message, {
				code: err.code,
				quota: { dimension: err.dimension, label: err.dimensionLabel, limit: err.limit, used: err.used, upgrade: err.upgradePath },
			});
		}

		// The home's own label, for the email. Read through the membership-resolved
		// store rather than trusted from the request, so an invitation can never
		// name a house the sender is not actually in.
		const home = await getConnection(homeId, user.id);

		const invite = await createInvite({
			homeId,
			email,
			role,
			scope: normalizeScope(body?.scope, role),
			invitedBy: user.id,
		});

		const url = inviteUrl(req, invite.token);

		// Mail it, and say honestly whether that worked.
		//
		// The link is still returned either way, because the send is the
		// convenience and the link is the invitation. A platform that mails the
		// only copy of a one-use credential and then fails to deliver it has
		// destroyed something the inviter cannot recreate without starting over,
		// so `emailed` reports what actually happened and the UI shows the link
		// beside it rather than promising a message that may never land.
		//
		// Awaited, unlike most sends here, for exactly that reason: `emailed:
		// true` is a claim about the world and a fire-and-forget send cannot make
		// it. `sendEmail` answers `{skipped:true}` with no RESEND_API_KEY, which is
		// the ordinary state on a preview deploy and is reported as not emailed
		// rather than as a failure.
		let emailed = false;
		try {
			const sent = await sendHouseholdInviteEmail({
				to: email,
				homeLabel: home?.label || null,
				role,
				inviterName: user.display_name || user.username || null,
				inviteUrl: url,
				expiresAt: invite.expiresAt,
			});
			emailed = !sent?.skipped;
		} catch (err) {
			// A dead mail provider must not cost somebody their invitation: the row
			// is already written and the link in this response still works.
			console.warn('[home-members] invite email failed', { home: homeId, error: err?.message });
		}

		logAudit({ userId: user.id, action: 'household.invite', resourceId: homeId, meta: { email, role, scope: invite.scope, emailed }, req });

		// The plaintext token exists in this response and nowhere else, ever.
		return json(res, 201, {
			invite: { id: invite.id, email: invite.email, role: invite.role, scope: invite.scope, expires_at: invite.expiresAt },
			invite_url: url,
			emailed,
		});
	}

	if (req.method === 'PATCH') {
		const targetId = String(body?.user_id || '').trim();
		if (!isUuid(targetId)) return error(res, 400, 'bad_request', 'user_id required');
		if (targetId === user.id) return error(res, 400, 'bad_request', 'you cannot change your own role');

		const target = await resolveMembership(homeId, targetId);
		if (!target) return error(res, 404, 'not_found', 'that person is not in this household');
		if (!canManageMember(gate.role, target.role)) {
			return error(res, 403, 'role_forbidden', `${a(gate.role)} cannot change ${a(target.role)}`);
		}

		const role = body?.role === undefined ? target.role : String(body.role).trim();
		if (!canAssignRole(gate.role, role)) {
			return error(res, 403, 'role_forbidden', `${a(gate.role)} cannot assign the ${role || 'requested'} role`);
		}

		const scope = body?.scope === undefined ? target.scope : body.scope;
		const updated = await setMemberRole({ homeId, userId: targetId, role, scope });
		if (!updated) return error(res, 404, 'not_found', 'that person is not in this household');

		logAudit({ userId: user.id, action: 'household.role_change', resourceId: homeId, meta: { target: targetId, from: target.role, to: updated.role, scope: updated.scope }, req });

		return json(res, 200, { member: { user_id: updated.userId, role: updated.role, scope: updated.scope, scoped: updated.scoped } });
	}

	// DELETE: a member, or an outstanding invitation.
	const inviteId = String(body?.invite_id || req.query?.invite_id || '').trim();
	if (inviteId) {
		if (!isUuid(inviteId)) return error(res, 400, 'bad_request', 'valid invite_id required');
		const withdrawn = await revokeInvite({ homeId, inviteId });
		if (!withdrawn) return error(res, 404, 'not_found', 'no such outstanding invitation');
		logAudit({ userId: user.id, action: 'household.invite_revoked', resourceId: homeId, meta: { invite: inviteId }, req });
		return json(res, 200, { revoked: true });
	}

	const targetId = String(body?.user_id || req.query?.user_id || '').trim();
	if (!isUuid(targetId)) return error(res, 400, 'bad_request', 'user_id or invite_id required');
	if (targetId === user.id) return error(res, 400, 'bad_request', 'you cannot remove yourself from a household you administer');

	const target = await resolveMembership(homeId, targetId);
	if (!target) return error(res, 404, 'not_found', 'that person is not in this household');
	if (!canManageMember(gate.role, target.role)) {
		return error(res, 403, 'role_forbidden', `${a(gate.role)} cannot remove ${a(target.role)}`);
	}

	const { removed, grantsRevoked } = await removeMember({ homeId, userId: targetId });
	if (!removed) return error(res, 404, 'not_found', 'that person is not in this household');

	logAudit({ userId: user.id, action: 'household.member_removed', resourceId: homeId, meta: { target: targetId, role: target.role, grants_revoked: grantsRevoked.length }, req });

	return json(res, 200, { removed: true, grants_revoked: grantsRevoked });
});
