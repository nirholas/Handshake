/**
 * Bundle purchase flow (Solana Pay).
 * ------------------------------------
 * POST /api/marketplace/purchase-bundle
 *   Body: { bundle_id }
 *   Creates a pending bundle_purchases row and returns Solana Pay params.
 *
 * POST /api/marketplace/purchase-bundle/:purchaseId/confirm
 *   Verifies on-chain transaction, marks confirmed, and unlocks every skill
 *   in the bundle via skill_purchases (one row per skill, status='confirmed').
 */

import { Keypair } from '@solana/web3.js';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { resolveMarketplaceFee } from '../_lib/marketplace-platform-fee.js';
import { verifyBundlePayment } from '../_lib/purchase-confirm.js';
import { isUuid } from '../_lib/validate.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,GET,OPTIONS', credentials: true })) return;

	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean);
	const purchaseId = url.searchParams.get('purchase_id') || parts[3] || null;
	const op = url.searchParams.get('op') || parts[4] || null;

	if (!purchaseId) {
		if (req.method === 'POST') return handleCreate(req, res);
		return error(res, 405, 'method_not_allowed', 'POST required');
	}
	if (!isUuid(purchaseId)) return error(res, 400, 'validation_error', 'invalid purchase id');
	if (op === 'confirm') return handleConfirm(req, res, purchaseId);
	return error(res, 404, 'not_found', 'unknown action');
});

// ── Create ──────────────────────────────────────────────────────────────────

async function handleCreate(req, res) {
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => null);
	if (!body?.bundle_id || !isUuid(body.bundle_id))
		return error(res, 400, 'validation_error', 'bundle_id required');

	const [bundle] = await sql`
		SELECT sb.id, sb.agent_id, sb.price_amount, sb.currency_mint, sb.chain,
		       COALESCE(json_agg(bi.skill_name) FILTER (WHERE bi.skill_name IS NOT NULL), '[]') AS skills
		FROM skill_bundles sb
		LEFT JOIN bundle_items bi ON bi.bundle_id = sb.id
		WHERE sb.id = ${body.bundle_id} AND sb.is_active = true
		GROUP BY sb.id
	`;
	if (!bundle) return error(res, 404, 'not_found', 'bundle not found');
	if (!bundle.skills.length) return error(res, 400, 'validation_error', 'bundle has no skills');

	// Resolve creator payout wallet.
	const [payoutRow] = await sql`
		SELECT w.address FROM agent_payout_wallets w
		WHERE w.agent_id = ${bundle.agent_id} AND w.chain = ${bundle.chain} AND w.is_default = true
		ORDER BY w.created_at DESC LIMIT 1
	`;
	const [agentRow] = payoutRow ? [payoutRow] : await sql`
		SELECT u.wallet_address AS address FROM users u
		JOIN agent_identities ai ON ai.user_id = u.id
		WHERE ai.id = ${bundle.agent_id}
	`;
	if (!agentRow?.address) return error(res, 422, 'no_payout_wallet', 'creator has no payout wallet');

	const feeResult = await resolveMarketplaceFee({
		priceAmount: bundle.price_amount,
		currencyMint: bundle.currency_mint,
		chain: bundle.chain,
	}).catch(() => ({ feeAmount: 0, treasuryWallet: null }));

	const reference = Keypair.generate().publicKey.toString();

	const [purchase] = await sql`
		INSERT INTO bundle_purchases
			(bundle_id, user_id, agent_id, price_amount, currency_mint, chain,
			 platform_fee_amount, reference, platform_fee_wallet)
		VALUES
			(${bundle.id}, ${auth.userId}, ${bundle.agent_id}, ${bundle.price_amount},
			 ${bundle.currency_mint}, ${bundle.chain}, ${feeResult.feeAmount ?? 0},
			 ${reference}, ${feeResult.treasuryWallet ?? null})
		RETURNING id, price_amount, currency_mint, chain
	`;

	return json(res, 201, {
		data: {
			purchase_id:   purchase.id,
			bundle_id:     bundle.id,
			price_amount:  bundle.price_amount,
			currency_mint: bundle.currency_mint,
			chain:         bundle.chain,
			recipient:     agentRow.address,
			reference,
			fee_amount:    feeResult.feeAmount ?? 0,
			treasury:      feeResult.treasuryWallet ?? null,
			skills:        bundle.skills,
		},
	});
}

// ── Confirm ─────────────────────────────────────────────────────────────────

