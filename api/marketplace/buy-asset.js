/**
 * Whole-asset purchase flow (Solana Pay) — avatars, agents, plugins.
 * Sibling of /api/marketplace/purchase which sells individual skills.
 *
 *   POST /api/marketplace/buy-asset
 *     Body: { item_type, item_id }
 *     Creates a pending asset_purchases row, returns Solana Pay params.
 *
 *   GET  /api/marketplace/buy-asset/:reference
 *     Returns { status, tx_signature, confirmed_at } for the caller.
 *
 *   POST /api/marketplace/buy-asset/:reference/confirm
 *     Validates the on-chain tx, marks confirmed, emits receipt + notifications.
 *
 * Routed via vercel.json rewrites (see project root).
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { findReference, validateTransfer } from '@solana/pay';
import BigNumber from 'bignumber.js';
import crypto from 'node:crypto';

import { sql } from '../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { rpcFallbackFromEnv } from '../_lib/solana/rpc-fallback.js';
import { insertNotification } from '../_lib/notify.js';

const REFERENCE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ITEM_TYPES = ['avatar', 'agent', 'plugin'];

let _rpc;
function rpc() {
	if (!_rpc) _rpc = rpcFallbackFromEnv({ network: 'mainnet' });
	return _rpc;
}

function receiptKey() {
	return (
		process.env.PURCHASE_RECEIPT_KEY ||
		crypto.createHash('sha256').update((process.env.SESSION_SECRET || 'dev') + ':receipts').digest('hex')
	);
}

export default wrap(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean);
	const reference = url.searchParams.get('reference') || parts[3] || null;
	const op = url.searchParams.get('op') || parts[4] || null;

	if (!reference) {
		if (req.method === 'POST') return handleCreate(req, res);
		return error(res, 405, 'method_not_allowed', 'POST required');
	}
	if (!REFERENCE_RE.test(reference)) {
		return error(res, 400, 'validation_error', 'invalid reference');
	}
	if (!op) return handleStatus(req, res, reference);
	if (op === 'confirm') return handleConfirm(req, res, reference);
	return error(res, 404, 'not_found', 'unknown action');
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

async function getSellerForItem(itemType, itemId) {
	if (itemType === 'avatar') {
		const [row] = await sql`SELECT owner_id AS user_id, name FROM avatars WHERE id = ${itemId} AND deleted_at IS NULL`;
		return row ? { userId: row.user_id, label: row.name || 'Avatar' } : null;
	}
	if (itemType === 'agent') {
		const [row] = await sql`SELECT user_id, name FROM agent_identities WHERE id = ${itemId} AND deleted_at IS NULL`;
		return row ? { userId: row.user_id, label: row.name || 'Agent' } : null;
	}
	if (itemType === 'plugin') {
		const [row] = await sql`SELECT author_id AS user_id, name FROM plugins WHERE id = ${itemId} AND deleted_at IS NULL`;
		return row ? { userId: row.user_id, label: row.name || 'Plugin' } : null;
	}
	return null;
}

async function resolveSellerPayout(sellerUserId, chain) {
	const [row] = await sql`
		SELECT address FROM agent_payout_wallets
		WHERE user_id = ${sellerUserId} AND chain = ${chain} AND is_default = true
		ORDER BY created_at ASC
		LIMIT 1
	`;
	return row?.address ?? null;
}

// ── Create ─────────────────────────────────────────────────────────────────

async function handleCreate(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = await readJson(req).catch(() => null);
	const itemType = String(body?.item_type || '').trim();
	const itemId = String(body?.item_id || '').trim();
	if (!ITEM_TYPES.includes(itemType) || !itemId) {
		return error(res, 400, 'validation_error', 'item_type and item_id required');
	}

	const [price] = await sql`
		SELECT amount, currency_mint, chain, mint_decimals, owner_user_id
		FROM asset_prices
		WHERE item_type = ${itemType} AND item_id = ${itemId} AND is_active = true
	`;
	if (!price) return error(res, 404, 'not_found', 'this asset is not for sale');
	if (price.owner_user_id === auth.userId) {
		return error(res, 400, 'self_purchase', 'you already own this asset');
	}

	const seller = await getSellerForItem(itemType, itemId);
	if (!seller) return error(res, 404, 'not_found', 'asset not found');

	const payoutAddress = await resolveSellerPayout(seller.userId, price.chain);
	if (!payoutAddress) {
		return error(res, 412, 'creator_wallet_missing', 'seller has not configured a payout wallet');
	}

	// Already-owned: any confirmed asset purchase returns the existing row.
	const [existing] = await sql`
		SELECT reference, status, tx_signature, confirmed_at
		FROM asset_purchases
		WHERE buyer_user_id = ${auth.userId}
		  AND item_type = ${itemType} AND item_id = ${itemId}
		  AND status = 'confirmed'
		ORDER BY confirmed_at DESC NULLS LAST
		LIMIT 1
	`;
	if (existing) {
		return json(res, 200, {
			data: { already_owned: true, ...existing },
		});
	}

	// Reuse a fresh pending row if one exists (idempotent retries).
	const [pending] = await sql`
		SELECT reference, amount, currency_mint, chain, expires_at
		FROM asset_purchases
		WHERE buyer_user_id = ${auth.userId}
		  AND item_type = ${itemType} AND item_id = ${itemId}
		  AND status = 'pending' AND expires_at > now()
		ORDER BY created_at DESC
		LIMIT 1
	`;

	const referrerUserId = await resolveReferrer(req, auth.userId);
	const reference = pending?.reference ?? Keypair.generate().publicKey.toBase58();
	const label = `${seller.label.slice(0, 40)}`;
	const message = `Purchase ${itemType}: '${seller.label.slice(0, 50)}'`;

	let row = pending;
	if (!pending) {
		const [inserted] = await sql`
			INSERT INTO asset_purchases (
				buyer_user_id, item_type, item_id, seller_user_id, status, reference,
				amount, currency_mint, chain, payout_address, expires_at, referrer_user_id
			) VALUES (
				${auth.userId}, ${itemType}, ${itemId}, ${seller.userId}, 'pending', ${reference},
				${price.amount}, ${price.currency_mint}, ${price.chain}, ${payoutAddress},
				now() + interval '30 minutes', ${referrerUserId}
			)
			RETURNING reference, amount, currency_mint, chain, expires_at
		`;
		row = inserted;
	}

	return json(res, 201, {
		data: {
			reference: row.reference,
			recipient: payoutAddress,
			amount: String(row.amount),
			currency_mint: row.currency_mint,
			chain: row.chain,
			mint_decimals: price.mint_decimals,
			expires_at: row.expires_at,
			label,
			message,
			item_type: itemType,
			item_id: itemId,
		},
	});
}

// ── Status ─────────────────────────────────────────────────────────────────

async function handleStatus(req, res, reference) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [row] = await sql`
		SELECT reference, item_type, item_id, status, tx_signature, confirmed_at,
		       amount, currency_mint, chain
		FROM asset_purchases
		WHERE reference = ${reference} AND buyer_user_id = ${auth.userId}
	`;
	if (!row) return error(res, 404, 'not_found', 'purchase not found');
	return json(res, 200, { data: row }, { 'cache-control': 'no-store' });
}

// ── Confirm ────────────────────────────────────────────────────────────────

async function handleConfirm(req, res, reference) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [pur] = await sql`
		SELECT id, buyer_user_id, item_type, item_id, seller_user_id, status,
		       amount, currency_mint, chain, tx_signature, expires_at, reference,
		       payout_address, referrer_user_id
		FROM asset_purchases
		WHERE reference = ${reference} AND buyer_user_id = ${auth.userId}
	`;
	if (!pur) return error(res, 404, 'not_found', 'purchase not found');
	if (pur.status === 'confirmed') {
		return json(res, 200, { data: { status: 'confirmed', tx_signature: pur.tx_signature } });
	}
	if (pur.status === 'expired' || (pur.expires_at && new Date(pur.expires_at) < new Date())) {
		await sql`UPDATE asset_purchases SET status = 'expired', updated_at = now() WHERE id = ${pur.id} AND status = 'pending'`;
		return error(res, 410, 'purchase_expired', 'this pending purchase expired; please start a new one');
	}
	if (pur.chain !== 'solana') {
		return error(res, 501, 'not_implemented', `chain '${pur.chain}' confirmation not yet supported`);
	}

	const refKey = new PublicKey(pur.reference);
	const recipient = new PublicKey(pur.payout_address);
	const splToken = new PublicKey(pur.currency_mint);
	const decimals = 6;
	const expectedAmount = new BigNumber(pur.amount).dividedBy(new BigNumber(10).pow(decimals));

	let signatureInfo;
	try {
		signatureInfo = await rpc().withFallback((conn) =>
			findReference(conn, refKey, { finality: 'confirmed' }),
		);
	} catch (e) {
		if (/FindReferenceError|not found/i.test(e?.message || '')) {
			return json(res, 200, { data: { status: 'pending' } });
		}
		throw e;
	}
	const txSignature = signatureInfo.signature;

	try {
		await rpc().withFallback((conn) =>
			validateTransfer(
				conn,
				txSignature,
				{ recipient, amount: expectedAmount, splToken, reference: refKey },
				{ commitment: 'confirmed' },
			),
		);
	} catch (e) {
		await sql`
			UPDATE asset_purchases
			SET status = 'tipped', tx_signature = ${txSignature}, confirmed_at = now(), updated_at = now()
			WHERE id = ${pur.id} AND status = 'pending'
		`;
		await insertNotification(pur.seller_user_id, 'asset_payment_mismatch', {
			item_type: pur.item_type,
			item_id: pur.item_id,
			expected_amount: String(pur.amount),
			tx_signature: txSignature,
			purchase_id: pur.id,
			reason: e?.message,
		});
		return error(res, 409, 'transfer_mismatch', e?.message || 'on-chain transfer did not match expected', {
			status: 'tipped',
			tx_signature: txSignature,
		});
	}

	const updated = await sql`
		UPDATE asset_purchases
		SET status = 'confirmed', tx_signature = ${txSignature}, confirmed_at = now(), updated_at = now()
		WHERE id = ${pur.id} AND status = 'pending'
		RETURNING id
	`;

	if (updated.length > 0) {
		// Receipt: signed JSON payload, stored once.
		const body = {
			v: 1,
			kind: 'asset_purchase',
			purchase_id: pur.id,
			reference: pur.reference,
			buyer_user_id: pur.buyer_user_id,
			seller_user_id: pur.seller_user_id,
			item_type: pur.item_type,
			item_id: pur.item_id,
			amount: String(pur.amount),
			currency_mint: pur.currency_mint,
			chain: pur.chain,
			recipient: pur.payout_address,
			tx_signature: txSignature,
			issued_at: new Date().toISOString(),
		};
		const canonical = JSON.stringify(body, Object.keys(body).sort());
		const sig = crypto.createHmac('sha256', receiptKey()).update(canonical).digest('hex');
		await sql`
			INSERT INTO asset_purchase_receipts (purchase_id, receipt_json, signature)
			VALUES (${pur.id}, ${JSON.stringify(body)}::jsonb, ${sig})
			ON CONFLICT (purchase_id) DO NOTHING
		`.catch(() => {/* table may not exist; non-fatal */});

		await insertNotification(pur.seller_user_id, 'asset_purchased', {
			item_type: pur.item_type,
			item_id: pur.item_id,
			amount: String(pur.amount),
			currency_mint: pur.currency_mint,
			tx_signature: txSignature,
			purchase_id: pur.id,
		});
		await insertNotification(pur.buyer_user_id, 'asset_purchase_confirmed', {
			item_type: pur.item_type,
			item_id: pur.item_id,
			amount: String(pur.amount),
			currency_mint: pur.currency_mint,
			tx_signature: txSignature,
			purchase_id: pur.id,
		});
	}

	return json(res, 200, { data: { status: 'confirmed', tx_signature: txSignature } });
}

// Resolve the inviting user from a ?ref=<code> query or users.referred_by_id.
async function resolveReferrer(req, buyerUserId) {
	const url = new URL(req.url, 'http://x');
	const code = url.searchParams.get('ref');
	if (code) {
		const [u] = await sql`SELECT id FROM users WHERE referral_code = ${code} LIMIT 1`;
		if (u && u.id !== buyerUserId) return u.id;
	}
	const [me] = await sql`SELECT referred_by_id FROM users WHERE id = ${buyerUserId}`;
	if (me?.referred_by_id && me.referred_by_id !== buyerUserId) return me.referred_by_id;
	return null;
}
