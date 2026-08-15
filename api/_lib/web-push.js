// Web Push (VAPID) delivery. Sends an OS-level notification to every device a
// user has subscribed. Dead endpoints (404/410) are pruned automatically, so
// the push_subscriptions table self-heals as browsers expire subscriptions.
//
// Required env:
//   VAPID_PUBLIC_KEY   — base64url public key (also exposed to the client)
//   VAPID_PRIVATE_KEY  — base64url private key (secret)
//   VAPID_SUBJECT      — mailto: or https: contact (default mailto:support@three.ws)
//
// Generate a keypair once with:  npx web-push generate-vapid-keys
//
// All sends are fire-and-forget — callers never await for correctness.

import { sql } from './db.js';
import { validatePublicUrl, resolvePublicHost, SsrfError } from './ssrf.js';

// Endpoints are re-validated at send time, not just at registration: rows stored
// before the registration guard landed are untrusted, and a public host can
// re-point at an internal address between subscribe and send. A row that can
// never be a legal target (bad scheme, private address) is pruned like a dead
// endpoint; a transient resolver failure only skips this send.
const RETRYABLE_SSRF_CODES = new Set(['dns_timeout', 'dns_failed']);

async function endpointDeliverable(endpoint) {
	try {
		const url = validatePublicUrl(endpoint);
		await resolvePublicHost(url.hostname);
		return 'ok';
	} catch (err) {
		const code = err instanceof SsrfError ? err.code : 'invalid_url';
		console.error('[web-push] endpoint rejected:', code);
		return RETRYABLE_SSRF_CODES.has(code) ? 'skip' : 'prune';
	}
}

let _configured = null; // null = not yet attempted, false = unavailable, true = ready
let _webpush = null;

export function vapidPublicKey() {
	return (process.env.VAPID_PUBLIC_KEY || '').trim();
}

export function pushConfigured() {
	return Boolean(vapidPublicKey() && (process.env.VAPID_PRIVATE_KEY || '').trim());
}

// Lazy-load the web-push module + configure VAPID exactly once. Returns the
// configured module, or null when keys are absent (dev / preview deploys) so
// callers degrade to in-app-only without throwing.
async function webpush() {
	if (_configured === false) return null;
	if (_configured === true) return _webpush;
	if (!pushConfigured()) {
		_configured = false;
		return null;
	}
	const mod = await import('web-push');
	_webpush = mod.default || mod;
	_webpush.setVapidDetails(
		(process.env.VAPID_SUBJECT || 'mailto:support@three.ws').trim(),
		vapidPublicKey(),
		(process.env.VAPID_PRIVATE_KEY || '').trim(),
	);
	_configured = true;
	return _webpush;
}

/**
 * Send a push payload to every subscription a user has. Returns the number of
 * subscriptions that accepted it. Prunes endpoints the push service reports as
 * gone (404/410). Safe to call when push is unconfigured (returns 0).
 *
 * @param {string} userId
 * @param {{ title: string, body: string, url?: string, tag?: string, notificationId?: string|null, category?: string }} payload
 */
export async function sendPushToUser(userId, payload) {
	const wp = await webpush();
	if (!wp) return 0;

	let subs;
	try {
		subs = await sql`
			select id, endpoint, p256dh, auth
			from push_subscriptions
			where user_id = ${userId}
		`;
	} catch (err) {
		console.error('[web-push] load subscriptions failed:', err.message);
		return 0;
	}
	if (!subs.length) return 0;

	const body = JSON.stringify(payload);
	const dead = [];
	let delivered = 0;

	await Promise.all(
		subs.map(async (s) => {
			const verdict = await endpointDeliverable(s.endpoint);
			if (verdict === 'prune') {
				dead.push(s.id);
				return;
			}
			if (verdict === 'skip') return;

			const subscription = {
				endpoint: s.endpoint,
				keys: { p256dh: s.p256dh, auth: s.auth },
			};
			try {
				await wp.sendNotification(subscription, body, { TTL: 60 * 60 * 24 });
				delivered++;
			} catch (err) {
				const code = err?.statusCode;
				if (code === 404 || code === 410) {
					dead.push(s.id); // gone — prune
				} else {
					console.error('[web-push] send failed', code || err.message);
				}
			}
		}),
	);

	if (dead.length) {
		sql`delete from push_subscriptions where id = any(${dead})`.catch((e) =>
			console.error('[web-push] prune failed:', e.message),
		);
	}
	return delivered;
}
