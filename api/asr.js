// POST /api/asr — free speech-to-text (voice IN) for the avatar voice loop.
//
// The companion to /api/tts/speak (voice OUT): Magpie TTS gives every avatar a
// free voice; this endpoint lets users TALK to the avatar with a real,
// cross-browser recognizer instead of the browser-only
// window.webkitSpeechRecognition (Chrome/Edge only, ships audio to Google,
// absent in Firefox and many embeds).
//
// Lane: NVIDIA NIM Riva ASR (free, gRPC — api/_lib/asr-nvidia.js). There is no
// paid backstop wired here on purpose: when the lane is unconfigured the client
// keeps its existing browser-SpeechRecognition path, so this endpoint is purely
// additive — nothing depends on it and nothing breaks when it is absent.
//
// Request: raw audio bytes as the body, with the encoding given by Content-Type
//   audio/wav | audio/x-wav   → WAV (header parsed, sent as LINEAR_PCM)
//   audio/L16 | audio/pcm     → raw 16-bit little-endian PCM (set ?rate)
//   audio/flac                → FLAC
//   audio/ogg                 → Ogg/Opus
// or a JSON body { audio: <base64>, format?, language?, sampleRate?, words? }.
// Query/JSON params: language (BCP-47, default en-US; a non-English tag routes
//   to the multilingual model, see asrFunctionIdFor), rate (PCM sample rate),
// words ("1" for word-level timestamps), model (override Riva model name).
//
// Response: { text, confidence, language, model, durationSec, words? }.

import { cors, method, readBody, readJson, error, json, wrap, rateLimited } from './_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import {
	transcribeNvidiaAsr,
	nvidiaAsrConfigured,
	resolveAsrEncoding,
	parseWav,
	asrLanguages,
} from './_lib/asr-nvidia.js';

export const maxDuration = 30;

// 8 MiB of audio — generous for a spoken utterance (~4 min of 16 kHz mono PCM,
// far more once compressed) while bounding the in-memory buffer per request.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const ASR_TIMEOUT_MS = 25_000;

// Content-Type → friendly encoding alias understood by resolveAsrEncoding.
// WebM/Opus (Chrome's MediaRecorder default) is intentionally absent: Riva does
// not accept the WebM container, so we reject it with actionable guidance rather
// than silently mislabel it as Ogg and emit garbage transcripts.
function encodingFromContentType(ct) {
	const type = String(ct || '').split(';')[0].trim().toLowerCase();
	switch (type) {
		case 'audio/wav':
		case 'audio/x-wav':
		case 'audio/wave':
			return 'wav';
		case 'audio/l16':
		case 'audio/pcm':
		case 'audio/x-pcm':
			return 'pcm';
		case 'audio/flac':
		case 'audio/x-flac':
			return 'flac';
		case 'audio/ogg':
		case 'audio/opus':
			return 'opus';
		default:
			return null;
	}
}

