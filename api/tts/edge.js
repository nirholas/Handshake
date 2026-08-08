/**
 * POST /api/tts/edge
 *
 * Microsoft Edge TTS proxy. No API key required — the protocol and the voice
 * catalog live in api/_lib/tts-edge.js, shared with the unified router
 * (/api/tts/synthesize) so the handshake quirks are implemented once.
 * Caches synthesized clips in R2 by sha256(voice + text + rate + pitch) for 30 days.
 *
 * Body: { voice: string, text: string, rate?: string, pitch?: string }
 *   voice — e.g. "en-US-AriaNeural". Defaults to "en-US-AriaNeural".
 *   rate  — prosody rate, e.g. "+0%", "-10%", "+20%". Defaults to "+0%".
 *   pitch — prosody pitch, e.g. "+0Hz", "-5Hz". Defaults to "+0Hz".
 * Response: audio/mpeg
 */

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { sha256 } from '../_lib/crypto.js';
import { headObject, getObjectBuffer, putObject } from '../_lib/r2.js';
import {
	synthesizeEdge,
	EDGE_VOICE_RE,
	EDGE_RATE_RE,
	EDGE_PITCH_RE,
	EDGE_DEFAULT_VOICE,
} from '../_lib/tts-edge.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');

	const userId = session?.id ?? bearer?.userId;
	const rl = await limits.ttsEdge(String(userId));
	if (!rl.success) {
		const retryAfter = Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000));
		res.setHeader('retry-after', String(retryAfter));
		return rateLimited(res, rl, 'Too many TTS requests', { retry_after: retryAfter });
	}

	const body = await readJson(req);
	const voice = String(body.voice || EDGE_DEFAULT_VOICE).trim();
	const text = String(body.text || '').trim();
	const rate = String(body.rate || '+0%').trim();
	const pitch = String(body.pitch || '+0Hz').trim();

	if (!EDGE_VOICE_RE.test(voice))
		return error(res, 400, 'validation_error', 'invalid voice name');
	if (!text) return error(res, 400, 'validation_error', 'text is required');
	if (text.length > 500)
		return error(res, 400, 'validation_error', 'text exceeds 500 chars per request');
	if (!EDGE_RATE_RE.test(rate))
		return error(res, 400, 'validation_error', 'rate must be like +0% or -10%');
	if (!EDGE_PITCH_RE.test(pitch))
		return error(res, 400, 'validation_error', 'pitch must be like +0Hz or -5Hz');

	// ── R2 cache lookup ───────────────────────────────────────────────────────
	const cacheHash = await sha256(`${voice}\x00${text}\x00${rate}\x00${pitch}`);
	const cacheKey = `tts/edge/${cacheHash}.mp3`;

	const cached = await headObject(cacheKey).catch(() => null);
	if (cached) {
		try {
			const buf = await getObjectBuffer(cacheKey);
			res.setHeader('content-type', 'audio/mpeg');
			res.setHeader('content-length', String(buf.length));
			res.setHeader('x-tts-cache', 'hit');
			res.setHeader('cache-control', 'private, max-age=86400');
			return res.end(buf);
		} catch {
			// Fall through to synthesize fresh on cache read failure.
		}
	}

	// ── Synthesize via Microsoft Edge TTS ────────────────────────────────────
	let audioBuffer;
	try {
		audioBuffer = await synthesizeEdge(voice, text, rate, pitch);
	} catch (err) {
		console.error('[tts/edge] synthesis failed after retry', err);
		return error(res, 502, 'upstream_error', 'Edge TTS synthesis failed');
	}

	if (!audioBuffer.length) return error(res, 502, 'upstream_error', 'Edge TTS returned empty audio');

	putObject({
		key: cacheKey,
		body: audioBuffer,
		contentType: 'audio/mpeg',
		metadata: { 'created-at': new Date().toISOString() },
	}).catch((e) => console.warn('[tts/edge] R2 cache write failed:', e.message));

	res.setHeader('content-type', 'audio/mpeg');
	res.setHeader('content-length', String(audioBuffer.length));
	res.setHeader('x-tts-cache', 'miss');
	res.setHeader('cache-control', 'private, max-age=86400');
	return res.end(audioBuffer);
});
