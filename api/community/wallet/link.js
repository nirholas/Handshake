// POST /api/community/wallet/link  { address, signature }
// Links a Solana wallet to the signed-in CoinCommunities user using the
// signature over the message from /wallet/challenge. Lets the user post from
// that wallet (subject to the community's token-balance gate).
import { z } from 'zod';
import { cors, error, json, method, readJson, wrap } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';
import { cc, userAuthHeaders, UnconfiguredError } from '../../_lib/coin-communities.js';

const schema = z.object({
	address: z.string().trim().min(32).max(60),
	signature: z.string().trim().min(1).max(200),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const headers = userAuthHeaders(req);
	if (!headers) return error(res, 401, 'unauthorized', 'sign in with X first');

	const parsed = schema.safeParse(await readJson(req).catch(() => null));
	if (!parsed.success) {
		return error(
			res,
			400,
			'validation_error',
			parsed.error.issues[0]?.message || 'invalid body',
		);
	}

	let api;
	try {
		api = cc();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			return error(res, 503, 'cc_unconfigured', 'CoinCommunities is not configured');
		}
		throw err;
	}

	const { data, error: apiErr } = await api.linkWallet({
		body: { address: parsed.data.address, chainType: 'svm', signature: parsed.data.signature },
		headers,
	});
	if (apiErr) {
		// 401 invalid signature, 409 already linked, 400 no pending challenge.
		const status = [400, 401, 409].includes(apiErr.statusCode) ? apiErr.statusCode : 502;
		return error(res, status, 'link_failed', apiErr.message || 'failed to link wallet');
	}

	return json(res, 200, { data: { address: data?.wallet?.address || parsed.data.address } });
});
