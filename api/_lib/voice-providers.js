// @ts-check
// The platform's voice registry: one description of every synthesis lane, and
// one function that renders text on any of them.
//
// Before this file each lane had its own endpoint, its own voice-id vocabulary
// and its own billing story, so a picker could only ever show one provider's
// voices. Everything user-facing (/voice, the agent voice editor, the widget
// studio) now reads `VOICE_PROVIDERS` for what exists and posts to
// /api/tts/synthesize to hear it.
//
// Billing doctrine (owner policy 2026-08-06, no free tier on a vendor-billed
// feature):
//   free    : no vendor invoice at all (Edge) or a free vendor tier
//             (NVIDIA NIM). Served without charge.
//   credits : the vendor bills the platform (ElevenLabs, OpenAI). Metered to
//             the caller's prepaid credit wallet, or bypassed entirely with
//             BYOK where the provider supports it.
//   gcp     : billed to the platform's Google credits under the standing
//             owner-approved spend (docs/ops/gcp-credits-plan.md), same
//             doctrine as the Vertex chat anchor. Free to the caller.

import { env } from './env.js';
import { TTS_ELEVEN_USD_PER_1K, TTS_OPENAI_USD_PER_1K } from './pricing/catalog.js';
import { synthesizeNvidiaTts, nvidiaTtsConfigured, VOICE_TO_MAGPIE } from './tts-nvidia.js';
import {
	synthesizeEdge,
	listEdgeVoices,
	EDGE_VOICE_RE,
	EDGE_RATE_RE,
	EDGE_PITCH_RE,
	EDGE_DEFAULT_VOICE,
} from './tts-edge.js';
import {
	synthesizeGeminiTts,
	geminiTtsConfigured,
	geminiTtsLanes,
	GEMINI_VOICES,
	GEMINI_TTS_MODELS,
	GEMINI_DEFAULT_VOICE,
	GEMINI_TTS_DEFAULT_MODEL,
} from './tts-gemini.js';
import { TTS_VOICES, DEFAULT_VOICE as OPENAI_DEFAULT_VOICE } from './tts-voices.js';
import {
	ELEVEN_BASE,
	DEFAULT_TTS_MODEL as ELEVEN_DEFAULT_MODEL,
	TTS_MODELS as ELEVEN_MODELS,
	isValidModel as isElevenModel,
	normalizeVoiceSettings,
	listVoices as listElevenVoices,
	isConfigured as elevenConfigured,
} from './elevenlabs.js';

