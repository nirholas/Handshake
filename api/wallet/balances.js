// POST /api/wallet/balances
// body: { chain: 'solana'|'evm', address: string }
// → { chain, address, native: {symbol, amount, usd}, tokens: [{symbol, amount, usd, logo}] }

import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getBalances } from '../_lib/balances.js';
import { isValidSolanaAddress, isValidEvmAddress } from '../_lib/validate.js';
import { z } from 'zod';

// The address is caller-supplied, so its shape is checked here rather than left
// to the upstream RPC. Without this, a string that cannot be an address reads as
// a real empty wallet: Helius/DAS answers "no assets" for base58 garbage and the
// caller gets a 200 with zero balances instead of being told the input is wrong.
// It also stops arbitrary-length junk from costing an upstream round trip.
const bodySchema = z
	.object({
		chain: z.enum(['solana', 'evm']),
		address: z.string().trim().min(1),
	})
	.superRefine((body, ctx) => {
		const ok = body.chain === 'solana' ? isValidSolanaAddress : isValidEvmAddress;
		if (ok(body.address)) return;
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['address'],
			message:
				body.chain === 'solana'
					? 'must be a base58 Solana address (32-44 chars)'
					: 'must be a 0x-prefixed 40-character hex address',
		});
	});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		const raw = await readJson(req);
		body = bodySchema.parse(raw);
	} catch (e) {
		return error(res, 400, 'validation_error', e.message);
	}

	try {
		const result = await getBalances({ chain: body.chain, address: body.address });
		return json(res, 200, result);
	} catch (e) {
		if (e.code === 'not_configured') {
			return error(res, 503, 'not_configured', `missing env var: ${e.missing}`, {
				missing_key: e.missing,
			});
		}
		if (e.status === 502) {
			return error(res, 502, 'upstream_error', e.message);
		}
		throw e;
	}
});
