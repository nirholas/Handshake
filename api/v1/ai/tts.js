// POST /api/v1/ai/tts — text-to-speech for agents (free daily quota → x402).
// GET  /api/v1/ai/tts?voices=1 — list the available voices (free, public).
//
// Productizes the platform's free NVIDIA NIM Magpie lane (api/_lib/tts-nvidia.js)
// as a versioned, agent-callable endpoint:
//   • Free tier: 10 calls/day per IP, text ≤500 chars — the funnel.
//   • Above the free tier (quota exhausted OR text >500 chars OR an X-PAYMENT
//     header is present) the request falls through to the x402 rail: a 402
//     challenge with bazaar discovery, settled per call in USDC.
//
// Both tiers run the SAME synthesis (api/_lib/ai-speech.js) and return the SAME
// JSON shape (base64 audio) — the paid rail must return JSON so settlement runs,
// so the free lane matches for a uniform contract.

import { cors, method, error, json, wrap, readBody } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';
import { priceFor } from '../../_lib/x402-prices.js';
import { paidEndpoint } from '../../_lib/x402-paid-endpoint.js';
import { declareHttpDiscovery, withService } from '../../_lib/x402/bazaar-helpers.js';
import { installAccessControl } from '../../_lib/x402/access-control.js';
import { TTS_VOICE_IDS, DEFAULT_VOICE } from '../../_lib/tts-voices.js';
import {
	ttsVoicesPayload,
	readTtsInput,
	ttsConfigured,
	ttsSynthesize,
	FREE_TTS_MAX_CHARS,
	PAID_TTS_MAX_CHARS,
	TTS_MAX_BODY_BYTES,
} from '../../_lib/ai-speech.js';

export const maxDuration = 45;

const ROUTE = '/api/v1/ai/tts';
const PRICE_ATOMICS = priceFor('ai-tts', '5000'); // $0.005 per call (env: X402_PRICE_AI_TTS)

// Uniqueness-first: the first sentence answers "what can I only get here".
const DESCRIPTION =
	'Text-to-speech for agents over x402 — a keyless neural TTS lane you can call ' +
	'with no account and no API key; pay $0.005 USDC per call for multilingual ' +
	'Magpie voices (English, Spanish, French, German, Italian, Hindi, Chinese, ' +
	'Vietnamese, Japanese). POST { text, voice? } and receive base64 WAV/PCM audio. ' +
	'A free daily quota lets you try it before paying.';

const INPUT_EXAMPLE = {
	text: 'Your deploy finished — three services are green and latency is nominal.',
	voice: 'nova',
	format: 'wav',
	language: 'en-US',
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['text'],
	properties: {
		text: {
			type: 'string',
			minLength: 1,
			maxLength: PAID_TTS_MAX_CHARS,
			description: `Text to synthesize (≤${PAID_TTS_MAX_CHARS} chars; free tier ≤${FREE_TTS_MAX_CHARS}).`,
		},
		voice: {
			type: 'string',
			enum: TTS_VOICE_IDS,
			default: DEFAULT_VOICE,
			description: 'Voice id. Unknown values fall back to the default persona.',
		},
		format: {
			type: 'string',
			enum: ['wav', 'pcm'],
			default: 'wav',
			description: 'Audio container. Magpie emits WAV or raw PCM.',
		},
		language: {
			type: 'string',
			default: 'en-US',
			description: 'BCP-47 language tag (en-US, es-US, fr-FR, de-DE, it-IT, hi-IN, zh-CN, vi-VN, ja-JP).',
		},
	},
};

const OUTPUT_EXAMPLE = {
	audio: 'UklGR... (base64-encoded WAV)',
	encoding: 'base64',
	format: 'wav',
	content_type: 'audio/wav',
	sample_rate: 44100,
	voice: 'Magpie-Multilingual.EN-US.Aria',
	model: 'magpie-tts-multilingual',
	characters: 71,
	bytes: 132_344,
	tier: 'paid',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['audio', 'format', 'content_type', 'sample_rate', 'voice', 'model'],
	properties: {
		audio: { type: 'string', description: 'Base64-encoded audio in `format`.' },
		encoding: { type: 'string', const: 'base64' },
		format: { type: 'string' },
		content_type: { type: 'string' },
		sample_rate: { type: 'integer' },
		voice: { type: 'string' },
		model: { type: 'string' },
		characters: { type: 'integer' },
		bytes: { type: 'integer' },
		tier: { type: 'string', enum: ['free', 'paid'] },
	},
};

