// Redeeming a household invitation: /api/home/invites/:token
//
//   GET   what this link is for, without spending it
//   POST  spend it, and join the household
//
// The GET exists so the join screen can say "Alex invited you to The office as a
// guest" before it asks anyone to sign in or register. Showing that first is the
// difference between an invite that converts and a login wall that does not, and
// it costs nothing: the token is a bearer credential either way, and inspecting
// it discloses only what its holder was already sent.
//
// Accepting requires an account. This endpoint deliberately does not create one:
// registration and sign-in already exist, they carry the captcha, the password
// rules and the session handling, and a second door into account creation is a
// second door to keep secure. An unauthenticated POST answers 401 with the
// invite still intact, so the client can send the visitor through /register and
// bring them straight back to the same link.

import { logAudit } from '../../_lib/audit.js';
import { getSessionUser } from '../../_lib/auth.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { acceptInvite, inspectInvite } from '../../_lib/home/members.js';
import { cors, error, json, method, rateLimited, wrap } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';

// A refusal the holder can act on. `code` distinguishes the four dead ends so the
// join screen can say which one happened: an expired link and a link that was
// already used need different words and different next steps.
const REFUSAL_STATUS = {
	invite_not_found: 404,
	invite_revoked: 410,
	invite_spent: 410,
	invite_expired: 410,
	home_revoked: 410,
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const token = String(req.query?.token || '').trim();
	// The shape a token can possibly have, checked before it reaches a query: a
	// 32-byte base64url string. Anything else is a probe and costs no round trip.
	if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
		return error(res, 404, 'invite_not_found', 'this invitation link is not valid');
	}

	// Token guessing is the only attack this endpoint has. The token is 256 bits
	// of randomness so guessing it is not feasible, but the limiter is what makes
	// that a bounded claim rather than a hopeful one.
	const rl = await limits.homeInviteRedeem(clientIp(req)).catch(() => ({ success: true }));
	if (rl && rl.success === false) return rateLimited(res, rl, 'too many attempts, try again shortly');

	if (req.method === 'GET') {
		const looked = await inspectInvite(token);
		if (!looked.ok) return error(res, REFUSAL_STATUS[looked.code] ?? 404, looked.code, looked.reason);
		return json(res, 200, {
			home: { id: looked.invite.homeId, label: looked.homeLabel },
			role: looked.invite.role,
			scope: looked.invite.scope,
			email: looked.invite.email,
			expires_at: looked.invite.expiresAt,
		});
	}

	const user = await getSessionUser(req, res).catch(() => null);
	if (!user) {
		return error(res, 401, 'unauthorized', 'sign in or create an account to accept this invitation');
	}
	if (!(await requireCsrf(req, res, user.id))) return;

	const accepted = await acceptInvite({ token, userId: user.id });
	if (!accepted.ok) return error(res, REFUSAL_STATUS[accepted.code] ?? 404, accepted.code, accepted.reason);

	logAudit({
		userId: user.id,
		action: 'household.invite_accepted',
		resourceId: accepted.membership?.homeId ?? null,
		meta: { role: accepted.membership?.role ?? null, already_member: accepted.alreadyMember },
		req,
	});

	return json(res, accepted.alreadyMember ? 200 : 201, {
		home: { id: accepted.membership.homeId, label: accepted.homeLabel },
		role: accepted.membership.role,
		scope: accepted.membership.scope,
		already_member: accepted.alreadyMember,
	});
});
