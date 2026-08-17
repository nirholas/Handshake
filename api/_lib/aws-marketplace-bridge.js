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
//   meterAwsSubscriptionUsage()     : fire-and-forget metering for a
//                                     subscription id, when the subscription
//                                     was issued via AWS Marketplace AND a
//                                     metering dimension is configured.
//   revokeSubscriptionForCustomer() — revoke the linked x402 subscription
//                                     when AWS ends the agreement or
//                                     deprovisions the license.
//
// We rely on the x402_subscriptions.meta JSONB to carry the AWS linkage:
//   { source: 'aws-marketplace',
//     aws_customer_row_id:      '<aws_marketplace_customers.id>',
//     aws_license_arn:          '<LicenseArn|null>',
//     aws_customer_account_id:  '<CustomerAWSAccountId|null>',
//     aws_customer_identifier:  '<CustomerIdentifier|null, legacy>',
//     aws_product_code:         '<ProductCode>',
//     aws_offer_id:             '<OfferIdentifier|null>',
//     is_free_trial:            true|false,
//     issued_for:               'aws-marketplace' }
//
// The row id is the join key rather than the license ARN: a license ARN is a
// grant identifier and belongs in exactly one table, and the row id survives a
// buyer whose row was opened by an agreement event before any license existed.
// Look-up uses the expression index declared in
// migrations/20260817120000_aws_marketplace_concurrent_agreements.sql.

import { sql } from './db.js';
import { env } from './env.js';
import { meterUsage } from './aws-marketplace.js';
import {
	createSubscription,
	revokeSubscription,
} from './x402/api-keys.js';

const AWS_ROW_META_KEY = 'aws_customer_row_id';
const AWS_LEGACY_META_KEY = 'aws_customer_identifier';

/**
 * Returns true when an x402 subscription belongs to an AWS Marketplace
 * customer whose AWS-side subscription_status is no longer active. The
 * access-control hook calls this so cancellations are enforced even before
 * the lifecycle event revokes the x402 row (delivery can lag by minutes).
 * Returns false when the subscription isn't AWS-issued.
 */
export async function isAwsCustomerInactive(subscription) {
	if (!subscription) return false;
	if (subscription.meta?.source !== 'aws-marketplace') return false;

	const rowId = subscription.meta?.[AWS_ROW_META_KEY];
	const legacyId = subscription.meta?.[AWS_LEGACY_META_KEY];
	if (!rowId && !legacyId) return false;

	const [row] = rowId
		? await sql`
			select subscription_status from aws_marketplace_customers
			where id = ${rowId} limit 1
		`
		: await sql`
			select subscription_status from aws_marketplace_customers
			where customer_identifier = ${legacyId} limit 1
		`;
	if (!row) return true;
	return row.subscription_status === 'cancelled' || row.subscription_status === 'expired';
}

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
 * @param {object} customer  a row from aws-marketplace-store.js
 * @returns {Promise<{ subscriptionId, keyPrefix, token, alreadyIssued, rateLimitPerMinute }>}
 */
export async function issueSubscriptionForCustomer(customer) {
	const rowId = customer?.id;
	if (!rowId) {
		throw new Error('issueSubscriptionForCustomer: customer row id is required');
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
		where c.id = ${rowId}
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
		name: `aws-marketplace:${rowId}`,
		rateLimitPerMinute: rateLimit,
		meta: {
			source: 'aws-marketplace',
			[AWS_ROW_META_KEY]: rowId,
			aws_license_arn: customer.license_arn || null,
			aws_customer_account_id: customer.customer_aws_account_id || null,
			[AWS_LEGACY_META_KEY]: customer.customer_identifier || null,
			aws_product_code: customer.product_code || null,
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
		where id = ${rowId}
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
 * Revoke the x402 subscription tied to an AWS customer row. Idempotent.
 *
 * Clears `aws_marketplace_customers.x402_subscription_id` so a future
 * re-subscribe can mint a fresh key. The revoked x402_subscriptions row is
 * retained for audit (revoked_at is set, key_hash kept) — it can no longer
 * authenticate any request.
 *
 * Returns the revoked subscription id, or null if no link existed.
 */
export async function revokeSubscriptionForCustomer(rowId) {
	if (!rowId) return null;
	const [row] = await sql`
		select x402_subscription_id
		from aws_marketplace_customers
		where id = ${rowId}
		limit 1
	`;
	if (!row?.x402_subscription_id) return null;
	await revokeSubscription(row.x402_subscription_id);
	await sql`
		update aws_marketplace_customers
		set x402_subscription_id = null,
		    updated_at           = now()
		where id = ${rowId}
	`;
	return row.x402_subscription_id;
}

// In-flight de-dupe: AWS Marketplace de-duplicates metering records on the
// hour, but issuing a metering call twice per second is wasted I/O. This
// memoizes (subscriptionId, secondBucket) so an x402 endpoint that fires
// multiple times in the same second only meters once. The Postgres audit row in
// aws_marketplace_metering carries the canonical count.
const _inFlight = new Set();

/**
 * Fire-and-forget metering for a granted bypass on an AWS-linked subscription.
 * Resolves the AWS customer via the subscription link and writes one row to
 * aws_marketplace_metering for every accepted metering call.
 *
 * No-op when:
 *   • AWS_MP_METERING_DIMENSION env is unset (free or contract listing).
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
					c.id,
					c.license_arn,
					c.customer_aws_account_id,
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

			const recordId = await meterUsage({
				licenseArn: row.license_arn,
				customerAWSAccountId: row.customer_aws_account_id,
				customerIdentifier: row.customer_identifier,
				dimension,
				quantity: 1,
				timestamp: new Date(bucket * 1000),
			});

			await sql`
				insert into aws_marketplace_metering
					(customer_row_id, customer_identifier, license_arn, dimension, quantity,
					 metering_record_id, usage_allocation_id)
				values
					(${row.id}, ${row.customer_identifier}, ${row.license_arn}, ${dimension}, ${1},
					 ${recordId || null}, ${`${subscriptionId}-${bucket}`})
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
export const __test = { _inFlight, AWS_ROW_META_KEY, AWS_LEGACY_META_KEY };
