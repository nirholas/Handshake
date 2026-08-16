/**
 * GET /api/users/me/transaction-history
 * Returns the authenticated caller's skill purchase/sale history.
 *
 * Query params:
 *   ?role=buyer  : only purchases where the caller bought
 *   ?role=seller — only sales where the caller's agent was the seller
 *   ?role=all    : both, merged and sorted by date desc (the default)
 *   ?limit=50    — number of rows (max 200, default 50)
 *   ?offset=0    — pagination offset
 *
 * Each row includes a `role` field ('buyer' or 'seller'), a decimals-aware
 * `amount_display` (the amount that actually settled — for 'tipped' rows that is
 * the on-chain amount, not the original quote), the seller's `net_display`
 * (gross minus platform fee), and an `explorer_url` to the block explorer.
 */

import { sql } from '../../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../../_lib/auth.js';
import { cors, error, json, method, wrap, rateLimited } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';

const SOLSCAN_BASE = 'https://solscan.io/tx';

function txLink(chain, signature) {
	if (!signature) return null;
	if (chain === 'solana') return `${SOLSCAN_BASE}/${signature}`;
	// EVM chains: use Basescan for Base, Etherscan fallback
	if (chain === 'base') return `https://basescan.org/tx/${signature}`;
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id || bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const role   = params.get('role') || 'all';
	const limit  = Math.min(200, Math.max(1, parseInt(params.get('limit') || '50', 10) || 50));
	const offset = Math.max(0, parseInt(params.get('offset') || '0', 10) || 0);

	if (!['buyer', 'seller', 'all'].includes(role)) {
		return error(res, 400, 'validation_error', 'role must be buyer, seller, or all');
	}

	// Buyer leg: purchases made by this user
	const buyerRows = (role === 'buyer' || role === 'all') ? await sql`
		SELECT
			sp.id,
			sp.agent_id,
			sp.skill,
			sp.status,
			sp.kind,
			sp.amount,
			sp.tipped_amount,
			sp.platform_fee_amount,
			COALESCE(asp.mint_decimals, 6) AS mint_decimals,
			sp.currency_mint,
			sp.chain,
			sp.tx_signature,
			sp.skill_nft_mint,
			sp.confirmed_at,
			sp.created_at,
			ai.name              AS agent_name,
			ai.profile_image_url AS agent_thumbnail,
			'buyer'::text AS role
		FROM skill_purchases sp
		LEFT JOIN agent_identities ai ON ai.id = sp.agent_id
		LEFT JOIN agent_skill_prices asp ON asp.agent_id = sp.agent_id AND asp.skill = sp.skill
		WHERE sp.user_id = ${userId}
		  AND sp.status IN ('confirmed', 'tipped', 'trial')
		ORDER BY sp.confirmed_at DESC NULLS LAST, sp.created_at DESC
		LIMIT ${limit} OFFSET ${offset}
	` : [];

	// Seller leg: confirmed purchases of skills on agents this user owns
	const sellerRows = (role === 'seller' || role === 'all') ? await sql`
		SELECT
			sp.id,
			sp.agent_id,
			sp.skill,
			sp.status,
			sp.kind,
			sp.amount,
			sp.tipped_amount,
			sp.platform_fee_amount,
			COALESCE(asp.mint_decimals, 6) AS mint_decimals,
			sp.currency_mint,
			sp.chain,
			sp.tx_signature,
			sp.skill_nft_mint,
			sp.confirmed_at,
			sp.created_at,
			ai.name              AS agent_name,
			ai.profile_image_url AS agent_thumbnail,
			'seller'::text AS role
		FROM skill_purchases sp
		JOIN agent_identities ai ON ai.id = sp.agent_id AND ai.user_id = ${userId}
		LEFT JOIN agent_skill_prices asp ON asp.agent_id = sp.agent_id AND asp.skill = sp.skill
		WHERE sp.status IN ('confirmed', 'tipped')
		ORDER BY sp.confirmed_at DESC NULLS LAST, sp.created_at DESC
		LIMIT ${limit} OFFSET ${offset}
	` : [];

	// Merge and sort by date
	const all = [...buyerRows, ...sellerRows].sort((a, b) => {
		const ta = new Date(a.confirmed_at || a.created_at).getTime();
		const tb = new Date(b.confirmed_at || b.created_at).getTime();
		return tb - ta;
	});

	// A user who bought a skill on their own agent legitimately appears once per
	// leg (one 'buyer' row, one 'seller' row): the two rows report different
	// money (what they paid vs. what they netted), so both are kept and the
	// merge above is the whole story.

	const toUnits = (atomics, decimals) => {
		const n = Number(atomics);
		if (!Number.isFinite(n)) return '0.00';
		return (n / 10 ** decimals).toFixed(2);
	};

	const transactions = all.slice(0, limit).map((row) => {
		const decimals = Number(row.mint_decimals ?? 6) || 6;
		// 'tipped' rows settled for a different amount than the quote — report what
		// actually moved on-chain, not the original ask. Everything else uses amount.
		const settledAtomics = row.status === 'tipped' && row.tipped_amount != null
			? row.tipped_amount
			: row.amount;
		const feeAtomics = Number(row.platform_fee_amount) || 0;
		// Seller take-home = gross minus the platform fee collected on-chain.
		const netAtomics = Math.max(0, (Number(settledAtomics) || 0) - feeAtomics);
		return {
			...row,
			amount_atomics:       String(settledAtomics ?? '0'),
			amount_display:       toUnits(settledAtomics, decimals),
			platform_fee_display: feeAtomics ? toUnits(feeAtomics, decimals) : null,
			net_display:          row.role === 'seller' ? toUnits(netAtomics, decimals) : null,
			explorer_url:         txLink(row.chain, row.tx_signature),
		};
	});

	return json(res, 200, { transactions, count: transactions.length }, { 'cache-control': 'private, max-age=30' });
});
