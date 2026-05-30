// GET /api/community/auth/url
// Returns the X (Twitter) OAuth URL the browser opens to sign a user into
// CoinCommunities. The redirect lands on our same-origin callback, which
// completes the exchange and sets the session cookie. The redirect URL must be
// whitelisted in the CoinCommunities dashboard.
import { cors, error, json, method, wrap } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import { cc, UnconfiguredError } from '../../_lib/coin-communities.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	let api;
	try {
		api = cc();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			return error(res, 503, 'cc_unconfigured', 'CoinCommunities is not configured');
		}
		throw err;
	}

	const redirectUrl = `${env.APP_ORIGIN}/api/community/auth/callback`;
	const { data, error: apiErr } = await api.twitterAuthUrl({ query: { redirectUrl } });
	if (apiErr || !data?.authUrl) {
		// 400 here typically means the redirect isn't whitelisted in the dashboard.
		const msg =
			apiErr?.statusCode === 400
				? `OAuth redirect not whitelisted. Add ${redirectUrl} in your CoinCommunities dashboard.`
				: apiErr?.message || 'failed to build auth URL';
		return error(res, apiErr?.statusCode === 400 ? 400 : 502, 'auth_url_failed', msg);
	}

	res.setHeader('cache-control', 'no-store');
	return json(res, 200, { data: { authUrl: data.authUrl } });
});
