/**
 * Whole-asset purchase flow (Solana Pay) — avatars, agents, plugins.
 * Sibling of /api/marketplace/purchase which sells individual skills.
 *
 *   POST /api/marketplace/buy-asset
 *     Body: { item_type, item_id }
 *     Creates a pending asset_purchases row, returns Solana Pay params.
 *
 *   POST /api/marketplace/buy-asset   (with agent_id)
 *     Body: { item_type, item_id, agent_id }
 *     Autonomous purchase: the buyer agent's OWN custodial wallet signs and
 *     settles server-side, with no browser wallet involved. Mirrors
 *     /api/marketplace/purchase-as-agent (which does the same for skills) and
 *     shares its daily spend cap via api/_lib/agent-purchase.js.
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
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { rpcFallbackFromEnv } from '../_lib/solana/rpc-fallback.js';
import { isUuid } from '../_lib/validate.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { buildGaslessPurchaseTx } from '../_lib/solana/gasless-tx.js';
import { insertNotification } from '../_lib/notify.js';
import { normalizeReferralCode } from '../_lib/referrals.js';
import { verifyEvmUsdcPayment, evmChainId } from '../_lib/evm-payment-verify.js';
import {
	loadBuyerAgentKeypair,
	sendAgentPurchaseTransfer,
	sumDailyPurchaseAtomics,
	readPurchaseCap,
	capExceededMessage,
} from '../_lib/agent-purchase.js';

const REFERENCE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ITEM_TYPES = ['avatar', 'agent', 'plugin'];
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

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

// validateTransfer compares a UI amount, so the atomic price has to be scaled by
// the MINT's decimals. Hardcoding 6 (USDC) silently rejected every payment for an
// asset priced in any other mint: the buyer paid the right atoms, the comparison
// was off by 10^(d-6), and confirm filed the purchase as 'tipped' instead of
// granting it. The seller sets mint_decimals on the listing, so it is stamped onto
// the purchase row at create time (a later price edit must not re-scale a payment
// already in flight).
function normalizeDecimals(value) {
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 && n <= 18 ? n : 6;
}

// Decimals for a purchase row: the value stamped at create, else the live listing
// (rows created before the stamp existed), else USDC's 6.
async function purchaseMintDecimals(pur) {
	const stamped = pur.metadata?.mint_decimals;
	if (stamped != null) return normalizeDecimals(stamped);
	const [price] = await sql`
		SELECT mint_decimals FROM asset_prices
		WHERE item_type = ${pur.item_type} AND item_id = ${pur.item_id}
		  AND currency_mint = ${pur.currency_mint}
		LIMIT 1
	`;
	return normalizeDecimals(price?.mint_decimals);
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
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => null);
	const itemType = String(body?.item_type || '').trim();
	const itemId = String(body?.item_id || '').trim();
	if (!ITEM_TYPES.includes(itemType) || !itemId) {
		return error(res, 400, 'validation_error', 'item_type and item_id required');
	}
	// item_id is a uuid column everywhere it is used below (asset_prices,
	// asset_purchases, avatars/agent_identities/plugins). A malformed id reaching
	// Postgres throws 22P02, which surfaces as an unhandled 500 on what is really
	// bad client input. Same guard as GET /api/marketplace/asset-price.
	if (!isUuid(itemId)) {
		return error(res, 400, 'validation_error', 'item_id must be a valid uuid');
	}
	// Optional connected-wallet pubkey → platform-sponsored (gasless) transaction.
	const buyerPublicKey =
		typeof body?.buyer_public_key === 'string' && REFERENCE_RE.test(body.buyer_public_key)
			? body.buyer_public_key
			: null;
	// Optional buyer agent → autonomous purchase paid from that agent's own
	// custodial wallet, settled server-side (no browser wallet at all).
	const agentId = typeof body?.agent_id === 'string' && body.agent_id.trim() ? body.agent_id.trim() : null;

	// Verify ownership BEFORE any pricing work, and take the per-agent purchase
	// rate limit (the coarse per-IP gate above does not bound a single agent's
	// autonomous spend rate).
	let buyerAgent = null;
	if (agentId) {
		const rlAgent = await limits.agentBuy(agentId);
		if (!rlAgent.success) {
			return rateLimited(res, rlAgent, 'too many autonomous purchases — try again later');
		}
		const [agent] = await sql`
			SELECT id, user_id, name, meta FROM agent_identities
			WHERE id = ${agentId} AND deleted_at IS NULL
		`;
		if (!agent) return error(res, 404, 'not_found', 'buyer agent not found');
		if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');
		buyerAgent = agent;
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

	// An agent wallet can only sign Solana SPL transfers; an EVM-priced asset has
	// no server-side agent path, so say that plainly instead of falling through to
	// a browser-wallet payload the caller did not ask for.
	if (agentId && price.chain !== 'solana') {
		return error(res, 400, 'unsupported_chain',
			`agent wallets pay on solana; this asset is priced on '${price.chain}'`);
	}

	// Daily autonomous-purchase cap — cheap pre-check. Shared with skill
	// purchases (api/_lib/agent-purchase.js), so one budget covers both. This read
	// is a TOCTOU on its own; the authoritative re-check runs after the pending
	// row exists, below.
	const cap = agentId ? readPurchaseCap(buyerAgent.meta) : { enabled: false };
	if (cap.enabled) {
		const spent = await sumDailyPurchaseAtomics({ userId: auth.userId, currencyMint: price.currency_mint });
		if (spent + BigInt(price.amount) > cap.limitAtomics) {
			return error(res, 402, 'spend_cap_exceeded', capExceededMessage(cap.limitUsdc));
		}
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
		SELECT reference, amount, currency_mint, chain, expires_at, metadata
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
				amount, currency_mint, chain, payout_address, expires_at, referrer_user_id,
				metadata
			) VALUES (
				${auth.userId}, ${itemType}, ${itemId}, ${seller.userId}, 'pending', ${reference},
				${price.amount}, ${price.currency_mint}, ${price.chain}, ${payoutAddress},
				now() + interval '30 minutes', ${referrerUserId},
				${JSON.stringify({ mint_decimals: normalizeDecimals(price.mint_decimals) })}::jsonb
			)
			RETURNING reference, amount, currency_mint, chain, expires_at, metadata
		`;
		row = inserted;
	}

	// The scale the buyer must pay at, and the one confirm will verify against: a
	// reused pending row keeps the decimals it was created with, so a price edit
	// mid-checkout can never move the goalposts under a payment already in flight.
	const decimals = normalizeDecimals(row.metadata?.mint_decimals ?? price.mint_decimals);

	// ── Autonomous path: the agent's own wallet pays, server-side ──────────────
	if (agentId) {
		return payAsAgent({
			res,
			auth,
			agent: buyerAgent,
			row,
			decimals,
			payoutAddress,
			itemType,
			itemId,
			label: seller.label,
			cap,
		});
	}

	// Gasless checkout: sponsor the network fee with a pre-signed
	// VersionedTransaction when the buyer's Solana wallet is connected. A whole
	// asset is a single full-amount transfer to the seller (no platform fee leg).
	let gaslessBlock = {};
	if (buyerPublicKey && row.chain === 'solana') {
		try {
			const connection = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
			const prepared = await buildGaslessPurchaseTx({
				connection,
				buyerPublicKey,
				recipient: payoutAddress,
				mint: row.currency_mint,
				creatorAtomics: BigInt(row.amount),
				reference: row.reference,
				decimals,
			});
			if (prepared) {
				gaslessBlock = { transaction: prepared.transaction, gasless: true, fee_payer: prepared.feePayer };
			}
		} catch (e) {
			// Sponsorship is best-effort — the buyer can still pay for the tx.
			console.warn('[buy-asset] gasless prepare failed:', e?.message);
		}
	}

	return json(res, 201, {
		data: {
			reference: row.reference,
			recipient: payoutAddress,
			amount: String(row.amount),
			currency_mint: row.currency_mint,
			chain: row.chain,
			mint_decimals: decimals,
			expires_at: row.expires_at,
			label,
			message,
			item_type: itemType,
			item_id: itemId,
			...gaslessBlock,
		},
	});
}

// ── Autonomous purchase (agent wallet) ─────────────────────────────────────
//
// Runs once the pending asset_purchases row exists. Order is load-bearing:
// re-check the cap against the persisted row (race-safe), recover the key, pay,
// verify the on-chain transfer, then finalize through the SAME
// finalizeAssetConfirm() the browser path uses — so receipts, revenue and
// notifications are identical no matter who signed.
async function payAsAgent({ res, auth, agent, row, decimals, payoutAddress, itemType, itemId, label, cap }) {
	const fail = async (reason) => {
		await sql`
			UPDATE asset_purchases SET status = 'failed', updated_at = now()
			WHERE reference = ${row.reference} AND status = 'pending'
		`.catch(() => {});
		console.warn('[buy-asset] agent purchase failed:', reason);
	};

	// Authoritative cap enforcement: our pending row is persisted and counted, so
	// this SUM sees every concurrent in-flight purchase. Voiding here aborts
	// BEFORE any transaction is broadcast.
	if (cap.enabled) {
		const spent = await sumDailyPurchaseAtomics({ userId: auth.userId, currencyMint: row.currency_mint });
		if (spent > cap.limitAtomics) {
			await fail('spend_cap_exceeded_reserved');
			return error(res, 402, 'spend_cap_exceeded', capExceededMessage(cap.limitUsdc));
		}
	}

	let buyer;
	try {
		buyer = await loadBuyerAgentKeypair({
			agentId: agent.id,
			userId: auth.userId,
			reason: 'autonomous_asset_purchase',
			meta: { item_type: itemType, item_id: itemId, reference: row.reference },
		});
	} catch (e) {
		await fail('wallet_unavailable');
		if (e?.code === 'no_buyer_wallet') {
			return error(res, 412, 'no_buyer_wallet',
				'buyer agent has no Solana wallet — provision via POST /api/agents/:id/solana');
		}
		return error(res, 500, 'wallet_decrypt_failed', 'could not load the agent wallet');
	}

	let txSignature;
	try {
		txSignature = await sendAgentPurchaseTransfer({
			connection: solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' }),
			keypair: buyer.keypair,
			currencyMint: row.currency_mint,
			recipient: payoutAddress,
			amountAtomics: row.amount,
			referenceKey: new PublicKey(row.reference),
		});
	} catch (e) {
		await fail(e?.message || 'tx_send_failed');
		// The send threw before confirmation, so no funds moved — say so plainly
		// rather than leaving the owner unsure whether to retry.
		return error(res, 502, 'tx_send_failed',
			'the payment could not be sent from the agent wallet and nothing was charged; check the agent has enough USDC and a little SOL, then try again');
	}

	// Verify what actually landed on-chain before granting the asset. The transfer
	// carries the Solana Pay reference, so this is the same validation the browser
	// path runs — a short or misdirected transfer becomes 'tipped', never a grant.
	try {
		await rpc().withFallback((conn) =>
			validateTransfer(
				conn,
				txSignature,
				{
					recipient: new PublicKey(payoutAddress),
					amount: new BigNumber(row.amount).dividedBy(new BigNumber(10).pow(decimals)),
					splToken: new PublicKey(row.currency_mint),
					reference: new PublicKey(row.reference),
				},
				{ commitment: 'confirmed' },
			),
		);
	} catch (e) {
		const [pur] = await sql`
			SELECT id, seller_user_id FROM asset_purchases WHERE reference = ${row.reference}
		`;
		await sql`
			UPDATE asset_purchases
			SET status = 'tipped', tx_signature = ${txSignature}, confirmed_at = now(), updated_at = now()
			WHERE reference = ${row.reference} AND status = 'pending'
		`;
		if (pur) {
			await insertNotification(pur.seller_user_id, 'asset_payment_mismatch', {
				item_type: itemType, item_id: itemId,
				expected_amount: String(row.amount),
				tx_signature: txSignature, purchase_id: pur.id, reason: e?.message,
			}).catch(() => {});
		}
		return error(res, 409, 'transfer_mismatch', e?.message || 'on-chain transfer did not match expected', {
			status: 'tipped', tx_signature: txSignature,
		});
	}

	const [pur] = await sql`
		SELECT id, buyer_user_id, item_type, item_id, seller_user_id, amount,
		       currency_mint, chain, reference, payout_address, referrer_user_id
		FROM asset_purchases WHERE reference = ${row.reference}
	`;
	if (!pur) return error(res, 500, 'purchase_missing', 'purchase row vanished mid-flight');

	// Same finalize as the browser path: receipt, revenue, both notifications.
	return finalizeAssetConfirm(res, pur, txSignature, {
		paid_by_agent: { id: agent.id, name: agent.name || null, address: buyer.address },
		label,
	});
}

// ── Status ─────────────────────────────────────────────────────────────────

async function handleStatus(req, res, reference) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

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
	if (!rl.success) return rateLimited(res, rl);

	const [pur] = await sql`
		SELECT id, buyer_user_id, item_type, item_id, seller_user_id, status,
		       amount, currency_mint, chain, tx_signature, expires_at, reference,
		       payout_address, referrer_user_id, metadata
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
		return handleEvmAssetConfirm(req, res, pur);
	}

	const refKey = new PublicKey(pur.reference);
	const recipient = new PublicKey(pur.payout_address);
	const splToken = new PublicKey(pur.currency_mint);
	const decimals = await purchaseMintDecimals(pur);
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

	return finalizeAssetConfirm(res, pur, txSignature);
}

// Atomic confirm + receipt + notifications for a verified asset payment. Shared
// by the Solana and EVM confirm paths; `txSignature` is the Solana signature or
// the EVM tx hash.
async function finalizeAssetConfirm(res, pur, txSignature, extra = null) {
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

	return json(res, 200, { data: { status: 'confirmed', tx_signature: txSignature, ...(extra || {}) } });
}

// EVM asset confirm: the buyer submits the settlement tx hash; verify a USDC
// transfer of at least the price reached the seller's payout wallet on Base,
// then finalize through the same path as Solana.
async function handleEvmAssetConfirm(req, res, pur) {
	if (!evmChainId(pur.chain)) {
		return error(res, 400, 'unsupported_chain', `chain '${pur.chain}' is not supported`);
	}
	const body = await readJson(req).catch(() => null);
	const txHash = body?.tx_hash || body?.txHash || null;
	if (!txHash) return error(res, 400, 'tx_hash_required', 'tx_hash is required to confirm an EVM purchase');

	// Idempotency guard: check already-settled rows AND atomically lock this
	// purchase by writing tx_signature before we hit the payment verifier.
	// Without this, two concurrent confirms of different pending purchases with
	// the same tx_hash could both pass the old read-only dupe check and both
	// call finalizeAssetConfirm (one tx → two confirmed rows).
	const [dupe] = await sql`
		SELECT id FROM asset_purchases
		WHERE tx_signature = ${txHash} AND status IN ('confirmed', 'tipped') AND id != ${pur.id}
		LIMIT 1
	`;
	if (dupe) return error(res, 409, 'transfer_mismatch', 'this transaction has already been used for another purchase');

	// Atomically claim this tx_hash on this purchase row before hitting the
	// payment verifier. This prevents a concurrent confirm of a *different*
	// pending purchase from using the same hash while this request is in flight
	// (the unique constraint + IS NULL guard block the other row's claim).
	// Retries of this same purchase with the same hash match the second condition
	// and proceed normally (idempotent).
	const claimed = await sql`
		UPDATE asset_purchases
		SET tx_signature = ${txHash}, updated_at = now()
		WHERE id = ${pur.id} AND status = 'pending'
		  AND (tx_signature IS NULL OR tx_signature = ${txHash})
		RETURNING id
	`;
	if (claimed.length === 0) {
		// Another concurrent request already claimed a different tx_hash for this
		// purchase, or the purchase moved out of pending. Re-read current state.
		const [current] = await sql`SELECT status, tx_signature FROM asset_purchases WHERE id = ${pur.id}`;
		if (current?.status === 'confirmed') return json(res, 200, { data: { status: 'confirmed', tx_signature: current.tx_signature } });
		return error(res, 409, 'transfer_mismatch', 'a different transaction is already being confirmed for this purchase');
	}

	const result = await verifyEvmUsdcPayment({
		txHash,
		chain: pur.chain,
		recipient: pur.payout_address,
		expectedAmount: pur.amount,
	});
	if (result.status === 'pending') return json(res, 200, { data: { status: 'pending' } });
	if (result.status === 'mismatch') {
		// A short-but-real transfer is a tip; nothing on-chain is a hard mismatch.
		if (result.actualAmount && BigInt(result.actualAmount) > 0n) {
			await sql`
				UPDATE asset_purchases
				SET status = 'tipped', tx_signature = ${txHash}, confirmed_at = now(), updated_at = now()
				WHERE id = ${pur.id} AND status = 'pending'
			`;
			await insertNotification(pur.seller_user_id, 'asset_payment_mismatch', {
				item_type: pur.item_type,
				item_id: pur.item_id,
				expected_amount: String(pur.amount),
				actual_amount: result.actualAmount,
				tx_signature: txHash,
				purchase_id: pur.id,
				reason: result.message,
			});
			return error(res, 409, 'transfer_mismatch', result.message || 'on-chain transfer did not match expected', {
				status: 'tipped',
				tx_signature: txHash,
			});
		}
		return error(res, 409, 'transfer_mismatch', result.message || 'no matching transfer found');
	}
	return finalizeAssetConfirm(res, pur, txHash);
}

// Resolve the inviting user from a ?ref=<code> query or users.referred_by_id.
async function resolveReferrer(req, buyerUserId) {
	const url = new URL(req.url, 'http://x');
	const code = normalizeReferralCode(url.searchParams.get('ref'));
	if (code) {
		const [u] = await sql`SELECT id FROM users WHERE UPPER(referral_code) = ${code} AND deleted_at IS NULL LIMIT 1`;
		if (u && u.id !== buyerUserId) return u.id;
	}
	const [me] = await sql`SELECT referred_by_id FROM users WHERE id = ${buyerUserId}`;
	if (me?.referred_by_id && me.referred_by_id !== buyerUserId) return me.referred_by_id;
	return null;
}