const BAZAAR = declareHttpDiscovery({
	method: 'POST',
	bodyType: 'json',
	input: INPUT_EXAMPLE,
	inputSchema: INPUT_SCHEMA,
	output: { example: OUTPUT_EXAMPLE, schema: OUTPUT_SCHEMA },
});

// The x402 paid twin — built once, lazily (constructing it touches env-derived
// pay-to config). Reused for every over-quota / paying request.
let _paid = null;
function paidHandler() {
	if (_paid) return _paid;
	_paid = paidEndpoint({
		route: ROUTE,
		method: 'POST',
		priceAtomics: PRICE_ATOMICS,
		networks: ['base', 'solana'],
		description: DESCRIPTION,
		bazaar: BAZAAR,
		service: withService({
			serviceName: 'three.ws Text-to-Speech',
			tags: ['tts', 'speech', 'voice', 'audio', 'ai'],
		}),
		requiredScope: 'x402:bypass',
		accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
		async handler({ req }) {
			const raw = req._aiSpeechBody ?? (await readBody(req, TTS_MAX_BODY_BYTES));
			const input = readTtsInput(raw, { maxChars: PAID_TTS_MAX_CHARS });
			const payload = await ttsSynthesize(input);
			return { ...payload, tier: 'paid' };
		},
	});
	return _paid;
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// ── Voices / capability probe (free, public) ─────────────────────────────
	if (req.method === 'GET') {
		const url = new URL(req.url, 'http://localhost');
		if (url.searchParams.has('voices')) {
			return json(res, 200, { data: ttsVoicesPayload() }, { 'cache-control': 'public, max-age=3600' });
		}
		return json(
			res,
			200,
			{
				data: {
					endpoint: ROUTE,
					description: 'POST text to synthesize speech. GET ?voices=1 lists voices.',
					configured: ttsConfigured(),
					free_tier: { per_day: 10, max_chars: FREE_TTS_MAX_CHARS },
					paid: { price_usdc: Number(PRICE_ATOMICS) / 1e6, max_chars: PAID_TTS_MAX_CHARS, networks: ['base', 'solana'] },
				},
			},
			{ 'cache-control': 'public, max-age=300' },
		);
	}

	// ── POST: synthesize ──────────────────────────────────────────────────────
	// ttsSynthesize falls through to the Gemini TTS lane when Magpie cannot
	// serve, so the endpoint is available whenever EITHER is configured. Gating
	// on the NVIDIA key alone used to 503 a request the Gemini lane could have
	// answered on platform credits.
	if (!ttsConfigured()) {
		return error(
			res,
			503,
			'not_configured',
			'Text-to-speech is not configured (set NVIDIA_API_KEY, or GOOGLE_CLOUD_PROJECT for the Gemini lane)',
		);
	}

	// Buffer the body once, then decide the lane — the paid rail reads the same
	// bytes (req._aiSpeechBody) so the stream is never consumed twice.
	let raw;
	try {
		raw = await readBody(req, TTS_MAX_BODY_BYTES);
	} catch (e) {
		if (e?.status === 413) return error(res, 413, 'payload_too_large', `request body exceeds ${TTS_MAX_BODY_BYTES} bytes`);
		return error(res, 400, 'bad_request', e?.message || 'could not read request body');
	}
	req._aiSpeechBody = raw;

	// A payment header means the caller is on the paid rail already.
	const paymentPresent = Boolean(req.headers['x-payment'] || req.headers['payment-signature']);
	if (paymentPresent) return paidHandler()(req, res);

	// Validate against the paid ceiling first, so genuinely bad input (empty / too
	// long) is a clean 400 rather than a payment prompt.
	let input;
	try {
		input = readTtsInput(raw, { maxChars: PAID_TTS_MAX_CHARS });
	} catch (e) {
		return error(res, e.status || 400, e.code || 'bad_request', e.message);
	}

	// Beyond the free-tier char cap → pay per call.
	if (input.text.length > FREE_TTS_MAX_CHARS) return paidHandler()(req, res);

	// Free daily quota (per IP). Exhausted → the 402 challenge.
	const rl = await limits.aiTtsFreeIp(clientIp(req));
	if (!rl.success) return paidHandler()(req, res);

	try {
		const payload = await ttsSynthesize(input);
		return json(
			res,
			200,
			{ data: { ...payload, tier: 'free', free_remaining_today: Math.max(0, rl.remaining) } },
			{ 'cache-control': 'no-store' },
		);
	} catch (e) {
		return error(res, e.status || 502, e.code || 'provider_error', e.message);
	}
});
