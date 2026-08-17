// POST /api/aws-marketplace/register
//
// Registration URL for AWS Marketplace SaaS products.
//
// When a customer subscribes in AWS Marketplace and chooses "Set up your
// account" they are redirected here via an HTTP POST
// (application/x-www-form-urlencoded) with:
//   x-amzn-marketplace-token  : short-lived token to exchange for the buyer's identity
//   x-amzn-marketplace-offer-type — "free-trial" when the subscription is a trial
//
// Steps:
//   1. Exchange the token via ResolveCustomer. For a new SaaS integration AWS
//      returns LicenseArn + CustomerAWSAccountId and leaves CustomerIdentifier
//      empty, so the store keys on the license.
//   2. Upsert (or adopt) the row in aws_marketplace_customers.
//   3. If the caller is already signed into three.ws, link the row to their
//      user account immediately.
//   4. Redirect to /aws-marketplace/welcome?customer=<row id>&trial=<bool> so
//      the frontend can show a tailored onboarding flow. The handle is the row
//      id, never the license ARN: a grant identifier does not belong in a URL
//      that lands in browser history, referrers, and access logs.

import { readForm, wrap } from '../_lib/http.js';
import { resolveCustomer, awsMarketplaceConfigured } from '../_lib/aws-marketplace.js';
import { upsertResolvedCustomer, claimCustomerForUser } from '../_lib/aws-marketplace-store.js';
import { getSessionUser } from '../_lib/auth.js';
import { env } from '../_lib/env.js';

function redirect(res, location) {
	res.statusCode = 302;
	res.setHeader('location', location);
	res.setHeader('cache-control', 'no-store');
	res.end();
}

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

	// Without AWS credentials, ResolveCustomer throws on the missing env var and
	// the customer used to be told their registration token had expired: a dead
	// end that blames them for our deployment gap and sends the operator hunting
	// the wrong bug. Name the real cause in the log and in the reason code.
	if (!awsMarketplaceConfigured()) {
		console.error(
			'[aws-marketplace/register] AWS Marketplace is not configured; set AWS_MP_ACCESS_KEY_ID, AWS_MP_SECRET_ACCESS_KEY and AWS_MP_PRODUCT_CODE',
		);
		redirect(res, `${env.APP_ORIGIN}/aws-marketplace/error?reason=not_configured`);
		return;
	}

	let resolved;
	try {
		resolved = await resolveCustomer(token);
	} catch (err) {
		console.error('[aws-marketplace/register] resolveCustomer failed', err?.message);
		// Surface a user-readable error page rather than a raw 500.
		redirect(res, `${env.APP_ORIGIN}/aws-marketplace/error?reason=token_expired`);
		return;
	}

	// A token that resolves but yields no usable identity is an integration
	// fault, not a buyer fault, and silently inserting an unkeyed row would
	// hand out access we could never revoke. Refuse it loudly.
	if (!resolved.licenseArn && !resolved.customerIdentifier) {
		console.error('[aws-marketplace/register] ResolveCustomer returned neither LicenseArn nor CustomerIdentifier', {
			productCode: resolved.productCode,
			customerAWSAccountId: resolved.customerAWSAccountId,
		});
		redirect(res, `${env.APP_ORIGIN}/aws-marketplace/error?reason=unresolved_customer`);
		return;
	}

	let customer;
	try {
		customer = await upsertResolvedCustomer({
			licenseArn: resolved.licenseArn,
			customerAWSAccountId: resolved.customerAWSAccountId,
			customerIdentifier: resolved.customerIdentifier,
			productCode: resolved.productCode || env.AWS_MP_PRODUCT_CODE,
			isFreeTrial,
		});
	} catch (err) {
		console.error('[aws-marketplace/register] failed to persist customer', err?.message);
		redirect(res, `${env.APP_ORIGIN}/aws-marketplace/error?reason=link_failed`);
		return;
	}

	// If a three.ws session is already active, link accounts right now.
	const user = await getSessionUser(req).catch(() => null);
	if (user && !customer.user_id) {
		await claimCustomerForUser(customer.id, user.id).catch((err) => {
			console.error('[aws-marketplace/register] auto-link failed', err?.message);
			return null;
		});
	}

	const params = new URLSearchParams({
		customer: customer.id,
		trial: isFreeTrial ? '1' : '0',
	});
	if (!user) params.set('signup', '1');

	redirect(res, `${env.APP_ORIGIN}/aws-marketplace/welcome?${params}`);
});
