// POST /api/aws-marketplace/register
//
// Registration URL for AWS Marketplace SaaS products.
//
// When a customer subscribes in AWS Marketplace they are redirected here via
// an HTTP POST (application/x-www-form-urlencoded) with:
//   x-amzn-marketplace-token  — short-lived token to exchange for customer ID
//   x-amzn-marketplace-offer-type — "free-trial" when the subscription is a trial
//
// Steps:
//   1. Exchange token for stable CustomerIdentifier via ResolveCustomer.
//   2. Upsert the customer row in aws_marketplace_customers.
//   3. If the caller is already signed into three.ws, link the customer record
//      to their user account immediately.
//   4. Redirect to /aws-marketplace/welcome?customer=<id>&trial=<bool>
//      so the frontend can show a tailored onboarding flow.

import { readForm, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { resolveCustomer } from '../_lib/aws-marketplace.js';
import { getSessionUser } from '../_lib/auth.js';
import { env } from '../_lib/env.js';

export default wrap(async (req, res) => {
	if (req.method !== 'POST') {
		res.statusCode = 405;
		res.setHeader('allow', 'POST');
		res.end();
		return;
	}

	let token, offerType;
	try {
		const body = await readForm(req);
		token = body['x-amzn-marketplace-token'];
		offerType = body['x-amzn-marketplace-offer-type'] ?? '';
	} catch {
		res.statusCode = 400;
		res.end('bad request');
		return;
	}

	if (!token) {
		res.statusCode = 400;
		res.end('missing x-amzn-marketplace-token');
		return;
	}

	const isFreeTrial = offerType === 'free-trial';

	let customer;
	try {
		customer = await resolveCustomer(token);
	} catch (err) {
		console.error('[aws-marketplace/register] resolveCustomer failed', err?.message);
		// Surface a user-readable error page rather than a raw 500.
		res.statusCode = 302;
		res.setHeader('location', `${env.APP_ORIGIN}/aws-marketplace/error?reason=token_expired`);
		res.setHeader('cache-control', 'no-store');
		res.end();
		return;
	}

	const { customerIdentifier, productCode, customerAWSAccountId } = customer;

	// Persist / update the customer record.
	await sql`
		INSERT INTO aws_marketplace_customers
			(customer_identifier, product_code, customer_aws_account_id,
			 subscription_status, is_free_trial, subscribed_at)
		VALUES
			(${customerIdentifier}, ${productCode}, ${customerAWSAccountId ?? null},
			 ${isFreeTrial ? 'trial' : 'active'}, ${isFreeTrial}, now())
		ON CONFLICT (customer_identifier) DO UPDATE SET
			customer_aws_account_id = COALESCE(EXCLUDED.customer_aws_account_id, aws_marketplace_customers.customer_aws_account_id),
			subscription_status     = CASE
				WHEN aws_marketplace_customers.subscription_status IN ('cancelled', 'expired')
				THEN EXCLUDED.subscription_status
				ELSE aws_marketplace_customers.subscription_status
			END,
			updated_at = now()
	`;

	// If a three.ws session is already active, link accounts right now.
	const user = await getSessionUser(req).catch(() => null);
	if (user) {
		await sql`
			UPDATE aws_marketplace_customers
			SET user_id    = ${user.id},
			    updated_at = now()
			WHERE customer_identifier = ${customerIdentifier}
			  AND user_id IS NULL
		`;
	}

	// Redirect to the frontend onboarding page.
	const params = new URLSearchParams({
		customer: customerIdentifier,
		trial: isFreeTrial ? '1' : '0',
	});
	if (!user) params.set('signup', '1');

	res.statusCode = 302;
	res.setHeader('location', `${env.APP_ORIGIN}/aws-marketplace/welcome?${params}`);
	res.setHeader('cache-control', 'no-store');
	res.end();
});
