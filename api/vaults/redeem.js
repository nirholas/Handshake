// POST /api/vaults/redeem  { vaultId, shares|'max', idempotency_key? }
//
// Redeem your shares at real NAV. The owner's performance fee is charged only on
// your realized gain. If the vault can't pay the full claim instantly (capital is
// live in open positions), we redeem what the liquid USDC covers and queue the
// rest honestly, never a fake instant number.

import { randomUUID } from 'node:crypto';
import { cors, json, method, error, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { authWrite } from '../_lib/vault-auth.js';
import { redeemFromVault } from '../_lib/vault-transfer.js';
import { parseAmountInput } from '../_lib/vault-accounting.js';
import { isUuid } from '../_lib/validate.js';

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
	if (!vaultId) return error(res, 400, 'validation_error', 'vaultId required');
	if (!isUuid(vaultId)) return error(res, 400, 'validation_error', 'vaultId must be a vault id');

	let sharesIn = 'max';
	if (body.shares !== 'max' && body.shares != null) {
		const parsed = parseAmountInput(body.shares);
		if (parsed == null) return error(res, 400, 'validation_error', 'shares must be a positive number or "max"');
		sharesIn = String(parsed);
	}

	const result = await redeemFromVault({
		vaultId, userId, shares: sharesIn,
		idempotencyKey: String(body.idempotency_key || `vault-redeem:${vaultId}:${userId}:${randomUUID()}`).slice(0, 128),
	});

	if (result.status === 'failed') return error(res, result.code === 'not_found' ? 404 : 400, result.code, result.message, result.detail ? { detail: result.detail } : {});
	if (result.status === 'queued') return json(res, 202, { data: result }, { 'cache-control': 'no-store' });
	return json(res, 200, { data: result }, { 'cache-control': 'no-store' });
});
