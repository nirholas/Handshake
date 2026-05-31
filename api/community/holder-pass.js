// POST /api/community/holder-pass?token=<mint>
//
// Mints a holder pass — proof a signed-in user holds at least HOLDER_MIN_USD of
// a coin — so the multiplayer server can admit them into that coin's gated
// Holders world without running Solana RPC itself.
//
// The check is on the user's *authenticated* wallet: we read the linked Solana
// wallet from their CoinCommunities session server-side, price its on-chain
// balance of this exact mint (Helius DAS + Jupiter, via the shared balances
// lib), and only then sign a pass. The browser never supplies the wallet, so a
// pass can't be minted against someone else's address.
//
// Responses (always 200 unless the request itself is bad):
//   { eligible: true,  usd, amount, minUsd, wallet, holderPass }  — admit
//   { eligible: false, usd, amount, minUsd, wallet }              — short; UI
//                                                                    shows buy CTA
// Auth/wallet problems are real errors the gate UI routes on:
//   401 auth_required   — not signed in to CoinCommunities
//   403 wallet_required — signed in but no linked Solana wallet
import { cors, error, json, method, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { cc, userAuthHeaders, isValidToken, UnconfiguredError } from '../_lib/coin-communities.js';
import { getBalances } from '../_lib/balances.js';
import { HOLDER_MIN_USD, signHolderPass } from '../_lib/holder-pass.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	res.setHeader('cache-control', 'no-store');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const token = new URL(req.url, 'http://x').searchParams.get('token');
	if (!isValidToken(token)) {
		return error(res, 400, 'validation_error', 'valid token query param required');
	}

	const headers = userAuthHeaders(req);
	if (!headers) {
		return error(res, 401, 'auth_required', 'sign in with X to enter a holder world');
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

	// The wallet is taken from the authenticated session — never the request body.
	const w = await api.getWallets({ headers });
	if (w.error) {
		if (w.error.statusCode === 401) {
			return error(res, 401, 'auth_required', 'session expired — sign in again');
		}
		return error(res, 502, 'upstream_error', w.error.message || 'failed to read wallets');
	}
	const wallet = (w.data?.wallets ?? []).find((x) => x.chainType === 'svm')?.address || null;
	if (!wallet) {
		return error(res, 403, 'wallet_required', 'link a Solana wallet to verify your holdings');
	}

	// Price the wallet's on-chain holding of this exact coin.
	let balances;
	try {
		balances = await getBalances({ chain: 'solana', address: wallet });
	} catch (err) {
		const status = err?.status === 503 ? 503 : 502;
		return error(res, status, 'balance_unavailable', err?.message || 'could not read on-chain balance');
	}

	const holding =
		token === SOL_MINT
			? balances?.native
			: (balances?.tokens ?? []).find((t) => t.mint === token);
	const usd = Math.round((holding?.usd || 0) * 100) / 100;
	const amount = holding?.amount || 0;
	const minUsd = HOLDER_MIN_USD;

	if (usd >= minUsd) {
		const holderPass = signHolderPass({ mint: token, wallet, usd });
		return json(res, 200, { data: { eligible: true, usd, amount, minUsd, wallet, holderPass } });
	}
	return json(res, 200, { data: { eligible: false, usd, amount, minUsd, wallet } });
});
