/**
 * Subscription billing — charge a creator subscription via x402.
 *
 * x402 is request-payment: the server cannot pull funds from a stored wallet.
 * For a recurring subscription we therefore:
 *   1. Insert a `subscription_payments` row marked 'pending' with the price.
 *   2. Insert an `agent_payment_intents` row the subscriber can pay against.
 *      The intent carries the canonical price + currency + payout address so
 *      the subscriber's wallet can construct the transfer without trusting
 *      the client UI.
 *   3. Insert a `user_notifications` row of type `subscription_renewal_required`
 *      so the subscriber sees an in-app prompt the next time they sign in.
 *   4. Return `{ pending: true, paymentId, intentId, payUrl }`.
 *      The caller (cron, billing dashboard) gets a real URL it can email or
 *      surface as a button.
 *
 * When the subscriber pays and the tx lands, the existing tx-confirmation
 * path calls `confirmPayment(paymentId, txHash)` which advances the
 * subscription's current_period_end.
 */

import { sql } from './db.js';
import { env } from './env.js';
import { nanoid } from 'nanoid';

const APP_ORIGIN =
	env.APP_ORIGIN ||
	env.ISSUER ||
	process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}` ||
	'https://three.ws';

/**
 * Attempt to charge a subscription for its current period.
 *
 * Builds a real checkout intent the subscriber can pay against and notifies
 * them in-app. Returns `pending: true` with a payment URL so the caller can
 * surface it (email, dashboard banner). On confirmed payment the cron's
 * confirm-tx path calls confirmPayment() which advances current_period_end.
 *
 * @param {string} subscriptionId
 * @returns {Promise<{ success: boolean, pending?: boolean, paymentId?: string, intentId?: string, payUrl?: string, amount_usd?: number, error?: string }>}
 */
export async function chargeSubscription(subscriptionId) {
	const [row] = await sql`
		SELECT
			cs.id, cs.plan_id, cs.subscriber_user_id, cs.wallet_address,
			cs.current_period_end, cs.payment_method, cs.chain, cs.currency_mint,
			sp.price_usd, sp.creator_id, sp.agent_id,
			u.email AS subscriber_email,
			payout.address AS payout_address
		FROM creator_subscriptions cs
		JOIN subscription_plans sp ON sp.id = cs.plan_id
		JOIN users u ON u.id = cs.subscriber_user_id
		LEFT JOIN agent_payout_wallets payout
			ON payout.user_id = sp.creator_id
		   AND payout.chain = cs.chain
		   AND payout.is_default = true
		WHERE cs.id = ${subscriptionId}
		LIMIT 1
	`;

	if (!row) {
		return { success: false, error: 'subscription_not_found' };
	}

	if (!row.payout_address) {
		// Creator hasn't configured a destination wallet — we can't direct the
		// subscriber where to pay. Surface this as a configuration failure
		// rather than silently treating it as a pending charge.
		return { success: false, error: 'creator_payout_wallet_missing' };
	}

	if (!row.agent_id) {
		// The renewal intent is an agent-scoped payable row (agent_payment_intents
		// .agent_id is NOT NULL and references agent_identities), so a plan that
		// was never attached to an agent has nothing to bill against. Say that
		// plainly here rather than letting the insert below fail as an opaque
		// intent_create_failed the creator cannot act on.
		return { success: false, error: 'plan_agent_missing' };
	}

	// Create the pending payment record — idempotently. At most one pending
	// payment may exist per (subscription, period): the partial-unique index makes
	// a concurrent/retried cron pass conflict instead of minting a second payable
	// intent for the same period. On conflict we REUSE the existing pending payment
	// (and its intent) rather than creating duplicates.
	const periodEnd = row.current_period_end;
	let [payment] = await sql`
		INSERT INTO subscription_payments (subscription_id, amount_usd, status, period_end)
		VALUES (${subscriptionId}, ${row.price_usd}, 'pending', ${periodEnd})
		ON CONFLICT (subscription_id, period_end) WHERE status = 'pending' AND period_end IS NOT NULL
		DO NOTHING
		RETURNING id, status, amount_usd
	`;
	let reusing = false;
	if (!payment) {
		[payment] = await sql`
			SELECT id, status, amount_usd FROM subscription_payments
			WHERE subscription_id = ${subscriptionId} AND period_end = ${periodEnd}
			  AND status = 'pending'
			ORDER BY created_at DESC LIMIT 1
		`;
		reusing = true;
		if (!payment) {
			// The conflicting row left 'pending' between our insert and select — a
			// charge is mid-flight for this period; let the next pass settle it.
			return { success: false, error: 'charge_in_progress' };
		}
	}

	const amountAtomics = String(BigInt(Math.round(row.price_usd * 1_000_000)));
	const memo = `sub:${subscriptionId}:${payment.id}`;

	// If we're reusing an existing pending payment that already has a live intent,
	// hand back THAT intent — never mint a second payable intent for one period.
	if (reusing) {
		const [existingIntent] = await sql`
			SELECT id FROM agent_payment_intents
			WHERE memo = ${memo} AND status = 'pending'
			ORDER BY start_time DESC LIMIT 1
		`;
		if (existingIntent) {
			return {
				success: false,
				pending: true,
				paymentId: payment.id,
				intentId: existingIntent.id,
				payUrl: `${APP_ORIGIN}/pay?intent=${encodeURIComponent(existingIntent.id)}`,
				amount_usd: Number(row.price_usd),
				reused: true,
			};
		}
	}

	// Create the matching payment intent so the subscriber can actually pay.
	// Amount stored in canonical USDC atomics — both EVM and Solana USDC are
	// 6-decimal so the conversion is identical.
	const intentId = `sub_${nanoid()}`;
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 7 * 24 * 3600 * 1000); // 7-day grace window

	try {
		await sql`
			INSERT INTO agent_payment_intents
				(id, payer_user_id, agent_id, currency_mint, amount, memo,
				 start_time, end_time, status, cluster, payload, expires_at)
			VALUES
				(${intentId}, ${row.subscriber_user_id},
				 ${row.agent_id}, ${row.currency_mint || 'USDC'},
				 ${amountAtomics}, ${memo},
				 ${now}, ${expiresAt}, 'pending',
				 ${row.chain === 'solana' ? 'mainnet' : row.chain || 'evm'},
				 ${JSON.stringify({
					kind: 'subscription_renewal',
					subscription_id: subscriptionId,
					payment_id: payment.id,
					recipient_address: row.payout_address,
					subscriber_wallet: row.wallet_address || null,
					plan_id: row.plan_id,
				})},
				 ${expiresAt})
		`;
	} catch (err) {
		// Log the cause before collapsing it to a code. The caller only ever sees
		// 'intent_create_failed', so discarding `err` here left a total billing
		// outage (a NOT NULL / foreign-key violation on the intent row) looking
		// like a transient blip in the cron report and in the ops alert.
		console.error(
			JSON.stringify({
				event: 'subscription_billing.intent_create_failed',
				subscriptionId,
				paymentId: payment.id,
				error: err?.message || String(err),
			}),
		);
		// Roll the payment row back to 'failed' so it doesn't sit in pending
		// forever and the next cron pass can retry.
		await sql`
			UPDATE subscription_payments
			SET status = 'failed'
			WHERE id = ${payment.id} AND status = 'pending'
		`;
		return {
			success: false,
			error: 'intent_create_failed',
			paymentId: payment.id,
		};
	}

	const payUrl = `${APP_ORIGIN}/pay?intent=${encodeURIComponent(intentId)}`;

	// In-app notification so the subscriber sees the renewal prompt next sign-in.
	try {
		await sql`
			INSERT INTO user_notifications (user_id, type, payload)
			VALUES (
				${row.subscriber_user_id},
				'subscription_renewal_required',
				${JSON.stringify({
					subscription_id: subscriptionId,
					payment_id: payment.id,
					intent_id: intentId,
					amount_usd: row.price_usd,
					pay_url: payUrl,
					expires_at: expiresAt.toISOString(),
				})}
			)
		`;
	} catch (err) {
		// Notification insert failure is non-fatal — payment + intent still
		// exist so the cron can email/notify by another channel.
		console.warn('[subscription-billing] notification insert failed', {
			subscription_id: subscriptionId,
			error: err?.message,
		});
	}

	return {
		success: false,
		pending: true,
		paymentId: payment.id,
		intentId,
		payUrl,
		amount_usd: Number(row.price_usd),
	};
}

/**
 * Mark a pending payment as succeeded (called from a webhook or confirm endpoint).
 *
 * @param {string} paymentId
 * @param {string} txHash
 */
export async function confirmPayment(paymentId, txHash) {
	const [payment] = await sql`
		UPDATE subscription_payments
		SET status = 'succeeded', tx_hash = ${txHash}, paid_at = now()
		WHERE id = ${paymentId} AND status = 'pending'
		RETURNING id, subscription_id
	`;
	if (!payment) return { ok: false, error: 'payment_not_found_or_already_processed' };

	// Advance current_period_end on the subscription.
	const [sub] = await sql`
		SELECT cs.current_period_end, sp.interval
		FROM creator_subscriptions cs
		JOIN subscription_plans sp ON sp.id = cs.plan_id
		WHERE cs.id = ${payment.subscription_id}
	`;
	if (sub) {
		const periodMs = sub.interval === 'weekly' ? 7 * 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000;
		const nextEnd = new Date(new Date(sub.current_period_end).getTime() + periodMs).toISOString();
		// GREATEST so an out-of-order confirm (e.g. a manual replay) can only ever
		// move the period boundary forward, never rewind a subscriber's paid time.
		await sql`
			UPDATE creator_subscriptions
			SET current_period_end = GREATEST(current_period_end, ${nextEnd}::timestamptz),
			    status = 'active'
			WHERE id = ${payment.subscription_id}
		`;
	}

	// Mark the matching payment_intent settled, if one exists.
	try {
		await sql`
			UPDATE agent_payment_intents
			SET status = 'settled', tx_signature = ${txHash}, paid_at = now()
			WHERE memo = ${`sub:${payment.subscription_id}:${paymentId}`}
			  AND status = 'pending'
		`;
	} catch (err) {
		console.warn('[subscription-billing] intent settle failed', {
			payment_id: paymentId,
			error: err?.message,
		});
	}

	return { ok: true, paymentId };
}

/**
 * Mark a payment as failed and optionally set subscription to past_due.
 *
 * @param {string} paymentId
 * @param {string} subscriptionId
 */
export async function failPayment(paymentId, subscriptionId) {
	await sql`
		UPDATE subscription_payments SET status = 'failed'
		WHERE id = ${paymentId}
	`;

	// Count failures for this subscription to decide whether to set past_due.
	const [{ failCount }] = await sql`
		SELECT count(*)::int AS "failCount"
		FROM subscription_payments
		WHERE subscription_id = ${subscriptionId} AND status = 'failed'
	`;

	if (failCount >= 3) {
		await sql`
			UPDATE creator_subscriptions SET status = 'past_due'
			WHERE id = ${subscriptionId} AND status = 'active'
		`;
	}
}
