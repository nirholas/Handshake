/**
 * POST /api/tts/eleven
 *
 * Server proxy for ElevenLabs TTS. Keeps the API key server-side. The clip is
 * streamed straight to the client (low TTFB) and, on a clean finish, cached in
 * R2 for 30 days keyed by sha256(voiceId + text + modelId + voice_settings).
 *
 * Billing (header `x-tts-billing` reports which rung served the call). There
 * is no free platform lane: every clip the platform pays ElevenLabs for is
 * paid for by the caller (owner policy 2026-08-06).
 *   byok    - request carried an `x-eleven-key` header: the user's own
 *             ElevenLabs account pays, so credits never apply.
 *   credits - platform key: the request is metered against the user's prepaid
 *             credit wallet (top up with $THREE or SOL at /credits) at
 *             TTS_ELEVEN_USD_PER_1K, with a 402 + top_up_url when short.
 *   cached  - R2 cache hit: no upstream call, nothing charged.
 *
 * Body: {
 *   voiceId: string,
 *   text: string,
 *   modelId?: string,                        // default eleven_flash_v2_5
 *   voice_settings?: {                        // canonical ElevenLabs shape, honored verbatim
 *     stability?, similarity_boost?, style?,  // clamped to 0..1
 *     use_speaker_boost?                       // boolean
 *   }
 * }
 * Response: audio/mpeg (chunked)
 */

import { randomUUID } from 'node:crypto';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, method, wrap, error, json, readJson, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { sha256 } from '../_lib/crypto.js';
import { headObject, getObjectBuffer, putObject } from '../_lib/r2.js';
import { chargeCreditsForAction, refundCredits } from '../_lib/credits.js';
import { TTS_ELEVEN_USD_PER_1K } from '../_lib/pricing/catalog.js';
import {
	ELEVEN_BASE,
	DEFAULT_TTS_MODEL,
	resolveElevenKey,
	normalizeVoiceSettings,
} from '../_lib/elevenlabs.js';

