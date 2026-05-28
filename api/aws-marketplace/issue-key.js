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
// Body (JSON): { customer: "<customerIdentifier>" }
// Requires an active session cookie.

import { cors, json, readJson, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { issueSubscriptionForCustomer } from '../_lib/aws-marketplace-bridge.js';

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

	const [row] = await sql`
		SELECT customer_identifier, product_code, offer_id, is_free_trial,
		       subscription_status, user_id
		FROM aws_marketplace_customers
		WHERE customer_identifier = ${customerId}
	`;

	if (!row) return json(res, 404, { error: 'customer_not_found' });
	if (row.user_id && row.user_id !== user.id) {
		return json(res, 403, { error: 'customer_linked_to_other_account' });
	}
	if (row.subscription_status === 'cancelled' || row.subscription_status === 'expired') {
		return json(res, 409, { error: 'subscription_inactive', status: row.subscription_status });
	}

	let issued;
	try {
		issued = await issueSubscriptionForCustomer({
			customer_identifier: row.customer_identifier,
			product_code: row.product_code,
			offer_id: row.offer_id,
			is_free_trial: row.is_free_trial,
			user_id: row.user_id || user.id,
		});
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
