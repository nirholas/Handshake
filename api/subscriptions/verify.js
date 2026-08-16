/**
 * POST /api/subscriptions/verify
 *
 * Second step of the user→agent subscription flow. The buyer broadcasts the
 * transaction returned by /api/subscriptions/subscribe and hands the signature
 * back here. We locate the pending `subscription_checkouts` row, validate the
 * on-chain transfer against the PERSISTED quote (never the client's numbers),
 * and — on success — activate the subscription: creator_subscriptions (active),
 * subscription_payments (first period), and the user_agent_subscriptions access
 * gate.
 *
 * Body: { transactionSignature?, tierId }
 *   transactionSignature is preferred; if omitted we scan the chain by reference.
 * Returns: { data: { success, status, subscription, current_period_end } }
 *          | { data: { status: 'pending' } } while the tx isn't visible yet.
 */

import { z } from 'zod';

import { sql } from '../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { verifySubscriptionPayment, activateSubscription } from '../_lib/subscription-checkout.js';

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/; // base58 signature

const bodySchema = z.object({
	tierId:               z.string().uuid(),
	transactionSignature: z.string().regex(SIG_RE, 'invalid signature').optional(),
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const parsed = bodySchema.safeParse(await readJson(req).catch(() => null));
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message || 'validation error');
	}
	const { tierId, transactionSignature } = parsed.data;

	const [checkout] = await sql`
		SELECT id, reference, user_id, plan_id, agent_id, status, amount, creator_amount,
		       platform_fee_amount, platform_fee_wallet, currency_mint, chain, recipient,
		       buyer_public_key, interval, expires_at, tx_signature, confirmed_at
		FROM subscription_checkouts
		WHERE user_id = ${auth.userId} AND plan_id = ${tierId}
		ORDER BY (status = 'pending') DESC, created_at DESC
		LIMIT 1
	`;
	if (!checkout) {
		return error(res, 404, 'no_pending_checkout', 'start a subscription before verifying it');
	}

	// Idempotent success: an already-confirmed checkout returns the live subscription.
	if (checkout.status === 'confirmed') {
		const [sub] = await sql`
			SELECT id, plan_id, status, current_period_start, current_period_end
			FROM creator_subscriptions
			WHERE plan_id = ${tierId} AND subscriber_user_id = ${auth.userId}
		`;
		return json(res, 200, {
			data: {
				success: true,
				status: sub?.status || 'active',
				subscription: sub || null,
				current_period_end: sub?.current_period_end || null,
				tx_signature: checkout.tx_signature,
			},
		});
	}

	if (checkout.status !== 'pending') {
		return error(res, 409, 'checkout_closed', `this checkout is ${checkout.status}`);
	}
	if (checkout.expires_at && new Date(checkout.expires_at) < new Date()) {
		await sql`UPDATE subscription_checkouts SET status = 'expired' WHERE id = ${checkout.id} AND status = 'pending'`;
		return error(res, 410, 'checkout_expired', 'this checkout expired, start a new subscription');
	}

	const result = await verifySubscriptionPayment(checkout, transactionSignature || null);

	if (result.status === 'pending') {
		return json(res, 200, { data: { status: 'pending' } });
	}
	if (result.status === 'mismatch') {
		// Funds may have moved but not as quoted — surface it, leave the checkout
		// pending so a corrected retry (or the by-reference scan) can still settle.
		return error(res, 409, 'transfer_mismatch', result.message || 'on-chain transfer did not match the quoted amount', {
			tx_signature: result.tx_signature,
		});
	}

	const activation = await activateSubscription(checkout, result.tx_signature, checkout.buyer_public_key);

	return json(res, 200, {
		data: {
			success: true,
			status: 'active',
			subscription: activation.subscription,
			current_period_end: activation.current_period_end || activation.subscription?.current_period_end || null,
			tx_signature: result.tx_signature,
		},
	});
});
