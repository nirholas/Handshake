// POST /api/vaults/trade  { vaultId, side, mint, usdc|amount|'max', slippageBps?, idempotency_key? }
//
// Owner-directed deployment of the POOLED vault capital into a real token position
// (buy: USDC→token) or a harvest back to USDC (sell: token→USDC). Every buy is
// checked against the vault's per-trade ceiling, rolling daily budget and on-chain
// balance before a key is touched; every fill is a real Jupiter swap; and the
// drawdown circuit breaker re-checks NAV after the trade and halts the vault if it
// has fallen past its max-drawdown limit.

import { randomUUID } from 'node:crypto';
import { cors, json, method, error, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { authWrite } from '../_lib/vault-auth.js';
import { getVault } from '../_lib/vault-store.js';
import { vaultTrade } from '../_lib/vault-trade.js';
import { usdcToAtomics, parseAmountInput } from '../_lib/vault-accounting.js';
import { isUuid, isValidSolanaAddress } from '../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const who = await authWrite(req, res);
	if (!who) return;
	const { userId } = who;

	const rl = await limits.tradePerUser(userId);
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try { body = (await readJson(req)) || {}; } catch (e) { return error(res, e?.status === 415 ? 415 : 400, 'bad_request', e?.message || 'invalid body'); }

	const vaultId = String(body.vaultId || body.vault_id || '').trim();
	const side = body.side === 'sell' ? 'sell' : body.side === 'buy' ? 'buy' : null;
	const mint = String(body.mint || '').trim();
	if (!vaultId) return error(res, 400, 'validation_error', 'vaultId required');
	if (!isUuid(vaultId)) return error(res, 400, 'validation_error', 'vaultId must be a vault id');
	if (!side) return error(res, 400, 'validation_error', 'side must be "buy" or "sell"');
	if (!mint) return error(res, 400, 'validation_error', 'mint required');
	if (!isValidSolanaAddress(mint)) return error(res, 400, 'validation_error', 'mint must be a Solana mint address');

	const vault = await getVault(vaultId);
	if (!vault) return error(res, 404, 'not_found', 'vault not found');
	if (vault.owner_user_id !== userId) return error(res, 403, 'forbidden', 'only the vault owner can direct trades');

	const slippageBps = Number.isFinite(Number(body.slippageBps)) ? Math.round(Number(body.slippageBps)) : 100;

	let usdcInAtomics; let amountRaw;
	if (side === 'buy') {
		const usdc = Number(body.usdc);
		if (!(usdc > 0)) return error(res, 400, 'validation_error', 'usdc must be a positive number for a buy');
		usdcInAtomics = usdcToAtomics(usdc);
	} else if (body.amount === 'max' || body.amount == null) {
		amountRaw = 'max';
	} else {
		amountRaw = parseAmountInput(body.amount);
		if (amountRaw == null) return error(res, 400, 'validation_error', 'amount must be a positive number or "max"');
	}

	const result = await vaultTrade({
		vaultId, userId, side, mint, usdcInAtomics, amountRaw, slippageBps,
		idempotencyKey: String(body.idempotency_key || `vault-trade:${vaultId}:${side}:${mint}:${randomUUID()}`).slice(0, 128),
	});

	if (result.status === 'blocked') return error(res, 403, result.code, result.message, result.detail ? { detail: result.detail } : {});
	if (result.status === 'failed') return error(res, result.code === 'not_found' ? 404 : 400, result.code, result.message, result.detail ? { detail: result.detail } : {});
	return json(res, 200, { data: result }, { 'cache-control': 'no-store' });
});
