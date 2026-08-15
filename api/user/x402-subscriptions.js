// GET  /api/user/x402-subscriptions
//   Lists the signed-in user's x402 subscription keys (the credential an AWS
//   Marketplace customer is issued, and any native subscription created on
//   their behalf). Returns prefixes and usage only — never the secret.
//
// POST /api/user/x402-subscriptions
//   body { action: 'rotate' | 'revoke', id: '<subscriptionId>' }
//     rotate — revoke the old key and mint a fresh one. The new plaintext is
//              returned ONCE. For AWS-Marketplace-sourced keys this goes
//              through the billing bridge so the new key stays linked to the
//              AWS CustomerIdentifier and keeps metering correctly.
//     revoke — permanently disable a NATIVE key. AWS-sourced keys cannot be
//              bare-revoked here (that would cut off access the customer is
//              paying AWS for); cancellation must originate in AWS Marketplace.
//              Rotate them instead.
//
// Auth: session cookie (matches the sibling /api/aws-marketplace/* endpoints).

import { cors, json, readJson, wrap, method } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { createSubscription, revokeSubscription } from '../_lib/x402/api-keys.js';
import {
	issueSubscriptionForCustomer,
	revokeSubscriptionForCustomer,
} from '../_lib/aws-marketplace-bridge.js';

const AWS_SOURCE = 'aws-marketplace';

function deriveStatus(row) {
	if (row.revoked_at) return 'revoked';
	if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
	return 'active';
}

