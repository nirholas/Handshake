// GET /api/rider/info
//
// Public terms of the rider pass: where to send $THREE, which mint, and how much.
// `accepting_payments` is false when RIDER_VAULT_ADDRESS is unset, so a client
// never renders a "send 8,000 $THREE" call to action with no destination.

import { cors, json, method, wrap } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { REQUIRED_AMOUNT } from '../_lib/rider.js';
import { TOKEN_MINT as THREE_MINT, TOKEN_SYMBOL } from '../_lib/token/config.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const vaultAddress = env.RIDER_VAULT_ADDRESS ?? null;
	return json(res, 200, {
		vault_address: vaultAddress,
		token_mint: THREE_MINT,
		token_symbol: TOKEN_SYMBOL,
		required_amount: REQUIRED_AMOUNT,
		accepting_payments: Boolean(vaultAddress),
	});
});
