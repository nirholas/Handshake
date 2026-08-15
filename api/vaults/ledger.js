// GET /api/vaults/ledger?vault_id=…&before=…&type=…
//
// The vault's immutable audit trail: every open, deposit, redeem, trade, fee,
// drawdown halt, pause/resume and terms change, newest first, with the on-chain
// signature where one exists. Public: this is the transparency that makes backing
// rational.

import { cors, json, method, error, wrap } from '../_lib/http.js';
import { getVault, listVaultEvents } from '../_lib/vault-store.js';
import { explorerTxUrl } from '../_lib/avatar-wallet.js';
import { isUuid } from '../_lib/validate.js';

const TYPES = new Set(['open', 'deposit', 'redeem', 'trade', 'fee', 'fee_claim', 'drawdown_halt', 'pause', 'resume', 'terms', 'close', 'nav']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const vaultId = url.searchParams.get('vault_id') || url.searchParams.get('vaultId');
	if (!vaultId || !isUuid(vaultId)) return error(res, 400, 'validation_error', 'vault_id required');

	const vault = await getVault(vaultId);
	if (!vault) return error(res, 404, 'not_found', 'vault not found');

	const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50));
	const beforeRaw = url.searchParams.get('before');
	const beforeId = beforeRaw && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : null;
	const typeRaw = url.searchParams.get('type');
	const type = typeRaw && TYPES.has(typeRaw) ? typeRaw : null;

	const rows = await listVaultEvents(vaultId, { limit, beforeId, type });
	const items = rows.map((e) => ({
		id: Number(e.id), type: e.type, status: e.status, reason: e.reason,
		shares_delta: e.shares_delta != null ? String(e.shares_delta) : null,
		atomics_delta: e.atomics_delta != null ? String(e.atomics_delta) : null,
		nav_atomics: e.nav_atomics != null ? String(e.nav_atomics) : null,
		share_price_e6: e.share_price_e6 != null ? String(e.share_price_e6) : null,
		signature: e.signature || null,
		explorer: e.signature ? explorerTxUrl(e.signature, vault.network) : null,
		meta: e.meta || {},
		created_at: e.created_at,
	}));
	const nextCursor = rows.length === limit ? Number(rows[rows.length - 1].id) : null;
	return json(res, 200, { data: { items, next_cursor: nextCursor } }, { 'cache-control': 'public, max-age=8, s-maxage=15' });
});
