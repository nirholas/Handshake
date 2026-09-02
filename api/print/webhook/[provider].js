// @ts-check
// POST /api/print/webhook/:provider — a fulfillment provider reporting in.
//
// Three properties, in the order they are enforced:
//
//   1. AUTHENTICITY. The adapter verifies the delivery against the exact bytes
//      received (HMAC over the raw body, constant-time compared). An
//      unverified delivery is refused before the payload is parsed, so a
//      forged body never reaches a JSON.parse, let alone the state machine.
//      An adapter with no webhook (the manual lane) refuses everything, which
//      is why that lane has no unauthenticated door.
//   2. IDEMPOTENCY. Every serious provider retries deliveries. The claim on
//      print_webhook_deliveries is a unique-key insert, so a replay of the same
//      delivery is a no-op that returns 200 (a 4xx would make the provider
//      retry forever) and appends nothing to the timeline.
//   3. ORDERING. The state machine, not the provider, decides what may follow
//      what. A report that arrives out of order is recorded on the timeline as
//      a refused provider event and answered 200 with applied: false.
//
// The response never echoes the payload and never leaks whether an order id
// exists to an unverified caller: verification comes first.

import { error, json, method, readBody, wrap } from '../../_lib/http.js';
import {
	claimWebhookDelivery,
	getOrderByProviderId,
	markWebhookApplied,
	printStoreEnabled,
} from '../../_lib/print-store.js';
import { getAdapter } from '../../_lib/print/adapters/index.js';
import { normalizeWebhookEvent } from '../../_lib/print/adapters/contract.js';
import { applyProviderEvent } from '../../_lib/print/fulfillment.js';

const MAX_BODY_BYTES = 256 * 1024;

export default wrap(async (req, res) => {
	if (!method(req, res, ['POST'])) return;

	const provider = String(
		req.query?.provider ?? new URL(req.url, 'http://x').pathname.split('/').pop() ?? '',
	).trim();

	const adapter = getAdapter(provider);
	if (!adapter) {
		// Unknown or unconfigured lane. 404 rather than 403: there is no endpoint
		// here to authenticate against.
		return error(res, 404, 'not_found', `no configured fulfillment provider '${provider}'`);
	}

	const raw = (await readBody(req, MAX_BODY_BYTES)).toString('utf8');
	const verdict = adapter.verifyWebhook(raw, req.headers || {});
	if (!verdict?.ok) {
		return error(res, 401, 'unauthorized', verdict?.reason || 'delivery could not be verified');
	}

	if (!printStoreEnabled()) {
		// 503 makes a provider retry, which is right: the delivery is genuine and
		// we simply cannot record it yet.
		return error(res, 503, 'not_configured', 'fulfillment webhooks need a configured database');
	}

	// Claim before parsing the body's meaning: the claim is what makes a retry
	// harmless, and it must happen even for a payload we end up not applying.
	const { fresh } = await claimWebhookDelivery({ provider, deliveryId: verdict.deliveryId });
	if (!fresh) {
		return json(res, 200, { ok: true, duplicate: true, applied: false });
	}

	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		return error(res, 400, 'validation_error', 'body must be JSON');
	}

	const event = normalizeWebhookEvent(adapter.key, adapter.parseWebhook(payload));
	const order = await getOrderByProviderId(provider, event.providerOrderId);
	if (!order) {
		// Verified sender, unknown job. Answer 200 so they stop retrying, and say
		// so plainly: this is a real condition when a provider replays history
		// after we have deleted an order.
		return json(res, 200, { ok: true, applied: false, reason: 'no matching order' });
	}

	const result = await applyProviderEvent({ order, event, actor: 'provider' });
	await markWebhookApplied({ provider, deliveryId: verdict.deliveryId, orderId: order.id });

	return json(res, 200, {
		ok: true,
		applied: result.applied,
		status: result.order.status,
		reason: result.reason || undefined,
	});
});
