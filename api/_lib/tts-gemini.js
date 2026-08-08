// @ts-check
// Gemini native TTS lane — 30 prebuilt voices, controllable by prompt.
//
// Two rungs, in this order:
//   1. Vertex AI (`GOOGLE_CLOUD_PROJECT`) authenticated with the GCP service
//      account and billed to the platform's Google credits. This is the lane
//      that actually runs in production: same anchor doctrine as
//      api/_lib/vertex-gemini.js — no third-party quota, no API key to rot,
//      standing owner-approved spend (docs/ops/gcp-credits-plan.md).
//   2. The Generative Language API with `GEMINI_API_KEY`, for local dev and as
//      a backstop when the Vertex token mint fails.
//
// Gemini TTS returns raw little-endian s16 PCM at 24 kHz, so every clip is
// wrapped in a RIFF/WAVE header before it leaves this module: browsers sniff
// the container, and the content-type we report stays truthful.
//
// Unlike every other lane here, the voice is only half the character: Gemini
// takes a natural-language style instruction in the prompt itself ("Say this
// in a warm, conspiratorial whisper:"), which the Voice Lab exposes as the
// "direction" field.

import { pcmToWav } from './tts-nvidia.js';
import { getGcpAccessToken } from './gcp-auth.js';
import { env } from './env.js';

// Preview TTS models. Flash is the real-time lane; Pro is the quality lane.
export const GEMINI_TTS_MODELS = [
	{
		id: 'gemini-2.5-flash-preview-tts',
		label: 'Gemini 2.5 Flash TTS',
		note: 'Fast · style-directable · 24 languages',
	},
	{
		id: 'gemini-2.5-pro-preview-tts',
		label: 'Gemini 2.5 Pro TTS',
		note: 'Highest quality · follows long directions',
	},
];
export const GEMINI_TTS_DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';
const GEMINI_MODEL_IDS = new Set(GEMINI_TTS_MODELS.map((m) => m.id));

export function isGeminiTtsModel(id) {
	return typeof id === 'string' && GEMINI_MODEL_IDS.has(id);
}

// Gemini's 30 prebuilt voices with the character Google documents for each.
// Ids are case-sensitive on the wire.
export const GEMINI_VOICES = [
	{ id: 'Zephyr', character: 'Bright' },
	{ id: 'Puck', character: 'Upbeat' },
	{ id: 'Charon', character: 'Informative' },
	{ id: 'Kore', character: 'Firm' },
	{ id: 'Fenrir', character: 'Excitable' },
	{ id: 'Leda', character: 'Youthful' },
	{ id: 'Orus', character: 'Firm' },
	{ id: 'Aoede', character: 'Breezy' },
	{ id: 'Callirrhoe', character: 'Easy-going' },
	{ id: 'Autonoe', character: 'Bright' },
	{ id: 'Enceladus', character: 'Breathy' },
	{ id: 'Iapetus', character: 'Clear' },
	{ id: 'Umbriel', character: 'Easy-going' },
	{ id: 'Algieba', character: 'Smooth' },
	{ id: 'Despina', character: 'Smooth' },
	{ id: 'Erinome', character: 'Clear' },
	{ id: 'Algenib', character: 'Gravelly' },
	{ id: 'Rasalgethi', character: 'Informative' },
	{ id: 'Laomedeia', character: 'Upbeat' },
	{ id: 'Achernar', character: 'Soft' },
	{ id: 'Alnilam', character: 'Firm' },
	{ id: 'Schedar', character: 'Even' },
	{ id: 'Gacrux', character: 'Mature' },
	{ id: 'Pulcherrima', character: 'Forward' },
	{ id: 'Achird', character: 'Friendly' },
	{ id: 'Zubenelgenubi', character: 'Casual' },
	{ id: 'Vindemiatrix', character: 'Gentle' },
	{ id: 'Sadachbia', character: 'Lively' },
	{ id: 'Sadaltager', character: 'Knowledgeable' },
	{ id: 'Sulafat', character: 'Warm' },
];
export const GEMINI_DEFAULT_VOICE = 'Kore';
const GEMINI_VOICE_IDS = new Set(GEMINI_VOICES.map((v) => v.id));

export function isGeminiVoice(id) {
	return typeof id === 'string' && GEMINI_VOICE_IDS.has(id);
}

// Gemini TTS emits 24 kHz mono s16.
const SAMPLE_RATE_HZ = 24_000;
const DEFAULT_TIMEOUT_MS = 45_000;

// The preview TTS models are not served from every Vertex region; us-central1
// is the one that has carried them since launch. Env-tunable so a region move
// needs no code change.
function vertexLocation() {
	return process.env.GOOGLE_CLOUD_LOCATION_TTS || 'us-central1';
}

/** True when either rung can serve. Read per call so late-injected env works. */
export function geminiTtsConfigured() {
	return Boolean(process.env.GOOGLE_CLOUD_PROJECT || env.GEMINI_API_KEY);
}

