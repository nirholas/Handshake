// GET /api/community/me
// Returns the signed-in CoinCommunities user (from the session cookie) plus
// their linked wallets, so Town knows whether the composer can post directly or
// needs an X sign-in / wallet link first. Unauthenticated → { user: null }.
import { cors, error, json, method, wrap } from '../_lib/http.js';
import { cc, withAuthRefresh, UnconfiguredError } from '../_lib/coin-communities.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	res.setHeader('cache-control', 'no-store');

	let api;
	try {
		api = cc();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			return error(res, 503, 'cc_unconfigured', 'CoinCommunities is not configured');
		}
		throw err;
	}

	const { data, error: apiErr, headers } = await withAuthRefresh(req, res, async (h) => {
		const me = await api.userMe({ headers: h });
		if (me.error) return { error: me.error };
		const w = await api.getWallets({ headers: h });
		const wallets = w.error
			? []
			: (w.data?.wallets ?? []).map((x) => ({ address: x.address, chainType: x.chainType }));
		return { data: { user: me.data?.user, wallets } };
	});

	// No usable session — never signed in, or the refresh token itself expired.
	if (!headers) return json(res, 200, { data: { user: null } });
	if (apiErr) return error(res, 502, 'upstream_error', apiErr.message || 'failed to load user');

	const user = data.user
		? {
				id: data.user.id,
				username: data.user.username,
				avatar: data.user.profileImageUrl || null,
				followers: data.user.followerCount ?? 0,
			}
		: null;
	const solWallet = data.wallets.find((x) => x.chainType === 'svm')?.address || null;

	return json(res, 200, { data: { user, wallets: data.wallets, solWallet } });
});
