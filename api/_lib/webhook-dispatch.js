// Outgoing webhook dispatch — delivers events to developer-registered endpoints.
//
// Uses the Standard Webhooks signature format:
//   webhook-id:        unique event ID
//   webhook-timestamp: unix epoch seconds
//   webhook-signature: v1,{base64 HMAC-SHA256}
//
// Retry: 3 attempts with exponential backoff (1s, 4s, 16s).
// Fire-and-forget — callers don't await delivery results.

import { sql } from './db.js';
import { randomToken, hmacSha256 } from './crypto.js';

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const DELIVERY_TIMEOUT_MS = 10_000;

const EVENT_TYPES = [
	'avatar.created',
	'avatar.updated',
	'avatar.deleted',
	'avatar.appearance.changed',
	'agent.created',
	'agent.updated',
	'agent.deleted',
];

export { EVENT_TYPES };

export async function dispatchWebhooks({ userId, eventType, data }) {
	if (!EVENT_TYPES.includes(eventType)) return;

	let webhooks;
	try {
		webhooks = await sql`
			select id, url, secret, events
			from developer_webhooks
			where user_id = ${userId}
			  and active = true
			  and (events @> ARRAY[${eventType}]::text[] or cardinality(events) = 0)
		`;
	} catch {
		return;
	}

	if (!webhooks.length) return;

	const eventId = `evt_${randomToken(16)}`;
	const timestamp = Math.floor(Date.now() / 1000);
	const payload = JSON.stringify({
		id: eventId,
		type: eventType,
		created_at: new Date().toISOString(),
		data,
	});

	for (const wh of webhooks) {
		deliverWithRetry(wh, eventId, timestamp, payload, eventType).catch(() => {});
	}
}

async function deliverWithRetry(webhook, eventId, timestamp, payload, eventType) {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const { statusCode, responseBody, error: deliveryError } = await deliver(
			webhook.url, webhook.secret, eventId, timestamp, payload,
		);

		try {
			await sql`
				insert into webhook_deliveries (webhook_id, event_type, event_id, payload, status_code, response_body, error, attempt)
				values (${webhook.id}, ${eventType}, ${eventId}, ${payload}::jsonb, ${statusCode}, ${responseBody}, ${deliveryError}, ${attempt})
			`;
		} catch {
			// Best-effort logging
		}

		if (statusCode && statusCode >= 200 && statusCode < 300) return;

		if (attempt < MAX_ATTEMPTS) {
			const delay = BACKOFF_BASE_MS * Math.pow(4, attempt - 1);
			await sleep(delay);
		}
	}

	try {
		const [{ failure_count }] = await sql`
			select count(*)::int as failure_count
			from webhook_deliveries
			where webhook_id = ${webhook.id}
			  and (status_code is null or status_code >= 400)
			  and created_at > now() - interval '24 hours'
		`;
		if (failure_count >= 50) {
			await sql`
				update developer_webhooks set active = false, updated_at = now()
				where id = ${webhook.id}
			`;
		}
	} catch {
		// Best-effort deactivation
	}
}

async function deliver(url, secret, eventId, timestamp, payload) {
	const signature = await sign(secret, eventId, timestamp, payload);

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'webhook-id': eventId,
				'webhook-timestamp': String(timestamp),
				'webhook-signature': `v1,${signature}`,
				'user-agent': 'three.ws-webhooks/1.0',
			},
			body: payload,
			signal: controller.signal,
		});

		clearTimeout(timeout);

		let responseBody = null;
		try {
			responseBody = await res.text();
			if (responseBody.length > 1024) responseBody = responseBody.slice(0, 1024);
		} catch {
			// Body read failed
		}

		return { statusCode: res.status, responseBody, error: null };
	} catch (err) {
		return { statusCode: null, responseBody: null, error: err?.message || 'delivery_failed' };
	}
}

async function sign(secret, eventId, timestamp, payload) {
	const message = `${eventId}.${timestamp}.${payload}`;
	return hmacSha256(secret, message);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
