// POST /api/community/ws-ticket?token=<mint>
// Mints a short-lived WebSocket ticket for a coin's community. The browser
// then opens the realtime socket to CoinCommunities directly with this ticket
// (the API key never leaves the server). Returns the CC origin too so the
// client knows where to connect.
import { cors, error, json, method, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { cc, ccBaseUrl, isValidToken, UnconfiguredError } from '../_lib/coin-communities.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const token = new URL(req.url, 'http://x').searchParams.get('token');
	if (!isValidToken(token)) {
		return error(res, 400, 'validation_error', 'valid token query param required');
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

	const { data, error: apiErr } = await api.getWsTicket({ path: { token_address: token } });
	if (apiErr || !data?.ticket) {
		return error(res, 502, 'upstream_error', apiErr?.message || 'failed to mint ws ticket');
	}

	// Tickets are single-use and short-lived — never cache.
	res.setHeader('cache-control', 'no-store');
	return json(res, 200, { data: { ticket: data.ticket, baseUrl: ccBaseUrl() } });
});
