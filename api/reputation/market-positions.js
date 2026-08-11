/**
 * GET /api/reputation/market-positions?staker=<pubkey>&network=devnet
 *
 * Every reputation-market position a wallet holds, with earnings quoted against
 * the live cohort and the per-epoch derivation attached so a staker can audit
 * the number against src/shared/reputation-staking.js themselves.
 *
 * Read-only and walletless: a position's owner is the fee payer recorded
 * on-chain, so there is nothing private to gate here.
 *
 * Contract: specs/REPUTATION_STAKING_MARKET.md §8.
 */

import { PublicKey } from '@solana/web3.js';

import { cors, json, method, wrap, rateLimited, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isDbUnavailableError } from '../_lib/db.js';
import { stakerView, MarketError } from '../_lib/reputation-market.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const staker = (p.get('staker') || '').trim();
	const network = p.get('network') === 'mainnet' ? 'mainnet' : 'devnet';

	if (!staker) return error(res, 400, 'validation_error', 'staker query param required');
	try {
		new PublicKey(staker);
	} catch {
		return error(res, 400, 'validation_error', 'staker must be a base58 Solana pubkey');
	}

	try {
		const body = await stakerView({ staker, network });
		return json(res, 200, body, { 'cache-control': 'no-store' });
	} catch (err) {
		if (err instanceof MarketError) return error(res, err.status, err.code, err.message);
		if (isDbUnavailableError(err)) {
			return error(res, 503, 'db_unavailable', 'The market index is temporarily unavailable.');
		}
		throw err;
	}
});
