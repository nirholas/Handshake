// POST /api/print/orders/:id/confirm: prove the USDC landed, then start the job.
//
// This endpoint reads the chain and writes the database. It never sends a
// transaction, never touches a key, and never moves anyone's money: the buyer
// already paid from their own wallet, and all this does is find that payment
// and check it.
//
// The proof is Solana Pay's reference mechanism, the same one the marketplace
// settles on. When the order was created it generated a reference pubkey and
// asked the buyer to attach it to their transfer. findReference() locates the
// transaction that carries it, and validateTransfer() then asserts the strict
// facts: the right mint, the right recipient, at least the quoted amount, with
// the reference on the final instruction. Any of those failing is a refusal,
// not a partial credit.
//
// A payment that has not landed yet answers 202 with status "pending" rather
// than an error, because the buyer's wallet may still be broadcasting and a red
// error on a payment that is about to confirm is the worst moment to lie.
//
// On success the order moves paid -> screening in one call: screening is the
// fabrication-safety gate that runs a second time now that money is committed,
// and leaving a paid order sitting in `paid` would mean a job nobody picked up.

import { PublicKey } from '@solana/web3.js';
import { findReference, validateTransfer } from '@solana/pay';
import BigNumber from 'bignumber.js';

import { cors, error, json, method, rateLimited, wrap } from '../../../_lib/http.js';
import { clientIp, limits } from '../../../_lib/rate-limit.js';
import { getSessionUser } from '../../../_lib/auth.js';
import { requireCsrf } from '../../../_lib/csrf.js';
import { env } from '../../../_lib/env.js';
import { rpcFallbackFromEnv } from '../../../_lib/solana/rpc-fallback.js';
import { PrintStoreError, getOrderWithEvents, transition } from '../../../_lib/print-store.js';
import { publicOrder } from '../[id].js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USDC_DECIMALS = 6;

let _rpc;
function rpc() {
	if (!_rpc) _rpc = rpcFallbackFromEnv({ network: 'mainnet' });
	return _rpc;
}

/** True when findReference simply has not seen the payment yet. */
function isNotFound(err) {
	return /FindReferenceError|not found/i.test(String(err?.message || ''));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const id = String(req.query?.id || '').trim();
	if (!UUID_RE.test(id)) return error(res, 400, 'validation_error', 'invalid order id');

	const user = await getSessionUser(req).catch(() => null);
	if (!user) return error(res, 401, 'unauthorized', 'sign in to confirm an order');
	if (!(await requireCsrf(req, res, user.id))) return;

	// Confirming is a chain read per call, so it gets the write bucket rather
	// than the read one: a client polling this in a tight loop is what would
	// otherwise burn the RPC allowance.
	const rl = await limits.printOrderIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many confirmation attempts');

	const order = await getOrderWithEvents(id);
	if (!order || order.user_id !== user.id) {
		return error(res, 404, 'not_found', 'no such print order');
	}

	// Already settled: answer with the order rather than re-reading the chain.
	// A double-clicked confirm button must be a no-op, not a second verification.
	if (order.status !== 'quoted') {
		if (order.paid_at) {
			return json(res, 200, { status: 'confirmed', order: publicOrder(order) }, { 'cache-control': 'no-store' });
		}
		return error(res, 409, 'not_awaiting_payment', `this order is ${order.status} and is not waiting for a payment`);
	}

	if (!order.payment_reference) {
		return error(res, 409, 'no_payment_intent', 'this order has no payment reference to check');
	}
	if (order.quote_expires_at && new Date(order.quote_expires_at) < new Date()) {
		return error(res, 410, 'quote_expired', 'this quote expired before it was paid. Request a fresh quote and order again.');
	}

	const payTo = env.X402_PAY_TO_SOLANA;
	const mint = env.X402_ASSET_MINT_SOLANA;
	if (!payTo || !mint) {
		return error(res, 503, 'checkout_unavailable', 'Solana USDC checkout is not configured on this deployment');
	}

	const referenceKey = new PublicKey(order.payment_reference);

	let signatureInfo;
	try {
		signatureInfo = await rpc().withFallback((conn) => findReference(conn, referenceKey, { finality: 'confirmed' }));
	} catch (err) {
		if (isNotFound(err)) {
			return json(
				res,
				202,
				{ status: 'pending', message: 'No payment carrying this order\'s reference has confirmed yet.' },
				{ 'cache-control': 'no-store' },
			);
		}
		throw err;
	}

	const signature = signatureInfo.signature;
	const expected = new BigNumber(String(order.price_usdc)).decimalPlaces(USDC_DECIMALS);

	try {
		await rpc().withFallback((conn) =>
			validateTransfer(
				conn,
				signature,
				{
					recipient: new PublicKey(payTo),
					amount: expected,
					splToken: new PublicKey(mint),
					reference: referenceKey,
				},
				{ commitment: 'confirmed' },
			),
		);
	} catch (err) {
		// A transaction that carries our reference but does not satisfy the
		// transfer is a real problem the buyer needs to see, with the signature so
		// they can look at it themselves. It is deliberately not written to the
		// order: nothing here can prove what that transaction was for.
		return error(res, 422, 'payment_mismatch', `a transaction carrying this order's reference did not transfer ${expected.toString()} USDC to the platform wallet`, {
			signature,
			explorer_url: `https://solscan.io/tx/${signature}`,
			expected_usdc: expected.toString(),
			detail: String(err?.message || err).slice(0, 200),
		});
	}

	try {
		await transition({
			orderId: order.id,
			to: 'paid',
			note: `USDC payment confirmed on Solana: ${signature}`,
			actor: 'buyer',
			actorId: user.id,
			patch: {
				payment_signature: signature,
				payment_chain: 'solana',
				payment_amount_atomics: expected.multipliedBy(10 ** USDC_DECIMALS).toFixed(0),
			},
		});
		await transition({
			orderId: order.id,
			to: 'screening',
			note: 'Queued for the fabrication safety screen.',
			actor: 'system',
		});
	} catch (err) {
		if (err instanceof PrintStoreError) {
			// The payment is real and on chain; only the state move failed. Say so
			// with the signature attached rather than implying the money vanished.
			return error(res, 409, err.code, err.message, { signature, explorer_url: `https://solscan.io/tx/${signature}` });
		}
		throw err;
	}

	const settled = await getOrderWithEvents(order.id);
	return json(
		res,
		200,
		{
			status: 'confirmed',
			signature,
			explorer_url: `https://solscan.io/tx/${signature}`,
			order: publicOrder(settled),
			events: settled.events.map((e) => ({ status: e.status, note: e.note, actor: e.actor, created_at: e.created_at })),
		},
		{ 'cache-control': 'no-store' },
	);
});
