// QStash worker endpoint for async knowledge embedding.
//
// Called by QStash after _knowledge.ingestKnowledge() queues large docs.
// Verifies the inbound signature so only QStash (or replays of valid messages)
// can trigger processing. Reads the queued doc by ID, embeds its chunks,
// marks ready. Idempotent — safe to retry on transient failures.

import { wrap, json, error, method } from '../../_lib/http.js';
import { verifyQstashSignature, qstashEnabled } from '../../_lib/qstash.js';
import { processQueuedDoc } from './_knowledge.js';
import { env } from '../../_lib/env.js';

function readRawBody(req, limit = 1_000_000) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on('data', (c) => {
			total += c.length;
			if (total > limit) {
				reject(Object.assign(new Error('payload too large'), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

export default wrap(async (req, res) => {
	if (!method(req, res, ['POST'])) return;

	if (!qstashEnabled()) {
		return error(res, 503, 'qstash_disabled', 'QStash not configured on this deployment');
	}

	const signature = req.headers['upstash-signature'];
	const rawBody = await readRawBody(req).catch((err) => {
		throw Object.assign(new Error(err?.message || 'body read failed'), {
			status: err?.status || 400,
		});
	});

	const widgetIdFromQuery = req.query?.id || '';
	const verifyUrl = `${env.APP_ORIGIN}/api/widgets/${widgetIdFromQuery}/knowledge-process`;

	try {
		await verifyQstashSignature({ signature, body: rawBody, url: verifyUrl });
	} catch (err) {
		console.warn('[knowledge-process] signature verify failed:', err?.message);
		return error(res, 401, 'invalid_signature', 'QStash signature verification failed');
	}

	let payload;
	try {
		payload = JSON.parse(rawBody || '{}');
	} catch {
		return error(res, 400, 'invalid_json', 'body must be JSON');
	}

	const docId = String(payload?.doc_id || '').trim();
	const widgetId = String(payload?.widget_id || widgetIdFromQuery || '').trim();
	if (!docId || !widgetId) {
		return error(res, 400, 'invalid_request', 'doc_id and widget_id required');
	}

	try {
		const result = await processQueuedDoc({ docId, widgetId });
		return json(res, 200, { ok: true, ...result });
	} catch (err) {
		const status = err?.status || 500;
		// Return 5xx so QStash retries with backoff. 4xx terminates retries.
		const code = err?.code || 'process_failed';
		console.error('[knowledge-process] failed', { docId, widgetId, err: err?.message });
		return error(res, status, code, err?.message || 'processing failed');
	}
});
