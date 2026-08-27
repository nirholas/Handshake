// Shared core for the productized speech package (api/v1/ai/asr, api/v1/ai/tts).
//
// The versioned /api/v1/ai/* endpoints and their x402 paid twins run the SAME
// synthesis / recognition here, so a free-quota caller and a paying caller hit
// identical lane code. This module owns:
//   • input parsing + validation (typed errors carrying { status, code })
//   • the tier limits (free-tier char/duration caps, hard body caps)
//   • the calls into the free NVIDIA NIM lanes (tts-nvidia.js / asr-nvidia.js),
//     with their gRPC error codes mapped to HTTP once, in one place.
//
// It deliberately pulls in NO x402 dependencies — the route files wire the
// billing rail. The NIM lanes are the only synthesis backend here (no OpenAI
// backstop): these endpoints productize the free NVIDIA lanes, and env gating
// answers 503 not_configured (never a fake response) when the key is absent.

import {
	synthesizeNvidiaTts,
	nvidiaTtsConfigured,
} from './tts-nvidia.js';
import {
	transcribeNvidiaAsr,
	nvidiaAsrConfigured,
	resolveAsrEncoding,
	parseWav,
} from './asr-nvidia.js';
import { TTS_VOICES, TTS_VOICE_IDS, DEFAULT_VOICE } from './tts-voices.js';
import { geminiTtsConfigured, synthesizeGeminiTts } from './tts-gemini.js';

export { nvidiaTtsConfigured, nvidiaAsrConfigured };

// ── Tier limits ──────────────────────────────────────────────────────────────
// Free tier is tight on purpose: the NIM lanes cost real GPU credit. Above these
// the caller falls through to the x402 402 challenge (pay-per-call).
export const FREE_TTS_MAX_CHARS = 500;
export const PAID_TTS_MAX_CHARS = 4096; // matches api/tts/speak.js
export const FREE_ASR_MAX_SECONDS = 60;

// Hard memory bounds (both tiers). ASR audio is buffered in full per request.
export const ASR_MAX_AUDIO_BYTES = 8 * 1024 * 1024; // 8 MiB of decoded audio
// Base64 in a JSON body inflates ~33%, so allow a larger raw read then bound the
// decoded audio to ASR_MAX_AUDIO_BYTES.
export const ASR_MAX_BODY_BYTES = Math.ceil(ASR_MAX_AUDIO_BYTES * 1.4);
export const TTS_MAX_BODY_BYTES = 64 * 1024; // 64 KiB JSON is plenty for 4096 chars

const TTS_TIMEOUT_MS = 30_000;
const ASR_TIMEOUT_MS = 25_000;

// Encodings the ASR lane accepts, advertised on the capability probe.
export const ASR_ACCEPTED_ENCODINGS = ['wav', 'pcm', 'flac', 'ogg'];

function httpError(status, code, message) {
	const err = new Error(message);
	err.status = status;
	err.code = code;
	return err;
}

// Map a NIM lane error (Error with .code from tts-nvidia/asr-nvidia) to an HTTP
// status once, so the free route and the paid handler answer identically.
function laneErrorToHttp(e, label) {
	const code = e?.code || 'provider_error';
	const status =
		code === 'not_configured' ? 503 :
		code === 'invalid_argument' ? 400 :
		code === 'rate_limited' ? 429 :
		code === 'timeout' ? 504 :
		502; // invalid_key / provider_unreachable / provider_error
	return httpError(status, code, `${label} failed: ${e?.message || 'unknown error'}`);
}

// ── TTS ────────────────────────────────────────────────────────────────────────

// The voices catalog (mirrors /api/tts/voices) — free, public metadata. Only the
// NVIDIA lane is reported here; `enabled` reflects whether synthesis is live.
export function ttsVoicesPayload() {
	const configured = nvidiaTtsConfigured();
	return {
		enabled: configured,
		default: DEFAULT_VOICE,
		voices: TTS_VOICES,
		formats: ['wav', 'pcm'],
		providers: { nvidia: configured },
	};
}

