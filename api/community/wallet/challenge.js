// POST /api/community/wallet/challenge  { address }
// Requests a sign-in challenge to link a Solana wallet (chainType 'svm') to the
// signed-in CoinCommunities user. Returns the message the wallet must sign.
import { z } from 'zod';
import { cors, error, json, method, readJson, wrap } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';
import { cc, userAuthHeaders, UnconfiguredError } from '../../_lib/coin-communities.js';

const schema = z.object({ address: z.string().trim().min(32).max(60) });

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const headers = userAuthHeaders(req);
	if (!headers) return error(res, 401, 'unauthorized', 'sign in with X first');

	const parsed = schema.safeParse(await readJson(req).catch(() => null));
	if (!parsed.success) return error(res, 400, 'validation_error', 'address required');

	let api;
	try {
		api = cc();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			return error(res, 503, 'cc_unconfigured', 'CoinCommunities is not configured');
		}
		throw err;
	}

	const { data, error: apiErr } = await api.walletChallenge({
		body: { address: parsed.data.address, chainType: 'svm' },
		headers,
	});
	if (apiErr || !data?.message) {
		return error(res, 502, 'upstream_error', apiErr?.message || 'failed to create challenge');
	}

	res.setHeader('cache-control', 'no-store');
	return json(res, 200, { data: { message: data.message, nonce: data.nonce } });
});