export const OPENAI_TTS_MODELS = [
	{ id: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS', note: 'Steerable · accepts a spoken direction' },
	{ id: 'tts-1', label: 'TTS-1', note: 'Lowest latency' },
	{ id: 'tts-1-hd', label: 'TTS-1 HD', note: 'Highest fidelity' },
];
const OPENAI_MODEL_IDS = new Set(OPENAI_TTS_MODELS.map((m) => m.id));
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini-tts';
const OPENAI_FORMATS = {
	mp3: 'audio/mpeg',
	opus: 'audio/ogg',
	aac: 'audio/aac',
	flac: 'audio/flac',
	wav: 'audio/wav',
};

const OPENAI_VOICE_IDS = new Set(TTS_VOICES.map((v) => v.id));
const NVIDIA_VOICE_IDS = new Set(Object.keys(VOICE_TO_MAGPIE));

const SYNTH_TIMEOUT_MS = 45_000;

/**
 * Static description of every lane. `id` values are the wire vocabulary shared
 * by /api/tts/catalog, /api/tts/synthesize and the client.
 */
export const VOICE_PROVIDERS = Object.freeze([
	{
		id: 'edge',
		label: 'Microsoft Edge',
		tagline: 'Free · ~500 neural voices · 100+ locales',
		billing: 'free',
		usdPer1k: 0,
		byok: false,
		clone: false,
		direction: false,
		anonymous: true,
		docs: 'https://learn.microsoft.com/azure/ai-services/speech-service/language-support',
	},
	{
		id: 'gemini',
		label: 'Google Gemini',
		tagline: 'Free on platform credits · 30 voices · style-directable',
		billing: 'gcp',
		usdPer1k: 0,
		byok: false,
		clone: false,
		direction: true,
		anonymous: true,
		docs: 'https://ai.google.dev/gemini-api/docs/speech-generation',
	},
	{
		id: 'nvidia',
		label: 'NVIDIA Magpie',
		tagline: 'Free · multilingual · the avatar real-time lane',
		billing: 'free',
		usdPer1k: 0,
		byok: false,
		clone: false,
		direction: false,
		anonymous: true,
		docs: 'https://build.nvidia.com/nvidia/magpie-tts-multilingual',
	},
	{
		id: 'openai',
		label: 'OpenAI',
		tagline: 'Credits · 11 voices · accepts a spoken direction',
		billing: 'credits',
		usdPer1k: TTS_OPENAI_USD_PER_1K,
		byok: false,
		clone: false,
		direction: true,
		anonymous: false,
		docs: 'https://platform.openai.com/docs/guides/text-to-speech',
	},
	{
		id: 'elevenlabs',
		label: 'ElevenLabs',
		tagline: 'Credits or your own key · full library · voice cloning',
		billing: 'credits',
		usdPer1k: TTS_ELEVEN_USD_PER_1K,
		byok: true,
		clone: true,
		direction: false,
		anonymous: false,
		docs: 'https://elevenlabs.io/docs/capabilities/text-to-speech',
	},
]);

export const PROVIDER_IDS = VOICE_PROVIDERS.map((p) => p.id);

export function getProvider(id) {
	return VOICE_PROVIDERS.find((p) => p.id === id) || null;
}

/** Which lanes this deployment can actually serve right now. */
export function providerAvailability({ elevenUserKey = false } = {}) {
	return {
		edge: true, // keyless by construction
		gemini: geminiTtsConfigured(),
		nvidia: nvidiaTtsConfigured(),
		openai: Boolean(env.OPENAI_API_KEY),
		elevenlabs: elevenConfigured() || elevenUserKey,
	};
}

/** The models selectable on a lane (empty when the lane has no model choice). */
export function providerModels(providerId) {
	if (providerId === 'elevenlabs') return ELEVEN_MODELS;
	if (providerId === 'openai') return OPENAI_TTS_MODELS;
	if (providerId === 'gemini') return GEMINI_TTS_MODELS;
	return [];
}

/** The lane's default voice id. */
export function providerDefaultVoice(providerId) {
	switch (providerId) {
		case 'edge': return EDGE_DEFAULT_VOICE;
		case 'gemini': return GEMINI_DEFAULT_VOICE;
		case 'nvidia': return OPENAI_DEFAULT_VOICE; // Magpie is addressed by OpenAI-style ids
		case 'openai': return OPENAI_DEFAULT_VOICE;
		default: return null;
	}
}

/**
 * USD this request will cost the caller. 0 for every free / GCP-credit lane
 * and for BYOK; the credit lanes bill per 1k characters.
 */
export function usdForSynthesis({ provider, chars, byok = false }) {
	if (byok) return 0;
	const p = getProvider(provider);
	if (!p || !p.usdPer1k) return 0;
	return Math.max(0.0001, (chars / 1000) * p.usdPer1k);
}

/** The credit-ledger action id for a metered lane, or null when free. */
export function creditActionFor(provider) {
	if (provider === 'elevenlabs') return 'tts.eleven';
	if (provider === 'openai') return 'tts.openai';
	return null;
}

// ── Catalogs ─────────────────────────────────────────────────────────────────

const GEMINI_VOICE_LIST = GEMINI_VOICES.map((v) => ({
	id: v.id,
	name: v.id,
	provider: 'gemini',
	gender: null,
	locale: null,
	language: 'multi',
	labels: { description: v.character, use_case: 'conversational' },
	preview_url: null,
}));

const OPENAI_VOICE_LIST = TTS_VOICES.map((v) => ({
	id: v.id,
	name: v.name,
	provider: 'openai',
	gender: null,
	locale: null,
	language: 'multi',
	labels: { description: v.description },
	preview_url: null,
}));

const NVIDIA_VOICE_LIST = TTS_VOICES.filter((v) => NVIDIA_VOICE_IDS.has(v.id)).map((v) => ({
	id: v.id,
	name: v.name,
	provider: 'nvidia',
	gender: null,
	locale: null,
	language: 'multi',
	labels: { description: v.description, persona: VOICE_TO_MAGPIE[v.id] },
	preview_url: null,
}));

/** Normalize an ElevenLabs catalog entry into the shared voice shape. */
function normalizeElevenVoice(v) {
	const labels = v.labels || {};
	return {
		id: v.voice_id,
		name: v.name,
		provider: 'elevenlabs',
		gender: labels.gender || null,
		locale: null,
		language: labels.language || 'multi',
		category: v.category || null,
		labels,
		preview_url: v.preview_url || null,
	};
}

/**
 * Every voice on one lane, in the shared shape.
 * @param {string} providerId
 * @param {{ elevenKey?: string|null, byok?: boolean }} [opts]
 * @returns {Promise<Array>}
 */
export async function listProviderVoices(providerId, { elevenKey = null, byok = false } = {}) {
	switch (providerId) {
		case 'edge': {
			const { voices } = await listEdgeVoices();
			return voices;
		}
		case 'gemini':
			return GEMINI_VOICE_LIST;
		case 'nvidia':
			return NVIDIA_VOICE_LIST;
		case 'openai':
			return OPENAI_VOICE_LIST;
		case 'elevenlabs': {
			if (!elevenKey) return [];
			const { voices } = await listElevenVoices(byok ? { apiKey: elevenKey } : {});
			return voices.map(normalizeElevenVoice);
		}
		default:
			return [];
	}
}

// ── Synthesis ────────────────────────────────────────────────────────────────

function tagged(message, code, extra = {}) {
	return Object.assign(new Error(message), { code, ...extra });
}

/**
 * Render text on one lane. Always resolves with the COMPLETE clip so callers
 * can meter, cache and fail over before a byte reaches the client.
 *
 * @param {{
 *   provider: string, text: string, voiceId?: string, model?: string,
 *   direction?: string, speed?: number, rate?: string, pitch?: string,
 *   format?: string, language?: string, voiceSettings?: object|null,
 *   elevenKey?: string|null,
 * }} opts
 * @returns {Promise<{ audio:Buffer, contentType:string, format:string, provider:string, model:string, voiceId:string, lane?:string }>}
 */
export async function synthesizeVoice(opts) {
	const provider = String(opts.provider || '');
	const text = String(opts.text || '').trim();
	if (!text) throw tagged('text is required', 'invalid_argument');

	switch (provider) {
		case 'edge': {
			const voiceId = EDGE_VOICE_RE.test(String(opts.voiceId || ''))
				? String(opts.voiceId)
				: EDGE_DEFAULT_VOICE;
			// Edge takes prosody as SSML strings; accept the numeric `speed` every
			// other lane uses and convert, so one client control drives them all.
			const rate =
				opts.rate && EDGE_RATE_RE.test(opts.rate)
					? opts.rate
					: `${Math.round((clampSpeed(opts.speed) - 1) * 100) >= 0 ? '+' : ''}${Math.round((clampSpeed(opts.speed) - 1) * 100)}%`;
			const pitch = opts.pitch && EDGE_PITCH_RE.test(opts.pitch) ? opts.pitch : '+0Hz';
			const audio = await synthesizeEdge(voiceId, text, rate, pitch);
			if (!audio.length) throw tagged('Edge TTS returned empty audio', 'provider_error');
			return {
				audio,
				contentType: 'audio/mpeg',
				format: 'mp3',
				provider,
				model: 'edge-readaloud',
				voiceId,
			};
		}

		case 'gemini': {
			const out = await synthesizeGeminiTts({
				text,
				voice: opts.voiceId,
				model: opts.model || GEMINI_TTS_DEFAULT_MODEL,
				direction: opts.direction,
				timeoutMs: SYNTH_TIMEOUT_MS,
			});
			return {
				audio: out.audio,
				contentType: out.contentType,
				format: out.format,
				provider,
				model: out.model,
				voiceId: out.voiceName,
				lane: out.lane,
			};
		}

		case 'nvidia': {
			const voiceId = OPENAI_VOICE_IDS.has(String(opts.voiceId))
				? String(opts.voiceId)
				: OPENAI_DEFAULT_VOICE;
			const out = await synthesizeNvidiaTts({
				text,
				voice: voiceId,
				language: opts.language || 'en-US',
				format: opts.format === 'pcm' ? 'pcm' : 'wav',
				timeoutMs: SYNTH_TIMEOUT_MS,
			});
			return {
				audio: out.audio,
				contentType: out.contentType,
				format: out.format,
				provider,
				model: out.model,
				voiceId,
			};
		}

		case 'openai': {
			const key = env.OPENAI_API_KEY;
			if (!key) throw tagged('OpenAI is not configured', 'not_configured');
			const voiceId = OPENAI_VOICE_IDS.has(String(opts.voiceId))
				? String(opts.voiceId)
				: OPENAI_DEFAULT_VOICE;
			const model = OPENAI_MODEL_IDS.has(String(opts.model))
				? String(opts.model)
				: OPENAI_DEFAULT_MODEL;
			const formatKey = OPENAI_FORMATS[opts.format] ? opts.format : 'mp3';
			const payload = {
				model,
				voice: voiceId,
				input: text,
				response_format: formatKey,
				speed: clampSpeed(opts.speed),
			};
			// Only gpt-4o-mini-tts understands a spoken direction; sending it to
			// tts-1 is a 400.
			if (opts.direction && model === 'gpt-4o-mini-tts') payload.instructions = String(opts.direction);

			let resp;
			try {
				resp = await fetch('https://api.openai.com/v1/audio/speech', {
					method: 'POST',
					headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
					body: JSON.stringify(payload),
					signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
				});
			} catch (e) {
				throw tagged(`Could not reach OpenAI: ${e?.message || 'fetch failed'}`, 'provider_unreachable');
			}
			if (!resp.ok) {
				const detail = await resp.text().catch(() => '');
				throw tagged(
					`OpenAI returned ${resp.status}: ${detail.slice(0, 300)}`,
					resp.status === 429 ? 'rate_limited' : 'provider_error',
				);
			}
			return {
				audio: Buffer.from(await resp.arrayBuffer()),
				contentType: OPENAI_FORMATS[formatKey],
				format: formatKey,
				provider,
				model,
				voiceId,
			};
		}

		case 'elevenlabs': {
			const apiKey = opts.elevenKey;
			if (!apiKey) throw tagged('ElevenLabs is not configured', 'not_configured');
			const voiceId = String(opts.voiceId || '').trim();
			if (!voiceId) throw tagged('voiceId is required for ElevenLabs', 'invalid_argument');
			const model = isElevenModel(opts.model) ? opts.model : ELEVEN_DEFAULT_MODEL;
			const settings = normalizeVoiceSettings(opts.voiceSettings || {});

			let resp;
			try {
				resp = await fetch(`${ELEVEN_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'audio/mpeg',
						'xi-api-key': apiKey,
					},
					body: JSON.stringify({ text, model_id: model, voice_settings: settings }),
					signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
				});
			} catch (e) {
				throw tagged(`Could not reach ElevenLabs: ${e?.message || 'fetch failed'}`, 'provider_unreachable');
			}
			if (!resp.ok) {
				const detail = await resp.text().catch(() => '');
				throw tagged(
					`ElevenLabs returned ${resp.status}: ${detail.slice(0, 300)}`,
					resp.status === 429 ? 'rate_limited' : resp.status === 401 ? 'invalid_key' : 'provider_error',
				);
			}
			return {
				audio: Buffer.from(await resp.arrayBuffer()),
				contentType: 'audio/mpeg',
				format: 'mp3',
				provider,
				model,
				voiceId,
			};
		}

		default:
			throw tagged(`Unknown voice provider "${provider}"`, 'invalid_argument');
	}
}

function clampSpeed(speed) {
	const n = Number(speed);
	if (!Number.isFinite(n)) return 1;
	return Math.min(2, Math.max(0.5, n));
}

export { geminiTtsLanes };
