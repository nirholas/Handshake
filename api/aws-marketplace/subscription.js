// POST /api/aws-marketplace/subscription
//
// Amazon SNS webhook called by AWS Marketplace when a customer subscribes,
// unsubscribes, or when entitlements change.
//
// AWS sends three message types:
//   SubscriptionConfirmation — one-time handshake; we must GET the SubscribeURL.
//   UnsubscribeConfirmation  — mirrored when AWS cancels the subscription.
//   Notification             — actual subscription lifecycle events.
//
// Notification actions received for SaaS usage-based products:
//   subscribe-success        — customer has subscribed (isFreeTrialTermPresent may be true)
//   subscribe-fail           — subscription could not be completed
//   unsubscribe-success      — customer cancelled or subscription expired
//   entitlement-updated      — contract product entitlement changed

import { json, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { verifySnsMessage } from '../_lib/aws-marketplace.js';
import { revokeSubscriptionForCustomer } from '../_lib/aws-marketplace-bridge.js';
import { env } from '../_lib/env.js';

async function readRawBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

export default wrap(async (req, res) => {
	// AWS SNS sends POST for all message types.
	if (req.method !== 'POST') {
		res.statusCode = 405;
		res.end();
		return;
	}

	let msg;
	try {
		const raw = await readRawBody(req);
		msg = JSON.parse(raw);
	} catch {
		res.statusCode = 400;
		res.end();
		return;
	}

	// Verify the message was genuinely signed by AWS.
	try {
		await verifySnsMessage(msg);
	} catch (err) {
		console.error('[aws-marketplace/subscription] SNS verification failed', err?.message);
		res.statusCode = 403;
		res.end();
		return;
	}

	if (msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation') {
		// Confirm the SNS subscription by hitting the provided URL.
		try {
			await fetch(msg.SubscribeURL);
		} catch (err) {
			console.error('[aws-marketplace/subscription] failed to confirm SNS subscription', err?.message);
		}
		return json(res, 200, { ok: true });
	}

	if (msg.Type !== 'Notification') {
		return json(res, 200, { ok: true });
	}

	let payload;
	try {
		payload = JSON.parse(msg.Message);
	} catch {
		console.error('[aws-marketplace/subscription] malformed Notification message');
		return json(res, 400, { error: 'malformed_message' });
	}

	const { action, 'customer-identifier': customerId, 'product-code': productCode, 'offer-identifier': offerId, isFreeTrialTermPresent } = payload;
	const isFreeTrial = isFreeTrialTermPresent === 'true' || isFreeTrialTermPresent === true;

	if (!customerId) {
		console.error('[aws-marketplace/subscription] missing customer-identifier', payload);
		return json(res, 400, { error: 'missing_customer_identifier' });
	}

	if (action === 'subscribe-success') {
		await sql`
			INSERT INTO aws_marketplace_customers
				(customer_identifier, product_code, offer_id, subscription_status, is_free_trial, subscribed_at)
			VALUES
				(${customerId}, ${productCode ?? env.AWS_MP_PRODUCT_CODE}, ${offerId ?? null},
				 ${isFreeTrial ? 'trial' : 'active'}, ${isFreeTrial}, now())
			ON CONFLICT (customer_identifier) DO UPDATE SET
				subscription_status = EXCLUDED.subscription_status,
				is_free_trial       = EXCLUDED.is_free_trial,
				offer_id            = COALESCE(EXCLUDED.offer_id, aws_marketplace_customers.offer_id),
				subscribed_at       = COALESCE(aws_marketplace_customers.subscribed_at, now()),
				cancelled_at        = NULL,
				updated_at          = now()
		`;
	} else if (action === 'unsubscribe-success') {
		// Revoke the x402 bypass key BEFORE flipping status — if the revoke
		// fails we leave the row 'active' so we can retry from the dead-letter
		// queue rather than ending up with a cancelled customer who still has
		// a working key.
		try {
			await revokeSubscriptionForCustomer(customerId);
		} catch (err) {
			console.error('[aws-marketplace/subscription] revoke failed', {
				customerId,
				error: err?.message,
			});
			return json(res, 500, { error: 'revoke_failed' });
		}
		await sql`
			UPDATE aws_marketplace_customers
			SET subscription_status = 'cancelled',
			    cancelled_at        = now(),
			    updated_at          = now()
			WHERE customer_identifier = ${customerId}
		`;
	} else if (action === 'subscribe-fail') {
		try {
			await revokeSubscriptionForCustomer(customerId);
		} catch (err) {
			console.error('[aws-marketplace/subscription] revoke on fail failed', {
				customerId,
				error: err?.message,
			});
		}
		await sql`
			UPDATE aws_marketplace_customers
			SET subscription_status = 'expired',
			    updated_at          = now()
			WHERE customer_identifier = ${customerId}
		`;
	} else if (action === 'entitlement-updated') {
		// Contract products use entitlements; usage products ignore this beat.
		// For both, we touch updated_at so audit queries reflect the event.
		// If a tier change implies a different rate-limit, the partner will
		// see it on next /api/x402/* call: lookupSubscription reads the live
		// rate_limit_per_minute from the row, so a follow-up admin update
		// (or future per-tier auto-tune) takes effect without a re-issue.
		await sql`
			UPDATE aws_marketplace_customers
			SET offer_id   = COALESCE(${offerId ?? null}, offer_id),
			    updated_at = now()
			WHERE customer_identifier = ${customerId}
		`;
	}

	return json(res, 200, { ok: true });
});
