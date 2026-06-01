// GET /api/friends/search?q=<term>
// Search accounts by display name / username to add as friends. Each hit is
// annotated with the caller's existing relationship so the UI renders the right
// action inline (Add / Pending / Friends).

import { cors, error, json, method, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { resolveAccount } from '../_lib/account-auth.js';
import { searchUsers } from '../_lib/friends-store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const auth = await resolveAccount(req, res);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const url = new URL(req.url, 'http://x');
	const q = url.searchParams.get('q') || '';
	const results = await searchUsers(auth.userId, q);
	return json(res, 200, { data: { results } });
});
