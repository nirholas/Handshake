// GET /api/premium/status?wallet=<base58> — pass state for one wallet.
//
// Returns { active, pass, keys, resources, history } — everything the
// developer dashboard needs in one call. Key prefixes and usage counts only;
// the plaintext key is never re-derivable.

import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { passStatus } from '../_lib/premium.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.premiumStatusIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const wallet = (new URL(req.url, 'http://x').searchParams.get('wallet') || '').trim();
	try {
		const status = await passStatus(wallet);
		return json(res, 200, status, { 'cache-control': 'no-store' });
	} catch (e) {
		return error(res, e.status || 502, e.code || 'status_failed', e.message);
	}
});
