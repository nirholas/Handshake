// GET /api/agent/wallet — public read of the avatar's custodial wallet.
//
// Returns the avatar wallet address, network, live SOL balance and USD value,
// the per-send cap and the default recipient. No secrets are exposed. The
// widget polls this to render the wallet chip and refresh after a payout.

import { cors, json, method, wrap, error } from '../_lib/http.js';
import {
	avatarWalletConfig,
	getConnection,
	getSolBalance,
	solUsdPrice,
	explorerAccountUrl,
} from '../_lib/avatar-wallet.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const cfg = avatarWalletConfig();
	if (!cfg.configured) {
		return error(
			res,
			503,
			'wallet_unconfigured',
			'avatar wallet is not configured: set AVATAR_WALLET_SECRET (run scripts/gen-avatar-wallet.mjs)',
		);
	}

	const connection = getConnection(cfg.rpcUrl);
	// The RPC is a network boundary: a provider blip used to take the whole
	// response down with a sanitized 500, so the chip lost the address, the
	// explorer link and the send cap along with the balance. Report the balance
	// as unknown instead and keep every configured field, so the widget can
	// render "balance unavailable" over a wallet the user can still inspect.
	const [balance, solPriceUsd] = await Promise.all([
		getSolBalance(connection, cfg.address).catch(() => null),
		solUsdPrice().catch(() => 0),
	]);
	const lamports = balance ? balance.lamports : null;
	const sol = balance ? balance.sol : null;

	return json(
		res,
		200,
		{
			address: cfg.address,
			network: cfg.network,
			lamports,
			sol,
			balanceAvailable: balance != null,
			usd: sol != null && solPriceUsd ? sol * solPriceUsd : null,
			solPriceUsd: solPriceUsd || null,
			maxSendUsd: cfg.maxSendUsd,
			defaultRecipient: cfg.defaultRecipient,
			recipientLocked: cfg.lockRecipient,
			explorer: explorerAccountUrl(cfg.address, cfg.network),
		},
		// Short cache so the chip feels live without hammering the RPC. A failed
		// balance read is never cached: the next poll must be able to recover.
		{ 'Cache-Control': balance ? 'public, max-age=10' : 'no-store' },
	);
});
