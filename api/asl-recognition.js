/**
 * /api/asl-recognition — webcam ASL fingerspelling → text.
 *
 *   GET  /api/asl-recognition
 *     → { columns: [390 landmark column names], max_frames, min_frames }
 *       The feature schema the browser must assemble per video frame
 *       (MediaPipe Holistic landmark selection, served by the worker).
 *
 *   POST /api/asl-recognition  { frames: [[390 numbers|null]…], clean?: boolean }
 *     → { text, raw, cleaned, confidence, frames, ms }
 *       `text` is the LLM-cleaned decode (send clean:false to skip that pass
 *       and get the worker's raw output); `confidence` is the recognizer's
 *       mean per-character softmax, which the UI uses to warn on a bad read.
 *
 * Thin authenticated proxy to workers/model-asl-recognition (Kaggle-2023
 * ASLFR 1st-place model, Apache-2.0 weights, FSboard CC BY 4.0 corpus).
 * Landmarks are extracted client-side (src/sign-input.js), so raw video
 * never reaches the platform — only pose coordinates.
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';

// 1500 frames × 390 floats serializes to ~10–20 MB; cap the body above that.
const MAX_BODY_BYTES = 24_000_000;

function config() {
	const base = (process.env.GCP_ASL_RECOGNITION_URL || '').replace(/\/$/, '');
	const key = process.env.GCP_RECONSTRUCTION_KEY || '';
	return base && key ? { base, key } : null;
}

function unconfigured(res) {
	return json(res, 503, {
		error: 'unconfigured',
		message:
			'Sign recognition is not configured. Set GCP_ASL_RECOGNITION_URL and ' +
			'GCP_RECONSTRUCTION_KEY on the API service.',
	});
}

let _schemaCache = null;
let _schemaAt = 0;
const SCHEMA_TTL_MS = 10 * 60 * 1000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const cfg = config();
	if (!cfg) return unconfigured(res);

	if (req.method === 'GET') {
		if (_schemaCache && Date.now() - _schemaAt < SCHEMA_TTL_MS) {
			return json(res, 200, _schemaCache);
		}
		const r = await fetch(`${cfg.base}/schema`, {
			headers: { authorization: `Bearer ${cfg.key}` },
		});
		if (!r.ok) return json(res, 502, { error: 'worker_error', status: r.status });
		_schemaCache = await r.json();
		_schemaAt = Date.now();
		return json(res, 200, _schemaCache);
	}

	const rl = await limits.aslTranscribeIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'Sign recognition limit reached. Try again shortly.');
	const body = await readJson(req, MAX_BODY_BYTES).catch(() => null);
	if (!body || !Array.isArray(body.frames)) {
		return json(res, 400, { error: 'bad_request', message: 'Body must be { frames: [[…]] }.' });
	}
	const r = await fetch(`${cfg.base}/transcribe`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${cfg.key}`,
		},
		body: JSON.stringify({ frames: body.frames }),
	});
	const out = await r.json().catch(() => ({}));
	if (!r.ok) {
		return json(res, r.status === 400 ? 400 : 502, {
			error: r.status === 400 ? 'bad_frames' : 'worker_error',
			message: out.detail || out.message || `worker returned ${r.status}`,
		});
	}
	out.raw = out.text ?? '';
	if (out.raw && body.clean !== false) {
		out.text = await cleanTranscription(out.raw);
		out.cleaned = out.text !== out.raw;
	}
	return json(res, 200, out);
});

/**
 * Webcam fingerspelling decodes at a 10–20% character error rate; a
 * constrained LLM pass recovers most of it ("esteredouble" → intended word).
 * Fail-open: any LLM problem returns the raw decode untouched.
 */
async function cleanTranscription(raw) {
	try {
		const { llmComplete, llmConfigured } = await import('./_lib/llm.js');
		if (!llmConfigured()) return raw;
		const cleaned = await llmComplete({
			system:
				'You correct noisy ASL fingerspelling transcriptions. The input is a ' +
				'machine decode of someone spelling letter by letter into a webcam; ' +
				'roughly 1 in 6 characters may be wrong, split, or merged. Return ONLY ' +
				'the most likely intended text, preserving meaning and proper nouns. ' +
				'No explanations, no quotes. If the input already looks right, return it unchanged.',
			user: raw,
			maxTokens: 120,
			timeoutMs: 8_000,
		});
		const text = (cleaned || '').trim();
		// Guard against LLM refusals/essays: a cleanup should stay in the same
		// size class as the input.
		if (!text || text.length > raw.length * 2 + 20) return raw;
		return text;
	} catch {
		return raw;
	}
}