async function handleConfirm(req, res, purchaseId) {
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const body = await readJson(req).catch(() => null);
	// EVM settles by client-submitted tx hash; Solana is located on-chain via the
	// reference minted at create (no client-supplied signature is trusted).
	const evmTxHash = body?.tx_signature || null;

	const [purchase] = await sql`
		SELECT bp.*,
		       COALESCE(json_agg(bi.skill_name) FILTER (WHERE bi.skill_name IS NOT NULL), '[]') AS skills
		FROM bundle_purchases bp
		JOIN skill_bundles sb ON sb.id = bp.bundle_id
		LEFT JOIN bundle_items bi ON bi.bundle_id = bp.bundle_id
		WHERE bp.id = ${purchaseId} AND bp.user_id = ${auth.userId}
		  AND bp.status = 'pending'
		GROUP BY bp.id
	`;
	if (!purchase) return error(res, 404, 'not_found', 'purchase not found or already processed');

	// Prove the payment on-chain BEFORE unlocking anything. A confirmed verdict
	// returns the real transaction signature/hash; we never trust a client string.
	const verdict = await verifyBundlePayment({
		chain:         purchase.chain,
		agentId:       purchase.agent_id,
		reference:     purchase.reference,
		txHash:        evmTxHash,
		currencyMint:  purchase.currency_mint,
		priceAtomics:  String(purchase.price_amount),
		feeAtomics:    String(purchase.platform_fee_amount ?? 0),
		feeWallet:     purchase.platform_fee_wallet,
		decimals:      purchase.mint_decimals ?? 6,
		userId:        auth.userId,
	});

	if (verdict.status === 'pending')
		return json(res, 200, { data: { ok: false, status: 'pending', message: 'payment not yet found on-chain — retry shortly' } });
	if (verdict.status !== 'confirmed')
		return error(res, 402, 'payment_not_verified', verdict.message || 'payment could not be verified on-chain');

	const txSignature = verdict.txSignature;

	// Atomically claim the purchase. Only the winner unlocks skills and records
	// revenue; the unique index on (tx_signature) is the hard backstop against a
	// reused settlement tx.
	let claimed;
	try {
		claimed = await sql`
			UPDATE bundle_purchases
			SET status = 'confirmed', tx_signature = ${txSignature}, confirmed_at = now()
			WHERE id = ${purchaseId} AND status = 'pending'
			RETURNING id
		`;
	} catch (e) {
		if (e?.code === '23505')
			return error(res, 409, 'tx_already_used', 'this transaction has already been used for another purchase');
		throw e;
	}
	if (claimed.length === 0)
		return error(res, 409, 'already_processed', 'purchase is no longer pending');

	// Unlock every skill in the bundle — one row per skill. hasSkillAccess() reads
	// skill_purchases, so this row IS the unlock.
	//
	// Three column choices are load-bearing, and getting any of them wrong silently
	// costs the buyer what they paid for:
	//   reference     — NOT NULL and UNIQUE, so it is derived per skill. Omitting it
	//                   made this insert throw 23502 for every bundle ever sold.
	//   tx_signature  — UNIQUE, so it CANNOT be repeated across the bundle's skills:
	//                   the second row would collide and ON CONFLICT DO NOTHING would
	//                   swallow it, unlocking only the first skill. The settlement tx
	//                   is recorded once on the bundle_purchases row above, which is
	//                   where it belongs; these rows point back via `reference`.
	//   amount/kind   — 0 and 'bundle'. The bundle's revenue is already counted once
	//                   on bundle_purchases, so these access records stay out of the
	//                   marketplace GMV and purchase counts on /pulse, which filter
	//                   to paid kinds. Pricing them per skill would double-count the
	//                   sale and report one bundle as N purchases.
	//
	// ON CONFLICT DO NOTHING remains correct: it now only absorbs the partial unique
	// index on an already-owned skill, which is the buyer keeping access they have.
	const skills = purchase.skills;
	for (const skillName of skills) {
		await sql`
			INSERT INTO skill_purchases
				(user_id, agent_id, skill, status, kind, reference, amount,
				 currency_mint, chain, confirmed_at)
			VALUES
				(${auth.userId}, ${purchase.agent_id}, ${skillName}, 'confirmed', 'bundle',
				 ${`bundle_${purchaseId}_${skillName}`}, 0,
				 ${purchase.currency_mint}, ${purchase.chain}, now())
			ON CONFLICT DO NOTHING
		`;
	}

	// Record ONE bundle-level revenue event (the skills are unlocked above without
	// their own per-skill credit, so the creator is paid exactly once for the
	// bundle price). Gated by the unique intent_id backstop.
	const gross = Number(purchase.price_amount);
	const platformFee = Number(purchase.platform_fee_amount ?? 0);
	const net = gross - platformFee;
	await sql`
		INSERT INTO agent_revenue_events
			(agent_id, intent_id, skill, gross_amount, fee_amount, platform_fee_amount,
			 net_amount, currency_mint, chain, payer_address)
		VALUES
			(${purchase.agent_id}, ${'bundle_' + purchase.id}, ${'bundle'},
			 ${gross}, ${0}, ${platformFee}, ${net},
			 ${purchase.currency_mint}, ${purchase.chain}, ${null})
		ON CONFLICT (intent_id) DO NOTHING
	`;

	return json(res, 200, {
		data: {
			ok:        true,
			skills_unlocked: skills.length,
			tx_signature: txSignature,
		},
	});
}
