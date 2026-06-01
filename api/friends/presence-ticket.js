// GET /api/friends/presence-ticket
// Mint a short-lived, HMAC-signed ticket the client hands to the multiplayer
// realm room on join. The room verifies it (without a callback to us) and then
// publishes the bearer's presence — so a client can never claim to be online as
// another account. The client refreshes the ticket before it expires.

import { cors, error, json, method, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { resolveAccount } from '../_lib/account-auth.js';
import { signPresenceTicket } from '../_lib/presence-store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const auth = await resolveAccount(req, res);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const { token, expiresIn } = await signPresenceTicket(auth.userId);
	return json(res, 200, { data: { token, expiresIn } });
});
