// Upstash QStash adapter — publish background jobs + verify inbound webhook
// signatures. Used for any work that may exceed Vercel's per-request execution
// cap (currently 60s on Hobby, 300s on Pro): knowledge embedding for large
// PDFs, scheduled refreshes, batch mint metadata pre-warming, etc.
//
// Env:
//   QSTASH_TOKEN           — REST API token for publishing
//   QSTASH_CURRENT_SIGNING_KEY  — current verification key (always required)
//   QSTASH_NEXT_SIGNING_KEY     — rotation key (verified as a fallback)
//
// If QSTASH_TOKEN is unset, qstashEnabled() returns false and callers should
// fall back to synchronous execution.

import { Client } from '@upstash/qstash';
import { Receiver } from '@upstash/qstash';

let _client = null;
let _receiver = null;

export function qstashEnabled() {
	return Boolean(process.env.QSTASH_TOKEN);
}

function client() {
	if (!process.env.QSTASH_TOKEN) {
		throw new Error('qstash: QSTASH_TOKEN not set');
	}
	if (!_client) {
		_client = new Client({ token: process.env.QSTASH_TOKEN });
	}
	return _client;
}

function receiver() {
	if (!process.env.QSTASH_CURRENT_SIGNING_KEY) {
		throw new Error('qstash: QSTASH_CURRENT_SIGNING_KEY not set');
	}
	if (!_receiver) {
		_receiver = new Receiver({
			currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
			nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || process.env.QSTASH_CURRENT_SIGNING_KEY,
		});
	}
	return _receiver;
}

/**
 * Publish a JSON job to QStash. Returns the message ID.
 * @param {{
 *   url: string,            // public HTTPS endpoint QStash will POST to
 *   body: any,              // JSON-serializable payload
 *   delaySeconds?: number,  // optional delay before delivery
 *   retries?: number,       // default 3
 *   deduplicationId?: string,
 * }} opts
 */
export async function publishJob({ url, body, delaySeconds, retries = 3, deduplicationId } = {}) {
	if (!url) throw new Error('qstash.publishJob: url required');
	const c = client();
	const opts = {
		url,
		body: JSON.stringify(body || {}),
		headers: { 'content-type': 'application/json' },
		retries,
	};
	if (delaySeconds && delaySeconds > 0) opts.delay = delaySeconds;
	if (deduplicationId) opts.deduplicationId = deduplicationId;
	const r = await c.publishJSON(opts);
	return r?.messageId || r?.id || null;
}

/**
 * Verify that an inbound request was signed by QStash. Pass the raw body string
 * (NOT a parsed object) and the value of the 'upstash-signature' header.
 * Throws on failure so handlers can surface 401 immediately.
 */
export async function verifyQstashSignature({ signature, body, url }) {
	if (!signature) throw new Error('qstash: missing signature header');
	const r = receiver();
	const ok = await r.verify({ signature, body, url });
	if (!ok) throw new Error('qstash: signature verification failed');
	return true;
}
