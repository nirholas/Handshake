/**
 * POST /api/tts/synthesize
 *
 * One endpoint that renders text on any voice lane the platform exposes:
 * Microsoft Edge, Gemini, NVIDIA Magpie, OpenAI and ElevenLabs. Callers pass
 * the `provider` + `voiceId` pair they got from /api/tts/catalog; everything
 * else (protocol, container, billing) is handled here.
 *
 * Body: {
 *   provider: 'edge'|'gemini'|'nvidia'|'openai'|'elevenlabs',
 *   voiceId: string,
 *   text: string,                 // <= 1000 chars
 *   model?: string,               // lane-specific; validated per lane
 *   direction?: string,           // style instruction (gemini, gpt-4o-mini-tts)
 *   speed?: number,               // 0.5 .. 2.0
 *   format?: string,              // openai/nvidia only; other lanes fix theirs
 *   language?: string,            // nvidia
 *   voice_settings?: object,      // elevenlabs
 * }
 *
 * Billing (`x-tts-billing` reports which rung served):
 *   free    : Edge / NVIDIA: no vendor invoice, nothing charged.
 *   gcp     : Gemini on Vertex: platform Google credits, nothing charged.
 *   byok    : the request carried `x-eleven-key`: the user's ElevenLabs account pays.
 *   credits : a vendor-billed lane on the platform key: metered to the caller's
 *             prepaid credit wallet before the upstream call, refunded if the
 *             clip never renders. 402 + top_up_url when short.
 *   cached  : R2 cache hit: no upstream call, nothing charged.
 *
 * Response: audio in the lane's container (content-type is always truthful).
 */

import { randomUUID } from 'node:crypto';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, method, wrap, error, json, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sha256 } from '../_lib/crypto.js';
import { headObject, getObjectBuffer, putObject } from '../_lib/r2.js';
import { chargeCreditsForAction, refundCredits } from '../_lib/credits.js';
import { resolveElevenKey } from '../_lib/elevenlabs.js';
import {
	getProvider,
	providerAvailability,
	isKnownVoice,
	synthesizeVoice,
	usdForSynthesis,
	creditActionFor,
} from '../_lib/voice-providers.js';

export const maxDuration = 60;

const MAX_TEXT = 1000;
const MAX_DIRECTION = 500;

