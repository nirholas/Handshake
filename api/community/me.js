// GET /api/community/me
// Returns the signed-in CoinCommunities user (from the session cookie) plus
// their linked wallets, so Town knows whether the composer can post directly or
// needs an X sign-in / wallet link first. Unauthenticated → { user: null }.
import { cors, error, json, method, wrap } from '../_lib/http.js';
import {
	cc,
	userAuthHeaders,
	clearUserSession,
	UnconfiguredError,
} from '../_lib/coin-communities.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	res.setHeader('cache-control', 'no-store');

	const headers = userAuthHeaders(req);
	if (!headers) return json(res, 200, { data: { user: null } });

	let api;
	try {
		api = cc();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			return error(res, 503, 'cc_unconfigured', 'CoinCommunities is not configured');
		}
		throw err;
	}

	const { data, error: apiErr } = await api.userMe({ headers });
	if (apiErr) {
		// Expired/invalid session — clear it so the client falls back to sign-in.
		if (apiErr.statusCode === 401) {
			clearUserSession(res);
			return json(res, 200, { data: { user: null } });
		}
		return error(res, 502, 'upstream_error', apiErr.message || 'failed to load user');
	}

	let wallets = [];
	const w = await api.getWallets({ headers });
	if (!w.error)
		wallets = (w.data?.wallets ?? []).map((x) => ({
			address: x.address,
			chainType: x.chainType,
		}));

	const user = data?.user
		? {
				id: data.user.id,
				username: data.user.username,
				avatar: data.user.profileImageUrl || null,
				followers: data.user.followerCount ?? 0,
			}
		: null;
	const solWallet = wallets.find((x) => x.chainType === 'svm')?.address || null;

	return json(res, 200, { data: { user, wallets, solWallet } });
});
