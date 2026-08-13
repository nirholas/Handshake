// GET /api/friends/search?q=<term>
// Search accounts by display name / username to add as friends. Each hit is
// annotated with the caller's existing relationship so the UI renders the right
// action inline (Add / Pending / Friends).

import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { resolveAccount } from '../_lib/account-auth.js';
import { searchUsers } from '../_lib/friends-store.js';

// Display names and usernames top out far below this. A term longer than the cap
// is not a search, it is a large ILIKE pattern pointed at a sequential scan of
// every account, so it is rejected here rather than handed to Postgres unbounded.
const MAX_QUERY_LEN = 200;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await resolveAccount(req, res);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const url = new URL(req.url, 'http://x');
	const q = url.searchParams.get('q') || '';
	if (q.length > MAX_QUERY_LEN) {
		return error(res, 400, 'bad_query', `keep the search term under ${MAX_QUERY_LEN} characters`);
	}
	const results = await searchUsers(auth.userId, q);
	return json(res, 200, { data: { results } });
});