function shape(row) {
	const meta = row.meta || {};
	return {
		id: row.id,
		name: row.name,
		keyPrefix: row.key_prefix,
		rateLimitPerMinute: row.rate_limit_per_minute,
		status: deriveStatus(row),
		source: meta.source === AWS_SOURCE ? AWS_SOURCE : 'native',
		isFreeTrial: Boolean(meta.is_free_trial),
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		usage: {
			granted: Number(row.granted || 0),
			denied: Number(row.denied || 0),
			lastSeenAt: row.last_seen || null,
		},
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	let user;
	try {
		user = await getSessionUser(req);
	} catch {
		return json(res, 401, { error: 'unauthenticated' });
	}
	if (!user) return json(res, 401, { error: 'unauthenticated' });

	if (req.method === 'GET') {
		const rows = await sql`
			SELECT s.id, s.name, s.key_prefix, s.rate_limit_per_minute,
			       s.expires_at, s.revoked_at, s.meta, s.created_at,
			       u.granted, u.denied, u.last_seen
			FROM x402_subscriptions s
			LEFT JOIN LATERAL (
				SELECT count(*) FILTER (WHERE granted)     AS granted,
				       count(*) FILTER (WHERE NOT granted) AS denied,
				       max(created_at)                     AS last_seen
				FROM x402_access_log
				WHERE caller_id = 'subscription:' || s.id
			) u ON true
			WHERE s.created_by = ${user.id}
			ORDER BY s.created_at DESC
		`;
		return json(res, 200, { subscriptions: rows.map(shape) });
	}

	// POST — rotate or revoke. Both permanently change a live API credential on
	// nothing but the session cookie, so they need the same CSRF proof every
	// other session-auth writer here demands (provider-keys PATCH, the wallet
	// routes). Without it a cross-site form POST could revoke a paying
	// customer's key: the attacker never reads the response, but the write
	// already happened, which is the whole damage.
	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return json(res, 429, { error: 'rate_limited' });

	let body;
	try {
		body = await readJson(req);
	} catch {
		return json(res, 400, { error: 'invalid_json' });
	}

	const action = body?.action;
	const id = body?.id;
	if (action !== 'rotate' && action !== 'revoke') {
		return json(res, 400, { error: 'invalid_action' });
	}
	if (!id || typeof id !== 'string') {
		return json(res, 400, { error: 'missing_id' });
	}

	// Ownership check — never act on a subscription the caller doesn't own.
	const [sub] = await sql`
		SELECT id, name, rate_limit_per_minute, expires_at, revoked_at, meta, created_by
		FROM x402_subscriptions
		WHERE id = ${id}
	`;
	if (!sub || sub.created_by !== user.id) {
		return json(res, 404, { error: 'subscription_not_found' });
	}

	const meta = sub.meta || {};
	const isAws = meta.source === AWS_SOURCE;

	if (action === 'revoke') {
		if (isAws) {
			return json(res, 409, {
				error: 'aws_revoke_not_allowed',
				message:
					'This key bills through AWS Marketplace. Cancel the subscription in AWS Marketplace to stop billing, or rotate the key to replace it.',
			});
		}
		await revokeSubscription(id);
		return json(res, 200, { ok: true, action: 'revoke', id });
	}

	// rotate
	if (isAws) {
		const customerId = meta.aws_customer_identifier;
		if (!customerId) {
			return json(res, 422, { error: 'aws_customer_unresolved' });
		}
		const [customer] = await sql`
			SELECT customer_identifier, product_code, offer_id, is_free_trial,
			       subscription_status, user_id
			FROM aws_marketplace_customers
			WHERE customer_identifier = ${customerId}
		`;
		if (!customer) return json(res, 404, { error: 'customer_not_found' });
		if (
			customer.subscription_status === 'cancelled' ||
			customer.subscription_status === 'expired'
		) {
			return json(res, 409, {
				error: 'subscription_inactive',
				status: customer.subscription_status,
				message:
					'Your AWS Marketplace subscription is no longer active. Re-subscribe in AWS Marketplace to issue a new key.',
			});
		}

		// Revoke the prior link, then mint a fresh key through the bridge so the
		// new key stays attached to the AWS CustomerIdentifier and keeps metering.
		await revokeSubscriptionForCustomer(customerId);
		let issued;
		try {
			issued = await issueSubscriptionForCustomer({
				customer_identifier: customer.customer_identifier,
				product_code: customer.product_code,
				offer_id: customer.offer_id,
				is_free_trial: customer.is_free_trial,
				user_id: customer.user_id || user.id,
			});
		} catch (err) {
			console.error('[user/x402-subscriptions] aws rotate failed', { customerId, error: err?.message });
			return json(res, 502, { error: 'rotate_failed' });
		}
		return json(res, 200, {
			ok: true,
			action: 'rotate',
			source: AWS_SOURCE,
			subscription: {
				id: issued.subscriptionId,
				keyPrefix: issued.keyPrefix,
				token: issued.token,
				rateLimitPerMinute: issued.rateLimitPerMinute,
			},
		});
	}

	// Native rotate — mint the replacement FIRST, then revoke the old key.
	// Revoking first meant any mint failure (createSubscription rejects a row
	// with no name, for one) left the caller holding nothing: old key dead, new
	// key never issued, 502 with no way back. In this order a failed mint is
	// inert and the caller keeps a working key.
	// The AWS branch above must stay revoke-first for the opposite reason:
	// issueSubscriptionForCustomer short-circuits on a still-active link and
	// would hand back the existing subscription with a null token.
	let created;
	try {
		created = await createSubscription({
			name: sub.name,
			rateLimitPerMinute: sub.rate_limit_per_minute,
			expiresAt: sub.expires_at,
			meta: sub.meta,
			createdBy: user.id,
		});
	} catch (err) {
		console.error('[user/x402-subscriptions] native rotate failed', { id, error: err?.message });
		return json(res, 502, { error: 'rotate_failed' });
	}
	await revokeSubscription(id);
	return json(res, 200, {
		ok: true,
		action: 'rotate',
		source: 'native',
		subscription: {
			id: created.id,
			keyPrefix: created.key_prefix,
			token: created.token,
			rateLimitPerMinute: created.rate_limit_per_minute,
		},
	});
});
