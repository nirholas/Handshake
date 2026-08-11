/**
 * POST /api/reputation/market-stake  { signature, network }
 *
 * Record a stake the staker ALREADY broadcast. This endpoint never signs and
 * never moves funds: it reads the transaction back off Solana, checks it against
 * the market envelope rules, and indexes the position it opens. The caller
 * cannot assert a principal, an agent, or an owner; all three come from the
 * chain (specs/REPUTATION_STAKING_MARKET.md §3.1).
 *
 * Idempotent on the stake signature.
 */

import { cors, json, method, wrap, rateLimited, error, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isDbUnavailableError } from '../_lib/db.js';
import { recordStake, MarketError } from '../_lib/reputation-market.js';

const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => null);
	const signature = String(body?.signature || '').trim();
	const network = body?.network === 'mainnet' ? 'mainnet' : 'devnet';

	if (!SIGNATURE_RE.test(signature)) {
		return error(res, 400, 'validation_error', 'signature must be a base58 Solana transaction signature');
	}

	try {
		const { position, created } = await recordStake({ signature, network });
		return json(res, created ? 201 : 200, {
			ok: true,
			created,
			position: {
				signature: position.signature,
				network: position.network,
				agent_asset: position.agentAsset,
				staker: position.staker,
				principal_lamports: position.principalLamports.toString(),
				score: position.score,
				status: position.status,
				opened_at: new Date(position.openedAt * 1000).toISOString(),
			},
		});
	} catch (err) {
		if (err instanceof MarketError) return error(res, err.status, err.code, err.message);
		if (isDbUnavailableError(err)) {
			return error(res, 503, 'db_unavailable', 'The market index is temporarily unavailable.');
		}
		throw err;
	}
});
