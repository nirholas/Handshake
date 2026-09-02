// /api/print/orders: the human checkout lane for Materialize.
//
//   POST → open an order from a signed quote token and hand back a Solana Pay
//          intent the buyer settles in USDC. Session + CSRF.
//   GET  → the caller's own orders, newest first.
//
// The whole design is in one sentence: the price comes out of the token, never
// out of the request. verifyQuote() re-derives the material, the size, the
// quantity, the destination and the total from an HMAC this server signed, so a
// buyer who edits the JSON in flight gets either the price we quoted or a 422.
// A token older than the catalog's TTL fails the same way a forged one does.
//
// Payment rides the platform's existing Solana Pay rail, the same one the
// marketplace settles on: the order carries a freshly generated reference
// pubkey, the buyer attaches it to their transfer, and
// POST /api/print/orders/:id/confirm finds the transaction BY that reference and
// validates it moved the quoted USDC to the platform wallet. Verification is a
// read against the chain; this endpoint never sends anything.
//
// USDC on Solana is the only way to pay, and the copy says so plainly. There is
// no card processor, by decision, not by omission.

import { Keypair, PublicKey } from '@solana/web3.js';

import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { getSessionUser } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { env } from '../_lib/env.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { buildGaslessPurchaseTx } from '../_lib/solana/gasless-tx.js';
import { verifyQuote } from '../_lib/print/quote.js';
import { PrintEditionError } from '../_lib/print/editions.js';
import {
	PrintStoreError,
	createOrder,
	listOrdersForUser,
	normalizeShipping,
	transition,
} from '../_lib/print-store.js';

const USDC_DECIMALS = 6;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** USDC atomics for a quoted dollar total, without floating-point drift. */
export function atomicsForUsdc(total) {
	return String(Math.round(Number(total) * 10 ** USDC_DECIMALS));
}

/**
 * The wallet a print order is paid to and the mint it is paid in. Missing
 * configuration is a 503, never a silent fallback to some other address: a
 * checkout that cannot name its receiver must not take money.
 */
function receiver() {
	const payTo = env.X402_PAY_TO_SOLANA;
	const mint = env.X402_ASSET_MINT_SOLANA;
	if (!payTo || !mint) {
		const err = new Error('Solana USDC checkout is not configured on this deployment');
		err.status = 503;
		err.code = 'checkout_unavailable';
		throw err;
	}
	return { payTo, mint };
}

/** The Solana Pay URL a wallet app or a QR code opens. */
function solanaPayUrl({ payTo, mint, amount, reference, label, message }) {
	const params = new URLSearchParams({
		'spl-token': mint,
		amount: String(amount),
		reference,
		label,
		message,
	});
	return `solana:${payTo}?${params.toString()}`;
}

/**
 * Close out an order that was inserted but never reached `quoted`. Best effort
 * on purpose: the caller is already returning an error, and a cancel that fails
 * must not replace the real reason with a second, less useful one. Anything left
 * behind is still a legal `created` row the operator console can close by hand.
 *
 * @param {{ id: string, status: string }|null} order
 * @param {unknown} cause
 */