// Parse + validate a TTS request body. `maxChars` differs by tier (free 500,
// paid 4096). Throws typed { status, code } errors on bad input.
export function readTtsInput(raw, { maxChars = PAID_TTS_MAX_CHARS } = {}) {
	let body;
	try {
		body = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || ''));
	} catch {
		throw httpError(400, 'bad_request', 'request body must be valid JSON');
	}
	if (!body || typeof body !== 'object') {
		throw httpError(400, 'bad_request', 'request body must be a JSON object');
	}
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (!text) throw httpError(400, 'bad_request', '"text" is required');
	if (text.length > maxChars) {
		throw httpError(400, 'text_too_long', `"text" exceeds the ${maxChars}-character limit (got ${text.length})`);
	}
	const voice = typeof body.voice === 'string' && body.voice ? body.voice : DEFAULT_VOICE;
	// Magpie honestly emits only WAV/PCM (see tts-nvidia.js), so those are the
	// only formats we advertise; anything else is coerced to WAV by the lane.
	const format = body.format === 'pcm' ? 'pcm' : 'wav';
	const language = typeof body.language === 'string' && body.language ? body.language : 'en-US';
	return { text, voice, format, language };
}

// Synthesize on the free NVIDIA NIM Magpie lane. Returns a JSON-serializable
// payload with base64 audio (uniform across the free + paid lanes so settlement
// on the paid rail always emits JSON). Throws an HTTP-typed error on lane failure.
/**
 * True when speech synthesis can serve at all: the NIM Magpie lane, the Gemini
 * TTS lane, or both. Callers gate on this rather than on one vendor's key, so
 * an endpoint is never reported unavailable while a configured lane sits idle.
 */
export function ttsConfigured() {
	return nvidiaTtsConfigured() || geminiTtsConfigured();
}

export async function ttsSynthesize({ text, voice, format, language }) {
	let out;
	try {
		out = await synthesizeNvidiaTts({ text, voice, language, format, timeoutMs: TTS_TIMEOUT_MS });
	} catch (e) {
		// Magpie is the preferred lane, not the only one it is worth trying. A
		// caller asked for speech, not for a vendor, so a NIM outage falls through
		// to the Gemini TTS lane (platform GCP credits, no vendor quota) before the
		// request is failed. The lane that answered is reported in `model` and
		// `voice`, so nothing pretends the clip came from Magpie, and the voice
		// name changes with it: that is the honest cost of still getting audio.
		if (geminiTtsConfigured()) {
			try {
				const alt = await synthesizeGeminiTts({ text, timeoutMs: TTS_TIMEOUT_MS });
				return {
					audio: alt.audio.toString('base64'),
					encoding: 'base64',
					format: alt.format,
					content_type: alt.contentType,
					sample_rate: alt.sampleRateHz,
					voice: alt.voiceName,
					model: alt.model,
					characters: text.length,
					bytes: alt.audio.length,
					lane: alt.lane,
					fallback_from: 'nvidia',
				};
			} catch (fallbackErr) {
				console.warn(`[ai-speech] gemini tts fallback failed: ${fallbackErr?.message || fallbackErr}`);
			}
		}
		throw laneErrorToHttp(e, 'Speech synthesis');
	}
	return {
		audio: out.audio.toString('base64'),
		encoding: 'base64',
		format: out.format,
		content_type: out.contentType,
		sample_rate: out.sampleRateHz,
		voice: out.voiceName,
		model: out.model,
		characters: text.length,
		bytes: out.audio.length,
	};
}

// ── ASR ────────────────────────────────────────────────────────────────────────

