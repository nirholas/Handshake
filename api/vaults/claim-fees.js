// POST /api/vaults/claim-fees  { vaultId, toAgentId, idempotency_key? }
//
// Owner-only: sweep the vault's accrued performance fees to one of the owner's
// agent wallets. Capped at the vault's liquid USDC; the rest stays accrued until
// more liquidity is harvested.

import { randomUUID } from 'node:crypto';
import { cors, json, method, error, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { authWrite, loadOwnedAgent } from '../_lib/vault-auth.js';
import { getVault } from '../_lib/vault-store.js';
import { claimVaultFees } from '../_lib/vault-transfer.js';
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
	const toAgentId = String(body.toAgentId || body.to_agent_id || '').trim();
	if (!vaultId) return error(res, 400, 'validation_error', 'vaultId required');
	if (!isUuid(vaultId)) return error(res, 400, 'validation_error', 'vaultId must be a vault id');
	if (!toAgentId) return error(res, 400, 'validation_error', 'toAgentId required (the wallet to receive fees)');
	if (!isUuid(toAgentId)) return error(res, 400, 'validation_error', 'toAgentId must be an agent id');

	const vault = await getVault(vaultId);
	if (!vault) return error(res, 404, 'not_found', 'vault not found');
	if (vault.owner_user_id !== userId) return error(res, 403, 'forbidden', 'only the vault owner can claim fees');

	let toAgent;
	try { toAgent = await loadOwnedAgent(toAgentId, userId); } catch (e) { return error(res, e.status || 400, e.code || 'bad_request', e.message); }

	const result = await claimVaultFees({
		vaultId, ownerUserId: userId, toAgent,
		idempotencyKey: String(body.idempotency_key || `vault-fee-claim:${vaultId}:${randomUUID()}`).slice(0, 128),
	});

	if (result.status === 'failed') return error(res, 400, result.code, result.message, result.detail ? { detail: result.detail } : {});
	if (result.status === 'queued') return json(res, 202, { data: result }, { 'cache-control': 'no-store' });
	return json(res, 200, { data: result }, { 'cache-control': 'no-store' });
});
