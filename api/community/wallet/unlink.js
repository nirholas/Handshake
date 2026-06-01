// POST /api/community/wallet/unlink
// Unlinks the signed-in user's Solana (svm) wallet(s) so they can link a
// different one — e.g. when the wallet they linked first doesn't hold the coin
// and they need to switch to the one that does. Idempotent: succeeds (unlinked:0)
// when nothing is linked, so the gate's "use a different wallet" path is safe to
// call from any state.
import { cors, error, json, method, wrap } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';
import { cc, userAuthHeaders, UnconfiguredError } from '../../_lib/coin-communities.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const headers = userAuthHeaders(req);
	if (!headers) return error(res, 401, 'unauthorized', 'sign in with X first');

	let api;
	try {
		api = cc();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			return error(res, 503, 'cc_unconfigured', 'CoinCommunities is not configured');
		}
		throw err;
	}

	const w = await api.getWallets({ headers });
	if (w.error) {
		if (w.error.statusCode === 401) {
			return error(res, 401, 'unauthorized', 'session expired — sign in again');
		}
		return error(res, 502, 'upstream_error', w.error.message || 'failed to read wallets');
	}

	// The holder check reads the first svm wallet, so removing every linked svm
	// wallet guarantees the next link is the one that gets verified.
	const svm = (w.data?.wallets ?? []).filter((x) => x.chainType === 'svm' && x.id);
	for (const wallet of svm) {
		const { error: delErr } = await api.unlinkWallet({ path: { id: wallet.id }, headers });
		// 404 — already gone; treat as success and keep going. Anything else is real.
		if (delErr && delErr.statusCode !== 404) {
			return error(res, 502, 'unlink_failed', delErr.message || 'failed to unlink wallet');
		}
	}

	return json(res, 200, { data: { unlinked: svm.length } });
});