// Content-Type → friendly encoding alias. WebM/Opus is intentionally absent:
// Riva rejects the WebM container, so callers must decode to PCM/WAV first.
export function asrEncodingFromContentType(ct) {
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

// Parse an ASR request from either transport:
//   • application/json  → { audio: <base64>, format?, language?, sampleRate?, words?, model? }
//   • audio/*           → raw bytes in the body, encoding from Content-Type
// Returns the lane-ready shape { audio, encoding, sampleRateHz, language,
// wantWords, model, durationSec|null }. `durationSec` is exact for WAV, estimated
// for raw PCM, and null for compressed formats (bounded only by the byte cap).
// Throws typed { status, code } errors on bad/oversize/unsupported input.
export function parseAsrRequest({ contentType, url, buf }) {
	const q = safeQuery(url);
	const isJson = String(contentType || '').split(';')[0].trim().toLowerCase() === 'application/json';

	let audio;
	let format;
	let language = q.language || q.lang || 'en-US';
	let sampleRate = Number(q.rate || q.sampleRate) || 0;
	let wantWords = q.words === '1' || q.words === 'true';
	let model = q.model || '';

	if (isJson) {
		let body;
		try {
			body = JSON.parse(buf.toString('utf8'));
		} catch {
			throw httpError(400, 'bad_request', 'request body must be valid JSON');
		}
		const b64 = typeof body?.audio === 'string' ? body.audio.replace(/^data:[^,]*,/, '') : '';
		if (!b64) throw httpError(400, 'bad_request', '"audio" (base64) is required');
		audio = Buffer.from(b64, 'base64');
		format = body.format || 'wav';
		if (typeof body.language === 'string') language = body.language;
		if (Number(body.sampleRate)) sampleRate = Number(body.sampleRate);
		if (body.words === true || body.words === '1') wantWords = true;
		if (typeof body.model === 'string') model = body.model;
	} else {
		format = asrEncodingFromContentType(contentType);
		if (!format) {
			throw httpError(
				415,
				'unsupported_media_type',
				`unsupported audio Content-Type "${String(contentType || '').split(';')[0] || 'none'}". ` +
					'Send audio/wav, audio/pcm (with ?rate=), audio/flac, audio/ogg, or a JSON body ' +
					'{ "audio": "<base64>" } — WebM/Opus must be decoded to PCM/WAV client-side first.',
			);
		}
		audio = buf;
	}

	if (!audio?.length) throw httpError(400, 'bad_request', 'no audio bytes received');
	if (audio.length > ASR_MAX_AUDIO_BYTES) {
		throw httpError(413, 'payload_too_large', `audio exceeds the ${ASR_MAX_AUDIO_BYTES}-byte limit`);
	}

	let encoding = resolveAsrEncoding(format);
	let durationSec = null;

	// A WAV carries its own rate and a 44-byte header Riva's LINEAR_PCM must not
	// see — strip to raw PCM, trust the header's rate, and compute exact duration.
	if (encoding === 'LINEAR_PCM') {
		const wav = parseWav(audio);
		if (wav) {
			audio = wav.pcm;
			sampleRate = wav.sampleRateHz;
			const bytesPerSample = 2 * (wav.channels || 1);
			durationSec = wav.pcm.length / (wav.sampleRateHz * bytesPerSample);
		} else {
			if (!sampleRate) sampleRate = 16000; // Riva model default + common capture rate
			durationSec = audio.length / (sampleRate * 2); // raw mono s16 estimate
		}
	} else if (!sampleRate) {
		sampleRate = 16000;
	}

	return { audio, encoding, sampleRateHz: sampleRate, language, wantWords, model, durationSec };
}

// Transcribe on the free NVIDIA NIM Riva lane. Returns a JSON-serializable
// payload; throws an HTTP-typed error on lane failure.
export async function asrTranscribe({ audio, encoding, sampleRateHz, language, wantWords, model }) {
	let out;
	try {
		out = await transcribeNvidiaAsr({
			audio,
			encoding,
			sampleRateHz,
			language,
			wordTimeOffsets: wantWords,
			model,
			timeoutMs: ASR_TIMEOUT_MS,
		});
	} catch (e) {
		throw laneErrorToHttp(e, 'Speech recognition');
	}
	return {
		text: out.text,
		confidence: out.confidence,
		duration: out.audioProcessed,
		language: out.language,
		model: out.model,
		...(wantWords ? { words: out.words } : {}),
	};
}

// Parse a request URL's query into a plain object without throwing on garbage.
function safeQuery(url) {
	try {
		const u = new URL(url || '/', 'http://internal');
		return Object.fromEntries(u.searchParams);
	} catch {
		return {};
	}
}
