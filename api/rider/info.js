import { cors, json, method, wrap } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { TOKEN_MINT as THREE_MINT, TOKEN_SYMBOL } from '../_lib/token/config.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	return json(res, 200, {
		vault_address: env.RIDER_VAULT_ADDRESS ?? null,
		token_mint: THREE_MINT,
		token_symbol: TOKEN_SYMBOL,
		required_amount: 8000,
	});
});