// Encodings the lane accepts, advertised on the capability probe so the client
// knows what it may upload without hard-coding the list twice.
const ACCEPTED_ENCODINGS = ['wav', 'pcm', 'flac', 'ogg'];

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// Capability probe — lets the avatar talk UI decide, without browser-sniffing,
	// whether to capture audio for server-side Riva recognition or fall back to the
	// browser's own SpeechRecognition. Cheap, unauthenticated, briefly cacheable.
	if (req.method === 'GET' || req.method === 'HEAD') {
		return json(
			res,
			200,
			{
				configured: nvidiaAsrConfigured(),
				encodings: ACCEPTED_ENCODINGS,
				// 16 kHz mono is the Riva acoustic-model rate and the rate the client
				// downsamples its capture to — surface it so the two never drift.
				sampleRate: 16000,
				// BCP-47 tags this deployment can recognize. A client builds its
				// language picker from this rather than guessing: offering a language
				// the lane rejects is worse than not offering it at all.
				languages: asrLanguages(),
			},
			{ 'cache-control': 'public, max-age=60' },
		);
	}

	if (!nvidiaAsrConfigured()) {
		return error(
			res,
			503,
			'not_configured',
			'Speech-to-text is not configured (set NVIDIA_API_KEY and NVIDIA_ASR_FUNCTION_ID — discover the id with scripts/verify-nvidia-asr.mjs --list)',
		);
	}

	// Metered: free upstream but credit-limited, and each call holds an audio clip
	// in memory. Authenticated callers get a per-user budget; anonymous a tight
	// per-IP one. Mirrors the TTS metering policy.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId ?? null;
	if (userId) {
		const rl = await limits.asrUser(userId);
		if (!rl.success) return rateLimited(res, rl, 'ASR rate limit exceeded, try again later');
	} else {
		const rl = await limits.asrIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'ASR rate limit exceeded, sign in for a higher limit');
	}

	const url = new URL(req.url, 'http://localhost');
	const q = url.searchParams;
	const contentType = req.headers['content-type'] || '';
	const isJson = contentType.split(';')[0].trim().toLowerCase() === 'application/json';

	// Pull audio + params from whichever transport was used.
	let audio;
	let format;
	let language = q.get('language') || q.get('lang') || 'en-US';
	let sampleRate = Number(q.get('rate') || q.get('sampleRate')) || 0;
	let wantWords = q.get('words') === '1' || q.get('words') === 'true';
	let model = q.get('model') || '';

	try {
		if (isJson) {
			const body = await readJson(req, Math.ceil(MAX_AUDIO_BYTES * 1.4)); // base64 inflates ~33%
			const b64 = typeof body.audio === 'string' ? body.audio.replace(/^data:[^,]*,/, '') : '';
			if (!b64) return error(res, 400, 'bad_request', 'audio (base64) is required');
			audio = Buffer.from(b64, 'base64');
			format = body.format || 'wav';
			if (typeof body.language === 'string') language = body.language;
			if (Number(body.sampleRate)) sampleRate = Number(body.sampleRate);
			if (body.words === true || body.words === '1') wantWords = true;
			if (typeof body.model === 'string') model = body.model;
		} else {
			format = encodingFromContentType(contentType);
			if (!format) {
				return error(
					res,
					415,
					'unsupported_media_type',
					`Unsupported audio Content-Type "${contentType.split(';')[0] || 'none'}". Send audio/wav, audio/pcm (with ?rate=), audio/flac, or audio/ogg — WebM/Opus must be decoded to PCM/WAV client-side first.`,
				);
			}
			audio = await readBody(req, MAX_AUDIO_BYTES);
		}
	} catch (e) {
		if (e?.status === 413) return error(res, 413, 'payload_too_large', 'audio exceeds the 8 MB limit');
		return error(res, e?.status || 400, 'bad_request', e?.message || 'could not read request body');
	}

	if (!audio?.length) return error(res, 400, 'bad_request', 'no audio bytes received');

	let encoding = resolveAsrEncoding(format);

	// A WAV carries its own sample rate and a 44-byte header Riva's LINEAR_PCM
	// must not see — strip to raw PCM and trust the header's rate. Non-WAV inputs
	// keep their declared encoding and the supplied (or default) rate.
	if (encoding === 'LINEAR_PCM') {
		const wav = parseWav(audio);
		if (wav) {
			audio = wav.pcm;
			sampleRate = wav.sampleRateHz;
		} else if (!sampleRate) {
			// Raw PCM with no declared rate — 16 kHz is the Riva model default and
			// the most common capture rate; the client can override with ?rate=.
			sampleRate = 16000;
		}
	} else if (!sampleRate) {
		sampleRate = 16000;
	}

	try {
		const out = await transcribeNvidiaAsr({
			audio,
			encoding,
			sampleRateHz: sampleRate,
			language,
			wordTimeOffsets: wantWords,
			model,
			timeoutMs: ASR_TIMEOUT_MS,
		});
		return json(res, 200, {
			text: out.text,
			confidence: out.confidence,
			language: out.language,
			model: out.model,
			durationSec: out.audioProcessed,
			...(wantWords ? { words: out.words } : {}),
		}, { 'cache-control': 'no-store' });
	} catch (e) {
		const code = e?.code || 'provider_error';
		const status =
			code === 'rate_limited' ? 429 :
			code === 'invalid_argument' ? 400 :
			code === 'not_configured' ? 503 :
			502;
		// An `invalid_argument` on a non-English language is nearly always the
		// hosted model refusing that language_code, which reads as a generic
		// provider failure unless we say so. Name the language and the way out.
		if (code === 'invalid_argument' && !String(language).toLowerCase().startsWith('en')) {
			return error(
				res,
				400,
				'unsupported_language',
				`The speech-to-text lane could not recognize "${language}". Supported: ${asrLanguages().join(', ') || 'none'}.`,
			);
		}
		return error(res, status, code, `Speech recognition failed: ${e?.message || 'unknown error'}`);
	}
});