async function cancelStrandedOrder(order, cause) {
	if (!order?.id || order.status !== 'created') return;
	try {
		await transition({
			orderId: order.id,
			to: 'canceled',
			note: `Checkout could not be completed: ${String(cause?.message || cause).slice(0, 200)}`,
			actor: 'system',
		});
	} catch (err) {
		console.warn('[print] could not close stranded order', order.id, err?.message);
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const user = await getSessionUser(req).catch(() => null);
	if (!user) return error(res, 401, 'unauthorized', 'sign in to order a print');

	if (req.method === 'GET') {
		const readRl = await limits.authedReadIp(clientIp(req));
		if (!readRl.success) return rateLimited(res, readRl);
		const orders = await listOrdersForUser(user.id);
		return json(res, 200, { orders }, { 'cache-control': 'no-store' });
	}

	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.printOrderIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many order attempts');

	const body = await readJson(req, 8_000).catch(() => null);
	if (!body || typeof body !== 'object') {
		return error(res, 400, 'validation_error', 'a JSON body is required');
	}

	// Every priced parameter is re-derived here, from the signature. A stale
	// token, an altered token and a forged token are all the same failure, and
	// none of them reaches the database.
	const quote = verifyQuote(typeof body.token === 'string' ? body.token : '');
	if (!quote) {
		return error(res, 422, 'quote_invalid', 'that quote is expired or was not issued by this server. Request a fresh one from /api/print/quote.');
	}

	let shipping;
	try {
		shipping = normalizeShipping(body.shipping);
	} catch (err) {
		if (err instanceof PrintStoreError) {
			return error(res, 422, err.code, err.message, err.field ? { field: err.field } : {});
		}
		throw err;
	}

	// Shipping cost is part of the signed total, so the address it ships to has
	// to be the country that total was priced for. Silently shipping elsewhere
	// would mean eating the difference on every order.
	if (quote.country && shipping.country !== quote.country) {
		return error(res, 422, 'destination_mismatch', `this quote was priced for shipping to ${quote.country}. Re-quote for ${shipping.country}.`, {
			quoted_country: quote.country,
			shipping_country: shipping.country,
		});
	}

	if (!quote.sourceUrl) {
		return error(res, 422, 'quote_invalid', 'that quote does not name a model to print');
	}

	let payment;
	try {
		payment = receiver();
	} catch (err) {
		return error(res, err.status || 503, err.code || 'checkout_unavailable', err.message);
	}

	const reference = Keypair.generate().publicKey.toBase58();

	let order;
	try {
		order = await createOrder({
			userId: user.id,
			quote,
			// The itemization the buyer was shown, kept verbatim beside the token
			// that signed it. The operator console and the receipt read this row;
			// neither ever recomputes a price.
			itemization: {
				token: body.token,
				total: quote.total,
				materialId: quote.materialId,
				finishId: quote.finishId,
				targetHeightMm: quote.targetHeightMm,
				quantity: quote.quantity,
				hollow: quote.hollow,
				country: quote.country,
				volumeCm3: quote.volumeCm3,
				leadTimeDays: quote.leadTimeDays,
				reportHash: quote.reportHash,
				expiresAt: quote.expiresAt,
			},
			report: { report_hash: quote.reportHash, volume_cm3: quote.volumeCm3 },
			sourceGlbUrl: quote.sourceUrl,
			creationId: quote.creationId || null,
			shipping,
			paymentReference: reference,
			paymentChain: 'solana',
		});
		// `quoted` is the state that says "this order has a price and is waiting
		// for money". The edition-scarcity check runs on this move, so a sold-out
		// edition is refused before the buyer is ever shown a payment request.
		const moved = await transition({
			orderId: order.id,
			to: 'quoted',
			note: 'Awaiting USDC payment on Solana.',
			actor: 'buyer',
			actorId: user.id,
		});
		order = moved.order;
	} catch (err) {
		// The row is inserted before the move to `quoted`, so a failure here (a
		// sold-out edition, a lost race) would otherwise strand an order in
		// `created` that nobody will ever pay for and nobody will ever close.
		// Cancel it on the way out: the buyer sees the real reason, and the
		// operator queue does not collect one orphan per failed checkout.
		await cancelStrandedOrder(order, err);
		// The scarcity check on the `quoted` move throws its own typed error, so
		// a sold-out edition has to be caught here too or it would surface as a
		// 500 on the one path where a buyer most needs to be told why.
		if (err instanceof PrintEditionError) {
			return error(res, 409, err.code, err.message);
		}
		if (err instanceof PrintStoreError) {
			const status = err.code === 'edition_sold_out' ? 409 : 422;
			return error(res, status, err.code, err.message);
		}
		throw err;
	}

	const amount = Number(quote.total).toFixed(2);
	const intent = {
		chain: 'solana',
		network: 'mainnet',
		recipient: payment.payTo,
		mint: payment.mint,
		mint_decimals: USDC_DECIMALS,
		amount,
		amount_atomics: atomicsForUsdc(quote.total),
		reference,
		url: solanaPayUrl({
			payTo: payment.payTo,
			mint: payment.mint,
			amount,
			reference,
			label: 'three.ws Materialize',
			message: `Print order ${order.id.slice(0, 8)}`,
		}),
		confirm_url: `/api/print/orders/${order.id}/confirm`,
	};

	// Gasless when the browser wallet is already connected: the platform pays the
	// network fee and pre-signs, so the buyer needs USDC and no SOL. Failing to
	// sponsor is never a checkout failure; the buyer can always pay for their own
	// transaction from the Solana Pay URL above.
	const buyerPublicKey =
		typeof body.buyer_public_key === 'string' && PUBKEY_RE.test(body.buyer_public_key)
			? body.buyer_public_key
			: null;
	if (buyerPublicKey) {
		try {
			const prepared = await buildGaslessPurchaseTx({
				connection: solanaConnection({ commitment: 'confirmed' }),
				buyerPublicKey,
				recipient: payment.payTo,
				mint: payment.mint,
				creatorAtomics: BigInt(intent.amount_atomics),
				reference,
				decimals: USDC_DECIMALS,
			});
			if (prepared) {
				intent.transaction = prepared.transaction;
				intent.gasless = true;
				intent.fee_payer = prepared.feePayer;
			}
		} catch (err) {
			console.warn('[print] gasless sponsorship unavailable:', err?.message);
		}
	}

	return json(
		res,
		201,
		{
			order: {
				id: order.id,
				status: order.status,
				material_id: order.material_id,
				target_height_mm: order.target_height_mm,
				quantity: order.quantity,
				price_usdc: order.price_usdc,
				lead_time_days: quote.leadTimeDays,
				quote_expires_at: order.quote_expires_at,
			},
			payment: intent,
			track_url: `/materialize/orders/${order.id}`,
		},
		{ 'cache-control': 'no-store' },
	);
});

// Exported so the reference generator can be swapped in tests without mocking
// @solana/web3.js wholesale.
export { PUBKEY_RE };
