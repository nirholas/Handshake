// @ts-check
// POST /api/jobs/flush-usage-events: QStash webhook that drains the usage event
// buffer from Redis and batch-inserts into Neon Postgres.
//
// Triggered two ways:
//   1. QStash job published by recordEvent() when BUFFER_FLUSH_THRESHOLD is crossed.
//   2. api/cron/flush-usage-events.js (1-minute cron) as a safety net.
//
// This file handles the QStash path; the cron handler is separate so it can
// keep its import graph lean and skip the signature verification overhead.
//
// Security: every inbound POST must carry a valid Upstash-Signature header
// signed by QStash. Requests without it are rejected 401.

import { error, json, method, wrap, readBody } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { verifyQstashSignature } from '../_lib/qstash.js';
import { flushUsageBuffer } from '../_lib/usage.js';
import { flushAuditBuffer } from '../_lib/x402/audit-log.js';

const JOB_PATH = '/api/jobs/flush-usage-events';

/**
 * The absolute URLs this delivery is allowed to have been signed for.
 *
 * QStash signs the exact URL it was told to POST to (the JWT `sub` claim), so
 * verification only passes when we rebuild that same string. The publisher
 * (api/_lib/usage.js triggerFlushJob) builds it from `env.APP_ORIGIN`, so that
 * is the first and canonical candidate: reading `process.env.APP_ORIGIN`
 * instead (a var nothing in this codebase sets) made every genuinely signed
 * delivery compare against a bare path and 401, silently killing the
 * threshold-triggered flush lane and leaving only the 1-minute cron.
 *
 * The forwarded-host candidate covers a deployment served on a hostname other
 * than the configured origin (a preview revision, the raw Cloud Run URL). It
 * cannot be abused to bypass the check: the path stays fixed to this endpoint
 * and the HMAC still has to validate against our signing keys, so a spoofed
 * Host only ever admits a token QStash minted for this same job on one of our
 * own hostnames.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string[]}
 */
function verificationUrls(req) {
	const urls = [];
	const configured = String(env.APP_ORIGIN || '').replace(/\/+$/, '');
	if (configured) urls.push(`${configured}${JOB_PATH}`);

	const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
	if (host) {
		const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
		const derived = `${proto}://${host}${JOB_PATH}`;
		if (!urls.includes(derived)) urls.push(derived);
	}
	return urls;
}

export default wrap(async (req, res) => {
	if (!method(req, res, ['POST'])) return;

	// An unset signing key cannot be told apart from a forged request once we are
	// inside the catch below, and "invalid qstash signature" sends the operator
	// hunting an attacker instead of a missing secret. wrap() turns this exact
	// message shape into a 503 not_configured plus one deduped alert naming the var.
	if (!process.env.QSTASH_CURRENT_SIGNING_KEY) {
		throw new Error('Missing required env var: QSTASH_CURRENT_SIGNING_KEY');
	}

	// Collect the raw body for signature verification. readBody prefers
	// req.rawBody (captured pre-parse by the Cloud Run server's express.json()
	// `verify` hook) so the QStash HMAC check below sees the exact signed bytes:
	// re-reading the raw stream here hangs forever once Express has drained it.
	const raw = (await readBody(req, 1_000_000)).toString('utf8');

	const signature = req.headers['upstash-signature'];
	let verified = false;
	let reason = 'no candidate url';
	for (const url of verificationUrls(req)) {
		try {
			await verifyQstashSignature({ signature, body: raw, url });
			verified = true;
			break;
		} catch (err) {
			reason = err?.message || String(err);
		}
	}
	if (!verified) {
		// The reason separates a forged/absent signature from a URL the publisher
		// and this deployment disagree about, which are the same 401 to the caller
		// and completely different fixes for us.
		console.warn('[usage-flush-job] rejected delivery:', reason);
		return error(res, 401, 'unauthorized', 'invalid qstash signature');
	}

	const [result, audit] = await Promise.all([
		flushUsageBuffer({ limit: 500 }),
		flushAuditBuffer({ limit: 1000 }),
	]);

	if (result.errors > 0) {
		console.warn('[usage-flush-job] completed with errors', result);
	}
	if (audit.errors > 0) {
		console.warn('[x402-audit-flush-job] completed with errors', audit);
	}

	return json(res, 200, { usage: result, audit });
});
