// AWS Marketplace ↔ x402 bridge.
//
// AWS Marketplace customers reach paid /api/x402/* endpoints by carrying a
// regular x402 subscription key. This module is the seam:
//
//   issueSubscriptionForCustomer()  — mint x402_subscriptions row + link it
//                                     onto aws_marketplace_customers. Returns
//                                     the existing key when it's still active;
//                                     mints a replacement when the prior link
//                                     was revoked (e.g. customer cancelled then
//                                     re-subscribed). Plaintext is only returned
//                                     for fresh mints.
//   meterAwsSubscriptionUsage()     — fire-and-forget MeterUsage(1) for a
//                                     subscription id, when the subscription
//                                     was issued via AWS Marketplace AND a
//                                     metering dimension is configured.
//   revokeSubscriptionForCustomer() — revoke the linked x402 subscription
//                                     when AWS sends unsubscribe-success.
//
// We rely on the x402_subscriptions.meta JSONB to carry the AWS linkage:
//   { source: 'aws-marketplace',
//     aws_customer_identifier: '<CustomerIdentifier>',
//     aws_product_code:        '<ProductCode>',
//     aws_offer_id:            '<OfferIdentifier|null>',
//     is_free_trial:           true|false,
//     issued_for:              'aws-marketplace' }
//
// Look-up by aws_customer_identifier uses the GIN-friendly meta->>'…' index
// declared in migrations/20260528000000_aws_marketplace_x402_link.sql.

import { sql } from './db.js';
import { env } from './env.js';
import { meterUsage } from './aws-marketplace.js';
import {
	createSubscription,
	revokeSubscription,
} from './x402/api-keys.js';

const AWS_META_KEY = 'aws_customer_identifier';