// Fire-and-forget R2 cache write — a miss on failure is acceptable.
function cacheAudio(key, buffer) {
	if (!buffer.length) return;
	putObject({
		key,
		body: buffer,
		contentType: 'audio/mpeg',
		metadata: { 'created-at': new Date().toISOString() },
	}).catch((e) => console.warn('[tts/eleven] R2 cache write failed:', e.message));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const { apiKey, byok } = resolveElevenKey(req);
	if (!apiKey)
		return error(
			res,
			503,
			'not_configured',
			'ElevenLabs is not configured on this server. Send your own key in the x-eleven-key header to use your account.',
		);

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;

	const rl = await limits.ttsSpeakUser(userId);
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req);
	const voiceId = String(body.voiceId || '').trim();
	const text = String(body.text || '').trim();
	const modelId = String(body.modelId || DEFAULT_TTS_MODEL).trim();

	if (!voiceId) return error(res, 400, 'validation_error', 'voiceId is required');
	if (!text) return error(res, 400, 'validation_error', 'text is required');
	if (text.length > 500)
		return error(res, 400, 'validation_error', 'text exceeds 500 chars per request');

	// Honor the canonical ElevenLabs `voice_settings` object the client sends
	// (the ElevenLabsTTS client maps `rate` → `style` and forwards it here);
	// fall back to ElevenLabs' recommended defaults. Folded into the cache key so
	// distinct settings never collide on a shared clip.
	const settings = normalizeVoiceSettings(
		body.voice_settings && typeof body.voice_settings === 'object' ? body.voice_settings : {},
	);

	// ── R2 cache lookup ───────────────────────────────────────────────────────
	// Checked BEFORE any metering: a cached clip costs nothing upstream, so it
	// never consumes the free budget and never charges credits.
	const cacheHash = await sha256(
		`${voiceId}\x00${text}\x00${modelId}\x00${settings.stability}\x00${settings.similarity_boost}\x00${settings.style}\x00${settings.use_speaker_boost}`,
	);
	const cacheKey = `tts/cache/${cacheHash}.mp3`;

	const cached = await headObject(cacheKey).catch(() => null);
	if (cached) {
		try {
			const buf = await getObjectBuffer(cacheKey);
			res.setHeader('content-type', 'audio/mpeg');
			res.setHeader('content-length', String(buf.length));
			res.setHeader('x-tts-cache', 'hit');
			res.setHeader('x-tts-billing', 'cached');
			res.setHeader('cache-control', 'private, max-age=86400');
			return res.end(buf);
		} catch {
			// Cache read failed: fall through to synthesize fresh.
		}
	}

	// ── Metering: no free platform lane ───────────────────────────────────────
	// BYOK requests run on the user's own ElevenLabs account, so credits never
	// apply. Every platform-key synthesis is charged to the user's credit wallet
	// (topped up with $THREE or SOL) BEFORE the upstream call, and refunded if
	// the clip is never delivered.
	const billing = byok ? 'byok' : 'credits';
	let creditCharge = null;

	if (!byok) {
		const idempotencyKey = `tts:eleven:${randomUUID()}`;
		const usd = Math.max(0.0001, (text.length / 1000) * TTS_ELEVEN_USD_PER_1K);
		try {
			const charged = await chargeCreditsForAction({
				user: session || { id: userId },
				action: 'tts.eleven',
				usd,
				refType: 'tts',
				refId: cacheHash,
				idempotencyKey,
				meta: { chars: text.length, voiceId, modelId },
			});
			creditCharge = { idempotencyKey, chargedUsd: charged.chargedUsd };
		} catch (err) {
			if (err?.code === 'insufficient_credits') {
				return json(res, 402, {
					error: 'insufficient_credits',
					feature: 'tts.eleven',
					available_usd: err.available_usd,
					required_usd: err.required_usd,
					top_up_url: '/credits',
					message:
						'Speech synthesis is metered to your credit balance. ' +
						'Top up with $THREE at /credits, or bring your own ElevenLabs key.',
				});
			}
			throw err;
		}
	}

	// Refund the charge when synthesis ultimately fails, so a user is never
	// billed for a clip they never received.
	const refundMetering = async () => {
		if (creditCharge?.chargedUsd > 0) {
			await refundCredits({
				userId,
				amountUsd: creditCharge.chargedUsd,
				action: 'tts.eleven',
				refType: 'tts',
				refId: cacheHash,
				idempotencyKey: `${creditCharge.idempotencyKey}:refund`,
				meta: { reason: 'synthesis_failed' },
			}).catch((e) => console.warn('[tts/eleven] credit refund failed:', e?.message || e));
		}
	};

	// ── Synthesize via ElevenLabs ─────────────────────────────────────────────
	let elResp;
	try {
		elResp = await fetch(
			`${ELEVEN_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'audio/mpeg',
					'xi-api-key': apiKey,
				},
				body: JSON.stringify({
					text,
					model_id: modelId,
					voice_settings: settings,
				}),
				// Bound a hung connection (ElevenLabs accepting but never responding)
				// under Vercel's 30s kill, so a stall returns a clean 502 + char refund
				// instead of a 504 with characters charged but no audio delivered. Set
				// well above a real clip's synth+stream time so it never cuts valid audio.
				signal: AbortSignal.timeout(28000),
			},
		);
	} catch (fetchErr) {
		console.error('[tts/eleven] ElevenLabs fetch failed', fetchErr);
		await refundMetering();
		return error(res, 502, 'upstream_error', 'Could not reach ElevenLabs');
	}

	if (!elResp.ok) {
		const msg = await elResp.text().catch(() => '');
		console.error('[tts/eleven] ElevenLabs error', elResp.status, msg);
		await refundMetering();
		return error(res, 502, 'upstream_error', `ElevenLabs returned ${elResp.status}`);
	}

	// Stream the clip to the client for low TTFB while teeing the chunks into a
	// buffer, so the complete audio can be cached once it has fully arrived.
	res.setHeader('content-type', 'audio/mpeg');
	res.setHeader('x-tts-cache', 'miss');
	res.setHeader('x-tts-billing', billing);
	if (creditCharge?.chargedUsd > 0)
		res.setHeader('x-tts-charged-usd', creditCharge.chargedUsd.toFixed(6));
	res.setHeader('cache-control', 'private, max-age=86400');

	if (!elResp.body) {
		// No readable stream (unexpected) — fall back to a single buffered write.
		const audioBuffer = Buffer.from(await elResp.arrayBuffer());
		res.setHeader('content-length', String(audioBuffer.length));
		res.end(audioBuffer);
		cacheAudio(cacheKey, audioBuffer);
		return;
	}

	const chunks = [];
	let completed = false;
	try {
		for await (const chunk of elResp.body) {
			if (res.destroyed) break; // client hung up — stop pulling from upstream
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			chunks.push(buf);
			// Respect write backpressure so a slow client can't pile unbounded data
			// into the socket buffer. Resolve on 'close' too, so a mid-clip
			// disconnect can't hang this await forever.
			if (!res.write(buf)) {
				await new Promise((resolve) => {
					const done = () => {
						res.off('drain', done);
						res.off('close', done);
						resolve();
					};
					res.once('drain', done);
					res.once('close', done);
				});
			}
		}
		// Only a naturally-exhausted iterator (no break/destroy) means every
		// upstream byte arrived — required before we may cache the clip.
		completed = !res.destroyed;
	} catch (streamErr) {
		// Upstream aborted or the client disconnected mid-clip. Don't cache a
		// partial, possibly-corrupt file — just close the response.
		console.error('[tts/eleven] stream interrupted', streamErr);
		if (!res.writableEnded && !res.destroyed) res.end();
		return;
	}

	if (!res.writableEnded && !res.destroyed) res.end();
	// Cache only a complete clip — a truncated one would poison the deterministic
	// cache key and be served as a permanent "hit" for this utterance.
	if (completed) cacheAudio(cacheKey, Buffer.concat(chunks));
});
