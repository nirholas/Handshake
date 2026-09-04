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
import { validatePublicUrl, resolvePublicHost, pinnedAgent, SsrfError } from './ssrf.js';

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
	// Generation jobs. A forge job is asynchronous and can outlive the browser
	// that started it (see docs/forge-background-generation.md), so an
	// integrator who submits over the API has no way to learn the outcome
	// except by polling. These two events close that: they fire from the two
	// universal terminal writers in forge-store.js (materializeCreation and
	// markFailed), which every lane flows through, so a job that finishes on
	// the free browser lane, the x402 paid lane or the unattended finalizer
	// all deliver the same event exactly once.
	'forge.completed',
	'forge.failed',
];

export { EVENT_TYPES };

/**
 * Resolve a caller-supplied event subscription into the list to store.
 *
 * Two failure modes this closes, both of which produced a webhook that looked
 * healthy in the dashboard and never fired:
 *
 *   - An unknown name (a typo like "avatar.create") was silently filtered out.
 *     It is an error now, and the caller gets the offending names back plus the
 *     full menu of valid ones.
 *   - An omitted or empty list became `[]`, i.e. subscribed to nothing, even
 *     though docs/developer-platform.md has always documented it as "all
 *     events". The documented contract wins.
 *
 * @param {unknown} raw - the request's `events` value.
 * @returns {{ events: string[] } | { error: string }}
 */
export function selectEventTypes(raw) {
	if (raw === undefined || raw === null) return { events: [...EVENT_TYPES] };
	if (!Array.isArray(raw)) return { error: 'events must be an array of event types' };
	const unknown = raw.filter((e) => !EVENT_TYPES.includes(e));
	if (unknown.length) {
		return {
			error: `unknown event type(s): ${unknown.join(', ')}. Valid types: ${EVENT_TYPES.join(', ')}`,
		};
	}
	const events = [...new Set(raw)];
	return { events: events.length ? events : [...EVENT_TYPES] };
}

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
		const {
			statusCode,
			responseBody,
			error: deliveryError,
		} = await deliver(webhook.url, webhook.secret, eventId, timestamp, payload);

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

	// SSRF guard: the URL is developer-supplied, so resolve it and pin the
	// connection to the validated public address(es). Without this, a webhook
	// pointed at 169.254.169.254 / localhost / RFC-1918 (directly or via a public
	// host that 30x-redirects inward) would have the server POST to an internal
	// target and persist the status/error as a probing oracle. Redirects are NOT
	// followed (manual) so a public host can't bounce the request internally.
	let target;
	let agent;
	try {
		target = validatePublicUrl(url);
		const addrs = await resolvePublicHost(target.hostname);
		agent = pinnedAgent(target.hostname, addrs);
	} catch (err) {
		const reason = err instanceof SsrfError ? `blocked_url:${err.code}` : 'invalid_url';
		return { statusCode: null, responseBody: null, error: reason };
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

		let res;
		try {
			res = await fetch(target, {
				method: 'POST',
				redirect: 'manual',
				dispatcher: agent,
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
		} finally {
			clearTimeout(timeout);
			await agent.close().catch(() => {});
		}

		// A redirect is a misconfigured (or hostile) endpoint — record it as a
		// failure instead of following it to a potentially internal target.
		if (res.status >= 300 && res.status < 400) {
			return { statusCode: res.status, responseBody: null, error: 'redirect_not_followed' };
		}

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
