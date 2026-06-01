// GET /api/play/nonce
//
// Hands the /play sign-in flow a fresh, self-verifying nonce to embed in the
// message the wallet signs. Also tells the client whether the token gate is even
// active (required) and what it demands (mint + minBalance) so the gate UI can
// state the exact requirement and skip the whole flow when the platform hasn't
// pinned a game token yet.
import { cors, error, json, method, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { issueNonce, PLAY_GATE_MINT, PLAY_GATE_MIN, PLAY_GATE_SYMBOL } from '../_lib/play-pass.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	res.setHeader('cache-control', 'no-store');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const { nonce, exp } = issueNonce();
	return json(res, 200, {
		data: {
			nonce,
			expiresAt: new Date(exp * 1000).toISOString(),
			// The gate is only enforced once the platform pins a game token. When no
			// mint is configured the client skips sign-in entirely (open /play).
			required: !!PLAY_GATE_MINT,
			mint: PLAY_GATE_MINT,
			minBalance: PLAY_GATE_MIN,
			symbol: PLAY_GATE_SYMBOL,
		},
	});
});
