// POST /api/aws-marketplace/issue-key
//
// Mints (or returns the existing) x402 subscription API key for the AWS
// Marketplace customer linked to the signed-in user. The plaintext key is
// returned ONCE on first issue — subsequent calls return alreadyIssued=true
// without the plaintext (we never store it in clear).
//
// Called by /aws-marketplace/welcome after /api/aws-marketplace/link succeeds,
// so the customer can copy the key and start calling /api/x402/* immediately.
//
// Body (JSON): { customer: "<row id, or a legacy CustomerIdentifier>" }
// Requires an active session cookie.

import { cors, json, readJson, wrap } from '../_lib/http.js';
import { getSessionUser } from '../_lib/auth.js';
import { issueSubscriptionForCustomer } from '../_lib/aws-marketplace-bridge.js';
import { findCustomerByHandle } from '../_lib/aws-marketplace-store.js';
import { customerEntitlement } from '../_lib/aws-marketplace.js';
import { env } from '../_lib/env.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;

	if (req.method !== 'POST') {
		res.statusCode = 405;
		res.setHeader('allow', 'POST');
		res.end();
		return;
	}

	let user;
	try {
		user = await getSessionUser(req);
	} catch {
		return json(res, 401, { error: 'unauthenticated' });
	}
	if (!user) return json(res, 401, { error: 'unauthenticated' });

	let body;
	try {
		body = await readJson(req);
	} catch {
		return json(res, 400, { error: 'invalid_json' });
	}

	const { customer: customerId } = body;
	if (!customerId || typeof customerId !== 'string') {
		return json(res, 400, { error: 'missing_customer' });
	}

	const row = await findCustomerByHandle(customerId);

	if (!row) return json(res, 404, { error: 'customer_not_found' });
	if (row.user_id && row.user_id !== user.id) {
		return json(res, 403, { error: 'customer_linked_to_other_account' });
	}
	if (row.subscription_status === 'cancelled' || row.subscription_status === 'expired') {
		return json(res, 409, { error: 'subscription_inactive', status: row.subscription_status });
	}

	// Contract (entitlement-based) products: gate key issuance on a REAL
	// GetEntitlements check against AWS. Usage-based products have no entitlements
	// (metering is the billing), so this is opt-in via AWS_MP_ENTITLEMENT_REQUIRED
	// and a no-op otherwise. Degrades open when AWS is unconfigured (inert path);
	// a throttled/unavailable AWS surfaces an actionable 503 instead of a 500.
	if (env.AWS_MP_ENTITLEMENT_REQUIRED) {
		try {
			const ent = await customerEntitlement({
				customerAWSAccountId: row.customer_aws_account_id,
				customerIdentifier: row.customer_identifier,
			});
			if (ent.configured && ent.entitled === false) {
				return json(res, 403, {
					error: 'not_entitled',
					message: 'Your AWS Marketplace entitlement is not active. Renew or re-subscribe in AWS Marketplace, then try again.',
				});
			}
		} catch (err) {
			console.error('[aws-marketplace/issue-key] entitlement check failed', { customerId, error: err?.message });
			return json(res, 503, {
				error: 'entitlement_unavailable',
				retryable: Boolean(err?.retryable),
				message: 'We could not verify your AWS Marketplace entitlement just now. Please retry in a moment.',
			});
		}
	}

	let issued;
	try {
		issued = await issueSubscriptionForCustomer({ ...row, user_id: row.user_id || user.id });
	} catch (err) {
		console.error('[aws-marketplace/issue-key] failed', {
			customerId,
			error: err?.message,
		});
		return json(res, 502, { error: 'issue_failed' });
	}

	return json(res, 200, {
		ok: true,
		subscription: {
			id: issued.subscriptionId,
			keyPrefix: issued.keyPrefix,
			token: issued.token,
			rateLimitPerMinute: issued.rateLimitPerMinute,
			alreadyIssued: issued.alreadyIssued,
		},
	});
});
