// GET /api/users/lookup?q=<username | wallet | user id>
//
// Resolves a public identifier to a minimal public profile, so the gift flow can
// confirm "you're sending this to <name>" before the buyer pays. Auth-gated to
// keep it from becoming an anonymous scraping/enumeration surface; returns only
// public fields (id, username, display name, avatar) and never the email.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { resolveRecipient } from '../_lib/resolve-recipient.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const callerId = session?.id ?? bearer.userId;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const q = new URL(req.url, 'http://x').searchParams.get('q');
	if (!q || !q.trim()) return error(res, 400, 'validation_error', 'q is required');

	const user = await resolveRecipient(q);
	if (!user) return error(res, 404, 'not_found', 'no user matches that username or wallet');

	return json(
		res,
		200,
		{
			data: {
				id: user.id,
				username: user.username,
				display_name: user.display_name,
				avatar_url: user.avatar_url,
				is_self: user.id === callerId,
			},
		},
		{ 'cache-control': 'no-store' },
	);
});
