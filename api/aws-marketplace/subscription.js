// POST /api/aws-marketplace/subscription
//
// Lifecycle webhook for the AWS Marketplace listing. Accepts BOTH transports,
// because which one AWS uses depends on when the product was created:
//
//   EventBridge, the transport AWS has required of new products since 2026-06-01.
//     Agreement and license events land on the seller account's default event
//     bus with source `aws.agreement-marketplace`. EventBridge cannot POST to an
//     external HTTPS endpoint, so a rule relays them through an API destination
//     whose connection attaches a shared secret header. The events carry a
//     LicenseArn and an agreement id; they never carry a CustomerIdentifier.
//       Purchase Agreement Created / Amended  → grant
//       Purchase Agreement Ended              → revoke
//       License Updated                       → grant, and attach the license
//       License Deprovisioned                 → revoke
//
//   Amazon SNS (existing products)
//     The aws-mp-subscription-notification-<PRODUCTCODE> topic, signed by AWS.
//       subscribe-success / unsubscribe-success / subscribe-fail / entitlement-updated
//
// Both paths converge on the same store, so a listing that is migrated from one
// transport to the other keeps working without a code change.

import { json, wrap, readBody } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import {
	verifySnsMessage,
	assertAwsHttpsUrl,
	isEventBridgeEnvelope,
	parseMarketplaceEvent,
	verifyEventSecret,
} from '../_lib/aws-marketplace.js';
import { revokeSubscriptionForCustomer } from '../_lib/aws-marketplace-bridge.js';
import {
	upsertResolvedCustomer,
	recordAgreementCreated,
	attachLicenseToAgreement,
	resolveLifecycleTargets,
	markCustomerStatus,
} from '../_lib/aws-marketplace-store.js';
import { env } from '../_lib/env.js';

// Delegates to the shared readBody (api/_lib/http.js), which prefers the
// pre-parsed req.rawBody/req.body the Cloud Run server already captured —
// re-reading the raw stream here (as this function used to) hangs forever
// once Express has drained it.
async function readRawBody(req) {
	return (await readBody(req, 1_000_000)).toString('utf8');
}

/**
 * Revoke a buyer's access. Revokes the x402 key BEFORE flipping status. If the
 * revoke fails we leave the row live so the event can be retried, rather than
 * ending up with a cancelled customer who still holds a working key.
 */
async function revokeCustomer(row, status) {
	await revokeSubscriptionForCustomer(row.id);
	await markCustomerStatus(row.id, status);
}

// ── EventBridge ──────────────────────────────────────────────────────────────

async function handleEventBridge(req, res, event) {
	const secretFailure = verifyEventSecret(req);
	if (secretFailure) {
		if (secretFailure === 'not_configured') {
			console.error('[aws-marketplace/subscription] refusing EventBridge delivery: AWS_MP_EVENT_SECRET is not set');
			return json(res, 503, { error: 'not_configured' });
		}
		console.error('[aws-marketplace/subscription] EventBridge secret rejected', { reason: secretFailure });
		return json(res, 403, { error: 'forbidden' });
	}

	const parsed = parseMarketplaceEvent(event);
	if (!parsed) {
		console.error('[aws-marketplace/subscription] event from unexpected source', { source: event.source });
		return json(res, 400, { error: 'unexpected_source' });
	}
	if (parsed.kind === 'ignored') {
		return json(res, 200, { ok: true, ignored: parsed.detailType });
	}

	const productCode = parsed.productCode || env.AWS_MP_PRODUCT_CODE;

	if (parsed.kind === 'agreement-created') {
		const row = await recordAgreementCreated({
			agreementId: parsed.agreementId,
			acceptorAccountId: parsed.acceptorAccountId,
			offerId: parsed.offerId,
			productCode,
		});
		return json(res, 200, { ok: true, customer: row?.id ?? null });
	}

	if (parsed.kind === 'license-updated') {
		const row = await attachLicenseToAgreement({
			agreementId: parsed.agreementId,
			licenseArn: parsed.licenseArn,
			acceptorAccountId: parsed.acceptorAccountId,
			offerId: parsed.offerId,
			productCode,
		});
		return json(res, 200, { ok: true, customer: row?.id ?? null });
	}

	// agreement-ended | license-deprovisioned
	const targets = await resolveLifecycleTargets({
		licenseArn: parsed.licenseArn,
		agreementId: parsed.agreementId,
		acceptorAccountId: parsed.acceptorAccountId,
		productCode,
	});

	if (targets.length === 0) {
		// The buyer never completed registration, so there is nothing to revoke.
		// Not an error: AWS sends the end event regardless.
		return json(res, 200, { ok: true, matched: 0 });
	}

	// Under Concurrent Agreements one AWS account can hold several live
	// agreements for the same product. If the event only identified the account,
	// revoking would be a coin flip between them, and the wrong call cuts off a
	// paying buyer. Retrying cannot add information, so answer 200 and make the
	// ambiguity loud instead of silently guessing.
	if (targets.length > 1) {
		console.error('[aws-marketplace/subscription] ambiguous lifecycle target; refusing to revoke', {
			detailType: parsed.detailType,
			agreementId: parsed.agreementId,
			acceptorAccountId: parsed.acceptorAccountId,
			matched: targets.length,
		});
		return json(res, 200, { ok: true, unresolved: true, matched: targets.length });
	}

	try {
		await revokeCustomer(targets[0], 'cancelled');
	} catch (err) {
		console.error('[aws-marketplace/subscription] revoke failed', {
			customer: targets[0].id,
			error: err?.message,
		});
		return json(res, 500, { error: 'revoke_failed' });
	}
	return json(res, 200, { ok: true, revoked: targets[0].id });
}

