// POST /api/vaults/deposit  { vaultId, backerAgentId, usdc, idempotency_key? }
//
// Back an agent: deposit USDC from one of YOUR agents' custodial wallets into the
// vault and receive shares priced at live NAV. The transfer is the platform's
// guarded agent→agent USDC settlement, so it respects the funding wallet's spend
// policy + kill switch and is fully audited on both sides.

import { randomUUID } from 'node:crypto';
import { cors, json, method, error, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { authWrite, loadOwnedAgent } from '../_lib/vault-auth.js';
import { getVault } from '../_lib/vault-store.js';
import { depositToVault } from '../_lib/vault-transfer.js';
import { usdcToAtomics } from '../_lib/vault-accounting.js';
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
	const backerAgentId = String(body.backerAgentId || body.backer_agent_id || '').trim();
	const usdc = Number(body.usdc);
	if (!vaultId) return error(res, 400, 'validation_error', 'vaultId required');
	if (!isUuid(vaultId)) return error(res, 400, 'validation_error', 'vaultId must be a vault id');
	if (!backerAgentId) return error(res, 400, 'validation_error', 'backerAgentId required (the agent wallet to fund from)');
	if (!isUuid(backerAgentId)) return error(res, 400, 'validation_error', 'backerAgentId must be an agent id');
	if (!(usdc > 0)) return error(res, 400, 'validation_error', 'usdc must be a positive number');

	const vault = await getVault(vaultId);
	if (!vault) return error(res, 404, 'not_found', 'vault not found');

	let backerAgent;
	try { backerAgent = await loadOwnedAgent(backerAgentId, userId); } catch (e) { return error(res, e.status || 400, e.code || 'bad_request', e.message); }
	if (!backerAgent.meta?.solana_address || !backerAgent.meta?.encrypted_solana_secret) {
		return error(res, 400, 'wallet_unready', 'that agent has no funded Solana wallet yet. Provision and fund it first.');
	}

	const result = await depositToVault({
		vault, backerAgent, userId,
		usdcAtomics: usdcToAtomics(usdc),
		idempotencyKey: String(body.idempotency_key || `vault-deposit:${vaultId}:${backerAgentId}:${randomUUID()}`).slice(0, 128),
	});

	if (result.status === 'blocked') return error(res, 403, result.code, result.message, result.detail ? { detail: result.detail } : {});
	if (result.status === 'failed') return error(res, 402, result.code, result.message);
	return json(res, 200, { data: result }, { 'cache-control': 'no-store' });
});