function rateLimitForCustomer(customer) {
	// Per-offer rate-limit overrides via env. Pattern: AWS_MP_RATE_LIMIT_<OFFER_ID>.
	// Falls back to the default. Useful when a single product code has multiple
	// pricing dimensions but the listing isn't split across product codes.
	if (customer.offer_id) {
		const key = `AWS_MP_RATE_LIMIT_${customer.offer_id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
		const override = Number(process.env[key]);
		if (Number.isFinite(override) && override > 0) return override;
	}
	return env.AWS_MP_DEFAULT_RATE_LIMIT_PER_MINUTE;
}

/**
 * Issue (or re-use) the x402 subscription for an AWS Marketplace customer.
 *
 * - Existing key is still active  → return it with `token: null, alreadyIssued: true`.
 * - Existing key was revoked      → mint a fresh subscription, relink, return plaintext.
 * - No existing key at all        → mint and return plaintext.
 *
 * The plaintext `token` is only returned at first surface — we never persist
 * it in clear, so a third call after the key was shown will return null again.
 *
 * @param {object} customer
 * @param {string} customer.customer_identifier   — stable AWS CustomerIdentifier
 * @param {string} customer.product_code          — AWS ProductCode
 * @param {string|null} [customer.offer_id]
 * @param {boolean} [customer.is_free_trial]
 * @param {string|null} [customer.user_id]        — three.ws user (when linked)
 * @returns {Promise<{ subscriptionId, keyPrefix, token, alreadyIssued, rateLimitPerMinute }>}
 */
export async function issueSubscriptionForCustomer(customer) {
	const customerId = customer.customer_identifier;
	if (!customerId) {
		throw new Error('issueSubscriptionForCustomer: customer_identifier is required');
	}

	// Already linked to an ACTIVE x402 subscription? Return that.
	// When the prior link is revoked (customer cancelled then re-subscribed),
	// fall through and mint a fresh subscription so the new bypass key works.
	const [existing] = await sql`
		select
			c.x402_subscription_id,
			s.key_prefix,
			s.rate_limit_per_minute,
			s.revoked_at,
			s.expires_at
		from aws_marketplace_customers c
		left join x402_subscriptions s on s.id = c.x402_subscription_id
		where c.customer_identifier = ${customerId}
		limit 1
	`;
	const stillActive =
		existing?.x402_subscription_id &&
		!existing.revoked_at &&
		(!existing.expires_at || new Date(existing.expires_at).getTime() > Date.now());
	if (stillActive) {
		return {
			subscriptionId: existing.x402_subscription_id,
			keyPrefix: existing.key_prefix,
			token: null,
			alreadyIssued: true,
			rateLimitPerMinute: existing.rate_limit_per_minute,
		};
	}

	const rateLimit = rateLimitForCustomer(customer);
	const subscription = await createSubscription({
		name: `aws-marketplace:${customerId}`,
		rateLimitPerMinute: rateLimit,
		meta: {
			source: 'aws-marketplace',
			[AWS_META_KEY]: customerId,
			aws_product_code: customer.product_code || env.AWS_MP_PRODUCT_CODE,
			aws_offer_id: customer.offer_id || null,
			is_free_trial: Boolean(customer.is_free_trial),
			issued_for: 'aws-marketplace',
		},
		createdBy: customer.user_id || null,
	});

	await sql`
		update aws_marketplace_customers
		set x402_subscription_id = ${subscription.id},
		    updated_at           = now()
		where customer_identifier = ${customerId}
	`;

	return {
		subscriptionId: subscription.id,
		keyPrefix: subscription.key_prefix,
		token: subscription.token,
		alreadyIssued: false,
		rateLimitPerMinute: subscription.rate_limit_per_minute,
	};
}

/**
 * Revoke the x402 subscription tied to an AWS customer. Idempotent.
 *
 * Clears `aws_marketplace_customers.x402_subscription_id` so a future
 * re-subscribe can mint a fresh key. The revoked x402_subscriptions row is
 * retained for audit (revoked_at is set, key_hash kept) — it can no longer
 * authenticate any request.
 *
 * Returns the revoked subscription id, or null if no link existed.
 */
export async function revokeSubscriptionForCustomer(customerIdentifier) {
	if (!customerIdentifier) return null;
	const [row] = await sql`
		select x402_subscription_id
		from aws_marketplace_customers
		where customer_identifier = ${customerIdentifier}
		limit 1
	`;
	if (!row?.x402_subscription_id) return null;
	await revokeSubscription(row.x402_subscription_id);
	await sql`
		update aws_marketplace_customers
		set x402_subscription_id = null,
		    updated_at           = now()
		where customer_identifier = ${customerIdentifier}
	`;
	return row.x402_subscription_id;
}

// In-flight de-dupe: AWS Marketplace charges idempotently per usage
// allocation id, but issuing MeterUsage twice per second is wasted I/O.
// This memoizes (subscriptionId, secondBucket) so an x402 endpoint that
// fires multiple times in the same second only meters once. The Postgres
// audit row in aws_marketplace_metering carries the canonical count.
const _inFlight = new Set();

/**
 * Fire-and-forget metering for a granted bypass on an AWS-linked subscription.
 * Resolves the AWS customer via the subscription meta and writes one row to
 * aws_marketplace_metering for every successful MeterUsage call.
 *
 * No-op when:
 *   • AWS_MP_METERING_DIMENSION env is unset (Contract product, not Usage).
 *   • The subscription was not issued via AWS Marketplace.
 *   • The customer subscription is no longer active.
 *
 * @param {object} args
 * @param {string} args.subscriptionId   — id of the x402_subscriptions row
 * @param {string} args.route            — route path for audit (e.g. /api/x402/...)
 */
export function meterAwsSubscriptionUsage({ subscriptionId, route }) {
	const dimension = env.AWS_MP_METERING_DIMENSION;
	if (!dimension || !subscriptionId) return;

	const bucket = Math.floor(Date.now() / 1000);
	const dedupeKey = `${subscriptionId}:${bucket}`;
	if (_inFlight.has(dedupeKey)) return;
	_inFlight.add(dedupeKey);

	queueMicrotask(async () => {
		try {
			const [row] = await sql`
				select
					c.customer_identifier,
					c.subscription_status
				from x402_subscriptions s
				join aws_marketplace_customers c on c.x402_subscription_id = s.id
				where s.id = ${subscriptionId}
				  and s.revoked_at is null
				limit 1
			`;
			if (!row) return;
			if (row.subscription_status === 'cancelled' || row.subscription_status === 'expired') {
				return;
			}

			const allocationId = `${subscriptionId}-${bucket}`;
			const recordId = await meterUsage({
				customerIdentifier: row.customer_identifier,
				dimension,
				quantity: 1,
				timestamp: new Date(bucket * 1000),
				usageAllocationId: allocationId,
			});

			await sql`
				insert into aws_marketplace_metering
					(customer_identifier, dimension, quantity, metering_record_id, usage_allocation_id)
				values
					(${row.customer_identifier}, ${dimension}, ${1}, ${recordId || null}, ${allocationId})
				on conflict (metering_record_id) do nothing
			`;
		} catch (err) {
			console.error('[aws-mp/bridge] meterAwsSubscriptionUsage failed', {
				subscriptionId,
				route,
				error: err?.message,
			});
		} finally {
			// Drop the dedupe entry after the bucket closes so the next second
			// can meter again. Keep memory bounded under steady traffic.
			setTimeout(() => _inFlight.delete(dedupeKey), 5000).unref?.();
		}
	});
}

/**
 * Test helper — exposes the in-flight set so unit tests can assert dedupe
 * behavior. Not part of the production API.
 */
export const __test = { _inFlight, AWS_META_KEY };