// ── Amazon SNS (legacy transport) ────────────────────────────────────────────

async function handleSns(req, res, msg) {
	// The topic pin is what binds this webhook to OUR listing. A valid signature
	// alone only proves "some AWS account signed this": anyone can create their
	// own SNS topic and have AWS sign a Notification for it, so an unpinned
	// handler would accept a forged subscribe-success (minting a free x402 key
	// for an attacker-chosen customer) or unsubscribe-success (revoking a paying
	// customer's key). Refuse delivery entirely until the ARN is configured
	// instead of trusting whatever topic shows up. SNS retries with backoff, so
	// an operator who sets the var recovers the missed notifications.
	if (!env.AWS_MP_SNS_TOPIC_ARN) {
		console.error('[aws-marketplace/subscription] refusing SNS delivery: AWS_MP_SNS_TOPIC_ARN is not set');
		return json(res, 503, { error: 'not_configured' });
	}

	try {
		await verifySnsMessage(msg);
	} catch (err) {
		console.error('[aws-marketplace/subscription] SNS verification failed', err?.message);
		res.statusCode = 403;
		res.end();
		return;
	}

	if (msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation') {
		// The signature covers SubscribeURL, so by here it is AWS-authored. Check
		// the host anyway before following it: this is the one outbound request
		// this handler makes from payload-supplied data, and the check costs
		// nothing next to the blast radius if the signature step ever regresses.
		let subscribeUrl;
		try {
			subscribeUrl = assertAwsHttpsUrl(msg.SubscribeURL, 'SNS SubscribeURL');
		} catch (err) {
			console.error('[aws-marketplace/subscription] refusing SubscribeURL', err?.message);
			return json(res, 400, { error: 'invalid_subscribe_url' });
		}
		try {
			await fetch(subscribeUrl);
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

	const {
		action,
		'customer-identifier': customerId,
		'product-code': productCode,
		'offer-identifier': offerId,
		isFreeTrialTermPresent,
	} = payload;
	const isFreeTrial = isFreeTrialTermPresent === 'true' || isFreeTrialTermPresent === true;

	// SNS never carries a LicenseArn, so this transport can only ever address a
	// buyer by the legacy identifier. A notification without one is unusable.
	if (!customerId) {
		console.error('[aws-marketplace/subscription] missing customer-identifier', payload);
		return json(res, 400, { error: 'missing_customer_identifier' });
	}

	if (action === 'subscribe-success') {
		const row = await upsertResolvedCustomer({
			customerIdentifier: customerId,
			productCode: productCode ?? env.AWS_MP_PRODUCT_CODE,
			isFreeTrial,
		});
		if (offerId) {
			await sql`
				update aws_marketplace_customers
				set offer_id = ${offerId}, updated_at = now()
				where id = ${row.id}
			`;
		}
		return json(res, 200, { ok: true, customer: row.id });
	}

	const [row] = await sql`
		select id from aws_marketplace_customers
		where customer_identifier = ${customerId} limit 1
	`;
	if (!row) {
		return json(res, 200, { ok: true, matched: 0 });
	}

	if (action === 'unsubscribe-success' || action === 'subscribe-fail') {
		const status = action === 'unsubscribe-success' ? 'cancelled' : 'expired';
		try {
			await revokeCustomer(row, status);
		} catch (err) {
			console.error('[aws-marketplace/subscription] revoke failed', { customerId, error: err?.message });
			return json(res, 500, { error: 'revoke_failed' });
		}
	} else if (action === 'entitlement-updated') {
		// Contract products use entitlements; usage products ignore this beat.
		// For both, we touch updated_at so audit queries reflect the event. If a
		// tier change implies a different rate limit, the partner sees it on the
		// next /api/x402/* call: lookupSubscription reads the live
		// rate_limit_per_minute from the row, so a follow-up update takes effect
		// without a re-issue.
		await sql`
			update aws_marketplace_customers
			set offer_id   = coalesce(${offerId ?? null}, offer_id),
			    updated_at = now()
			where id = ${row.id}
		`;
	}

	return json(res, 200, { ok: true });
}

export default wrap(async (req, res) => {
	if (req.method !== 'POST') {
		res.statusCode = 405;
		res.setHeader('allow', 'POST');
		res.end();
		return;
	}

	let body;
	try {
		body = JSON.parse(await readRawBody(req));
	} catch {
		res.statusCode = 400;
		res.end();
		return;
	}

	if (isEventBridgeEnvelope(body)) {
		return handleEventBridge(req, res, body);
	}
	return handleSns(req, res, body);
});
