// GET /api/pump/check-three-balance?wallet=<base58>&min=<raw_amount>
//
// Returns whether a wallet meets a $THREE token balance threshold.
// Used by the skill-execution gate: agents can require holders to carry a
// minimum $THREE balance before their paid skills are callable.
//
// {
//   wallet: string,
//   balance: number,   // raw token units
//   min: number,
//   eligible: boolean
// }

import { cors, json, method, error, wrap } from '../_lib/http.js';
import { checkThreeBalance } from '../_lib/three-gate.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const wallet = (req.query?.wallet || '').trim();
	const minRaw = parseInt(req.query?.min ?? '1', 10);

	if (!BASE58_RE.test(wallet)) {
		return error(res, 400, 'invalid_wallet', 'wallet must be a valid base58 public key');
	}
	if (isNaN(minRaw) || minRaw < 0) {
		return error(res, 400, 'invalid_min', 'min must be a non-negative integer');
	}

	// Validate pubkey early to surface bad input quickly
	try {
		const { PublicKey } = await import('@solana/web3.js');
		new PublicKey(wallet);
	} catch {
		return error(res, 400, 'invalid_wallet', 'wallet is not a valid Solana public key');
	}

	const result = await checkThreeBalance(wallet, minRaw);
	return json(res, 200, result, { 'cache-control': 'public, max-age=30, s-maxage=30' });
});
