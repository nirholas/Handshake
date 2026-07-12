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
import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { cc, withAuthRefresh, isValidToken, UnconfiguredError } from '../_lib/coin-communities.js';
import { getBalances, solanaMintUsdPrice } from '../_lib/balances.js';
import { HOLDER_MIN_USD, signHolderPass } from '../_lib/holder-pass.js';
import { readWorldGate } from '../_lib/world-gate.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// A user may have linked more than one Solana wallet over time and hold the coin
// in any of them. Read each (bounded) and gate on the combined holding so we
// never reject a real holder for linking a second, empty wallet first.
const MAX_WALLETS_CHECKED = 5;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	res.setHeader('cache-control', 'no-store');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

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

	// The wallets are taken from the authenticated session — never the request
	// body. Transparently refreshes an expired (1h) access token off the 30-day
	// refresh token before giving up, so a player who's been signed in for a
	// while isn't wrongly bounced out of the holders-world gate as "not signed in".
	const { data: wData, error: wErr, headers } = await withAuthRefresh(req, res, (h) =>
		api.getWallets({ headers: h }),
	);
	if (!headers) {
		return error(res, 401, 'auth_required', 'sign in with X to enter a holder world');
	}
	if (wErr) {
		return error(res, 502, 'upstream_error', wErr.message || 'failed to read wallets');
	}
	const svmWallets = (wData?.wallets ?? [])
		.filter((x) => x.chainType === 'svm')
		.map((x) => x.address)
		.filter(Boolean);
	if (svmWallets.length === 0) {
		return error(res, 403, 'wallet_required', 'link a Solana wallet to verify your holdings');
	}

	// Sum this exact coin's holding across the user's linked Solana wallets, and
	// keep the best on-chain price any of them resolved. We report the wallet
	// holding the most of the coin.
	let amount = 0;
	let priceFromBalances = 0;
	let primaryWallet = svmWallets[0];
	let largestHolding = -1;
	let balanceError = null;
	for (const address of svmWallets.slice(0, MAX_WALLETS_CHECKED)) {
		let balances;
		try {
			balances = await getBalances({ chain: 'solana', address });
		} catch (err) {
			balanceError = err;
			continue;
		}
		const holding =
			token === SOL_MINT
				? balances?.native
				: (balances?.tokens ?? []).find((t) => t.mint === token);
		const held = holding?.amount || 0;
		amount += held;
		if (holding?.price > 0) priceFromBalances = holding.price;
		if (held > largestHolding) {
			largestHolding = held;
			primaryWallet = address;
		}
	}
	// Only surface an upstream error if we couldn't read *any* wallet — a partial
	// failure still gates correctly on whatever we did read.
	if (amount === 0 && balanceError) {
		const status = balanceError?.status === 503 ? 503 : 502;
		return error(res, status, 'balance_unavailable', balanceError?.message || 'could not read on-chain balance');
	}

	// Price the holding. The generic balance read prices via Helius/Jupiter, which
	// leaves a 0 for coins neither source routes yet (fresh bonding-curve pump.fun
	// coins). When we hold some but it came back unpriced, fetch a real price
	// (Jupiter → pump.fun curve) so a genuine holder is never gated at $0.
	let price = priceFromBalances;
	if (amount > 0 && price <= 0 && token !== SOL_MINT) {
		price = await solanaMintUsdPrice(token);
	}
	const usd = Math.round(amount * price * 100) / 100;
	const wallet = primaryWallet;
	const minUsd = HOLDER_MIN_USD;

	// A coin's creator may pin a token-amount threshold (R24); absent that, the
	// world gates on the platform USD floor. Read it best-effort — a KV hiccup
	// falls back to the USD floor rather than wrongly locking the world.
	const gate = await readWorldGate(token);
	const minTokens = gate?.minTokens || 0;
	const eligible = minTokens > 0 ? amount >= minTokens : usd >= minUsd;

	if (eligible) {
		const holderPass = signHolderPass({ mint: token, wallet, usd, amount, minTokens });
		return json(res, 200, { data: { eligible: true, usd, amount, minUsd, minTokens, wallet, holderPass } });
	}
	return json(res, 200, { data: { eligible: false, usd, amount, minUsd, minTokens, wallet } });
});
