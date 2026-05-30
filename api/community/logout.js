// POST /api/community/logout — clears the CoinCommunities user session cookies.
import { cors, json, method, wrap } from '../_lib/http.js';
import { clearUserSession } from '../_lib/coin-communities.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	clearUserSession(res);
	return json(res, 200, { data: { ok: true } });
});