// Upstream error code → HTTP status, so a client can tell "your fault" from
// "our fault" without parsing prose.
const STATUS_BY_CODE = {
	invalid_argument: 400,
	content_blocked: 422,
	not_configured: 503,
	invalid_key: 502,
	rate_limited: 429,
	provider_unreachable: 502,
	provider_error: 502,
	// Gemini answered the prompt instead of speaking it, and there was no style
	// direction left to drop on the retry. That is an upstream misread, not a
	// caller error.
	answered_instead_of_spoke: 502,
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	let body;
	try {
		body = await readJson(req, 50_000);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const providerId = String(body.provider || 'edge').trim();
	const provider = getProvider(providerId);
	if (!provider) return error(res, 400, 'validation_error', `unknown provider "${providerId}"`);

	const text = String(body.text || '').trim();
	if (!text) return error(res, 400, 'validation_error', 'text is required');
	if (text.length > MAX_TEXT)
		return error(res, 400, 'validation_error', `text exceeds ${MAX_TEXT} characters`);

	const direction = String(body.direction || '').trim().slice(0, MAX_DIRECTION);

	// ── Auth + rate limit ─────────────────────────────────────────────────────
	// The keyless lanes serve anonymous visitors (that is the point of a free
	// lane); the vendor-billed ones need an identity to meter against.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId ?? null;

	if (!provider.anonymous && !userId)
		return error(res, 401, 'unauthorized', `sign in to use the ${provider.label} voices`);

	if (userId) {
		const rl = await limits.ttsSpeakUser(String(userId));
		if (!rl.success) return rateLimited(res, rl, 'TTS rate limit exceeded, try again later');
	} else {
		const rl = await limits.ttsSpeakIp(clientIp(req));
		if (!rl.success)
			return rateLimited(res, rl, 'TTS rate limit exceeded, sign in for a higher limit');
	}

	const { apiKey: elevenKey, byok } = resolveElevenKey(req);
	const availability = providerAvailability({ elevenUserKey: byok });
	if (!availability[providerId]) {
		return error(
			res,
			503,
			'not_configured',
			providerId === 'elevenlabs'
				? 'ElevenLabs is not configured on this server. Send your own key in the x-eleven-key header.'
				: `${provider.label} is not configured on this server`,
		);
	}

	const voiceId = String(body.voiceId || '').trim();
	const model = String(body.model || '').trim();
	const speed = Number(body.speed);
	const format = typeof body.format === 'string' ? body.format : undefined;
	const language = typeof body.language === 'string' ? body.language : undefined;
	const voiceSettings =
		body.voice_settings && typeof body.voice_settings === 'object' ? body.voice_settings : null;

	// A voiceId the lane does not have is a caller error, and it has to be caught
	// here: the router would otherwise swap in the lane default and return 200,
	// so a typo came back as a different voice, charged, with nothing in the
	// response saying so. Checked before the cache key is minted and before any
	// metering, so a bad id costs nothing. An omitted voiceId still means "lane
	// default" and passes.
	if (!(await isKnownVoice(providerId, voiceId))) {
		return error(
			res,
			400,
			'validation_error',
			`"${voiceId}" is not a ${provider.label} voice. Pick one from /api/tts/catalog?provider=${providerId}`,
		);
	}

	// ── R2 cache ──────────────────────────────────────────────────────────────
	// Checked BEFORE metering: a cached clip costs nothing upstream, so it is
	// never charged. BYOK clips are keyed separately: they render on a
	// different account and must not be served from (or into) the shared cache.
	const cacheHash = await sha256(
		[
			providerId,
			voiceId,
			text,
			model,
			direction,
			Number.isFinite(speed) ? speed : '',
			format || '',
			language || '',
			voiceSettings ? JSON.stringify(voiceSettings) : '',
			byok ? 'byok' : '',
		].join('\x00'),
	);
	const cacheKey = `tts/synth/${providerId}/${cacheHash}`;

	const cached = await headObject(cacheKey).catch(() => null);
	if (cached) {
		try {
			const buf = await getObjectBuffer(cacheKey);
			// HeadObjectCommand output is the raw S3 shape (PascalCase).
			res.setHeader('content-type', cached.ContentType || 'audio/mpeg');
			res.setHeader('content-length', String(buf.length));
			res.setHeader('x-tts-provider', providerId);
			res.setHeader('x-tts-cache', 'hit');
			res.setHeader('x-tts-billing', 'cached');
			res.setHeader('cache-control', 'private, max-age=86400');
			return res.end(buf);
		} catch {
			// Cache read failed, synthesize fresh.
		}
	}

	// ── Metering ──────────────────────────────────────────────────────────────
	const action = creditActionFor(providerId);
	const usd = usdForSynthesis({ provider: providerId, chars: text.length, byok });
	const billing =
		byok && providerId === 'elevenlabs' ? 'byok'
		: provider.billing === 'gcp' ? 'gcp'
		: usd > 0 ? 'credits'
		: 'free';

	let creditCharge = null;
	if (billing === 'credits' && action) {
		const idempotencyKey = `tts:${providerId}:${randomUUID()}`;
		try {
			const charged = await chargeCreditsForAction({
				user: session || { id: userId },
				action,
				usd,
				refType: 'tts',
				refId: cacheHash,
				idempotencyKey,
				meta: { chars: text.length, provider: providerId, voiceId, model },
			});
			creditCharge = { idempotencyKey, chargedUsd: charged.chargedUsd };
		} catch (err) {
			if (err?.code === 'insufficient_credits') {
				return json(res, 402, {
					error: 'insufficient_credits',
					feature: action,
					available_usd: err.available_usd,
					required_usd: err.required_usd,
					top_up_url: '/credits',
					message:
						`${provider.label} synthesis is metered to your credit balance. ` +
						'Top up with $THREE at /credits, switch to a free voice lane, ' +
						(provider.byok ? 'or bring your own key.' : 'or pick a free provider.'),
				});
			}
			throw err;
		}
	}

	const refundMetering = async () => {
		if (creditCharge?.chargedUsd > 0) {
			await refundCredits({
				userId,
				amountUsd: creditCharge.chargedUsd,
				action,
				refType: 'tts',
				refId: cacheHash,
				idempotencyKey: `${creditCharge.idempotencyKey}:refund`,
				meta: { reason: 'synthesis_failed' },
			}).catch((e) => console.warn('[tts/synthesize] credit refund failed:', e?.message || e));
		}
	};

	// ── Synthesize ────────────────────────────────────────────────────────────
	let out;
	try {
		out = await synthesizeVoice({
			provider: providerId,
			text,
			voiceId,
			model,
			direction,
			speed,
			format,
			language,
			voiceSettings,
			elevenKey,
		});
	} catch (err) {
		console.error('[tts/synthesize] lane failed', providerId, err?.code, err?.message);
		await refundMetering();
		return error(
			res,
			STATUS_BY_CODE[err?.code] || 502,
			err?.code || 'upstream_error',
			err?.message || `${provider.label} synthesis failed`,
		);
	}

	if (!out.audio?.length) {
		await refundMetering();
		return error(res, 502, 'upstream_error', `${provider.label} returned empty audio`);
	}

	putObject({
		key: cacheKey,
		body: out.audio,
		contentType: out.contentType,
		metadata: { 'created-at': new Date().toISOString() },
	}).catch((e) => console.warn('[tts/synthesize] R2 cache write failed:', e.message));

	res.statusCode = 200;
	res.setHeader('content-type', out.contentType);
	res.setHeader('content-length', String(out.audio.length));
	res.setHeader('x-tts-provider', providerId);
	res.setHeader('x-tts-voice', out.voiceId);
	res.setHeader('x-tts-model', out.model);
	res.setHeader('x-tts-format', out.format);
	res.setHeader('x-tts-cache', 'miss');
	res.setHeader('x-tts-billing', billing);
	if (out.lane) res.setHeader('x-tts-lane', out.lane);
	if (creditCharge?.chargedUsd > 0)
		res.setHeader('x-tts-charged-usd', creditCharge.chargedUsd.toFixed(6));
	res.setHeader('cache-control', 'private, max-age=86400');
	return res.end(out.audio);
});