/** Which rungs are live, for the catalog endpoint's provider report. */
export function geminiTtsLanes() {
	return {
		vertex: Boolean(process.env.GOOGLE_CLOUD_PROJECT),
		apiKey: Boolean(env.GEMINI_API_KEY),
	};
}

function tagged(message, code, extra = {}) {
	return Object.assign(new Error(message), { code, ...extra });
}

/**
 * Compose the request payload. `direction` is a natural-language style
 * instruction Gemini honors as part of the prompt; it is prefixed rather than
 * sent as a separate field because that is the documented control surface.
 */
function buildBody({ text, voice, direction }) {
	const prompt = direction ? `${direction.replace(/:\s*$/, '')}: ${text}` : text;
	return {
		contents: [{ role: 'user', parts: [{ text: prompt }] }],
		generationConfig: {
			responseModalities: ['AUDIO'],
			speechConfig: {
				voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
			},
		},
	};
}

/** Pull the base64 PCM out of a generateContent response. */
function extractAudio(data) {
	const parts = data?.candidates?.[0]?.content?.parts || [];
	for (const part of parts) {
		const inline = part?.inlineData || part?.inline_data;
		const b64 = inline?.data;
		if (typeof b64 === 'string' && b64.length) return Buffer.from(b64, 'base64');
	}
	const blocked = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
	throw tagged(
		blocked ? `Gemini TTS returned no audio (${blocked})` : 'Gemini TTS returned no audio',
		blocked === 'SAFETY' || blocked === 'PROHIBITED_CONTENT' ? 'content_blocked' : 'provider_error',
	);
}

async function callGemini({ url, headers, body, timeoutMs }) {
	let resp;
	try {
		resp = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (e) {
		throw tagged(`Could not reach Gemini TTS: ${e?.message || 'fetch failed'}`, 'provider_unreachable');
	}
	if (!resp.ok) {
		const detail = await resp.text().catch(() => '');
		const code =
			resp.status === 429 ? 'rate_limited'
			: resp.status === 401 || resp.status === 403 ? 'invalid_key'
			: 'provider_error';
		throw tagged(`Gemini TTS returned ${resp.status}: ${detail.slice(0, 300)}`, code, {
			status: resp.status,
		});
	}
	return extractAudio(await resp.json());
}

/**
 * Synthesize one clip. Resolves with the COMPLETE audio buffer so a caller can
 * fail over to another lane before a byte reaches the client.
 *
 * @param {{ text:string, voice?:string, model?:string, direction?:string, timeoutMs?:number }} opts
 * @returns {Promise<{ audio:Buffer, contentType:string, format:string, voiceName:string, model:string, lane:string, sampleRateHz:number }>}
 * @throws {Error & { code:string }} not_configured | invalid_key | rate_limited |
 *         content_blocked | provider_unreachable | provider_error
 */
export async function synthesizeGeminiTts({
	text,
	voice = GEMINI_DEFAULT_VOICE,
	model = GEMINI_TTS_DEFAULT_MODEL,
	direction = '',
	timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
	if (!text || !String(text).trim()) throw tagged('text is required', 'invalid_argument');
	const voiceName = isGeminiVoice(voice) ? voice : GEMINI_DEFAULT_VOICE;
	const modelId = isGeminiTtsModel(model) ? model : GEMINI_TTS_DEFAULT_MODEL;
	const body = buildBody({ text: String(text), voice: voiceName, direction: String(direction || '') });

	const laneErrors = [];
	let pcm = null;
	let lane = '';

	// ── Rung 1: Vertex AI on platform credits ────────────────────────────────
	if (process.env.GOOGLE_CLOUD_PROJECT) {
		const project = process.env.GOOGLE_CLOUD_PROJECT;
		const location = vertexLocation();
		try {
			const token = await getGcpAccessToken();
			pcm = await callGemini({
				url:
					`https://${location}-aiplatform.googleapis.com/v1/projects/${project}` +
					`/locations/${location}/publishers/google/models/${modelId}:generateContent`,
				headers: { authorization: `Bearer ${token}` },
				body,
				timeoutMs,
			});
			lane = 'vertex';
		} catch (e) {
			laneErrors.push(`vertex: ${e?.code || 'error'} ${e?.message || ''}`.trim());
		}
	}

	// ── Rung 2: Generative Language API key ──────────────────────────────────
	if (!pcm && env.GEMINI_API_KEY) {
		try {
			pcm = await callGemini({
				url: `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
				headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
				body,
				timeoutMs,
			});
			lane = 'api-key';
		} catch (e) {
			laneErrors.push(`api-key: ${e?.code || 'error'} ${e?.message || ''}`.trim());
		}
	}

	if (!pcm) {
		if (!laneErrors.length) throw tagged('Gemini TTS is not configured', 'not_configured');
		throw tagged(`Gemini TTS failed — ${laneErrors.join('; ')}`, 'provider_error');
	}

	return {
		audio: pcmToWav(pcm, { sampleRateHz: SAMPLE_RATE_HZ }),
		contentType: 'audio/wav',
		format: 'wav',
		voiceName,
		model: modelId,
		lane,
		sampleRateHz: SAMPLE_RATE_HZ,
	};
}
